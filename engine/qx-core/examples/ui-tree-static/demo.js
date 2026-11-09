import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  analyze,
  buildWebProject,
  lowerToQIR,
  parse,
  runQIR,
  validateQIR,
  validateUIComponentTree
} from "../../src/index.js";

const exampleDirectory = new URL("./", import.meta.url);

export async function runDemo() {
  const [treeJson, lockJson] = await Promise.all([
    readFile(new URL("tree.json", exampleDirectory), "utf8"),
    readFile(new URL("qx.ui-lock.json", exampleDirectory), "utf8")
  ]);
  const uiLock = JSON.parse(lockJson);
  const source = `UI.TREE(${JSON.stringify(treeJson)})`;

  const ast = parse(source);
  const semantic = analyze(ast);
  if (!semantic.valid) {
    throw new Error("QX semantic validation failed: " + JSON.stringify(semantic.diagnostics));
  }

  const qir = lowerToQIR(ast, semantic);
  const qirDiagnostics = validateQIR(qir);
  if (qirDiagnostics.length) {
    throw new Error("QIR validation failed: " + JSON.stringify(qirDiagnostics));
  }

  const vmResult = runQIR(qir, { uiLock });
  const webProject = buildWebProject(source, {
    title: "QX Static UI Tree Demo",
    uiLock
  });

  const invalidTree = JSON.parse(treeJson);
  invalidTree.unexpected = true;
  let invalidTreeRejected = false;
  try {
    validateUIComponentTree(invalidTree, uiLock);
  } catch (error) {
    invalidTreeRejected = error.code === "QX_UI_TREE_INVALID";
  }
  if (!invalidTreeRejected) throw new Error("Invalid UI tree was not rejected");

  let invalidLockRejected = false;
  try {
    runQIR(qir, { uiLock: { ...uiLock, components: [] } });
  } catch (error) {
    invalidLockRejected = error.code === "QX_UI_LOCK_MISSING";
  }
  if (!invalidLockRejected) throw new Error("Invalid UI lock was not rejected");

  return {
    source,
    uiLock,
    qir,
    vmResult,
    webProject,
    negativeChecks: { invalidTreeRejected, invalidLockRejected }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDemo();
  console.log("QX UI tree demo passed");
  console.log("QIR version:", result.qir.version);
  console.log("VM outputs:", result.vmResult.outputs.map(output => output.component).join(", "));
  console.log("Browser assets:", Object.keys(result.webProject.files).join(", "));
}
