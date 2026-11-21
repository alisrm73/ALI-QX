import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { assertBuildPlanForProject } from "./build-plan.js";
import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { runProjectTestSuite } from "./project-test-suite.js";

const TEST_LEVELS = Object.freeze([
  "component", "contract", "integration", "project", "user_flow"
]);
const TEST_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_TESTS = 1000;
const MAX_TIMEOUT_MS = 300000;

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(canonicalJSON(value), "utf8").digest("hex");
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function requireSummary(value, field = "executor summary") {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1000) {
    fail("QX_SMART_TEST_RESULT_INVALID", field + " must be a non-empty string of at most 1000 characters");
  }
  return value.trim();
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length > TEST_LEVELS.length ||
      value.some(level => typeof level !== "string" || !TEST_LEVELS.includes(level)) ||
      new Set(value).size !== value.length) {
    fail("QX_SMART_TEST_CAPABILITIES_INVALID", "capabilities must be a unique array of supported test levels");
  }
  return new Set(value);
}

function normalizeExecutors(value) {
  if (!isPlainObject(value) ||
      Object.keys(value).some(level => !TEST_LEVELS.includes(level)) ||
      Object.values(value).some(executor => typeof executor !== "function")) {
    fail("QX_SMART_TEST_EXECUTORS_INVALID", "executors must be a plain object mapping supported test levels to functions");
  }
  return value;
}

function normalizeSignal(signal) {
  if (signal === undefined) return null;
  if (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function") {
    fail("QX_SMART_TEST_SIGNAL_INVALID", "signal must be an AbortSignal");
  }
  return signal;
}

function normalizeFileDigests(value) {
  if (!isPlainObject(value)) {
    fail("QX_TEST_REPORT_INVALID", "fileDigests must be a plain object");
  }
  const result = {};
  for (const [filePath, fileDigest] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 1024 ||
        filePath.startsWith("/") || filePath.includes("\\") ||
        filePath.split("/").some(part => !part || part === "." || part === "..") ||
        typeof fileDigest !== "string" || !DIGEST_PATTERN.test(fileDigest)) {
      fail("QX_TEST_REPORT_INVALID", "Each file digest requires a safe relative path and SHA-256 digest");
    }
    result[filePath] = fileDigest;
  }
  return result;
}

function summarizeError(error) {
  return {
    name: typeof error?.name === "string" ? error.name.slice(0, 120) : "Error",
    code: typeof error?.code === "string" ? error.code.slice(0, 120) : null,
    message: typeof error?.message === "string" ? error.message.slice(0, 1000) : "Test executor failed"
  };
}

function reportContent(report) {
  return {
    schemaVersion: report.schemaVersion,
    projectId: report.projectId,
    projectRevision: report.projectRevision,
    projectDigest: report.projectDigest,
    buildPlanDigest: report.buildPlanDigest,
    fileDigests: report.fileDigests,
    scope: report.scope,
    selectedTestIds: report.selectedTestIds,
    results: report.results,
    summary: report.summary,
    status: report.status
  };
}

/**
 * Runs host-provided test adapters while preserving the legacy project test report.
 * A timeout or AbortSignal stops waiting and signals the adapter; it cannot forcibly
 * terminate an adapter that ignores its AbortSignal.
 */
