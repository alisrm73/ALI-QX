import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft,
  createBuildPlan, openProjectWorkspace, readProjectFile,
  runProjectBuildWorkflow
} from "../src/index.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qx-phase7-browser-"));
let browser;
let server;
try {
  const root = path.join(temp, "project");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  const draft = createProjectDraft({
    projectId: "phase7-browser-acceptance",
    title: "Phase 7 Acceptance Site",
    description: "A small static website generated from an approved structured project brief.",
    requirements: ["Display the project overview"],
    pages: [{ id: "home", title: "Project Overview", description: "The approved project content is visible." }]
  });
  const reviewed = submitProjectForReview(draft).project;
  assert.equal(reviewed.status, "ready_for_review");
  const project = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const buildPlan = createBuildPlan(project, {
    externalInputs: ["approved-manifest"],
    tasks: [{
      id: "static-web-build",
      dependsOn: [],
      inputs: ["approved-manifest"],
      outputs: ["web-index", "web-css", "web-app"]
    }]
  });
  const workspace = await openProjectWorkspace({ root, projectId: project.projectId });
  const outputPaths = ["dist/index.html", "dist/styles.css", "dist/app.js"];
  const writePermissions = outputPaths.map(relativePath => ({
    operation: "write",
    relativePath,
    approvedProjectDigest: project.digest,
    mode: "create"
  }));
  const testCases = [
    { id: "component.static-ui", level: "component", title: "Static UI component output", required: true, artifactIds: ["web-index", "web-app"] },
    { id: "contract.asset-links", level: "contract", title: "HTML asset contract", required: true, artifactIds: ["web-index", "web-css", "web-app"] },
    { id: "integration.web-assets", level: "integration", title: "Generated asset integration", required: true, artifactIds: ["web-index", "web-css", "web-app"] },
    { id: "project.approved-content", level: "project", title: "Approved project content", required: true, artifactIds: ["web-index", "web-app"] },
    { id: "user_flow.static-render", level: "user_flow", title: "Browser renders approved project", required: true, artifactIds: ["web-index", "web-app"] }
  ];
  const requirementCoverage = [{
    category: "requirement",
    requirementIndex: 0,
    acceptanceCriteria: [{
      id: "overview.visible",
      description: "The approved project overview is visible in the generated website",
      testIds: ["project.approved-content", "user_flow.static-render"],
      evidencePaths: ["dist/index.html", "dist/app.js"]
    }]
  }];

  const result = await runProjectBuildWorkflow({
    workspace,
    project,
    expectedProjectDigest: project.digest,
    buildPlan,
    writePermissions,
    testCases,
    requirementCoverage,
    executeTest: async ({ testCase, fileDigests }) => {
      const files = {};
      for (const relativePath of outputPaths) {
        const file = await readProjectFile(workspace, {
          project,
          expectedProjectDigest: project.digest,
          relativePath
        });
        assert.equal(file.contentDigest, fileDigests[relativePath]);
        assert.ok(file.size > 0);
        files[relativePath] = file.content.toString("utf8");
      }
      if (testCase.id === "component.static-ui") {
        assert.match(files["dist/app.js"], /qx-ui-heading/);
      } else if (testCase.id === "contract.asset-links") {
        assert.match(files["dist/index.html"], /styles\\.css/);
        assert.match(files["dist/index.html"], /app\\.js/);
      } else if (testCase.id === "integration.web-assets") {
        assert.ok(files["dist/index.html"].length > 0);
        assert.ok(files["dist/styles.css"].length > 0);
        assert.ok(files["dist/app.js"].length > 0);
      } else if (testCase.id === "project.approved-content") {
        assert.match(files["dist/index.html"], /Phase 7 Acceptance Site/);
        assert.match(files["dist/app.js"], /Project Overview/);
      } else if (testCase.id === "user_flow.static-render") {
        const types = {
          "index.html": "text/html; charset=utf-8",
          "app.js": "text/javascript; charset=utf-8",
          "styles.css": "text/css; charset=utf-8"
        };
        server = http.createServer((request, response) => {
          const name = request.url === "/" ? "index.html" : request.url.slice(1);
          if (!Object.hasOwn(types, name) || !Object.hasOwn(files, "dist/" + name)) {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, {
            "content-type": types[name],
            "x-content-type-options": "nosniff"
          });
          response.end(files["dist/" + name]);
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
        await page.getByRole("button", { name: "Run QX program" }).click();
        await page.getByRole("heading", { name: "Phase 7 Acceptance Site" }).waitFor();
        await page.getByRole("heading", { name: "Project Overview" }).waitFor();
        await page.getByText("The approved project content is visible.").waitFor();
      }
      return { status: "passed", summary: testCase.title + " passed against generated project assets" };
    }
  });

  assert.equal(result.testReport.status, "passed");
  assert.deepEqual(result.testReport.summary, {
    total: 5, selected: 5, passed: 5, failed: 0, skipped: 0, notRun: 0, requiredUnsuccessful: 0
  });
  assert.equal(result.delivery.report.status, "ready");
  assert.equal(result.delivery.package.files.length, 3);
  assert.equal(result.requirementCoverage.status, "covered");
  assert.equal(result.status, "ready");
  console.log("Phase 7 integrated browser acceptance passed: approved brief -> generation -> protected writes -> component/contract/integration/project/user-flow tests -> verified delivery.");
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
