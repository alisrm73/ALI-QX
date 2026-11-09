import { QXUIError } from "./ui-component-runtime.js";
import { validateUIComponentTreeWithLifecycle } from "./ui-component-lifecycle.js";

const LOCK_SCHEMA = "QX.UI.COMPONENT-LOCK";
const LOCK_VERSION = "1.0";
const TUPLE_KEYS = ["registryRelease", "type", "contractVersion", "schemaDigest"];

function upgradeFail(message) {
  throw new QXUIError("QX_UI_UPGRADE_INCOMPATIBLE", message);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function allowedKeys(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function lockKey(value) {
  return value.type + "@" + value.contractVersion;
}

function cloneValidatedLock(lockInput) {
  const serialized = typeof lockInput === "string" ? lockInput : JSON.stringify(lockInput);
  if (typeof serialized !== "string") upgradeFail("The source lock cannot be serialized as JSON");
  let lock;
  try { lock = JSON.parse(serialized); }
  catch { upgradeFail("The source lock must be valid JSON"); }
  if (!exactKeys(lock, ["schema", "version", "components"]) ||
      lock.schema !== LOCK_SCHEMA || lock.version !== LOCK_VERSION ||
      !Array.isArray(lock.components)) {
    upgradeFail("The source lock has an invalid envelope");
  }
  return lock;
}

function validateTuple(value, label) {
  if (!exactKeys(value, TUPLE_KEYS) ||
      TUPLE_KEYS.some(key => typeof value[key] !== "string" || value[key].length === 0)) {
    upgradeFail(label + " must contain the exact registry release, type, contract version, and schema digest");
  }
}

function rewriteTree(node, targets) {
  if (node.kind === "text") return { kind: "text", value: node.value };
  const target = targets.get(lockKey({ type: node.type, contractVersion: node.version }));
  if (!target) upgradeFail("No explicit target mapping exists for " + lockKey({ type: node.type, contractVersion: node.version }));
  return {
    kind: "component",
    id: node.id,
    type: node.type,
    version: target.contractVersion,
    props: { ...node.props },
    children: node.children.map(child => rewriteTree(child, targets))
  };
}

/**
 * Builds an explicit, non-mutating UI lock/tree upgrade proposal.
 *
 * Every source lock entry must have one exact from/to mapping. The target
 * component type must remain the same; changing its schema requires a
 * separately reviewed tree transformation rather than an implicit rewrite.
 */
export function proposeUIComponentUpgrade(input = {}) {
  if (!allowedKeys(input, ["tree", "lock", "sourceRegistry", "targetRegistry", "mappings"], ["targetTree"]) ||
      !input.sourceRegistry || typeof input.sourceRegistry.resolve !== "function" ||
      !input.targetRegistry || typeof input.targetRegistry.resolve !== "function" ||
      !Array.isArray(input.mappings)) {
    upgradeFail("Upgrade proposal requires a tree, lock, source and target lifecycle registries, and explicit mappings");
  }

  // Validate the existing project against its exact historical pins first.
  const sourceResult = validateUIComponentTreeWithLifecycle(
    input.tree, input.lock, input.sourceRegistry
  );
  const sourceLock = cloneValidatedLock(input.lock);
  const sourceEntries = sourceLock.components;
  const mappedSourceEntries = new Set();

  const targetsByNode = new Map();
  const targetLockEntries = [];
  const targetLockKeys = new Set();

  for (const mapping of input.mappings) {
    if (!exactKeys(mapping, ["from", "to"])) {
      upgradeFail("Each upgrade mapping must contain exactly from and to tuples");
    }
    validateTuple(mapping.from, "Upgrade source mapping");
    validateTuple(mapping.to, "Upgrade target mapping");
    const sourceEntry = sourceEntries.find(entry =>
      TUPLE_KEYS.every(key => entry[key] === mapping.from[key]));
    if (!sourceEntry) upgradeFail("Upgrade mapping does not match an exact source lock entry");
    if (mappedSourceEntries.has(sourceEntry)) upgradeFail("Duplicate mapping for one exact source lock entry");
    if (mapping.from.type !== mapping.to.type) {
      upgradeFail("A component upgrade cannot silently change the component type");
    }

    let targetRecord;
    try {
      targetRecord = input.targetRegistry.resolve(
        mapping.to.type, mapping.to.contractVersion, mapping.to.registryRelease
      );
    } catch (error) {
      if (error?.code === "QX_UI_RELEASE_RETIRED" || error?.code === "QX_UI_RELEASE_UNAVAILABLE") throw error;
      upgradeFail("The exact target component release cannot be resolved");
    }
    if (targetRecord.schemaDigest !== mapping.to.schemaDigest) {
      upgradeFail("Target schema digest does not match the exact host registry record");
    }

    const targetEntry = {
      type: targetRecord.type,
      contractVersion: targetRecord.contractVersion,
      schemaDigest: targetRecord.schemaDigest,
      registryRelease: targetRecord.registryRelease
    };
    const targetKey = lockKey(targetEntry);
    if (targetLockKeys.has(targetKey)) upgradeFail("Multiple source entries map to the same target lock entry");
    targetLockKeys.add(targetKey);
    mappedSourceEntries.add(sourceEntry);
    targetsByNode.set(lockKey(sourceEntry), targetEntry);
    targetLockEntries.push(targetEntry);
  }

  if (mappedSourceEntries.size !== sourceEntries.length) {
    upgradeFail("Every source lock entry, including unused entries, requires exactly one explicit target mapping");
  }

  targetLockEntries.sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 :
      a.contractVersion < b.contractVersion ? -1 :
        a.contractVersion > b.contractVersion ? 1 : 0);

  const proposedTree = input.targetTree ?? {
    schema: sourceResult.tree.schema,
    version: sourceResult.tree.version,
    children: sourceResult.tree.children.map(node => rewriteTree(node, targetsByNode))
  };
  const proposedLock = {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION,
    components: targetLockEntries
  };

  let targetResult;
  try {
    targetResult = validateUIComponentTreeWithLifecycle(
      proposedTree, proposedLock, input.targetRegistry
    );
  } catch (error) {
    if (error?.code === "QX_UI_RELEASE_RETIRED" || error?.code === "QX_UI_RELEASE_UNAVAILABLE") throw error;
    if (error?.code === "QX_UI_UPGRADE_INCOMPATIBLE") throw error;
    upgradeFail("The existing UI tree does not satisfy the exact target component contracts");
  }

  return freezeDeep({
    tree: targetResult.tree,
    lock: proposedLock,
    sourceWarnings: sourceResult.warnings,
    targetWarnings: targetResult.warnings,
    sourcePolicyRevision: sourceResult.policyRevision,
    targetPolicyRevision: targetResult.policyRevision
  });
}
