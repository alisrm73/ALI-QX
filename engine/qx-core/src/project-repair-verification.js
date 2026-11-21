import { createHash } from "node:crypto";
import { assertBuildPlanForProject } from "./build-plan.js";
import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { executeProjectRepair } from "./project-repair-execution.js";
import {
  assertProjectSmartTestRunnerConfig,
  assertProjectSmartTestReport,
  runProjectSmartTestRunner
} from "./project-smart-test-runner.js";

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function summarizeFailure(error) {
  return Object.freeze({
    code: typeof error?.code === "string" && error.code.startsWith("QX_")
      ? error.code : "QX_PROJECT_REPAIR_VERIFICATION_FAILED",
    message: error instanceof QXProjectError
      ? error.message.slice(0, 1000)
      : "Post-repair verification could not be completed"
  });
}

function reportDigest(content) {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(content), "utf8").digest("hex");
}

/**
 * Executes one authorized repair and then runs the complete host-provided test
 * suite. A repair is verified only when every required test has passed.
 * Test adapters receive the post-write file digests from the Workspace writes.
 */
export async function executeProjectRepairAndVerify({
  authorization,
  workspace,
  project,
  expectedProjectDigest,
  buildPlan,
  testCases,
  testCapabilities,
  testExecutors,
  testTimeoutMs = 30000,
  signal
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertBuildPlanForProject(project, buildPlan);
  if (!Array.isArray(testCases) || testCases.length === 0) {
    fail("QX_TEST_EXECUTOR_REQUIRED",
      "A non-empty complete test case list is required before repair execution");
  }
  assertProjectSmartTestRunnerConfig({
    capabilities: testCapabilities,
    executors: testExecutors,
    timeoutMs: testTimeoutMs,
    signal
  });

  const repairReport = await executeProjectRepair({
    authorization,
    workspace,
    project,
    expectedProjectDigest,
    signal
  });

  if (repairReport.status !== "applied") {
    const status = repairReport.status === "partial" ? "repair_partial" :
      repairReport.status === "cancelled" ? "repair_cancelled" : "repair_failed";
    const content = {
      schemaVersion: "1.0.0",
      status,
      projectDigest: project.digest,
      repairReport,
      smartTestReport: null,
      verificationFailure: null
    };
    return freezeDeep({ ...content, digest: reportDigest(content) });
  }

  const fileDigests = Object.fromEntries(
    repairReport.writes.map(write => [write.relativePath, write.contentDigest])
  );
  let smartTestReport = null;
  let verificationFailure = null;
  let status;

  try {
    const result = await runProjectSmartTestRunner(project, buildPlan, {
      expectedProjectDigest,
      testCases,
      capabilities: testCapabilities,
      executors: testExecutors,
      fileDigests,
      scope: "all",
      timeoutMs: testTimeoutMs,
      signal
    });
    smartTestReport = assertProjectSmartTestReport(
      project, buildPlan, result.smartTestReport
    );
    if (smartTestReport.status === "passed" &&
        smartTestReport.summary.requiredUnsuccessful === 0 &&
        smartTestReport.summary.selected > 0) {
      status = "verified";
    } else if (smartTestReport.status === "cancelled" || signal?.aborted === true) {
      status = "verification_cancelled";
    } else if (smartTestReport.status === "failed") {
      status = "verification_failed";
    } else {
      status = "verification_incomplete";
    }
  } catch (error) {
    verificationFailure = summarizeFailure(error);
    status = signal?.aborted === true
      ? "verification_cancelled" : "verification_incomplete";
  }

  const content = {
    schemaVersion: "1.0.0",
    status,
    projectDigest: project.digest,
    repairReport,
    smartTestReport,
    verificationFailure
  };
  return freezeDeep({ ...content, digest: reportDigest(content) });
}