export async function runProjectSmartTestRunner(project, plan, {
  expectedProjectDigest,
  testCases,
  capabilities = [],
  executors = {},
  fileDigests = {},
  scope = "all",
  changedArtifactIds = [],
  timeoutMs = 30000,
  signal
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertBuildPlanForProject(project, plan);
  if (!Array.isArray(testCases) || testCases.length === 0 || testCases.length > MAX_TESTS) {
    fail("QX_TEST_REPORT_INVALID", "testCases must contain between 1 and " + MAX_TESTS + " entries");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail("QX_SMART_TEST_TIMEOUT_INVALID", "timeoutMs must be an integer between 1 and " + MAX_TIMEOUT_MS);
  }

  const supportedLevels = normalizeCapabilities(capabilities);
  const adapters = normalizeExecutors(executors);
  const externalSignal = normalizeSignal(signal);
  const normalizedDigests = normalizeFileDigests(fileDigests);
  const measured = new Map();
  let wasCancelled = externalSignal?.aborted === true;

  const executeTest = async context => {
    const { testCase } = context;
    const startedAt = performance.now();
    const record = (status, summary, reason = null, error = null) => {
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      measured.set(testCase.id, { status, summary, reason, error, durationMs });
      return {
        status: status === "cancelled" ? "skipped" : status,
        summary,
        ...(status === "skipped" || status === "cancelled" || reason
          ? { reason: reason || summary } : {})
      };
    };

    if (externalSignal?.aborted) {
      wasCancelled = true;
      return record("cancelled", "Test was not started because cancellation was requested",
        "The host AbortSignal was already aborted");
    }
    if (!supportedLevels.has(testCase.level)) {
      return record("skipped", "Test capability is unavailable",
        "The host did not declare support for the " + testCase.level + " test level");
    }
    const executor = adapters[testCase.level];
    if (typeof executor !== "function") {
      return record("skipped", "Test adapter is unavailable",
        "No host executor was supplied for the " + testCase.level + " test level");
    }

    const controller = new AbortController();
    let timer;
    let abortHandler;
    const work = Promise.resolve().then(() => executor(Object.freeze({
      ...context,
      signal: controller.signal
    })));
    const interruption = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Test timed out"));
        const error = Object.assign(new Error("Test exceeded its " + timeoutMs + " ms timeout"), {
          code: "QX_SMART_TEST_TIMEOUT"
        });
        reject(error);
      }, timeoutMs);
      if (externalSignal) {
        abortHandler = () => {
          wasCancelled = true;
          controller.abort(externalSignal.reason);
          reject(Object.assign(new Error("Test was cancelled by the host"), {
            code: "QX_SMART_TEST_CANCELLED"
          }));
        };
        externalSignal.addEventListener("abort", abortHandler, { once: true });
        if (externalSignal.aborted) abortHandler();
      }
    });

    try {
      const outcome = await Promise.race([work, interruption]);
      if (!isPlainObject(outcome) || !["passed", "failed", "skipped"].includes(outcome.status)) {
        const error = Object.assign(new Error("Test adapter returned an invalid result contract"), {
          code: "QX_SMART_TEST_RESULT_INVALID"
        });
        return record("failed", "Test adapter returned an invalid result", error.message, summarizeError(error));
      }
      const summary = requireSummary(outcome.summary);
      if (outcome.status === "skipped" &&
          (typeof outcome.reason !== "string" || outcome.reason.trim().length === 0)) {
        const error = Object.assign(new Error("A skipped test must include a non-empty reason"), {
          code: "QX_SMART_TEST_RESULT_INVALID"
        });
        return record("failed", "Test adapter returned an invalid skipped result", error.message, summarizeError(error));
      }
      const reason = typeof outcome.reason === "string" ? outcome.reason.slice(0, 1000) : null;
      return record(outcome.status, summary, reason,
        outcome.status === "failed" ? {
          name: "TestFailure",
          code: null,
          message: reason || summary
        } : null);
    } catch (error) {
      if (error?.code === "QX_SMART_TEST_CANCELLED") {
        return record("cancelled", "Test was cancelled", error.message, summarizeError(error));
      }
      if (error?.code === "QX_SMART_TEST_TIMEOUT") {
        return record("failed", "Test timed out", error.message, summarizeError(error));
      }
      return record("failed", "Test adapter threw an error",
        typeof error?.message === "string" ? error.message.slice(0, 1000) : "Test adapter failed",
        summarizeError(error));
    } finally {
      clearTimeout(timer);
      if (externalSignal && abortHandler) {
        externalSignal.removeEventListener("abort", abortHandler);
      }
    }
  };

  const testReport = await runProjectTestSuite(project, plan, {
    expectedProjectDigest,
    testCases,
    executeTest,
    fileDigests: normalizedDigests,
    scope,
    changedArtifactIds
  });

  const results = testReport.results.map(result => {
    const measurement = measured.get(result.testId);
    if (!measurement) {
      return {
        testId: result.testId,
        level: result.level,
        required: result.required,
        status: result.status,
        summary: result.summary,
        reason: result.error?.message || null,
        error: result.error,
        durationMs: 0
      };
    }
    return {
      testId: result.testId,
      level: result.level,
      required: result.required,
      status: measurement.status,
      summary: measurement.summary,
      reason: measurement.reason,
      error: measurement.error,
      durationMs: measurement.durationMs
    };
  });

  const summary = {
    total: results.length,
    selected: results.filter(result => result.status !== "not_run").length,
    passed: results.filter(result => result.status === "passed").length,
    failed: results.filter(result => result.status === "failed").length,
    skipped: results.filter(result => result.status === "skipped").length,
    cancelled: results.filter(result => result.status === "cancelled").length,
    notRun: results.filter(result => result.status === "not_run").length,
    requiredUnsuccessful: results.filter(result =>
      result.required && result.status !== "passed"
    ).length
  };
  const status = summary.failed > 0 ? "failed" :
    wasCancelled || summary.cancelled > 0 ? "cancelled" :
    summary.requiredUnsuccessful > 0 ? "incomplete" : "passed";
  const content = {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    buildPlanDigest: plan.digest,
    fileDigests: normalizedDigests,
    scope: testReport.scope,
    selectedTestIds: testReport.selectedTestIds,
    results,
    summary,
    status
  };
  const report = freezeDeep({ ...content, digest: digest(content) });
  return Object.freeze({ testReport, smartTestReport: report });
}

