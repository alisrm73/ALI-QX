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
import { createProjectDeliveryPackage } from "../src/project-delivery.js";
import {
  exportProjectDeliveryPackage, PROJECT_EXPORT_LIMITS
} from "../src/project-export.js";
import { createProjectDeliveryPackage } from "../src/project-delivery.js";

function sha(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qx-export-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "workspace");
  const output = path.join(temp, "output");
  await fs.mkdir(root);
  await fs.mkdir(output);
  const draft = createProjectDraft({
    projectId: "export-demo", title: "Export demo", description: "Verified export fixture",
    requirements: ["The page is available"], pages: [{ id: "home", title: "Home" }]
  });
  const ready = submitProjectForReview(draft).project;
  const project = approveProjectDraft(ready, { approvedDigest: ready.digest });
  const plan = createBuildPlan(project, {
    externalInputs: ["source"],
    tasks: [{ id: "build", dependsOn: [], inputs: ["source"], outputs: ["site"] }]
  });
  const workspace = await openProjectWorkspace({ root, projectId: project.projectId });
  const content = Buffer.from("<!doctype html><title>Export</title>", "utf8");
  await fs.mkdir(path.join(root, "dist"));
  await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest,
    relativePath: "dist/index.html", content,
    permission: {
      operation: "write", relativePath: "dist/index.html",
      approvedProjectDigest: project.digest, mode: "create"
    }
  });
  const testReport = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    fileDigests: { "dist/index.html": sha(content) },
    testCases: [{
      id: "project.smoke", level: "project", title: "Smoke test",
      required: true, artifactIds: ["site"]
    }],
    executeTest: async () => ({ status: "passed", summary: "Passed" })
  });
  const delivery = await createProjectDeliveryPackage(workspace, project, plan, testReport, {
    expectedProjectDigest: project.digest,
    deliverables: [{ path: "dist/index.html", required: true }]
  });
  const destinationPath = path.join(output, "export.qxpackage.json");
  const permission = {
    operation: "export",
    destinationPath,
    approvedProjectDigest: project.digest,
    packageDigest: delivery.package.digest,
    mode: "create"
  };
  return { temp, root, output, workspace, project, plan, testReport, delivery, destinationPath, permission };
}

test("exports a verified package and confirms the written bytes and digest", async t => {
  const f = await fixture(t);
  const result = await exportProjectDeliveryPackage({
    project: f.project, plan: f.plan, testReport: f.testReport,
    deliveryReport: f.delivery.report, packageValue: f.delivery.package,
    destinationPath: f.destinationPath, permission: f.permission
  });
  assert.equal(result.status, "exported");
  assert.equal(result.packageDigest, f.delivery.package.digest);
  assert.equal(result.fileDigest, sha(await fs.readFile(f.destinationPath)));
  assert.equal(JSON.parse(await fs.readFile(f.destinationPath, "utf8")).digest, f.delivery.package.digest);
  assert.equal(result.size, (await fs.stat(f.destinationPath)).size);
});

test("rejects missing or mismatched permission without creating a file", async t => {
  const f = await fixture(t);
  await assert.rejects(exportProjectDeliveryPackage({
    project: f.project, plan: f.plan, testReport: f.testReport,
    deliveryReport: f.delivery.report, packageValue: f.delivery.package,
    destinationPath: f.destinationPath, permission: { ...f.permission, destinationPath: f.destinationPath + ".other" }
  }), { code: "QX_EXPORT_PERMISSION_REQUIRED" });
  await assert.rejects(fs.stat(f.destinationPath), { code: "ENOENT" });
});

test("never overwrites an existing destination", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.destinationPath, "keep-me");
  await assert.rejects(exportProjectDeliveryPackage({
    project: f.project, plan: f.plan, testReport: f.testReport,
    deliveryReport: f.delivery.report, packageValue: f.delivery.package,
    destinationPath: f.destinationPath, permission: f.permission
  }), { code: "QX_EXPORT_TARGET_EXISTS" });
  assert.equal(await fs.readFile(f.destinationPath, "utf8"), "keep-me");
});

test("rejects blocked delivery, unsafe paths, and symbolic-link parents", async t => {
  const f = await fixture(t);
  const blocked = await createProjectDeliveryPackage(f.workspace, f.project, f.plan, f.testReport, {
    expectedProjectDigest: f.project.digest,
    deliverables: [{ path: "dist/not-present.html", required: true }]
  });
  await assert.rejects(exportProjectDeliveryPackage({
    project: f.project, plan: f.plan, testReport: f.testReport,
    deliveryReport: blocked.report, packageValue: f.delivery.package,
    destinationPath: f.destinationPath, permission: f.permission
  }), { code: "QX_EXPORT_BLOCKED" });
  await assert.rejects(exportProjectDeliveryPackage({
    project: f.project, plan: f.plan, testReport: f.testReport,
    deliveryReport: f.delivery.report, packageValue: f.delivery.package,
    destinationPath: f.output + "/../escape.json", permission: f.permission
  }), { code: "QX_EXPORT_PATH_INVALID" });
  const link = path.join(f.temp, "output-link");
  await fs.symlink(f.output, link, "dir");
  const linkedDestination = path.join(link, "linked.json");
  await assert.rejects(exportProjectDeliveryPackage({
    project: f.project, plan: f.plan, testReport: f.testReport,
    deliveryReport: f.delivery.report, packageValue: f.delivery.package,
    destinationPath: linkedDestination,
    permission: { ...f.permission, destinationPath: linkedDestination }
  }), { code: "QX_EXPORT_PATH_UNSAFE" });
});

test("declares bounded, create-only export behavior", () => {
  assert.equal(PROJECT_EXPORT_LIMITS.overwrite, false);
  assert.equal(PROJECT_EXPORT_LIMITS.requiresExistingParent, true);
  assert.equal(PROJECT_EXPORT_LIMITS.maxBytes, 70 * 1024 * 1024);
});
