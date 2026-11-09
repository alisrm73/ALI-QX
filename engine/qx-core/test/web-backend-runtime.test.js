import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildWebProject, generateWebAssets, QXWebBuildError } from "../src/web-backend.js";
import { parse } from "../src/parser.js";
import { analyze } from "../src/semantic-analyzer.js";
import { lowerToQIR } from "../src/qir.js";
import { createDefaultUILock } from "../src/ui-component-runtime.js";
import { createUIComponentRegistry } from "../src/ui-component-registry.js";
import { createUIComponentLifecycleRegistry } from "../src/ui-component-lifecycle.js";

test("generated browser runtime executes QIR and renders global results", () => {
  const project = buildWebProject('DATA.CREATE(total, 4 + 5)\nPROCESS.CALCULATE(total, total * 2)');
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const section = nodes.get("qx-output").children.find(node => node.className === "qx-value");
  assert.equal(section.children[0].textContent, "total");
  assert.equal(section.children[1].textContent, "18");
});

test("browser runtime executes functions and DATA.COUNT", () => {
  const project = buildWebProject([
    "FUNCTION add(a, b)",
    "RETURN a + b",
    "END",
    "DATA.CREATE(items, [add(2, 3), 7])",
    "DATA.CREATE(size, DATA.COUNT(items))"
  ].join("\n"));
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const values = new Map(nodes.get("qx-output").children.filter(node => node.className === "qx-value")
    .map(node => [node.children[0].textContent, node.children[1].textContent]));
  assert.equal(values.get("items"), "[\n  5,\n  7\n]");
  assert.equal(values.get("size"), "2");
});

test("browser runtime executes branches, loops, and short-circuit control flow", () => {
  const project = buildWebProject([
    "DATA.CREATE(counter, 0)",
    "WHILE(counter < 3)",
    "PROCESS.CALCULATE(counter, counter + 1)",
    "END",
    "DATA.CREATE(flag, FALSE AND (1 / 0 > 0))",
    "DATA.CREATE(done, FALSE)",
    "IF(counter == 3)",
    "DATA.SET(done, TRUE)",
    "ELSE",
    "DATA.SET(done, FALSE)",
    "END"
  ].join("\n"));
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const values = new Map(nodes.get("qx-output").children.filter(node => node.className === "qx-value")
    .map(node => [node.children[0].textContent, node.children[1].textContent]));
  assert.equal(values.get("counter"), "3");
  assert.equal(values.get("flag"), "false");
  assert.equal(values.get("done"), "true");
});

test("browser runtime surfaces source-aware execution errors", () => {
  const project = buildWebProject("DATA.CREATE(value, 4 / 0)");
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution failed");
  assert.match(nodes.get("qx-output").children[0].textContent, /QX_VM_DIVIDE_BY_ZERO/);
  assert.match(nodes.get("qx-output").children[0].textContent, /line 1/);
});


test("browser runtime executes immutable DATA.ADD and DATA.REMOVE", () => {
  const project = buildWebProject([
    "DATA.CREATE(items, [1, [2, 3], 4])",
    "DATA.CREATE(added, DATA.ADD(items, 5))",
    "DATA.CREATE(removed, DATA.REMOVE(added, 1))"
  ].join("\n"));
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const values = new Map(nodes.get("qx-output").children.filter(node => node.className === "qx-value")
    .map(node => [node.children[0].textContent, node.children[1].textContent]));
  assert.equal(values.get("items"), "[\n  1,\n  [\n    2,\n    3\n  ],\n  4\n]");
  assert.equal(values.get("added"), "[\n  1,\n  [\n    2,\n    3\n  ],\n  4,\n  5\n]");
  assert.equal(values.get("removed"), "[\n  1,\n  4,\n  5\n]");
});

test("browser runtime reports an invalid DATA.REMOVE index", () => {
  const project = buildWebProject("DATA.CREATE(items, [1])\nDATA.CREATE(updated, DATA.REMOVE(items, 1))");
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution failed");
  assert.match(nodes.get("qx-output").children[0].textContent, /QX_VM_LIST_INDEX/);
});

