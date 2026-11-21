import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import { createBuildPlan } from "../src/build-plan.js";
import { openProjectWorkspace, readProjectFile } from "../src/project-workspace.js";
import { runProjectBuildWorkflow } from "../src/project-build-workflow.js";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qx-project-workflow-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, "dist"));
  const draft = createProjectDraft({
    projectId: "workflow-demo",
    title: "Workflow Demo",
    description: "A generated static website",
    requirements: ["Display the project overview"],
    pages: [{ id: "home", title: "Home", description: "Welcome to the demo" }]
  });
  const reviewed = submitProjectForReview(draft).project;
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
  const writePermissions = [
    "dist/index.html", "dist/styles.css", "dist/app.js"
  ].map(relativePath => ({
    operation: "write",
    relativePath,
    approvedProjectDigest: project.digest,
    mode: "create"
  }));
  const testCases = [{
    id: "project.static-web-smoke",
    level: "project",
    title: "Generated static website smoke test",
    required: true,
    artifactIds: ["web-index", "web-css", "web-app"]
  }];
  return { project, buildPlan, workspace, writePermissions, testCases };
}

test("runs approved manifest through generation, web build, protected writes, tests, and delivery", async t => {
  const { project, buildPlan, workspace, writePermissions, testCases } = await fixture(t);
  const result = await runProjectBuildWorkflow({
    workspace,
    project,
    expectedProjectDigest: project.digest,
    buildPlan,
    writePermissions,
    testCases,
    executeTest: async ({ fileDigests }) => {
      for (const relativePath of ["dist/index.html", "dist/styles.css", "dist/app.js"]) {
        const file = await readProjectFile(workspace, {
          project,
          expectedProjectDigest: project.digest,
          relativePath
        });
        assert.equal(file.contentDigest, fileDigests[relativePath]);
        assert.ok(file.size > 0);
      }
      const html = await readProjectFile(workspace, {
        project, expectedProjectDigest: project.digest, relativePath: "dist/index.html"
      });
      assert.match(html.content.toString("utf8"), /Workflow Demo/);
      return { status: "passed", summary: "All generated web assets exist and match their recorded digests" };
    }
  });

  assert.equal(result.testReport.status, "passed");
  assert.equal(result.delivery.report.status, "ready");
  assert.ok(result.delivery.package);
  assert.equal(result.delivery.package.files.length, 3);
  assert.equal(result.status, "requires_requirement_review");
  assert.equal(result.generated.unmappedRequirements.length, 1);
  assert.deepEqual(result.writes.map(item => item.relativePath), [
    "dist/index.html", "dist/styles.css", "dist/app.js"
  ]);
});

test("rejects incomplete or extra write permissions before modifying the workspace", async t => {
  const { project, buildPlan, workspace, writePermissions, testCases } = await fixture(t);
  await assert.rejects(runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: project.digest, buildPlan,
    writePermissions: writePermissions.slice(0, 2),
    testCases, executeTest: async () => ({ status: "passed", summary: "not reached" })
  }), { code: "QX_WORKSPACE_PERMISSION_REQUIRED" });
  await assert.rejects(readProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "dist/index.html"
  }), { code: "QX_WORKSPACE_FILE_MISSING" });
});

