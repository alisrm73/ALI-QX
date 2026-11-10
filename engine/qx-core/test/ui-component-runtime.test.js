import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultUILock,
  getUIComponentRegistry,
  validateUIComponentTree,
  validateUIComponentTreeWithRegistry
} from "../src/ui-component-runtime.js";
import { createUIComponentRegistry } from "../src/ui-component-registry.js";

const lock = createDefaultUILock();
const component = (id, type, children = [], props = {}, version = "1.0.0") => ({
  kind: "component", id, type, version, props, children
});
const tree = children => ({ schema: "QX.UI.TREE", version: "1.0", children });

test("publishes immutable built-in presentation component releases and exact lock pins", () => {
  assert.deepEqual(getUIComponentRegistry().map(item =>
    item.type + "@" + item.contractVersion + "@" + item.registryRelease), [
    "UI.CONTAINER@1.0.0@ui-registry-1.0.0",
    "UI.TEXT_BLOCK@1.0.0@ui-registry-1.0.0",
    "UI.HEADING@1.0.0@ui-registry-1.0.0",
    "UI.CONTAINER@1.0.0@ui-registry-1.1.0",
    "UI.CONTAINER@1.1.0@ui-registry-1.1.0",
    "UI.DIVIDER@1.0.0@ui-registry-1.1.0",
    "UI.HEADING@1.0.0@ui-registry-1.1.0",
    "UI.TEXT_BLOCK@1.0.0@ui-registry-1.1.0"
  ]);
  assert.equal(lock.schema, "QX.UI.COMPONENT-LOCK");
  assert.equal(lock.components.length, 5);
  assert.deepEqual(lock.components.map(entry => entry.schemaDigest), [
    "sha256:6693f6a569739a270be14209ba18ae467a101823eb83e12028619ad4e86dadab",
    "sha256:8f6facc7900cc140063923538b56b3ec127783ee3b0e5c25997f7bf1ae7f44ee",
    "sha256:cfbdc6d89e14cebadf052ac5474150eea216e2d3ee6ef9f0ee597ce54fb4c0af",
    "sha256:c793f48ad34d9d73ba62c96cc4b42c061ecf7f845c46dffd87c3ac35a5e7b239",
    "sha256:1e385953ec61605090646609296cc53d7ed91db49d43f9e6497051963515ddcc"
  ]);
  assert.ok(lock.components.every(entry => /^sha256:[0-9a-f]{64}$/.test(entry.schemaDigest)));
  assert.ok(lock.components.every(entry => entry.registryRelease === "ui-registry-1.1.0"));
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

test("adds UI.DIVIDER through a new container contract without changing the old pin", () => {
  const legacyTree = tree([
    component("legacy", "UI.CONTAINER", [
      component("rule", "UI.DIVIDER")
    ])
  ]);
  assert.throws(() => validateUIComponentTree(legacyTree, lock), {
    code: "QX_UI_CHILD_POLICY"
  });

  const currentTree = tree([
    component("current", "UI.CONTAINER", [
      component("rule", "UI.DIVIDER")
    ], {}, "1.1.0")
  ]);
  const result = validateUIComponentTree(currentTree, lock);
  assert.equal(result.children[0].version, "1.1.0");
  assert.equal(result.children[0].children[0].type, "UI.DIVIDER");

  const invalidDivider = tree([
    component("current", "UI.CONTAINER", [
      component("rule", "UI.DIVIDER", [{ kind: "text", value: "not allowed" }])
    ], {}, "1.1.0")
  ]);
  assert.throws(() => validateUIComponentTree(invalidDivider, lock), {
    code: "QX_UI_CHILD_POLICY"
  });
});

test("preserves exact pins from the immutable legacy registry snapshot", () => {
  const legacyLock = {
    schema: "QX.UI.COMPONENT-LOCK",
    version: "1.0",
    components: [
      {
        type: "UI.CONTAINER",
        contractVersion: "1.0.0",
        schemaDigest: "sha256:6693f6a569739a270be14209ba18ae467a101823eb83e12028619ad4e86dadab",
        registryRelease: "ui-registry-1.0.0"
      },
      {
        type: "UI.HEADING",
        contractVersion: "1.0.0",
        schemaDigest: "sha256:c793f48ad34d9d73ba62c96cc4b42c061ecf7f845c46dffd87c3ac35a5e7b239",
        registryRelease: "ui-registry-1.0.0"
      },
      {
        type: "UI.TEXT_BLOCK",
        contractVersion: "1.0.0",
        schemaDigest: "sha256:1e385953ec61605090646609296cc53d7ed91db49d43f9e6497051963515ddcc",
        registryRelease: "ui-registry-1.0.0"
      }
    ]
  };
  const legacyTree = tree([
    component("root", "UI.CONTAINER", [
      component("heading", "UI.HEADING", [{ kind: "text", value: "Legacy title" }], { level: 1 }),
      component("body", "UI.TEXT_BLOCK", [{ kind: "text", value: "Legacy content" }])
    ])
  ]);
  const result = validateUIComponentTree(legacyTree, legacyLock);
  assert.equal(result.children[0].children[0].children[0].value, "Legacy title");
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
  assert.deepEqual(first.components.map(entry => entry.type + "@" + entry.contractVersion), [
    "UI.CONTAINER@1.0.0", "UI.CONTAINER@1.1.0", "UI.DIVIDER@1.0.0",
    "UI.HEADING@1.0.0", "UI.TEXT_BLOCK@1.0.0"
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


test("validates a tree against the exact pinned version in a multi-version registry", () => {
  const heading = (contractVersion, maximum) => ({
    type: "UI.HEADING",
    contractVersion,
    renderer: "heading",
    props: {
      level: {
        type: "number",
        required: true,
        integer: true,
        minimum: 1,
        maximum
      }
    },
    children: { text: true, components: [] }
  });
  const hostRegistry = createUIComponentRegistry({
    snapshots: [
      {
        registryRelease: "ui-registry-1.0.0",
        components: [heading("1.0.0", 6)]
      },
      {
        registryRelease: "ui-registry-2.0.0",
        components: [heading("1.0.0", 6), heading("2.0.0", 4)]
      }
    ]
  });
  const pinned = hostRegistry.resolve("UI.HEADING", "1.0.0", "ui-registry-1.0.0");
  const projectLock = {
    schema: "QX.UI.COMPONENT-LOCK",
    version: "1.0",
    components: [{
      type: pinned.type,
      contractVersion: pinned.contractVersion,
      schemaDigest: pinned.schemaDigest,
      registryRelease: pinned.registryRelease
    }]
  };
  const input = tree([
    component("heading", "UI.HEADING", [
      { kind: "text", value: "Pinned old release" }
    ], { level: 6 })
  ]);

  const result = validateUIComponentTreeWithRegistry(input, projectLock, hostRegistry);
  assert.equal(result.children[0].props.level, 6);
  assert.equal(hostRegistry.listReleases("UI.HEADING").length, 3);
  assert.throws(() => validateUIComponentTreeWithRegistry(
    input,
    {
      ...projectLock,
      components: [{
        ...projectLock.components[0],
        registryRelease: "ui-registry-3.0.0"
      }]
    },
    hostRegistry
  ), { code: "QX_UI_RELEASE_UNAVAILABLE" });
});

test("preserves the existing validator third argument as resource limits", () => {
  assert.throws(() => validateUIComponentTree(tree([
    { kind: "text", value: "too long" }
  ]), lock, { maxTextLength: 3 }), { code: "QX_UI_TEXT_LIMIT" });
});
