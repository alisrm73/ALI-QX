import { createHash } from "node:crypto";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMPONENT_TYPE_PATTERN = /^[A-Z][A-Z0-9]*(?:[._][A-Z0-9]+)*$/;
const RENDERER_PATTERN = /^[a-z][a-z0-9-]*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class QXUIRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QXUIRegistryError";
    this.code = code;
  }
}

function registryFail(message) {
  throw new QXUIRegistryError("QX_UI_REGISTRY_INVALID", message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function cloneJSON(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) registryFail("Registry definitions must contain finite numbers");
    return value;
  }
  if (typeof value !== "object") registryFail("Registry definitions must contain JSON data");
  if (seen.has(value)) registryFail("Registry definitions must not contain cycles");
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
          !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) {
        registryFail("Registry arrays must contain only indexed data values");
      }
    }
    const result = value.map(item => cloneJSON(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) registryFail("Registry definitions must use plain objects");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      registryFail("Registry objects must contain only enumerable string data properties");
    }
    result[key] = cloneJSON(descriptor.value, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJSON(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) registryFail("Canonical registry data requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (isPlainObject(value)) {
    return "{" + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
  }
  registryFail("Registry data is not canonical JSON");
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(canonicalJSON(value), "utf8").digest("hex");
}

function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    value
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index], b = right[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const an = BigInt(a), bn = BigInt(b);
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else {
      return a < b ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

function compareSemver(left, right) {
  const a = parseSemver(left), b = parseSemver(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const precedence = comparePrerelease(a.prerelease, b.prerelease);
  if (precedence !== 0) return precedence;
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function validateComponentDefinition(input) {
  if (!exactKeys(input, ["type", "contractVersion", "renderer", "props", "children"])) {
    registryFail("Component definitions must contain exactly type, contractVersion, renderer, props, and children");
  }
  const definition = cloneJSON(input);
  if (typeof definition.type !== "string" || !COMPONENT_TYPE_PATTERN.test(definition.type)) {
    registryFail("Component type is not canonical");
  }
  if (!parseSemver(definition.contractVersion)) registryFail("Component contractVersion must be exact SemVer");
  if (typeof definition.renderer !== "string" || !RENDERER_PATTERN.test(definition.renderer)) {
    registryFail("Component renderer identifier is invalid");
  }
  if (!isPlainObject(definition.props)) registryFail("Component props schema must be a plain object");
  for (const [name, rule] of Object.entries(definition.props)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
        !isPlainObject(rule) ||
        Object.keys(rule).some(key => !["type", "required", "integer", "minimum", "maximum"].includes(key)) ||
        !["string", "number", "boolean"].includes(rule.type)) {
      registryFail("Component property rule is invalid");
    }
    if (rule.required !== undefined && typeof rule.required !== "boolean") registryFail("Property required flag must be Boolean");
    if (rule.integer !== undefined && typeof rule.integer !== "boolean") registryFail("Property integer flag must be Boolean");
    if (rule.integer === true && rule.type !== "number") registryFail("Only numeric properties may require integers");
    for (const key of ["minimum", "maximum"]) {
      if (rule[key] !== undefined && (typeof rule[key] !== "number" || !Number.isFinite(rule[key]))) {
        registryFail("Property numeric bounds must be finite numbers");
      }
    }
    if (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum) {
      registryFail("Property minimum cannot exceed maximum");
    }
  }
  if (!exactKeys(definition.children, ["text", "components"]) ||
      typeof definition.children.text !== "boolean" ||
      !Array.isArray(definition.children.components) ||
      !definition.children.components.every(type => typeof type === "string" && COMPONENT_TYPE_PATTERN.test(type)) ||
      new Set(definition.children.components).size !== definition.children.components.length) {
    registryFail("Component children policy is invalid");
  }
  return definition;
}

function snapshotRecord(registryRelease, definitions) {
  if (typeof registryRelease !== "string" || !REGISTRY_ID_PATTERN.test(registryRelease)) {
    registryFail("Registry snapshot identifier is invalid");
  }
  if (!Array.isArray(definitions) || definitions.length === 0) {
    registryFail("Each registry snapshot must contain at least one component release");
  }
  const seen = new Set();
  const components = definitions.map(input => {
    const definition = validateComponentDefinition(input);
    const key = definition.type + "@" + definition.contractVersion;
    if (seen.has(key)) registryFail("Duplicate component release in registry snapshot: " + key);
    seen.add(key);
    const schema = freezeDeep({
      type: definition.type,
      contractVersion: definition.contractVersion,
      props: definition.props,
      children: definition.children,
      renderer: definition.renderer
    });
    return freezeDeep({
      type: definition.type,
      contractVersion: definition.contractVersion,
      registryRelease,
      schemaDigest: digest(schema),
      schema,
      renderer: definition.renderer,
      props: definition.props,
      children: definition.children
    });
  });
  components.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 :
    compareSemver(a.contractVersion, b.contractVersion));
  const snapshotDigest = digest(components.map(({ type, contractVersion, schemaDigest }) =>
    ({ type, contractVersion, schemaDigest })));
  return freezeDeep({ registryRelease, snapshotDigest, components });
}

export function createUIComponentRegistry({ snapshots } = {}) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    registryFail("A registry must contain at least one immutable snapshot");
  }
  const releases = new Map();
  const schemaDigests = new Map();
  for (const input of snapshots) {
    if (!exactKeys(input, ["registryRelease", "components"])) {
      registryFail("Registry snapshots must contain exactly registryRelease and components");
    }
    const snapshot = snapshotRecord(input.registryRelease, input.components);
    if (releases.has(snapshot.registryRelease)) {
      registryFail("Duplicate registry snapshot identifier: " + snapshot.registryRelease);
    }
    for (const record of snapshot.components) {
      const key = record.type + "@" + record.contractVersion;
      const previousDigest = schemaDigests.get(key);
      if (previousDigest && previousDigest !== record.schemaDigest) {
        registryFail("A component contract cannot be republished with a different schema digest: " + key);
      }
      schemaDigests.set(key, record.schemaDigest);
    }
    releases.set(snapshot.registryRelease, snapshot);
  }

  function getRelease(registryRelease) {
    const snapshot = releases.get(registryRelease);
    if (!snapshot) {
      throw new QXUIRegistryError("QX_UI_RELEASE_UNAVAILABLE", "Registry snapshot is not available: " + registryRelease);
    }
    return snapshot;
  }

  function resolve(type, contractVersion, registryRelease) {
    const snapshot = getRelease(registryRelease);
    const record = snapshot.components.find(item =>
      item.type === type && item.contractVersion === contractVersion);
    if (!record) {
      throw new QXUIRegistryError(
        "QX_UI_RELEASE_UNAVAILABLE",
        "The exact component release is not available: " + type + "@" + contractVersion
      );
    }
    return record;
  }

  function listReleases(type, registryRelease) {
    const snapshotsToRead = registryRelease === undefined
      ? [...releases.values()]
      : [getRelease(registryRelease)];
    const records = snapshotsToRead.flatMap(snapshot => snapshot.components)
      .filter(record => type === undefined || record.type === type)
      .sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 :
        compareSemver(a.contractVersion, b.contractVersion) ||
        (a.registryRelease < b.registryRelease ? -1 : a.registryRelease > b.registryRelease ? 1 : 0));
    return Object.freeze(records);
  }

  function createSnapshot(registryRelease) {
    return getRelease(registryRelease);
  }

  return Object.freeze({
    resolve,
    getRelease,
    listReleases,
    createSnapshot
  });
}
