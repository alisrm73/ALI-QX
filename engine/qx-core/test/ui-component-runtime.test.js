import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultUILock,
  getUIComponentRegistry,
  validateUIComponentTree
} from "../src/ui-component-runtime.js";

const lock = createDefaultUILock();
const component = (id, type, children = [], props = {}) => ({
  kind: "component", id, type, version: "1.0.0", props, children
});
const tree = children => ({ schema: "QX.UI.TREE", version: "1.0", children });

test("publishes immutable built-in presentation component releases and exact lock pins", () => {
  assert.deepEqual(getUIComponentRegistry().map(item => item.type), [
    "UI.CONTAINER", "UI.TEXT_BLOCK", "UI.HEADING"
  ]);
  assert.equal(lock.schema, "QX.UI.COMPONENT-LOCK");
  assert.equal(lock.components.length, 3);
  assert.ok(lock.components.every(entry => /^sha256:[0-9a-f]{64}$/.test(entry.schemaDigest)));
});

test("keeps host registry schemas immutable and enforces strict SemVer", () => {
  const registry = getUIComponentRegistry();
  assert.equal(Object.isFrozen(registry[0].children), true);
  assert.equal(Object.isFrozen(registry[0].children.components), true);
  assert.throws(() => registry[0].children.components.push("UI.UNTRUSTED"), TypeError);
  const invalid = {
    ...lock,
    components: lock.components.map(entry => entry.type === "UI.HEADING"
      ? { ...entry, contractVersion: "1.0.0-01" } : entry)
  };
  assert.throws(() => validateUIComponentTree(tree([]), invalid), { code: "QX_UI_LOCK_INVALID" });
});

test("validates and preserves nested static component trees and literal text", () => {
  const input = tree([
    component("root", "UI.CONTAINER", [
      component("title", "UI.HEADING", [{ kind: "text", value: "<script>literal</script>" }], { level: 1 }),
      component("body", "UI.TEXT_BLOCK", [{ kind: "text", value: "Hello QX" }])
    ])
  ]);
  const result = validateUIComponentTree(JSON.stringify(input), lock);
  assert.equal(result.children[0].children[0].children[0].value, "<script>literal</script>");
  assert.equal(Object.isFrozen(result.children[0].children[0].props), true);
});

test("rejects missing lock files and missing exact pins", () => {
  const input = tree([component("title", "UI.HEADING", [{ kind: "text", value: "Hi" }], { level: 2 })]);
  assert.throws(() => validateUIComponentTree(input, null), { code: "QX_UI_LOCK_INVALID" });
  const partial = { ...lock, components: lock.components.filter(entry => entry.type !== "UI.HEADING") };
  assert.throws(() => validateUIComponentTree(input, partial), { code: "QX_UI_LOCK_MISSING" });
});

test("rejects duplicate IDs, unknown fields, and missing children arrays", () => {
  const duplicate = tree([component("same", "UI.CONTAINER", [
    component("same", "UI.TEXT_BLOCK", [{ kind: "text", value: "x" }])
  ])]);
  assert.throws(() => validateUIComponentTree(duplicate, lock), { code: "QX_UI_ID_DUPLICATE" });
  const unknown = tree([{ ...component("x", "UI.TEXT_BLOCK", [{ kind: "text", value: "x" }]), html: "<b>" }]);
  assert.throws(() => validateUIComponentTree(unknown, lock), { code: "QX_UI_NODE_INVALID" });
  const missing = tree([{ kind: "component", id: "x", type: "UI.TEXT_BLOCK", version: "1.0.0", props: {} }]);
  assert.throws(() => validateUIComponentTree(missing, lock), { code: "QX_UI_NODE_INVALID" });
});

test("rejects unsupported components, versions, and child-policy violations", () => {
  assert.throws(() => validateUIComponentTree(tree([component("x", "UI.UNKNOWN")]), lock), { code: "QX_UI_UNKNOWN_COMPONENT" });
  assert.throws(() => validateUIComponentTree(tree([{
    ...component("x", "UI.TEXT_BLOCK", [{ kind: "text", value: "x" }]), version: "2.0.0"
  }]), lock), { code: "QX_UI_VERSION_MISMATCH" });
  assert.throws(() => validateUIComponentTree(tree([
    component("leaf", "UI.TEXT_BLOCK", [component("nested", "UI.TEXT_BLOCK", [{ kind: "text", value: "x" }])])
  ]), lock), { code: "QX_UI_CHILD_POLICY" });
});

test("rejects altered, duplicate, and malformed lock entries", () => {
  const mismatch = {
    ...lock,
    components: lock.components.map(entry => entry.type === "UI.HEADING"
      ? { ...entry, schemaDigest: "sha256:" + "0".repeat(64) } : entry)
  };
  assert.throws(() => validateUIComponentTree(tree([]), mismatch), { code: "QX_UI_DIGEST_MISMATCH" });
  const duplicate = { ...lock, components: [...lock.components, lock.components[0]].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.contractVersion < b.contractVersion ? -1 : 1) };
  assert.throws(() => validateUIComponentTree(tree([]), duplicate), { code: "QX_UI_LOCK_DUPLICATE" });
  const unsorted = { ...lock, components: [...lock.components].reverse() };
  assert.throws(() => validateUIComponentTree(tree([]), unsorted), { code: "QX_UI_LOCK_ORDER" });
  assert.throws(() => validateUIComponentTree(tree([]), { ...lock, version: "latest" }), { code: "QX_UI_LOCK_INVALID" });
});

test("enforces node, depth, text, and serialized byte limits", () => {
  assert.throws(() => validateUIComponentTree(tree([{ kind: "text", value: "12345" }]), lock, { maxTextLength: 4 }), { code: "QX_UI_TEXT_LIMIT" });
  assert.throws(() => validateUIComponentTree(tree([{ kind: "text", value: "x" }, { kind: "text", value: "y" }]), lock, { maxNodes: 1 }), { code: "QX_UI_TREE_NODES" });
  assert.throws(() => validateUIComponentTree(JSON.stringify(tree([])).padEnd(100, " "), lock, { maxSerializedBytes: 50 }), { code: "QX_UI_TREE_INVALID" });
  assert.throws(() => validateUIComponentTree(tree([component("c", "UI.CONTAINER", [{ kind: "text", value: "x" }])]), lock, { maxDepth: 1 }), { code: "QX_UI_TREE_DEPTH" });
  assert.throws(() => validateUIComponentTree(tree([{ kind: "text", value: "a" }, { kind: "text", value: "b" }]), lock, { maxTotalTextLength: 1 }), { code: "QX_UI_TEXT_LIMIT" });
  assert.throws(() => validateUIComponentTree(tree([component("h", "UI.HEADING", [{ kind: "text", value: "x" }], { level: 1 })]), lock, { maxPropertyBytes: 1 }), { code: "QX_UI_PROP_LIMIT" });
});

test("rejects non-JSON objects and invalid property values", () => {
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => validateUIComponentTree(cyclic, lock), { code: "QX_UI_TREE_INVALID" });
  assert.throws(() => validateUIComponentTree(tree([component("h", "UI.HEADING", [{ kind: "text", value: "x" }], { level: 9 })]), lock), { code: "QX_UI_PROP_INVALID" });
});
