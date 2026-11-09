import test from "node:test";
import assert from "node:assert/strict";
import {
  createUIComponentRegistry,
  QXUIRegistryError
} from "../src/ui-component-registry.js";

function heading(contractVersion, maximum = 6) {
  return {
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
  };
}

test("creates immutable snapshots with deterministic content digests", () => {
  const components = [heading("1.0.0"), heading("2.0.0", 4)];
  const registry = createUIComponentRegistry({
    snapshots: [{ registryRelease: "ui-registry-2.0.0", components }]
  });
  const snapshot = registry.getRelease("ui-registry-2.0.0");

  assert.match(snapshot.snapshotDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(registry.createSnapshot("ui-registry-2.0.0"), snapshot);
  assert.deepEqual(registry.listReleases("UI.HEADING").map(item => item.contractVersion), [
    "1.0.0", "2.0.0"
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.components), true);
  assert.equal(Object.isFrozen(snapshot.components[0].schema.props.level), true);
  assert.throws(() => { snapshot.components[0].props.level.maximum = 99; }, TypeError);

  components[0].props.level.maximum = 99;
  assert.equal(registry.resolve("UI.HEADING", "1.0.0", "ui-registry-2.0.0").props.level.maximum, 6);
});

test("resolves exact component versions from exact immutable snapshots", () => {
  const registry = createUIComponentRegistry({
    snapshots: [
      { registryRelease: "ui-registry-1.0.0", components: [heading("1.0.0")] },
      { registryRelease: "ui-registry-2.0.0", components: [heading("1.0.0"), heading("2.0.0", 4)] }
    ]
  });

  assert.equal(registry.resolve("UI.HEADING", "1.0.0", "ui-registry-1.0.0").registryRelease,
    "ui-registry-1.0.0");
  assert.equal(registry.resolve("UI.HEADING", "2.0.0", "ui-registry-2.0.0").props.level.maximum, 4);
  assert.equal(registry.listReleases("UI.HEADING").length, 3);
  assert.throws(() => registry.resolve("UI.HEADING", "2.0.0", "ui-registry-1.0.0"), {
    name: "QXUIRegistryError",
    code: "QX_UI_RELEASE_UNAVAILABLE"
  });
  assert.throws(() => registry.getRelease("missing"), {
    name: "QXUIRegistryError",
    code: "QX_UI_RELEASE_UNAVAILABLE"
  });
});

test("rejects conflicting schema digests for the same component contract version", () => {
  assert.throws(() => createUIComponentRegistry({
    snapshots: [
      { registryRelease: "ui-registry-1.0.0", components: [heading("1.0.0", 6)] },
      { registryRelease: "ui-registry-2.0.0", components: [heading("1.0.0", 5)] }
    ]
  }), {
    name: "QXUIRegistryError",
    code: "QX_UI_REGISTRY_INVALID"
  });
});

test("rejects duplicate snapshot IDs, duplicate contract pins, and malformed definitions", () => {
  assert.throws(() => createUIComponentRegistry({
    snapshots: [{ registryRelease: "ui-registry-1.0.0", components: [heading("1.0.0")] }],
    unexpected: true
  }), { code: "QX_UI_REGISTRY_INVALID" });

  assert.throws(() => createUIComponentRegistry({
    snapshots: [
      { registryRelease: "ui-registry-1.0.0", components: [heading("1.0.0")] },
      { registryRelease: "ui-registry-1.0.0", components: [heading("2.0.0")] }
    ]
  }), { code: "QX_UI_REGISTRY_INVALID" });

  assert.throws(() => createUIComponentRegistry({
    snapshots: [{
      registryRelease: "ui-registry-1.0.0",
      components: [heading("1.0.0"), heading("1.0.0")]
    }]
  }), { code: "QX_UI_REGISTRY_INVALID" });

  assert.throws(() => createUIComponentRegistry({
    snapshots: [{
      registryRelease: "ui-registry-1.0.0",
      components: [{ ...heading("1.0.0"), renderer: "project-supplied renderer" }]
    }]
  }), { code: "QX_UI_REGISTRY_INVALID" });

  const textWithNumericBounds = {
    ...heading("1.0.0"),
    props: { title: { type: "string", minimum: 1 } }
  };
  assert.throws(() => createUIComponentRegistry({
    snapshots: [{
      registryRelease: "ui-registry-1.0.0",
      components: [textWithNumericBounds]
    }]
  }), { code: "QX_UI_REGISTRY_INVALID" });
});

test("orders releases by SemVer precedence with deterministic build-metadata ties", () => {
  const versions = [
    "1.0.0",
    "1.0.0+build.2",
    "1.0.0+build.1",
    "1.0.0-alpha.10",
    "1.0.0-alpha.2",
    "1.0.0-alpha"
  ];
  const registry = createUIComponentRegistry({
    snapshots: [{
      registryRelease: "ui-registry-1.0.0",
      components: versions.map(version => heading(version))
    }]
  });
  assert.deepEqual(registry.listReleases("UI.HEADING").map(item => item.contractVersion), [
    "1.0.0-alpha",
    "1.0.0-alpha.2",
    "1.0.0-alpha.10",
    "1.0.0",
    "1.0.0+build.1",
    "1.0.0+build.2"
  ]);
});

test("returns the same snapshot digest regardless of component input order", () => {
  const registryA = createUIComponentRegistry({
    snapshots: [{
      registryRelease: "ui-registry-1.0.0",
      components: [heading("1.0.0"), heading("2.0.0", 4)]
    }]
  });
  const registryB = createUIComponentRegistry({
    snapshots: [{
      registryRelease: "ui-registry-1.0.0",
      components: [heading("2.0.0", 4), heading("1.0.0")]
    }]
  });
  assert.equal(
    registryA.getRelease("ui-registry-1.0.0").snapshotDigest,
    registryB.getRelease("ui-registry-1.0.0").snapshotDigest
  );
});

test("exposes typed registry errors", () => {
  const registry = createUIComponentRegistry({
    snapshots: [{ registryRelease: "ui-registry-1.0.0", components: [heading("1.0.0")] }]
  });
  assert.throws(() => registry.resolve("UI.UNKNOWN", "1.0.0", "ui-registry-1.0.0"), error =>
    error instanceof QXUIRegistryError && error.code === "QX_UI_RELEASE_UNAVAILABLE");
});
