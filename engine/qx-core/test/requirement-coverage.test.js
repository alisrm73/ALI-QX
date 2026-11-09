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
import { assertRequirementCoverageReport } from "../src/requirement-coverage.js";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qx-requirement-coverage-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, "dist"));
  const draft = createProjectDraft({
    projectId: "coverage-demo",
    title: "Coverage Demo",
    description: "A generated static website",
    requirements: ["Display the project overview"],
    pages: [{ id: "home", title: "Home", description: "Welcome" }]
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
  const executeTest = async ({ fileDigests }) => {
    for (const relativePath of ["dist/index.html", "dist/styles.css", "dist/app.js"]) {
      const file = await readProjectFile(workspace, {
        project, expectedProjectDigest: project.digest, relativePath
      });
      assert.equal(file.contentDigest, fileDigests[relativePath]);
      assert.ok(file.size > 0);
    }
    return { status: "passed", summary: "Generated assets exist and match their recorded digests" };
  };
  const requirementCoverage = [{
    category: "requirement",
    requirementIndex: 0,
    acceptanceCriteria: [{
      id: "overview.visible",
      description: "The generated page displays the project overview",
      testIds: ["project.static-web-smoke"],
      evidencePaths: ["dist/index.html"]
    }]
  }];
  return { project, buildPlan, workspace, writePermissions, testCases, executeTest, requirementCoverage };
}

test("marks workflow ready only when every requirement has passing tests and packaged evidence", async t => {
  const state = await fixture(t);
  const result = await runProjectBuildWorkflow({
    ...state,
    expectedProjectDigest: state.project.digest
  });

  assert.equal(result.testReport.status, "passed");
  assert.equal(result.delivery.report.status, "ready");
  assert.equal(result.requirementCoverage.status, "covered");
  assert.deepEqual(result.requirementCoverage.summary, {
    total: 1, covered: 1, partiallyCovered: 0, uncovered: 0, needsClarification: 0
  });
  assert.equal(result.status, "ready");
  assert.equal(assertRequirementCoverageReport(
    state.project, state.buildPlan, result.testReport, result.delivery.report,
    result.requirementCoverage
  ), result.requirementCoverage);
});

test("rejects missing requirement mappings before writing generated assets", async t => {
  const state = await fixture(t);
  await assert.rejects(runProjectBuildWorkflow({
    ...state,
    expectedProjectDigest: state.project.digest,
    requirementCoverage: []
  }), { code: "QX_REQUIREMENT_COVERAGE_INCOMPLETE" });
  await assert.rejects(readProjectFile(state.workspace, {
    project: state.project,
    expectedProjectDigest: state.project.digest,
    relativePath: "dist/index.html"
  }), { code: "QX_WORKSPACE_FILE_MISSING" });
});

test("keeps partially evidenced requirements out of ready state", async t => {
  const state = await fixture(t);
  const partial = [{
    category: "requirement",
    requirementIndex: 0,
    acceptanceCriteria: [{
      id: "overview.visible",
      description: "The generated page displays the project overview",
      testIds: ["project.static-web-smoke"],
      evidencePaths: ["dist/not-produced.html"]
    }]
  }];
  const result = await runProjectBuildWorkflow({
    ...state,
    expectedProjectDigest: state.project.digest,
    requirementCoverage: partial
  });
  assert.equal(result.requirementCoverage.entries[0].status, "partially_covered");
  assert.equal(result.requirementCoverage.status, "partially_covered");
  assert.equal(result.status, "requires_requirement_review");
});

test("marks requirements needing clarification and prevents readiness", async t => {
  const state = await fixture(t);
  const entries = [{
    category: "requirement",
    requirementIndex: 0,
    clarification: "The expected overview content needs user confirmation",
    acceptanceCriteria: [{
      id: "overview.visible",
      description: "The generated page displays the project overview",
      testIds: ["project.static-web-smoke"],
      evidencePaths: ["dist/index.html"]
    }]
  }];
  const result = await runProjectBuildWorkflow({
    ...state,
    expectedProjectDigest: state.project.digest,
    requirementCoverage: entries
  });
  assert.equal(result.requirementCoverage.entries[0].status, "needs_clarification");
  assert.equal(result.status, "requires_requirement_review");
});

test("rejects unknown or duplicate requirement references before writes", async t => {
  const state = await fixture(t);
  const entries = [
    { category: "requirement", requirementIndex: 0, acceptanceCriteria: [] },
    { category: "requirement", requirementIndex: 0, acceptanceCriteria: [] }
  ];
  await assert.rejects(runProjectBuildWorkflow({
    ...state,
    expectedProjectDigest: state.project.digest,
    requirementCoverage: entries
  }), { code: "QX_REQUIREMENT_COVERAGE_INVALID" });
  await assert.rejects(readProjectFile(state.workspace, {
    project: state.project,
    expectedProjectDigest: state.project.digest,
    relativePath: "dist/index.html"
  }), { code: "QX_WORKSPACE_FILE_MISSING" });
});


test("rejects invalid acceptance criteria before writing generated assets", async t => {
  const duplicateIds = [
    { id: "overview.visible", description: "First criterion", testIds: ["project.static-web-smoke"], evidencePaths: ["dist/index.html"] },
    { id: "overview.visible", description: "Duplicate criterion ID", testIds: ["project.static-web-smoke"], evidencePaths: ["dist/index.html"] }
  ];
  const overlongDescription = [{
    id: "overview.long-description",
    description: "x".repeat(1001),
    testIds: ["project.static-web-smoke"],
    evidencePaths: ["dist/index.html"]
  }];
  const excessiveCriteria = Array.from({ length: 1001 }, (_, index) => ({
    id: "criterion-" + index,
    description: "Criterion " + index,
    testIds: ["project.static-web-smoke"],
    evidencePaths: ["dist/index.html"]
  }));

  for (const acceptanceCriteria of [duplicateIds, overlongDescription, excessiveCriteria]) {
    const state = await fixture(t);
    const requirementCoverage = [{
      category: "requirement",
      requirementIndex: 0,
      acceptanceCriteria
    }];
    await assert.rejects(runProjectBuildWorkflow({
      ...state,
      expectedProjectDigest: state.project.digest,
      requirementCoverage
    }), { code: "QX_REQUIREMENT_COVERAGE_INVALID" });
    await assert.rejects(readProjectFile(state.workspace, {
      project: state.project,
      expectedProjectDigest: state.project.digest,
      relativePath: "dist/index.html"
    }), { code: "QX_WORKSPACE_FILE_MISSING" });
  }
});
