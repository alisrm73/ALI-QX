import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultUILock } from "../src/index.js";
import { runDemo } from "../examples/ui-tree-static/demo.js";

test("static UI tree example validates, executes in the VM, and builds browser assets", async () => {
  const result = await runDemo();

  assert.equal(result.qir.version, "1.4");
  assert.deepEqual(result.uiLock, createDefaultUILock());
  assert.deepEqual(result.vmResult.outputs.map(output => output.component), ["TREE"]);
  assert.deepEqual(result.negativeChecks, {
    invalidTreeRejected: true,
    invalidLockRejected: true
  });
  assert.equal(result.vmResult.outputs[0].tree.children[0].type, "UI.CONTAINER");
  assert.equal(result.vmResult.outputs[0].tree.children[0].children[0].type, "UI.HEADING");
  assert.deepEqual(Object.keys(result.webProject.files).sort(), ["app.js", "index.html", "styles.css"]);
  assert.match(result.webProject.files["app.js"], /createElement/);
});
