import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { buildWebProject } from "../src/web-backend.js";

const project = buildWebProject([
  "DATA.CREATE(total, 4 + 5)",
  "PROCESS.CALCULATE(total, total * 2)"
].join("\n"), { title: "QX Browser Smoke Test" });
const types = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8" };
const server = http.createServer((request, response) => {
  const name = request.url === "/" ? "index.html" : request.url.slice(1);
  if (!Object.hasOwn(types, name)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": types[name], "x-content-type-options": "nosniff" });
  response.end(project.files[name]);
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("qx-status")?.textContent === "Execution completed");
  const result = await page.locator(".qx-value").evaluateAll(nodes => nodes.map(node => ({
    name: node.querySelector("h2").textContent,
    value: node.querySelector("pre").textContent
  })));
  assert.deepEqual(result, [{ name: "total", value: "18" }]);
  console.log("Phase 5 Chromium smoke test passed: QIR executed and result rendered.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
