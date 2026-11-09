import test from "node:test";
import assert from "node:assert/strict";
import { createUIComponentRegistry } from "../src/ui-component-registry.js";
import {
  createUIComponentLifecycleRegistry,
  validateUIComponentTreeWithLifecycle
} from "../src/ui-component-lifecycle.js";

const heading = {
  type: "UI.HEADING",
  contractVersion: "1.0.0",
  renderer: "heading",
  props: { level: { type: "number", required: true, integer: true, minimum: 1, maximum: 6 } },
  children: { text: true, components: [] }
};
const baseRegistry = () => createUIComponentRegistry({
  snapshots: [{ registryRelease: "ui-registry-1.0.0", components: [heading] }]
});
const exact = registry => {
  const record = registry.resolve("UI.HEADING", "1.0.0", "ui-registry-1.0.0");
  return {
    registryRelease: record.registryRelease,
    type: record.type,
    contractVersion: record.contractVersion,
    schemaDigest: record.schemaDigest
  };
};
const lockFor = registry => ({
  schema: "QX.UI.COMPONENT-LOCK",
  version: "1.0",
  components: [exact(registry)]
});
const tree = () => ({
  schema: "QX.UI.TREE",
  version: "1.0",
  children: [{
    kind: "component",
    id: "heading",
    type: "UI.HEADING",
    version: "1.0.0",
    props: { level: 2 },
    children: [{ kind: "text", value: "Lifecycle test" }]
  }]
});
const policy = (entries = [], status = "available") => ({
  revision: "host-policy-1",
  status,
  entries
});
const lifecycle = (registry, state = {}) => [{
  ...exact(registry),
  lifecycle: state.lifecycle ?? "active",
  supported: state.supported ?? true,
  ...(state.deprecation === undefined ? {} : { deprecation: state.deprecation })
}];
const create = (state = {}, policyEntries = [], policyStatus = "available") => {
  const registry = baseRegistry();
  return {
    registry,
    lifecycleRegistry: createUIComponentLifecycleRegistry({
      registry,
      lifecycle: lifecycle(registry, state),
      hostPolicy: policy(policyEntries, policyStatus)
    })
  };
};

test("allows an active exact release without warnings", () => {
  const { registry, lifecycleRegistry } = create();
  const result = validateUIComponentTreeWithLifecycle(tree(), lockFor(registry), lifecycleRegistry);
  assert.equal(result.tree.children[0].props.level, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.policyRevision, "host-policy-1");
});

test("allows a deprecated supported release and emits one structured warning", () => {
  const { registry, lifecycleRegistry } = create({
    lifecycle: "deprecated",
    deprecation: "Move to the next reviewed heading contract"
  });
  const originalLock = lockFor(registry);
  const originalLockJSON = JSON.stringify(originalLock);
  const result = validateUIComponentTreeWithLifecycle(tree(), originalLock, lifecycleRegistry);

  assert.equal(result.tree.children[0].id, "heading");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "QX_UI_RELEASE_DEPRECATED");
  assert.equal(result.warnings[0].message, "Move to the next reviewed heading contract");
  assert.equal(JSON.stringify(originalLock), originalLockJSON);
  assert.equal(Object.isFrozen(result.warnings[0]), true);
});

test("rejects a retired lifecycle release before returning a tree", () => {
  const { registry, lifecycleRegistry } = create({ lifecycle: "retired" });
  assert.throws(() =>
    validateUIComponentTreeWithLifecycle(tree(), lockFor(registry), lifecycleRegistry),
  { code: "QX_UI_RELEASE_RETIRED" });
});

test("rejects a release unsupported by the current host", () => {
  const { registry, lifecycleRegistry } = create({ supported: false });
  assert.throws(() =>
    validateUIComponentTreeWithLifecycle(tree(), lockFor(registry), lifecycleRegistry),
  { code: "QX_UI_RELEASE_UNAVAILABLE" });
});