test("browser runtime executes PROCESS.ADD increments", () => {
  const project = buildWebProject([
    "DATA.CREATE(count, 1)",
    "PROCESS.ADD(count, 2)",
    "FUNCTION increment(value)",
    "PROCESS.ADD(value, 3)",
    "RETURN value",
    "END",
    "DATA.CREATE(result, increment(4))"
  ].join("\n"));
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const values = new Map(nodes.get("qx-output").children.filter(node => node.className === "qx-value")
    .map(node => [node.children[0].textContent, node.children[1].textContent]));
  assert.equal(values.get("count"), "3");
  assert.equal(values.get("result"), "7");
});

test("browser runtime renders validated UI.TREE with safe DOM text nodes", () => {
  const source = 'UI.TREE("{\\"schema\\":\\"QX.UI.TREE\\",\\"version\\":\\"1.0\\",\\"children\\":[{\\"kind\\":\\"component\\",\\"id\\":\\"heading\\",\\"type\\":\\"UI.HEADING\\",\\"version\\":\\"1.0.0\\",\\"props\\":{\\"level\\":1},\\"children\\":[{\\"kind\\":\\"text\\",\\"value\\":\\"<script>literal</script>\\"}]}]}")';
  const project = buildWebProject(source, { uiLock: createDefaultUILock() });
  const makeNode = tag => ({ tag, children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode("root")], ["qx-status", makeNode("status")]]);
  const document = {
    getElementById: id => nodes.get(id),
    createElement: tag => makeNode(tag),
    createTextNode: value => ({ nodeType: 3, textContent: value })
  };
  vm.runInNewContext(project.files["app.js"], { document, TextEncoder });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const heading = nodes.get("qx-output").children[0];
  assert.equal(heading.tag, "h1");
  assert.equal(heading.children[0].textContent, "<script>literal</script>");
});

test("browser build requires and validates the exact UI component lock", () => {
  assert.throws(() => buildWebProject('UI.TREE("{}")'), { code: "QX_WEB_UI_LOCK_REQUIRED" });
  const validLock = createDefaultUILock();
  const badLock = { ...validLock, components: validLock.components.map(entry => entry.type === "UI.HEADING"
    ? { ...entry, schemaDigest: "sha256:" + "0".repeat(64) } : entry) };
  assert.throws(() => buildWebProject('UI.TREE("{}")', { uiLock: badLock }), { code: "QX_WEB_UI_LOCK_INVALID" });
});

test("browser runtime renders UI.TEXT and UI.SHOW as safe accessible text", () => {
  const project = buildWebProject([
    'UI.TEXT("<script>alert(1)</script>")',
    "DATA.CREATE(items, [1, [2, 3], TRUE])",
    "UI.SHOW(items)",
    "UI.SHOW(NULL)"
  ].join("\n"));
  assert.equal(project.metadata.qirVersion, "1.2");
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const output = nodes.get("qx-output").children;
  const textNode = output.find(node => node.className === "qx-ui-text");
  assert.equal(textNode.textContent, "<script>alert(1)</script>");
  const shows = output.filter(node => node.className === "qx-ui-show");
  assert.equal(shows.length, 2);
  assert.equal(shows[0].children[0].textContent, "[\n  1,\n  [\n    2,\n    3\n  ],\n  true\n]");
  assert.equal(shows[1].children[0].textContent, "null");
});

test("browser runtime renders UI output produced inside a function", () => {
  const project = buildWebProject([
    "FUNCTION greet(name)",
    'UI.TEXT("Hello")',
    "UI.SHOW(name)",
    "END",
    'greet("QX")'
  ].join("\n"));
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const output = nodes.get("qx-output").children;
  assert.equal(output[0].textContent, "Hello");
  assert.equal(output[1].children[0].textContent, "QX");
});

test("static browser builds reject INTEGRATION.REQUEST without a trusted host bridge", () => {
  assert.throws(
    () => buildWebProject('DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{}"))'),
    error => error instanceof QXWebBuildError && error.code === "QX_WEB_INTEGRATION_UNSUPPORTED"
  );
});

