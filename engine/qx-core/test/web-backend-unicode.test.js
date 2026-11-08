import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildWebProject } from "../src/web-backend.js";

test("browser runtime uses the pinned Unicode combining-class table for NFC equality", () => {
  const project = buildWebProject('DATA.CREATE(equal, "é" == "é")');
  const makeNode = () => ({ children: [], textContent: "", className: "", append(...items) { this.children.push(...items); } });
  const nodes = new Map([["qx-output", makeNode()], ["qx-status", makeNode()]]);
  const document = { getElementById: id => nodes.get(id), createElement: () => makeNode() };
  vm.runInNewContext(project.files["app.js"], { document });
  assert.equal(nodes.get("qx-status").textContent, "Execution completed");
  const section = nodes.get("qx-output").children.find(node => node.className === "qx-value");
  assert.equal(section.children[0].textContent, "equal");
  assert.equal(section.children[1].textContent, "true");
  assert.match(project.files["app.js"], /combiningClasses/);
});
