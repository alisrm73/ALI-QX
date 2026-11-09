import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import { createBuildPlan } from "../src/build-plan.js";
import {
  runProjectTestSuite, assertProjectTestReport
} from "../src/project-test-suite.js";

function approvedProject() {
  const draft = createProjectDraft({
    projectId: "test-suite-demo", title: "Test suite demo", description: "Project test report fixture",
    requirements: ["The home page renders"], pages: [{ id: "home", title: "Home" }]
  });
  const ready = submitProjectForReview(draft).project;
  return approveProjectDraft(ready, { approvedDigest: ready.digest });
}

function fixture() {
  const project = approvedProject();
  const plan = createBuildPlan(project, {
    externalInputs: ["source"],
    tasks: [
      { id: "compile", dependsOn: [], inputs: ["source"], outputs: ["compiled"] },
      { id: "bundle", dependsOn: ["compile"], inputs: ["compiled"], outputs: ["bundle"] },
      { id: "publish", dependsOn: ["bundle"], inputs: ["bundle"], outputs: ["site"] }
    ]
  });
  const testCases = [
    { id: "component.home", level: "component", title: "Home component renders", required: true, artifactIds: ["compiled"] },
    { id: "contract.bundle", level: "contract", title: "Bundle contract is valid", required: true, artifactIds: ["bundle"] },
    { id: "integration.site", level: "integration", title: "Static assets integrate", required: true, artifactIds: ["site"] },
    { id: "project.acceptance", level: "project", title: "Project acceptance checks", required: true, artifactIds: ["site"] },
    { id: "flow.home", level: "user_flow", title: "Home user flow works", required: false, artifactIds: ["site"] },
    { id: "flow.settings", level: "user_flow", title: "Settings flow works", required: false, artifactIds: ["bundle"] }
  ];
  return { project, plan, testCases };
}

test("runs all test levels in stable order and binds report to project, plan, and file digests", async () => {
  const { project, plan, testCases } = fixture();
  const calls = [];
  const report = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    fileDigests: { "dist/app.js": "sha256:" + "a".repeat(64) },
    executeTest: async ({ testCase, project: contextProject, buildPlan, fileDigests }) => {
      calls.push(testCase.id);
      assert.equal(contextProject.digest, project.digest);
      assert.equal(buildPlan.digest, plan.digest);
      assert.ok(fileDigests["dist/app.js"]);
      return { status: "passed", summary: "Assertions passed" };
    }
  });
  assert.deepEqual(calls, testCases.map(item => item.id).sort());
  assert.equal(report.status, "passed");
  assert.deepEqual(report.summary, {
    total: 6, selected: 6, passed: 6, failed: 0, skipped: 0, notRun: 0, requiredUnsuccessful: 0
  });
  assert.equal(report.projectDigest, project.digest);
  assert.equal(report.buildPlanDigest, plan.digest);
  assert.equal(assertProjectTestReport(project, plan, report), report);
});

test("affected scope runs required tests and tests linked to changed artifacts", async () => {
  const { project, plan, testCases } = fixture();
  const calls = [];
  const report = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    scope: "affected",
    changedArtifactIds: ["compiled"],
    executeTest: async ({ testCase }) => {
      calls.push(testCase.id);
      return { status: "passed", summary: "Affected test passed" };
    }
  });
  assert.deepEqual(calls, ["component.home", "contract.bundle", "integration.site", "project.acceptance"]);
  assert.equal(report.summary.notRun, 2);
  assert.equal(report.results.find(item => item.testId === "flow.home").status, "not_run");
  assert.equal(report.status, "passed");
});

test("required skipped tests make the report incomplete; optional skipped tests remain visible", async () => {
  const { project, plan, testCases } = fixture();
  const report = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    executeTest: async ({ testCase }) => ({
      status: "skipped",
      summary: "Environment capability unavailable",
      reason: "This test needs a browser host"
    })
  });
  assert.equal(report.summary.skipped, 6);
  assert.equal(report.summary.requiredUnsuccessful, 4);
  assert.equal(report.status, "incomplete");
});

test("captures assertion failures and thrown executor errors without hiding them", async () => {
  const { project, plan, testCases } = fixture();
  const report = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    testCases: testCases.slice(0, 2),
    executeTest: async ({ testCase }) => {
      if (testCase.id === "component.home") {
        return { status: "failed", summary: "Expected heading was missing", reason: "heading mismatch" };
      }
      throw Object.assign(new Error("integration crashed"), { code: "E_TEST" });
    }
  });
  assert.equal(report.status, "failed");
  assert.equal(report.summary.failed, 2);
  assert.equal(report.results[0].error.message, "heading mismatch");
  assert.equal(report.results[1].error.code, "E_TEST");
});

test("rejects stale approvals, unknown artifacts, and missing executor", async () => {
  const { project, plan, testCases } = fixture();
  await assert.rejects(runProjectTestSuite(project, plan, {
    expectedProjectDigest: "sha256:stale", testCases,
    executeTest: async () => ({ status: "passed", summary: "ok" })
  }), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
  await assert.rejects(runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    testCases: [{ id: "bad.test", level: "component", title: "Unknown", required: true, artifactIds: ["not-in-plan"] }],
    executeTest: async () => ({ status: "passed", summary: "ok" })
  }), { code: "QX_TEST_REPORT_UNKNOWN_ARTIFACT" });
  await assert.rejects(runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest, testCases
  }), { code: "QX_TEST_EXECUTOR_REQUIRED" });
});

test("rejects malformed test levels, duplicate IDs, unsafe file paths, and invalid executor contracts", async () => {
  const { project, plan, testCases } = fixture();
  const run = options => runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest, testCases, ...options
  });
  await assert.rejects(run({
    testCases: [{ ...testCases[0], level: "smoke" }],
    executeTest: async () => ({ status: "passed", summary: "ok" })
  }), { code: "QX_TEST_REPORT_INVALID" });
  await assert.rejects(run({
    testCases: [testCases[0], testCases[0]],
    executeTest: async () => ({ status: "passed", summary: "ok" })
  }), { code: "QX_TEST_REPORT_INVALID" });
  await assert.rejects(run({
    fileDigests: { "../outside": "sha256:" + "a".repeat(64) },
    executeTest: async () => ({ status: "passed", summary: "ok" })
  }), { code: "QX_TEST_REPORT_INVALID" });
  const report = await run({
    executeTest: async () => ({ status: "unknown", summary: "bad" })
  });
  assert.equal(report.summary.failed, 6);
  assert.equal(report.status, "failed");
});

test("report digest detects post-run modification and stale build plans", async () => {
  const { project, plan, testCases } = fixture();
  const report = await runProjectTestSuite(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    executeTest: async () => ({ status: "passed", summary: "ok" })
  });
  assert.throws(() => assertProjectTestReport(project, plan, {
    ...report, status: "passed", summary: { ...report.summary, failed: 1 }
  }), { code: "QX_TEST_REPORT_INVALID" });
  const otherPlan = createBuildPlan(project, {
    externalInputs: ["source"],
    tasks: [{ id: "compile", dependsOn: [], inputs: ["source"], outputs: ["compiled"] }]
  });
  assert.throws(() => assertProjectTestReport(project, otherPlan, report), {
    code: "QX_TEST_REPORT_INVALID"
  });
});
