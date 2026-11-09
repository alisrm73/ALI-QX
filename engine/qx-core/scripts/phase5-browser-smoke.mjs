import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { buildWebProject } from "../src/web-backend.js";
import { runDemo } from "../examples/ui-tree-static/demo.js";

const project = buildWebProject([
  "DATA.CREATE(total, 4 + 5)",
  "PROCESS.CALCULATE(total, total * 2)",
  "DATA.CREATE(label, \"<img src=x onerror=alert(1)>\")"
].join("\n"), { title: "QX Browser Smoke Test" });
const errorProject = buildWebProject("DATA.CREATE(value, 4 / 0)", { title: "QX Browser Error Test" });
const uiTreeDemo = await runDemo();
const types = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8" };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const isUITree = url.pathname.startsWith("/ui-tree/");
  const isError = url.pathname.startsWith("/error/");
  const assets = isUITree ? uiTreeDemo.webProject.files : isError ? errorProject.files : project.files;
  const assetPath = isUITree ? url.pathname.slice("/ui-tree".length) : isError ? url.pathname.slice("/error".length) : url.pathname;
  const name = assetPath === "/" ? "index.html" : assetPath.slice(1);
  if (!Object.hasOwn(types, name)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": types[name], "x-content-type-options": "nosniff" });
  response.end(assets[name]);
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("qx-status")?.textContent === "Ready to run");
  assert.equal(await page.locator(".qx-value").count(), 0, "QX must not execute before the user presses the button");
  await page.getByRole("button", { name: "Run QX program" }).click();
  await page.waitForFunction(() => document.getElementById("qx-status")?.textContent === "Execution completed");
  const result = await page.locator(".qx-value").evaluateAll(nodes => nodes.map(node => ({
    name: node.querySelector("h2").textContent,
    value: node.querySelector("pre").textContent
  })));
  assert.deepEqual(result, [{ name: "total", value: "18" }, { name: "label", value: '\"<img src=x onerror=alert(1)>\"' }]);
  assert.equal(await page.locator("#qx-output img").count(), 0);
  await page.getByRole("button", { name: "Run QX program" }).click();
  assert.equal(await page.locator(".qx-value").count(), 2, "re-running must replace previous output instead of duplicating it");

  await page.goto("http://127.0.0.1:" + server.address().port + "/error/", { waitUntil: "load" });
  await page.getByRole("button", { name: "Run QX program" }).click();
  await page.waitForFunction(() => document.getElementById("qx-status")?.textContent === "Execution failed");
  assert.match(await page.locator(".qx-error").textContent(), /QX_VM_DIVIDE_BY_ZERO/);

  await page.goto("http://127.0.0.1:" + server.address().port + "/ui-tree/", { waitUntil: "load" });
  await page.getByRole("button", { name: "Run QX program" }).click();
  await page.waitForFunction(() => document.getElementById("qx-status")?.textContent === "Execution completed");
  const uiTreeResult = await page.locator("#qx-output").evaluate(root => ({
    containerCount: root.querySelectorAll(".qx-ui-container").length,
    heading: root.querySelector(".qx-ui-heading")?.textContent,
    paragraph: root.querySelector(".qx-ui-text-block")?.textContent,
    scriptCount: root.querySelectorAll("script").length
  }));
  assert.deepEqual(uiTreeResult, {
    containerCount: 1,
    heading: "Welcome to QX",
    paragraph: "This page is rendered from a validated, version-pinned UI component tree.",
    scriptCount: 0
  });
  console.log("Phase 5 Chromium interaction test passed: no auto-run, button execution, repeat execution, and visible runtime errors.");
  console.log("Phase 6 Chromium UI.TREE smoke test passed: pinned static components rendered.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
