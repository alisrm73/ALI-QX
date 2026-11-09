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


test("accepts exact resource boundaries and rejects the first value beyond each boundary", () => {
  const twoNodes = tree([
    { kind: "text", value: "a" },
    { kind: "text", value: "b" }
  ]);
  assert.doesNotThrow(() => validateUIComponentTree(twoNodes, lock, {
    maxNodes: 2, maxTextLength: 1, maxTotalTextLength: 2
  }));
  assert.throws(() => validateUIComponentTree(twoNodes, lock, { maxNodes: 1 }), {
    code: "QX_UI_TREE_NODES"
  });
  const overlongText = tree([{ kind: "text", value: "ab" }]);
  assert.throws(() => validateUIComponentTree(overlongText, lock, { maxTextLength: 1 }), {
    code: "QX_UI_TEXT_LIMIT"
  });
  assert.throws(() => validateUIComponentTree(twoNodes, lock, { maxTextLength: 1, maxTotalTextLength: 1 }), {
    code: "QX_UI_TEXT_LIMIT"
  });

  const nested = tree([component("root", "UI.CONTAINER", [
    { kind: "text", value: "x" }
  ])]);
  assert.doesNotThrow(() => validateUIComponentTree(nested, lock, { maxDepth: 2 }));
  assert.throws(() => validateUIComponentTree(nested, lock, { maxDepth: 1 }), {
    code: "QX_UI_TREE_DEPTH"
  });

  const serialized = JSON.stringify(tree([{ kind: "text", value: "é" }]));
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  assert.doesNotThrow(() => validateUIComponentTree(serialized, lock, {
    maxSerializedBytes: serializedBytes
  }));
  assert.throws(() => validateUIComponentTree(serialized, lock, {
    maxSerializedBytes: serializedBytes - 1
  }), { code: "QX_UI_TREE_INVALID" });

  const heading = tree([component("h", "UI.HEADING", [
    { kind: "text", value: "x" }
  ], { level: 1 })]);
  const propertyBytes = Buffer.byteLength(JSON.stringify({ level: 1 }), "utf8");
  assert.doesNotThrow(() => validateUIComponentTree(heading, lock, {
    maxPropertyBytes: propertyBytes
  }));
  assert.throws(() => validateUIComponentTree(heading, lock, {
    maxPropertyBytes: propertyBytes - 1
  }), { code: "QX_UI_PROP_LIMIT" });
});

test("enforces component ID length at its exact boundary", () => {
  const validId = "a".repeat(64);
  assert.doesNotThrow(() => validateUIComponentTree(tree([
    component(validId, "UI.TEXT_BLOCK", [{ kind: "text", value: "x" }])
  ]), lock));
  const invalidId = "a".repeat(65);
  assert.throws(() => validateUIComponentTree(tree([
    component(invalidId, "UI.TEXT_BLOCK", [{ kind: "text", value: "x" }])
  ]), lock), { code: "QX_UI_ID_INVALID" });
});


test("rejects malformed UI tree envelopes and non-exact root fields", () => {
  const valid = tree([]);
  assert.throws(() => validateUIComponentTree({ ...valid, extra: true }, lock), {
    code: "QX_UI_TREE_INVALID"
  });
  assert.throws(() => validateUIComponentTree({ schema: valid.schema, children: [] }, lock), {
    code: "QX_UI_TREE_INVALID"
  });
  assert.throws(() => validateUIComponentTree({ ...valid, version: "2.0" }, lock), {
    code: "QX_UI_TREE_INVALID"
  });
  assert.throws(() => validateUIComponentTree({ ...valid, children: {} }, lock), {
    code: "QX_UI_TREE_INVALID"
  });
});