test("rejects a build plan for another project and invalid permissions before writes", async t => {
  const { project, buildPlan, workspace, writePermissions, testCases } = await fixture(t);
  const otherDraft = createProjectDraft({
    projectId: "different-workflow-project",
    title: "Other Project",
    description: "A different approved project",
    requirements: ["Display an overview"],
    pages: [{ id: "home", title: "Other Home" }]
  });
  const otherReviewed = submitProjectForReview(otherDraft).project;
  const otherProject = approveProjectDraft(otherReviewed, {
    approvedDigest: otherReviewed.digest
  });
  const otherPlan = createBuildPlan(otherProject, {
    externalInputs: ["approved-manifest"],
    tasks: [{
      id: "static-web-build",
      dependsOn: [],
      inputs: ["approved-manifest"],
      outputs: ["web-index", "web-css", "web-app"]
    }]
  });

  await assert.rejects(runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: project.digest,
    buildPlan: otherPlan, writePermissions, testCases,
    executeTest: async () => ({ status: "passed", summary: "not reached" })
  }), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });

  const incompletePlan = createBuildPlan(project, {
    externalInputs: ["approved-manifest"],
    tasks: [{
      id: "incomplete-web-build",
      dependsOn: [],
      inputs: ["approved-manifest"],
      outputs: ["web-index", "web-css"]
    }]
  });
  await assert.rejects(runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: project.digest,
    buildPlan: incompletePlan, writePermissions, testCases,
    executeTest: async () => ({ status: "passed", summary: "not reached" })
  }), { code: "QX_PROJECT_WORKFLOW_PLAN_INVALID" });

  const duplicatePermissions = [
    writePermissions[0],
    writePermissions[0],
    writePermissions[2]
  ];
  await assert.rejects(runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: project.digest,
    buildPlan, writePermissions: duplicatePermissions, testCases,
    executeTest: async () => ({ status: "passed", summary: "not reached" })
  }), { code: "QX_WORKSPACE_PERMISSION_REQUIRED" });

  const unexpectedPermission = writePermissions.map((permission, index) =>
    index === 0 ? { ...permission, unapprovedField: true } : permission
  );
  await assert.rejects(runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: project.digest,
    buildPlan, writePermissions: unexpectedPermission, testCases,
    executeTest: async () => ({ status: "passed", summary: "not reached" })
  }), { code: "QX_WORKSPACE_PERMISSION_REQUIRED" });

  const wrongDigestPermissions = writePermissions.map(permission => ({
    ...permission,
    approvedProjectDigest: "sha256:" + "0".repeat(64)
  }));
  await assert.rejects(runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: project.digest,
    buildPlan, writePermissions: wrongDigestPermissions, testCases,
    executeTest: async () => ({ status: "passed", summary: "not reached" })
  }), { code: "QX_WORKSPACE_PERMISSION_REQUIRED" });

  await assert.rejects(readProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "dist/index.html"
  }), { code: "QX_WORKSPACE_FILE_MISSING" });
});

test("blocks delivery when a required project test fails", async t => {
  const { project, buildPlan, workspace, writePermissions, testCases } = await fixture(t);
  const result = await runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: project.digest, buildPlan,
    writePermissions, testCases,
    executeTest: async () => ({ status: "failed", summary: "Expected content was not present", reason: "Content assertion failed" })
  });
  assert.equal(result.testReport.status, "failed");
  assert.equal(result.delivery.report.status, "blocked");
  assert.equal(result.delivery.package, null);
  assert.equal(result.status, "blocked");
});

test("rejects stale project approval before writing any generated assets", async t => {
  const { project, buildPlan, workspace, writePermissions, testCases } = await fixture(t);
  await assert.rejects(runProjectBuildWorkflow({
    workspace, project, expectedProjectDigest: "sha256:" + "0".repeat(64),
    buildPlan, writePermissions, testCases,
    executeTest: async () => ({ status: "passed", summary: "not reached" })
  }), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
  await assert.rejects(readProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "dist/index.html"
  }), { code: "QX_WORKSPACE_FILE_MISSING" });
});


test("integrates the smart runner and preserves the legacy test report for delivery", async t => {
  const { project, buildPlan, workspace, writePermissions, testCases } = await fixture(t);
  const result = await runProjectBuildWorkflow({
    workspace,
    project,
    expectedProjectDigest: project.digest,
    buildPlan,
    writePermissions,
    testCases,
    testCapabilities: ["project"],
    testExecutors: {
      project: async ({ testCase, fileDigests, signal }) => {
        assert.equal(testCase.id, "project.static-web-smoke");
        assert.ok(fileDigests["dist/index.html"]);
        assert.equal(signal.aborted, false);
        return { status: "passed", summary: "Smart project smoke test passed" };
      }
    }
  });
  assert.equal(result.testReport.status, "passed");
  assert.equal(result.smartTestReport.status, "passed");
  assert.equal(result.delivery.report.status, "ready");
  assert.equal(result.status, "requires_requirement_review");
});

test("blocks delivery when a required smart test capability is unavailable", async t => {
  const { project, buildPlan, workspace, writePermissions, testCases } = await fixture(t);
  const result = await runProjectBuildWorkflow({
    workspace,
    project,
    expectedProjectDigest: project.digest,
    buildPlan,
    writePermissions,
    testCases,
    testCapabilities: [],
    testExecutors: {}
  });
  assert.equal(result.testReport.status, "incomplete");
  assert.equal(result.smartTestReport.status, "incomplete");
  assert.equal(result.delivery.report.status, "blocked");
  assert.equal(result.delivery.package, null);
  assert.equal(result.status, "blocked");
  assert.ok(result.delivery.report.issues.some(issue =>
    issue.code === "QX_DELIVERY_ADDITIONAL_BLOCKER"
  ));
});
