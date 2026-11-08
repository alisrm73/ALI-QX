import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildWebProject } from "../src/web-backend.js";

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
