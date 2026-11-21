import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import { createBuildPlan } from "../src/build-plan.js";
import {
  runProjectSmartTestRunner,
  assertProjectSmartTestReport
} from "../src/project-smart-test-runner.js";

function fixture() {
  const draft = createProjectDraft({
    projectId: "smart-test-demo",
    title: "Smart test demo",
    description: "Smart test runner fixture",
    requirements: ["The generated page renders"],
    pages: [{ id: "home", title: "Home" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  const project = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const plan = createBuildPlan(project, {
    externalInputs: ["source"],
    tasks: [
      { id: "compile", dependsOn: [], inputs: ["source"], outputs: ["compiled"] },
      { id: "bundle", dependsOn: ["compile"], inputs: ["compiled"], outputs: ["bundle"] }
    ]
  });
  const testCases = [
    { id: "component.home", level: "component", title: "Home component", required: true, artifactIds: ["compiled"] },
    { id: "integration.bundle", level: "integration", title: "Bundle integration", required: true, artifactIds: ["bundle"] },
    { id: "flow.optional", level: "user_flow", title: "Optional user flow", required: false, artifactIds: ["bundle"] }
  ];
  return { project, plan, testCases };
}

test("runs declared adapters, measures each test, and creates a verifiable smart report", async () => {
  const { project, plan, testCases } = fixture();
  const calls = [];
  const result = await runProjectSmartTestRunner(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    capabilities: ["component", "integration", "user_flow"],
    executors: {
      component: async ({ testCase, signal }) => {
        calls.push(testCase.id);
        assert.equal(signal.aborted, false);
        return { status: "passed", summary: "Component assertions passed" };
      },
      integration: async ({ testCase }) => {
        calls.push(testCase.id);
        return { status: "passed", summary: "Integration assertions passed" };
      },
      user_flow: async ({ testCase }) => {
        calls.push(testCase.id);
        return { status: "passed", summary: "User flow assertions passed" };
      }
    }
  });
  assert.deepEqual(calls, testCases.map(item => item.id).sort());
  assert.equal(result.testReport.status, "passed");
  assert.equal(result.smartTestReport.status, "passed");
  assert.equal(result.smartTestReport.results.length, 3);
  assert.ok(result.smartTestReport.results.every(item => item.durationMs >= 0));
  assert.equal(assertProjectSmartTestReport(project, plan, result.smartTestReport), result.smartTestReport);
});

test("unavailable required capabilities remain skipped and make the smart report incomplete", async () => {
  const { project, plan, testCases } = fixture();
  const result = await runProjectSmartTestRunner(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    capabilities: ["component"],
    executors: {
      component: async () => ({ status: "passed", summary: "Component passed" })
    }
  });
  assert.equal(result.smartTestReport.status, "incomplete");
  assert.equal(result.smartTestReport.summary.skipped, 2);
  assert.equal(result.testReport.status, "incomplete");
  assert.equal(result.smartTestReport.results.find(item => item.testId === "integration.bundle").status, "skipped");
});

test("timeout aborts the adapter signal and records a failed test", async () => {
  const { project, plan, testCases } = fixture();
  let adapterAborted = false;
  const result = await runProjectSmartTestRunner(project, plan, {
    expectedProjectDigest: project.digest,
    testCases: [testCases[0]],
    capabilities: ["component"],
    timeoutMs: 10,
    executors: {
      component: async ({ signal }) => new Promise(resolve => {
        signal.addEventListener("abort", () => {
          adapterAborted = true;
          resolve({ status: "passed", summary: "Late completion" });
        }, { once: true });
      })
    }
  });
  assert.equal(adapterAborted, true);
  assert.equal(result.smartTestReport.status, "failed");
  assert.equal(result.smartTestReport.results[0].error.code, "QX_SMART_TEST_TIMEOUT");
  assert.equal(result.testReport.status, "failed");
});

test("host cancellation is represented explicitly and blocks required tests", async () => {
  const { project, plan, testCases } = fixture();
  const controller = new AbortController();
  const result = await runProjectSmartTestRunner(project, plan, {
    expectedProjectDigest: project.digest,
    testCases: [testCases[0]],
    capabilities: ["component"],
    signal: controller.signal,
    executors: {
      component: async () => {
        controller.abort(new Error("Host stopped the run"));
        return new Promise(() => {});
      }
    }
  });
  assert.equal(result.smartTestReport.status, "cancelled");
  assert.equal(result.smartTestReport.results[0].status, "cancelled");
  assert.equal(result.testReport.status, "incomplete");
});

test("rejects malformed capabilities, timeout values, and modified report digests", async () => {
  const { project, plan, testCases } = fixture();
  await assert.rejects(runProjectSmartTestRunner(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    capabilities: ["unknown"],
    executors: {}
  }), { code: "QX_SMART_TEST_CAPABILITIES_INVALID" });
  await assert.rejects(runProjectSmartTestRunner(project, plan, {
    expectedProjectDigest: project.digest,
    testCases,
    capabilities: [],
    executors: {},
    timeoutMs: 0
  }), { code: "QX_SMART_TEST_TIMEOUT_INVALID" });

  const result = await runProjectSmartTestRunner(project, plan, {
    expectedProjectDigest: project.digest,
    testCases: [testCases[0]],
    capabilities: ["component"],
    executors: {
      component: async () => ({ status: "passed", summary: "Passed" })
    }
  });
  assert.throws(() => assertProjectSmartTestReport(project, plan, {
    ...result.smartTestReport,
    status: "failed"
  }), { code: "QX_SMART_TEST_REPORT_INVALID" });
});
