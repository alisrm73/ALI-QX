import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import { createBuildPlan } from "../src/build-plan.js";
import { openProjectWorkspace, writeProjectFile } from "../src/project-workspace.js";
import { runProjectTestSuite } from "../src/project-test-suite.js";
import {
  createProjectDeliveryPackage, assertProjectDeliveryReport
} from "../src/project-delivery.js";

function sha(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qx-delivery-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, "dist"));
  const draft = createProjectDraft({
    projectId: "delivery-demo", title: "Delivery demo", description: "A verified delivery fixture",
    requirements: ["The page is available"], pages: [{ id: "home", title: "Home" }]
  });
  const ready = submitProjectForReview(draft).project;
  const project = approveProjectDraft(ready, { approvedDigest: ready.digest });
  const plan = createBuildPlan(project, {
    externalInputs: ["source"],
    tasks: [{ id: "build", dependsOn: [], inputs: ["source"], outputs: ["site"] }]
  });
  const workspace = await openProjectWorkspace({ root, projectId: project.projectId });
  const files = {
    "dist/index.html": Buffer.from("<!doctype html><title>Demo</title>", "utf8"),
    "dist/app.js": Buffer.from("console.log('demo')", "utf8")
  };
  for (const [relativePath, content] of Object.entries(files)) {
    await writeProjectFile(workspace, {
      project, expectedProjectDigest: project.digest, relativePath, content,
      permission: {
        operation: "write", relativePath, approvedProjectDigest: project.digest, mode: "create"
      }
    });
  }
  const testReport = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    fileDigests: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])),
    testCases: [{
      id: "project.smoke",
      level: "project",
      title: "Project smoke test",
      required: true,
      artifactIds: ["site"]
    }],
    executeTest: async () => ({ status: "passed", summary: "Smoke test passed" })
  });
  return { root, project, plan, workspace, files, testReport };
}

test("creates a deterministic package only after files and required tests are verified", async t => {
  const { project, plan, workspace, testReport, files } = await fixture(t);
  const result = await createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [
      { path: "dist/app.js", required: true },
      { path: "dist/index.html", required: true }
    ]
  });
  assert.equal(result.report.status, "ready");
  assert.equal(result.report.summary.included, 2);
  assert.equal(result.report.summary.requiredMissing, 0);
  assert.equal(result.report.packageDigest, result.package.digest);
  assert.equal(result.package.files.length, 2);
  assert.equal(Buffer.from(result.package.files[0].contentBase64, "base64").toString("utf8"), files["dist/app.js"].toString("utf8"));
  const serialized = JSON.parse(result.packageJson);
  assert.equal(serialized.digest, result.package.digest);
  assert.equal(assertProjectDeliveryReport(project, plan, testReport, result.report), result.report);
});

test("blocks delivery when a required file is missing but permits missing optional files", async t => {
  const { project, plan, workspace, testReport } = await fixture(t);
  const blocked = await createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [
      { path: "dist/index.html", required: true },
      { path: "dist/missing.js", required: true }
    ]
  });
  assert.equal(blocked.report.status, "blocked");
  assert.equal(blocked.package, null);
  assert.equal(blocked.packageJson, null);
  assert.equal(blocked.report.summary.requiredMissing, 1);
  assert.ok(blocked.report.issues.some(issue => issue.code === "QX_DELIVERY_REQUIRED_FILE_MISSING"));

  const optional = await createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [
      { path: "dist/index.html", required: true },
      { path: "dist/optional.js", required: false }
    ]
  });
  assert.equal(optional.report.status, "ready");
  assert.equal(optional.report.summary.missing, 1);
});

test("blocks delivery if a file changed after the test report was produced", async t => {
  const { project, plan, workspace, testReport } = await fixture(t);
  await fs.writeFile(path.join(workspace.root, "dist/index.html"), "changed after testing");
  const result = await createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [{ path: "dist/index.html", required: true }]
  });
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.summary.unverified, 1);
  assert.ok(result.report.issues.some(issue => issue.code === "QX_DELIVERY_FILE_NOT_VERIFIED"));
  assert.equal(result.package, null);
});

test("blocks delivery when required tests failed, were skipped, or were not run", async t => {
  const { project, plan, workspace, files } = await fixture(t);
  const failedReport = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    fileDigests: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])),
    testCases: [{
      id: "project.smoke", level: "project", title: "Project smoke test",
      required: true, artifactIds: ["site"]
    }],
    executeTest: async () => ({ status: "failed", summary: "Page assertion failed" })
  });
  const result = await createProjectDeliveryPackage(workspace, project, plan, failedReport, {
    expectedProjectDigest: project.digest,
    deliverables: [{ path: "dist/index.html", required: true }]
  });
  assert.equal(result.report.status, "blocked");
  assert.ok(result.report.issues.some(issue => issue.code === "QX_DELIVERY_TESTS_NOT_PASSED"));
});

test("rejects stale approvals, duplicate paths, and unsafe paths", async t => {
  const { project, plan, workspace, testReport } = await fixture(t);
  await assert.rejects(createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: "sha256:stale",
    deliverables: [{ path: "dist/index.html", required: true }]
  }), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
  await assert.rejects(createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [
      { path: "dist/index.html", required: true },
      { path: "dist/index.html", required: false }
    ]
  }), { code: "QX_DELIVERY_INVALID" });
  await assert.rejects(createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [{ path: "../outside", required: true }]
  }), { code: "QX_DELIVERY_INVALID" });
});

test("delivery report digest rejects modification and mismatched test report", async t => {
  const { project, plan, workspace, testReport } = await fixture(t);
  const result = await createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [{ path: "dist/index.html", required: true }]
  });
  assert.throws(() => assertProjectDeliveryReport(project, plan, testReport, {
    ...result.report, status: "blocked"
  }), { code: "QX_DELIVERY_INVALID" });
  const otherReport = { ...testReport, digest: "sha256:" + "0".repeat(64) };
  assert.throws(() => assertProjectDeliveryReport(project, plan, otherReport, result.report));
});
