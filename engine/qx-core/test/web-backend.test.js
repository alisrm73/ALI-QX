import test from "node:test";
import assert from "node:assert/strict";
import { buildWebProject, generateWebAssets, QXWebBuildError } from "../src/web-backend.js";
import { parse } from "../src/parser.js";
import { analyze } from "../src/semantic-analyzer.js";
import { lowerToQIR } from "../src/qir.js";

test("builds deterministic assets from valid QX source", () => {
  const source='DATA.CREATE(total, 4 + 5)\nPROCESS.CALCULATE(total, total * 2)';
  const a=buildWebProject(source,{title:"QX Demo"}), b=buildWebProject(source,{title:"QX Demo"});
  assert.deepEqual(Object.keys(a.files).sort(),["app.js","index.html","styles.css"]);
  assert.equal(a.files["app.js"],b.files["app.js"]);
  assert.equal(a.files["index.html"],b.files["index.html"]);
  assert.match(a.files["app.js"],/"opcode":"BINARY"/);
  assert.match(a.files["index.html"],/Content-Security-Policy/);
  assert.equal(a.metadata.networkAccess,false);
});

test("uses safe text rendering and avoids dynamic code and network APIs",()=>{
  const p=buildWebProject('DATA.CREATE(label, "<script>")');
  assert.match(p.files["app.js"],/textContent/);
  assert.doesNotMatch(p.files["app.js"],/\beval\s*\(|new Function|fetch\s*\(|XMLHttpRequest/);
  assert.match(p.files["index.html"],/default-src 'none'/);
});

test("escapes title in generated HTML",()=>{
  const p=buildWebProject("DATA.CREATE(value, 1)",{title:'<img src=x onerror="alert(1)">'});
  assert.doesNotMatch(p.files["index.html"],/<h1><img/);
  assert.match(p.files["index.html"],/&lt;img/);
});

test("rejects semantically invalid QX source",()=>{
  assert.throws(()=>buildWebProject("DATA.CREATE(value, missing)"),
    e=>e instanceof QXWebBuildError&&e.code==="QX_WEB_SEMANTIC_ERROR"&&e.diagnostics.length>0);
});

test("rejects invalid QIR before generating assets",()=>{
  const ast=parse("DATA.CREATE(value, 1)"), qir=lowerToQIR(ast,analyze(ast));
  qir.initializer.blocks[0].instructions[0].opcode="HOST_ACCESS";
  assert.throws(()=>generateWebAssets(qir),e=>e instanceof QXWebBuildError&&e.code==="QX_WEB_INVALID_QIR");
});

test("rejects oversized titles",()=>{
  assert.throws(()=>buildWebProject("DATA.CREATE(value, 1)",{title:"x".repeat(121)}),
    e=>e instanceof QXWebBuildError&&e.code==="QX_WEB_INVALID_TITLE");
});
