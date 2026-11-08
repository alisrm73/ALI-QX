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
