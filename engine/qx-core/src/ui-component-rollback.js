import { QXUIError } from "./ui-component-runtime.js";
import { proposeUIComponentUpgrade } from "./ui-component-upgrade.js";

function rollbackFail(message) {
  throw new QXUIError("QX_UI_ROLLBACK_INCOMPATIBLE", message);
}

function allowedKeys(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

/**
 * Builds an explicit, non-mutating UI rollback proposal.
 *
 * Each mapping identifies the exact currently pinned release in "from"
 * and one exact previously published release in "to". Historical targets
 * are still checked against the current host lifecycle and policy overlay.
 */
export function proposeUIComponentRollback(input = {}) {
  if (!allowedKeys(input,
    ["tree", "lock", "currentRegistry", "targetRegistry", "mappings"],
    ["targetTree"]) ||
      !input.currentRegistry || typeof input.currentRegistry.resolve !== "function" ||
      !input.targetRegistry || typeof input.targetRegistry.resolve !== "function" ||
      !Array.isArray(input.mappings)) {
    rollbackFail("Rollback proposal requires a tree, lock, current and target lifecycle registries, and explicit mappings");
  }

  try {
    return proposeUIComponentUpgrade({
      tree: input.tree,
      lock: input.lock,
      sourceRegistry: input.currentRegistry,
      targetRegistry: input.targetRegistry,
      mappings: input.mappings,
      ...(input.targetTree === undefined ? {} : { targetTree: input.targetTree })
    });
  } catch (error) {
    if (error?.code === "QX_UI_UPGRADE_INCOMPATIBLE") {
      rollbackFail(error.message);
    }
    throw error;
  }
}