export function assertProjectSmartTestReport(project, plan, report) {
  assertProjectApproved(project, { expectedDigest: report?.projectDigest });
  assertBuildPlanForProject(project, plan);
  if (!isPlainObject(report) || report.schemaVersion !== "1.0.0" ||
      report.projectId !== project.projectId ||
      report.projectRevision !== project.revision ||
      report.projectDigest !== project.digest ||
      report.buildPlanDigest !== plan.digest ||
      !isPlainObject(report.fileDigests) ||
      !Array.isArray(report.selectedTestIds) ||
      !Array.isArray(report.results) ||
      !isPlainObject(report.summary) ||
      !["passed", "failed", "incomplete", "cancelled"].includes(report.status) ||
      typeof report.digest !== "string" ||
      report.digest !== digest(reportContent(report))) {
    fail("QX_SMART_TEST_REPORT_INVALID", "Smart test report is malformed, stale, or its digest does not match");
  }
  normalizeFileDigests(report.fileDigests);
  if (report.results.some(item => !isPlainObject(item) ||
      typeof item.testId !== "string" || !TEST_ID_PATTERN.test(item.testId) ||
      !TEST_LEVELS.includes(item.level) || typeof item.required !== "boolean" ||
      !["passed", "failed", "skipped", "not_run", "cancelled"].includes(item.status) ||
      typeof item.summary !== "string" || !Number.isSafeInteger(item.durationMs) ||
      item.durationMs < 0 || (item.reason !== null && typeof item.reason !== "string"))) {
    fail("QX_SMART_TEST_REPORT_INVALID", "Smart test report contains malformed result entries");
  }
  const counts = {
    total: report.results.length,
    selected: report.results.filter(item => item.status !== "not_run").length,
    passed: report.results.filter(item => item.status === "passed").length,
    failed: report.results.filter(item => item.status === "failed").length,
    skipped: report.results.filter(item => item.status === "skipped").length,
    cancelled: report.results.filter(item => item.status === "cancelled").length,
    notRun: report.results.filter(item => item.status === "not_run").length,
    requiredUnsuccessful: report.results.filter(item =>
      item.required && item.status !== "passed"
    ).length
  };
  const expectedStatus = counts.failed > 0 ? "failed" :
    counts.cancelled > 0 ? "cancelled" :
    counts.requiredUnsuccessful > 0 ? "incomplete" : "passed";
  if (canonicalJSON(counts) !== canonicalJSON(report.summary) ||
      report.selectedTestIds.length !== counts.selected ||
      report.results.some(item => item.status !== "not_run" &&
        !report.selectedTestIds.includes(item.testId)) ||
      report.status !== expectedStatus) {
    fail("QX_SMART_TEST_REPORT_INVALID", "Smart test report aggregate summary is inconsistent");
  }
  return report;
}