test("static browser builds remain network-disabled for local UI programs", () => {
  const project = buildWebProject([
    'UI.TEXT("local only")',
    "DATA.CREATE(value, 7)"
  ].join("\n"));
  assert.equal(project.metadata.qirVersion, "1.2");
  assert.equal(project.metadata.networkAccess, false);
});



test("web backend produces byte-for-byte deterministic assets for identical inputs", () => {
  const source = [
    "DATA.CREATE(total, 4 + 5)",
    'UI.TEXT("Stable output")',
    "PROCESS.CALCULATE(total, total * 2)"
  ].join("\n");
  const first = buildWebProject(source, { title: "Deterministic QX Project" });
  const second = buildWebProject(source, { title: "Deterministic QX Project" });
  assert.deepEqual(Object.keys(first.files).sort(), ["app.js", "index.html", "styles.css"]);
  for (const name of Object.keys(first.files)) {
    assert.equal(first.files[name], second.files[name], name + " must be byte-for-byte deterministic");
  }
  assert.deepEqual(first.metadata, second.metadata);
});

test("web asset generation rejects invalid QIR before producing files", () => {
  const source = "DATA.CREATE(value, 1)";
  const ast = parse(source);
  const semantic = analyze(ast);
  assert.equal(semantic.valid, true);
  const qir = lowerToQIR(ast, semantic);
  qir.version = "999.0";
  assert.throws(
    () => generateWebAssets(qir),
    error => error instanceof QXWebBuildError &&
      error.code === "QX_WEB_INVALID_QIR" &&
      Array.isArray(error.diagnostics) &&
      error.diagnostics.length > 0
  );
});


test("browser runtime resolves multiple exact releases of one component through lifecycle registry", () => {
  const component = version => ({
    type: "UI.HEADING",
    contractVersion: version,
    renderer: "heading",
    props: { level: { type: "number", required: true, integer: true, minimum: 1, maximum: 6 } },
    children: { text: true, components: [] }
  });
  const registry = createUIComponentRegistry({ snapshots: [
    { registryRelease: "ui-registry-v1", components: [component("1.0.0")] },
    { registryRelease: "ui-registry-v2", components: [component("2.0.0")] }
  ] });
  const pins = [
    registry.resolve("UI.HEADING", "1.0.0", "ui-registry-v1"),
    registry.resolve("UI.HEADING", "2.0.0", "ui-registry-v2")
  ];
  const lifecycleRegistry = createUIComponentLifecycleRegistry({
    registry,
    lifecycle: pins.map(item => ({
      registryRelease: item.registryRelease, type: item.type,
      contractVersion: item.contractVersion, schemaDigest: item.schemaDigest,
      lifecycle: "active", supported: true
    })),
    hostPolicy: { revision: "host-policy-1", status: "available", entries: [] }
  });
  const uiLock = {
    schema: "QX.UI.COMPONENT-LOCK", version: "1.0",
    components: pins.map(({ type, contractVersion, schemaDigest, registryRelease }) =>
      ({ type, contractVersion, schemaDigest, registryRelease }))
      .sort((a,b) => a.type.localeCompare(b.type) || a.contractVersion.localeCompare(b.contractVersion))
  };
  const source = 'UI.TREE("{\\"schema\\":\\"QX.UI.TREE\\",\\"version\\":\\"1.0\\",\\"children\\":[{\\"kind\\":\\"component\\",\\"id\\":\\"old\\",\\"type\\":\\"UI.HEADING\\",\\"version\\":\\"1.0.0\\",\\"props\\":{\\"level\\":1},\\"children\\":[{\\"kind\\":\\"text\\",\\"value\\":\\"old release\\"}]},{\\"kind\\":\\"component\\",\\"id\\":\\"new\\",\\"type\\":\\"UI.HEADING\\",\\"version\\":\\"2.0.0\\",\\"props\\":{\\"level\\":2},\\"children\\":[{\\"kind\\":\\"text\\",\\"value\\":\\"new release\\"}]}]}")';
  const project = buildWebProject(source, { uiLock, uiLifecycleRegistry: lifecycleRegistry });
  const makeNode = tag => ({ tag, children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode("root")], ["qx-status", makeNode("status")]]);
  const document = {
    getElementById: id => nodes.get(id),
    createElement: tag => makeNode(tag),
    createTextNode: value => ({ nodeType: 3, textContent: value })
  };
  vm.runInNewContext(project.files["app.js"], { document, TextEncoder });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  assert.deepEqual(nodes.get("qx-output").children.filter(node => /^h[1-6]$/.test(node.tag)).map(node => node.tag), ["h1", "h2"]);
  assert.equal(project.metadata.uiRegistryReleases.length, 2);
});