test("current host revocation overrides an immutable historical active snapshot", () => {
  const registry = baseRegistry();
  const key = exact(registry);
  const { lifecycleRegistry } = createUIComponentLifecycleRegistryFixture(registry, [], [
    { ...key, decision: "retired" }
  ]);
  assert.throws(() =>
    validateUIComponentTreeWithLifecycle(tree(), lockFor(registry), lifecycleRegistry),
  { code: "QX_UI_RELEASE_RETIRED" });
});

test("host support denial overrides historical lifecycle without changing the snapshot", () => {
  const registry = baseRegistry();
  const key = exact(registry);
  const { lifecycleRegistry } = createUIComponentLifecycleRegistryFixture(registry, [], [
    { ...key, decision: "unsupported" }
  ]);
  assert.throws(() =>
    validateUIComponentTreeWithLifecycle(tree(), lockFor(registry), lifecycleRegistry),
  { code: "QX_UI_RELEASE_UNAVAILABLE" });
});

test("fails closed before tree validation when host policy is unavailable", () => {
  const { registry, lifecycleRegistry } = create({}, [], "unavailable");
  assert.throws(() =>
    validateUIComponentTreeWithLifecycle(tree(), lockFor(registry), lifecycleRegistry),
  { code: "QX_UI_RELEASE_UNAVAILABLE" });
});

test("rejects malformed, duplicate, and digest-mismatched lifecycle or policy records", () => {
  const registry = baseRegistry();
  const key = exact(registry);
  const validLifecycle = lifecycle(registry)[0];
  const hostPolicy = policy();

  assert.throws(() => createUIComponentLifecycleRegistry({
    registry, lifecycle: [{ ...validLifecycle, lifecycle: "latest" }], hostPolicy
  }), { code: "QX_UI_LIFECYCLE_INVALID" });
  assert.throws(() => createUIComponentLifecycleRegistry({
    registry, lifecycle: [validLifecycle, validLifecycle], hostPolicy
  }), { code: "QX_UI_LIFECYCLE_INVALID" });
  assert.throws(() => createUIComponentLifecycleRegistry({
    registry,
    lifecycle: [{ ...validLifecycle, schemaDigest: "sha256:" + "0".repeat(64) }],
    hostPolicy
  }), { code: "QX_UI_LIFECYCLE_INVALID" });
  assert.throws(() => createUIComponentLifecycleRegistry({
    registry, lifecycle: [validLifecycle],
    hostPolicy: { ...hostPolicy, entries: [{ ...key, decision: "latest" }] }
  }), { code: "QX_UI_LIFECYCLE_INVALID" });
  assert.throws(() => createUIComponentLifecycleRegistry({
    registry, lifecycle: [validLifecycle],
    hostPolicy: { ...hostPolicy, entries: [{ ...key, decision: "retired" }, { ...key, decision: "unsupported" }] }
  }), { code: "QX_UI_LIFECYCLE_INVALID" });
});

test("project lock and tree data cannot change the host revocation overlay", () => {
  const registry = baseRegistry();
  const key = exact(registry);
  const { lifecycleRegistry } = createUIComponentLifecycleRegistryFixture(registry, [], [
    { ...key, decision: "retired" }
  ]);
  const projectLock = lockFor(registry);
  projectLock.components[0].schemaDigest = key.schemaDigest;
  projectLock.hostPolicy = { entries: [] };
  const projectTree = tree();
  projectTree.hostPolicy = { entries: [] };

  assert.throws(() =>
    validateUIComponentTreeWithLifecycle(projectTree, projectLock, lifecycleRegistry),
  { code: "QX_UI_RELEASE_RETIRED" });
});

function createUIComponentLifecycleRegistryFixture(registry, lifecycleEntries, policyEntries) {
  return {
    lifecycleRegistry: createUIComponentLifecycleRegistry({
      registry,
      lifecycle: lifecycleEntries,
      hostPolicy: policy(policyEntries)
    })
  };
}
