import test from "node:test";
import assert from "node:assert/strict";
import { createUIComponentRegistry } from "../src/ui-component-registry.js";
import { createUIComponentLifecycleRegistry } from "../src/ui-component-lifecycle.js";
import { proposeUIComponentUpgrade } from "../src/ui-component-upgrade.js";

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
    hostPolicy: { revision: "host-policy-1", status: "available", entries: [] }
  });
}

const sourceSnapshot = {
  registryRelease: "ui-registry-1.0.0",
  components: [heading("1.0.0")]
};
function fixture(targetComponents = [heading("2.0.0")], targetStates = {}) {
  const sourceRegistry = lifecycleRegistry([sourceSnapshot]);
  const targetSnapshots = [
    sourceSnapshot,
    { registryRelease: "ui-registry-2.0.0", components: targetComponents }
  ];
  const targetCatalog = createUIComponentRegistry({ snapshots: targetSnapshots });
  const targetRegistry = lifecycleRegistry(targetSnapshots, targetStates);
  const sourceRecord = sourceRegistry.resolve("UI.HEADING", "1.0.0", "ui-registry-1.0.0");
  const targetRecord = targetCatalog.resolve(
    targetComponents[0].type,
    targetComponents[0].contractVersion,
    "ui-registry-2.0.0"
  );
  const lock = {
    schema: "QX.UI.COMPONENT-LOCK",
    version: "1.0",
    components: [{
      type: sourceRecord.type,
      contractVersion: sourceRecord.contractVersion,
      schemaDigest: sourceRecord.schemaDigest,
      registryRelease: sourceRecord.registryRelease
    }]
  };
  const tree = {
    schema: "QX.UI.TREE",
    version: "1.0",
    children: [{
      kind: "component",
      id: "heading",
      type: "UI.HEADING",
      version: "1.0.0",
      props: { level: 2 },
      children: [{ kind: "text", value: "Upgrade proposal" }]
    }]
  };
  const mapping = {
    from: {
      registryRelease: sourceRecord.registryRelease,
      type: sourceRecord.type,
      contractVersion: sourceRecord.contractVersion,
      schemaDigest: sourceRecord.schemaDigest
    },
    to: {
      registryRelease: targetRecord.registryRelease,
      type: targetRecord.type,
      contractVersion: targetRecord.contractVersion,
      schemaDigest: targetRecord.schemaDigest
    }
  };
  return { sourceRegistry, targetRegistry, lock, tree, mapping };
}

const request = (input, mappings, targetTree) => ({
  tree: input.tree,
  lock: input.lock,
  sourceRegistry: input.sourceRegistry,
  targetRegistry: input.targetRegistry,
  mappings,
  ...(targetTree === undefined ? {} : { targetTree })
});

test("returns an exact deterministic lock and tree proposal without mutating source inputs", () => {
  const input = fixture();
  const originalLock = JSON.stringify(input.lock);
  const originalTree = JSON.stringify(input.tree);

  const first = proposeUIComponentUpgrade(request(input, [input.mapping]));
  const second = proposeUIComponentUpgrade(request(input, [input.mapping]));

  assert.deepEqual(first, second);
  assert.equal(first.lock.components[0].contractVersion, "2.0.0");
  assert.equal(first.lock.components[0].registryRelease, "ui-registry-2.0.0");
  assert.equal(first.tree.children[0].version, "2.0.0");
  assert.equal(first.tree.children[0].props.level, 2);
  assert.equal(JSON.stringify(input.lock), originalLock);
  assert.equal(JSON.stringify(input.tree), originalTree);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.lock.components[0]), true);
});

test("requires an explicit mapping for every source lock entry", () => {
  const input = fixture();
  assert.throws(() => proposeUIComponentUpgrade(request(input, [])), { code: "QX_UI_UPGRADE_INCOMPATIBLE" });
});

test("rejects mappings that do not identify an exact source tuple", () => {
  const input = fixture();
  assert.throws(() => proposeUIComponentUpgrade(request(input, [{ ...input.mapping, from: { ...input.mapping.from, schemaDigest: "sha256:" + "0".repeat(64) } }])), { code: "QX_UI_UPGRADE_INCOMPATIBLE" });
});

test("rejects implicit component type changes", () => {
  const input = fixture();
  assert.throws(() => proposeUIComponentUpgrade(request(input, [{ ...input.mapping, to: { ...input.mapping.to, type: "UI.TEXT_BLOCK" } }])), { code: "QX_UI_UPGRADE_INCOMPATIBLE" });
});

test("rejects a target whose schema cannot validate the existing tree", () => {
  const input = fixture([heading("2.0.0", 3)]);
  assert.throws(() => proposeUIComponentUpgrade(request(input, [input.mapping])), { code: "QX_UI_UPGRADE_INCOMPATIBLE" });
});

test("accepts an explicitly transformed tree when the target schema requires new properties", () => {
  const input = fixture([heading("2.0.0", 1, true)]);
  const transformedTree = {
    ...input.tree,
    children: [{
      ...input.tree.children[0],
      version: "2.0.0",
      props: { level: 2, tone: "info" }
    }]
  };
  const proposal = proposeUIComponentUpgrade(request(input, [input.mapping], transformedTree));
  assert.deepEqual(proposal.tree.children[0].props, { level: 2, tone: "info" });
  assert.equal(proposal.lock.components[0].contractVersion, "2.0.0");
  assert.equal(input.tree.children[0].props.tone, undefined);
});

test("does not propose a target release retired by current host policy", () => {
  const input = fixture([heading("2.0.0")], {
    "2.0.0": { lifecycle: "retired" }
  });
  assert.throws(() => proposeUIComponentUpgrade(request(input, [input.mapping])), { code: "QX_UI_RELEASE_RETIRED" });
});

test("rejects duplicate source mappings", () => {
  const input = fixture();
  assert.throws(() => proposeUIComponentUpgrade(request(input, [input.mapping, input.mapping])), { code: "QX_UI_UPGRADE_INCOMPATIBLE" });
});

test("rejects a target tuple with a mismatched schema digest", () => {
  const input = fixture();
  assert.throws(() => proposeUIComponentUpgrade(request(input, [{
    ...input.mapping,
    to: { ...input.mapping.to, schemaDigest: "sha256:" + "f".repeat(64) }
  }])), { code: "QX_UI_UPGRADE_INCOMPATIBLE" });
});