test("browser build rejects host-retired exact component pins before rendering", () => {
  const component = {
    type: "UI.HEADING", contractVersion: "1.0.0", renderer: "heading",
    props: { level: { type: "number", required: true, integer: true, minimum: 1, maximum: 6 } },
    children: { text: true, components: [] }
  };
  const registry = createUIComponentRegistry({
    snapshots: [{ registryRelease: "ui-registry-retired", components: [component] }]
  });
  const pin = registry.resolve("UI.HEADING", "1.0.0", "ui-registry-retired");
  const lifecycleRegistry = createUIComponentLifecycleRegistry({
    registry,
    lifecycle: [{
      registryRelease: pin.registryRelease, type: pin.type, contractVersion: pin.contractVersion,
      schemaDigest: pin.schemaDigest, lifecycle: "retired", supported: true
    }],
    hostPolicy: { revision: "host-policy-2", status: "available", entries: [] }
  });
  const uiLock = {
    schema: "QX.UI.COMPONENT-LOCK", version: "1.0",
    components: [{ type: pin.type, contractVersion: pin.contractVersion,
      schemaDigest: pin.schemaDigest, registryRelease: pin.registryRelease }]
  };
  assert.throws(
    () => buildWebProject('UI.TREE("{}")', { uiLock, uiLifecycleRegistry: lifecycleRegistry }),
    error => error instanceof QXWebBuildError &&
      error.code === "QX_WEB_UI_LOCK_INVALID" &&
      error.diagnostics[0].code === "QX_UI_RELEASE_RETIRED"
  );
});


test("browser build preserves deprecated-but-supported exact pins with a warning", () => {
  const component = {
    type: "UI.HEADING", contractVersion: "1.0.0", renderer: "heading",
    props: { level: { type: "number", required: true, integer: true, minimum: 1, maximum: 6 } },
    children: { text: true, components: [] }
  };
  const registry = createUIComponentRegistry({
    snapshots: [{ registryRelease: "ui-registry-deprecated", components: [component] }]
  });
  const pin = registry.resolve("UI.HEADING", "1.0.0", "ui-registry-deprecated");
  const lifecycleRegistry = createUIComponentLifecycleRegistry({
    registry,
    lifecycle: [{
      registryRelease: pin.registryRelease, type: pin.type, contractVersion: pin.contractVersion,
      schemaDigest: pin.schemaDigest, lifecycle: "deprecated", supported: true,
      deprecation: "Use the next reviewed heading release when ready"
    }],
    hostPolicy: { revision: "host-policy-deprecated-1", status: "available", entries: [] }
  });
  const uiLock = {
    schema: "QX.UI.COMPONENT-LOCK", version: "1.0",
    components: [{ type: pin.type, contractVersion: pin.contractVersion,
      schemaDigest: pin.schemaDigest, registryRelease: pin.registryRelease }]
  };
  const project = buildWebProject('UI.TREE("{}")', { uiLock, uiLifecycleRegistry: lifecycleRegistry });
  assert.equal(project.metadata.uiWarnings.length, 1);
  assert.equal(project.metadata.uiWarnings[0].code, "QX_UI_RELEASE_DEPRECATED");
  assert.equal(project.metadata.uiRegistryReleases[0].lifecycle, "deprecated");
});