test("rejects malformed UI component lock envelopes and entries", () => {
  assert.throws(() => validateUIComponentTree(tree([]), { ...lock, extra: true }), {
    code: "QX_UI_LOCK_INVALID"
  });
  assert.throws(() => validateUIComponentTree(tree([]), {
    schema: lock.schema, version: lock.version
  }), { code: "QX_UI_LOCK_INVALID" });
  assert.throws(() => validateUIComponentTree(tree([]), {
    ...lock, components: {}
  }), { code: "QX_UI_LOCK_INVALID" });

  const entry = lock.components[0];
  const extraField = {
    ...lock,
    components: lock.components.map((item, index) => index === 0 ? { ...item, extra: true } : item)
  };
  assert.throws(() => validateUIComponentTree(tree([]), extraField), {
    code: "QX_UI_LOCK_INVALID"
  });
  const missingField = {
    ...lock,
    components: lock.components.map((item, index) => {
      if (index !== 0) return item;
      const { registryRelease, ...rest } = item;
      return rest;
    })
  };
  assert.throws(() => validateUIComponentTree(tree([]), missingField), {
    code: "QX_UI_LOCK_INVALID"
  });
  const unknownComponent = {
    ...lock,
    components: [...lock.components, {
      ...entry, type: "UI.UNKNOWN"
    }].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : 0)
  };
  assert.throws(() => validateUIComponentTree(tree([]), unknownComponent), {
    code: "QX_UI_UNKNOWN_COMPONENT"
  });
});

test("preserves mixed root and nested child order exactly", () => {
  const input = tree([
    { kind: "text", value: "before" },
    component("root", "UI.CONTAINER", [
      { kind: "text", value: "first" },
      component("heading", "UI.HEADING", [
        { kind: "text", value: "middle" }
      ], { level: 2 }),
      { kind: "text", value: "last" }
    ]),
    { kind: "text", value: "after" }
  ]);
  const result = validateUIComponentTree(input, lock);
  assert.deepEqual(result.children.map(node => node.kind === "text" ? node.value : node.id), [
    "before", "root", "after"
  ]);
  assert.deepEqual(result.children[1].children.map(node =>
    node.kind === "text" ? node.value : node.id
  ), ["first", "heading", "last"]);
});

test("rejects nested object property values instead of accepting unbounded property data", () => {
  const input = tree([
    component("heading", "UI.HEADING", [
      { kind: "text", value: "Title" }
    ], { level: { nested: { value: 1 } } })
  ]);
  assert.throws(() => validateUIComponentTree(input, lock), {
    code: "QX_UI_PROP_INVALID"
  });
});


test("keeps generated registry lock snapshots deterministic and immutable", () => {
  const first = createDefaultUILock();
  const second = createDefaultUILock();
  assert.deepEqual(first, second);
  assert.deepEqual(first.components.map(entry => entry.type), [
    "UI.CONTAINER", "UI.HEADING", "UI.TEXT_BLOCK"
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.components), true);
  assert.ok(first.components.every(entry => Object.isFrozen(entry)));
  assert.throws(() => { first.components[0].contractVersion = "2.0.0"; }, TypeError);
  assert.throws(() => { first.components.push(first.components[0]); }, TypeError);
});

test("rejects unavailable older and newer releases without silent version fallback", () => {
  for (const unsupportedVersion of ["0.9.0", "1.1.0"]) {
    const unavailable = {
      ...lock,
      components: lock.components.map(entry => entry.type === "UI.HEADING"
        ? { ...entry, contractVersion: unsupportedVersion } : entry)
    };
    assert.throws(() => validateUIComponentTree(tree([]), unavailable), {
      code: "QX_UI_RELEASE_UNAVAILABLE"
    });
  }
});

test("rejects a lock pin from a different registry release", () => {
  const foreignRegistry = {
    ...lock,
    components: lock.components.map(entry => entry.type === "UI.HEADING"
      ? { ...entry, registryRelease: "ui-registry-2.0.0" } : entry)
  };
  assert.throws(() => validateUIComponentTree(tree([]), foreignRegistry), {
    code: "QX_UI_RELEASE_UNAVAILABLE"
  });
});
