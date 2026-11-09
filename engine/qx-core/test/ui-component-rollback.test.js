import test from "node:test";
import assert from "node:assert/strict";
import { createUIComponentRegistry } from "../src/ui-component-registry.js";
import { createUIComponentLifecycleRegistry } from "../src/ui-component-lifecycle.js";
import { proposeUIComponentRollback } from "../src/ui-component-rollback.js";

const heading = (version, minimum = 1, requireTone = false) => ({
  type: "UI.HEADING",
  contractVersion: version,
  renderer: "heading",
  props: {
    level: { type: "number", required: true, integer: true, minimum, maximum: 6 },
    ...(requireTone ? { tone: { type: "string", required: true } } : {})
  },
  children: { text: true, components: [] }
});

function lifecycleRegistry(snapshots, states = {}) {
  const registry = createUIComponentRegistry({ snapshots });
  const records = snapshots.flatMap(snapshot => snapshot.components.map(component => {
    const record = registry.resolve(component.type, component.contractVersion, snapshot.registryRelease);
    const state = states[component.contractVersion] ?? {};
    return {
      registryRelease: record.registryRelease,
      type: record.type,
      contractVersion: record.contractVersion,
      schemaDigest: record.schemaDigest,
      lifecycle: state.lifecycle ?? "active",
      supported: state.supported ?? true,
      ...(state.deprecation === undefined ? {} : { deprecation: state.deprecation })
    };
  }));
  return createUIComponentLifecycleRegistry({
    registry,
    lifecycle: records,
    hostPolicy: { revision: "host-policy-rollback-1", status: "available", entries: [] }
  });
}

const oldSnapshot = {
  registryRelease: "ui-registry-1.0.0",
  components: [heading("1.0.0")]
};
const currentSnapshot = {
  registryRelease: "ui-registry-2.0.0",
  components: [heading("2.0.0")]
};

function fixture(targetStates = {}, targetComponents = [heading("1.0.0")]) {
  const currentSnapshots = [oldSnapshot, currentSnapshot];
  const currentRegistry = lifecycleRegistry(currentSnapshots);
  const targetSnapshots = [
    oldSnapshot,
    { registryRelease: "ui-registry-2.0.0", components: [heading("2.0.0")] }
  ];
  const targetRegistry = lifecycleRegistry(targetSnapshots, targetStates);
  const currentRecord = currentRegistry.resolve("UI.HEADING", "2.0.0", "ui-registry-2.0.0");

  const targetCatalog = createUIComponentRegistry({
    snapshots: [
      { registryRelease: "ui-registry-1.0.0", components: targetComponents },
      currentSnapshot
    ]
  });
  const targetRecord = targetCatalog.resolve(
    targetComponents[0].type,
    targetComponents[0].contractVersion,
    "ui-registry-1.0.0"
  );
  const lock = {
    schema: "QX.UI.COMPONENT-LOCK",
    version: "1.0",
    components: [{
      type: currentRecord.type,
      contractVersion: currentRecord.contractVersion,
      schemaDigest: currentRecord.schemaDigest,
      registryRelease: currentRecord.registryRelease
    }]
  };
  const tree = {
    schema: "QX.UI.TREE",
    version: "1.0",
    children: [{
      kind: "component",
      id: "heading",
      type: "UI.HEADING",
      version: "2.0.0",
      props: { level: 2 },
      children: [{ kind: "text", value: "Rollback proposal" }]
    }]
  };
  const mapping = {
    from: {
      registryRelease: currentRecord.registryRelease,
      type: currentRecord.type,
      contractVersion: currentRecord.contractVersion,
      schemaDigest: currentRecord.schemaDigest
    },
    to: {
      registryRelease: targetRecord.registryRelease,
      type: targetRecord.type,
      contractVersion: targetRecord.contractVersion,
      schemaDigest: targetRecord.schemaDigest
    }
  };
  return { currentRegistry, targetRegistry, lock, tree, mapping };
}

const request = (input, mappings, targetTree) => ({
  tree: input.tree,
  lock: input.lock,
  currentRegistry: input.currentRegistry,
  targetRegistry: input.targetRegistry,
  mappings,
  ...(targetTree === undefined ? {} : { targetTree })
});

test("returns a deterministic historical lock/tree proposal without mutating source inputs", () => {
  const input = fixture();
  const originalLock = JSON.stringify(input.lock);
  const originalTree = JSON.stringify(input.tree);

  const first = proposeUIComponentRollback(request(input, [input.mapping]));
  const second = proposeUIComponentRollback(request(input, [input.mapping]));

  assert.deepEqual(first, second);
  assert.equal(first.lock.components[0].contractVersion, "1.0.0");
  assert.equal(first.lock.components[0].registryRelease, "ui-registry-1.0.0");
  assert.equal(first.tree.children[0].version, "1.0.0");
  assert.equal(first.tree.children[0].props.level, 2);
  assert.equal(JSON.stringify(input.lock), originalLock);
  assert.equal(JSON.stringify(input.tree), originalTree);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.lock.components[0]), true);
});

test("requires one explicit mapping for every current lock entry", () => {
  const input = fixture();
  assert.throws(
    () => proposeUIComponentRollback(request(input, [])),
    { code: "QX_UI_ROLLBACK_INCOMPATIBLE" }
  );
});

test("rejects a mapping that does not identify the exact current pin", () => {
  const input = fixture();
  assert.throws(() => proposeUIComponentRollback(request(input, [{
    ...input.mapping,
    from: { ...input.mapping.from, schemaDigest: "sha256:" + "0".repeat(64) }
  }])), { code: "QX_UI_ROLLBACK_INCOMPATIBLE" });
});

test("rejects an implicit component type change", () => {
  const input = fixture();
  assert.throws(() => proposeUIComponentRollback(request(input, [{
    ...input.mapping,
    to: { ...input.mapping.to, type: "UI.TEXT_BLOCK" }
  }])), { code: "QX_UI_ROLLBACK_INCOMPATIBLE" });
});

test("rejects a historical target retired by current host policy", () => {
  const input = fixture({
    "1.0.0": { lifecycle: "retired" }
  });
  assert.throws(
    () => proposeUIComponentRollback(request(input, [input.mapping])),
    { code: "QX_UI_RELEASE_RETIRED" }
  );
});

test("rejects a historical target that cannot validate the current tree", () => {
  const input = fixture({}, [heading("1.0.0", 3)]);
  assert.throws(
    () => proposeUIComponentRollback(request(input, [input.mapping])),
    { code: "QX_UI_ROLLBACK_INCOMPATIBLE" }
  );
});

test("accepts an explicitly transformed rollback tree when the old schema requires it", () => {
  const input = fixture({}, [heading("1.0.0", 1, true)]);
  const transformedTree = {
    ...input.tree,
    children: [{
      ...input.tree.children[0],
      version: "1.0.0",
      props: { level: 2, tone: "info" }
    }]
  };
  const proposal = proposeUIComponentRollback(
    request(input, [input.mapping], transformedTree)
  );
  assert.deepEqual(proposal.tree.children[0].props, { level: 2, tone: "info" });
  assert.equal(proposal.lock.components[0].contractVersion, "1.0.0");
  assert.equal(input.tree.children[0].props.tone, undefined);
});
