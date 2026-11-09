import { QXUIError, validateUIComponentTreeWithRegistry } from "./ui-component-runtime.js";

const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TYPE = /^[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function lifecycleFail(message) {
  throw new QXUIError("QX_UI_LIFECYCLE_INVALID", message);
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key));
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function tupleKey(record) {
  return [record.registryRelease, record.type, record.contractVersion, record.schemaDigest].join("\u0000");
}

function validateTuple(record, label) {
  if (!exactKeys(record, ["registryRelease", "type", "contractVersion", "schemaDigest"]) ||
      typeof record.registryRelease !== "string" || !REGISTRY_ID.test(record.registryRelease) ||
      typeof record.type !== "string" || !TYPE.test(record.type) ||
      typeof record.contractVersion !== "string" || !SEMVER.test(record.contractVersion) ||
      typeof record.schemaDigest !== "string" || !DIGEST.test(record.schemaDigest)) {
    lifecycleFail(label + " must identify one exact registry component tuple");
  }
}

function validateHostPolicy(policy) {
  if (!exactKeys(policy, ["revision", "status", "entries"]) ||
      typeof policy.revision !== "string" || !REGISTRY_ID.test(policy.revision) ||
      !["available", "unavailable"].includes(policy.status) ||
      !Array.isArray(policy.entries)) {
    lifecycleFail("Host UI release policy is malformed");
  }
  const entries = new Map();
  for (const entry of policy.entries) {
    if (!exactKeys(entry, ["registryRelease", "type", "contractVersion", "schemaDigest", "decision"])) {
      lifecycleFail("Host UI release policy entry is malformed");
    }
    validateTuple({
      registryRelease: entry.registryRelease,
      type: entry.type,
      contractVersion: entry.contractVersion,
      schemaDigest: entry.schemaDigest
    }, "Host policy entry");
    if (!["retired", "unsupported"].includes(entry.decision)) {
      lifecycleFail("Host policy decision must be retired or unsupported");
    }
    const key = tupleKey(entry);
    if (entries.has(key)) lifecycleFail("Host policy contains a duplicate exact release decision");
    entries.set(key, entry.decision);
  }
  return { revision: policy.revision, status: policy.status, entries };
}

/**
 * Wraps an immutable host registry with lifecycle metadata and a separately
 * supplied host-controlled policy overlay. The overlay is never read from
 * project locks or UI trees.
 */
export function createUIComponentLifecycleRegistry(input = {}) {
  if (!exactKeys(input, ["registry", "lifecycle", "hostPolicy"]) ||
      !input.registry || typeof input.registry.resolve !== "function" ||
      typeof input.registry.listReleases !== "function" ||
      typeof input.registry.getRelease !== "function" ||
      !Array.isArray(input.lifecycle)) {
    lifecycleFail("Lifecycle registry requires a host registry, lifecycle records, and host policy");
  }

  const lifecycleRecords = new Map();
  for (const entry of input.lifecycle) {
    if (!exactKeys(entry,
      ["registryRelease", "type", "contractVersion", "schemaDigest", "lifecycle", "supported"],
      ["deprecation"])) {
      lifecycleFail("Lifecycle record is malformed");
    }
    validateTuple(entry, "Lifecycle record");
    if (!["active", "deprecated", "retired"].includes(entry.lifecycle) ||
        typeof entry.supported !== "boolean") {
      lifecycleFail("Lifecycle state or host support flag is invalid");
    }
    if (entry.deprecation !== undefined &&
        (typeof entry.deprecation !== "string" || entry.deprecation.trim().length === 0 ||
         entry.deprecation.length > 512)) {
      lifecycleFail("Deprecation notice must be a non-empty string of at most 512 characters");
    }
    if (entry.lifecycle !== "deprecated" && entry.deprecation !== undefined) {
      lifecycleFail("Deprecation notice is valid only for deprecated releases");
    }
    let registered;
    try {
      registered = input.registry.resolve(entry.type, entry.contractVersion, entry.registryRelease);
    } catch {
      lifecycleFail("Lifecycle record does not identify a published host registry release");
    }
    if (registered.schemaDigest !== entry.schemaDigest) {
      lifecycleFail("Lifecycle record schema digest does not match its immutable registry release");
    }
    const key = tupleKey(entry);
    if (lifecycleRecords.has(key)) lifecycleFail("Duplicate lifecycle record for an exact component release");
    lifecycleRecords.set(key, freezeDeep({
      lifecycle: entry.lifecycle,
      supported: entry.supported,
      ...(entry.deprecation === undefined ? {} : { deprecation: entry.deprecation })
    }));
  }

  const policy = validateHostPolicy(input.hostPolicy);

  function resolve(type, contractVersion, registryRelease) {
    if (policy.status !== "available") {
      throw new QXUIError(
        "QX_UI_RELEASE_UNAVAILABLE",
        "The host UI release policy is unavailable; component execution is blocked"
      );
    }
    const record = input.registry.resolve(type, contractVersion, registryRelease);
    const key = tupleKey(record);
    const state = lifecycleRecords.get(key) ?? { lifecycle: "active", supported: true };
    const decision = policy.entries.get(key);

    if (decision === "retired" || state.lifecycle === "retired") {
      throw new QXUIError("QX_UI_RELEASE_RETIRED", "The exact pinned UI component release is retired");
    }
    if (decision === "unsupported" || !state.supported) {
      throw new QXUIError("QX_UI_RELEASE_UNAVAILABLE", "The exact UI component release is not supported by this host");
    }
    return freezeDeep({ ...record, ...state });
  }

  return Object.freeze({
    resolve,
    listReleases: (...args) => input.registry.listReleases(...args),
    getRelease: (...args) => input.registry.getRelease(...args),
    createSnapshot: typeof input.registry.createSnapshot === "function"
      ? (...args) => input.registry.createSnapshot(...args)
      : (...args) => input.registry.getRelease(...args),
    getPolicyRevision: () => policy.revision
  });
}

/**
 * Validates a tree against lifecycle-aware exact pins and returns structured
 * deprecation warnings without changing the legacy validator return shape.
 */
export function validateUIComponentTreeWithLifecycle(input, lockInput, lifecycleRegistry, limits = {}) {
  if (!lifecycleRegistry || typeof lifecycleRegistry.resolve !== "function" ||
      typeof lifecycleRegistry.listReleases !== "function" ||
      typeof lifecycleRegistry.getRelease !== "function") {
    throw new TypeError("A host UI lifecycle registry is required");
  }
  const warnings = new Map();
  const registry = Object.freeze({
    resolve(type, contractVersion, registryRelease) {
      const record = lifecycleRegistry.resolve(type, contractVersion, registryRelease);
      if (record.lifecycle === "deprecated") {
        const key = tupleKey(record);
        if (!warnings.has(key)) {
          warnings.set(key, freezeDeep({
            code: "QX_UI_RELEASE_DEPRECATED",
            type: record.type,
            contractVersion: record.contractVersion,
            registryRelease: record.registryRelease,
            message: record.deprecation ?? "This exact component release is deprecated"
          }));
        }
      }
      return record;
    },
    listReleases: (...args) => lifecycleRegistry.listReleases(...args),
    getRelease: (...args) => lifecycleRegistry.getRelease(...args)
  });
  const tree = validateUIComponentTreeWithRegistry(input, lockInput, registry, limits);
  return freezeDeep({
    tree,
    warnings: [...warnings.values()],
    policyRevision: typeof lifecycleRegistry.getPolicyRevision === "function"
      ? lifecycleRegistry.getPolicyRevision()
      : null
  });
}
