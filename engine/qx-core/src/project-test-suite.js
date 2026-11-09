import { createHash } from "node:crypto";
import { assertBuildPlanForProject } from "./build-plan.js";
import { assertProjectApproved, QXProjectError } from "./project-model.js";

const TEST_LEVELS = Object.freeze([
  "component", "contract", "integration", "project", "user_flow"
]);
const TEST_STATUSES = Object.freeze(["passed", "failed", "skipped", "not_run"]);
const TEST_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_TESTS = 1000;
const MAX_TEXT = 4000;

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

function requireText(value, field, maximum = MAX_TEXT) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail("QX_TEST_REPORT_INVALID", field + " must be a non-empty string of at most " + maximum + " characters");
  }
  return value.trim();
}

function normalizeIds(value, field, pattern, maximum = 200) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("QX_TEST_REPORT_INVALID", field + " must be an array with at most " + maximum + " entries");
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !pattern.test(item)) {
      fail("QX_TEST_REPORT_INVALID", field + "[" + index + "] has an invalid identifier");
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    fail("QX_TEST_REPORT_INVALID", field + " must not contain duplicate identifiers");
  }
  return result.sort();
}

function normalizeFileDigests(fileDigests) {
  if (!isPlainObject(fileDigests)) {
    fail("QX_TEST_REPORT_INVALID", "fileDigests must be a plain object keyed by relative file path");
  }
  const entries = Object.entries(fileDigests).sort(([a], [b]) => a.localeCompare(b));
  const normalized = {};
  for (const [filePath, fileDigest] of entries) {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 1024 ||
        filePath.startsWith("/") || filePath.includes("\\") ||
        filePath.split("/").some(part => !part || part === "." || part === "..") ||
        !DIGEST_PATTERN.test(fileDigest)) {
      fail("QX_TEST_REPORT_INVALID", "Each file digest requires a safe relative path and SHA-256 digest");
    }
    normalized[filePath] = fileDigest;
  }
  return normalized;
}

function normalizeTestCases(testCases, knownArtifacts) {
  if (!Array.isArray(testCases) || testCases.length === 0 || testCases.length > MAX_TESTS) {
    fail("QX_TEST_REPORT_INVALID", "testCases must contain between 1 and " + MAX_TESTS + " entries");
  }
  const ids = new Set();
  return testCases.map((raw, index) => {
    if (!isPlainObject(raw) ||
        Object.keys(raw).some(key => !["id", "level", "title", "required", "artifactIds"].includes(key)) ||
        !["id", "level", "title", "required", "artifactIds"].every(key => Object.hasOwn(raw, key))) {
      fail("QX_TEST_REPORT_INVALID", "Each test case must contain only id, level, title, required, and artifactIds");
    }
    if (typeof raw.id !== "string" || !TEST_ID_PATTERN.test(raw.id) || ids.has(raw.id)) {
      fail("QX_TEST_REPORT_INVALID", "Test case IDs must be valid and unique");
    }
    ids.add(raw.id);
    if (!TEST_LEVELS.includes(raw.level)) {
      fail("QX_TEST_REPORT_INVALID", "Test case " + raw.id + " has an unsupported test level");
    }
    if (typeof raw.required !== "boolean") {
      fail("QX_TEST_REPORT_INVALID", "Test case " + raw.id + " must declare required as a boolean");
    }
    const artifactIds = normalizeIds(raw.artifactIds, "testCases[" + index + "].artifactIds", ARTIFACT_PATTERN);
    for (const artifactId of artifactIds) {
      if (!knownArtifacts.has(artifactId)) {
        fail("QX_TEST_REPORT_UNKNOWN_ARTIFACT", "Test case " + raw.id + " references unknown build artifact " + artifactId);
      }
    }
    return {
      id: raw.id,
      level: raw.level,
      title: requireText(raw.title, "testCases[" + index + "].title", 200),
      required: raw.required,
      artifactIds
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function summarizeError(error) {
  const name = typeof error?.name === "string" ? error.name.slice(0, 120) : "Error";
  const code = typeof error?.code === "string" ? error.code.slice(0, 120) : null;
  const message = typeof error?.message === "string" ? error.message.slice(0, 1000) : "Test executor threw a non-Error value";
  return { name, code, message };
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

export function assertProjectTestReport(project, plan, report) {
  assertProjectApproved(project, { expectedDigest: report?.projectDigest });
  assertBuildPlanForProject(project, plan);
  if (!isPlainObject(report) || report.schemaVersion !== "1.0.0" ||
      report.projectId !== project.projectId ||
      report.projectRevision !== project.revision ||
      report.projectDigest !== project.digest ||
      report.buildPlanDigest !== plan.digest ||
      !isPlainObject(report.fileDigests) || !Array.isArray(report.results) ||
      !isPlainObject(report.summary) || typeof report.digest !== "string" ||
      report.digest !== digest(reportContent(report))) {
    fail("QX_TEST_REPORT_INVALID", "Test report is malformed, stale, or its digest does not match");
  }
  return report;
}

export async function runProjectTestSuite(project, plan, {
  expectedProjectDigest,
  testCases,
  executeTest,
  fileDigests = {},
  scope = "all",
  changedArtifactIds = []
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertBuildPlanForProject(project, plan);
  if (typeof executeTest !== "function") {
    fail("QX_TEST_EXECUTOR_REQUIRED", "A caller-provided test executor function is required");
  }
  if (scope !== "all" && scope !== "affected") {
    fail("QX_TEST_REPORT_INVALID", "scope must be all or affected");
  }

  const knownArtifacts = new Set(plan.externalInputs);
  for (const task of plan.tasks) for (const output of task.outputs) knownArtifacts.add(output);
  const normalizedCases = normalizeTestCases(testCases, knownArtifacts);
  const normalizedDigests = normalizeFileDigests(fileDigests);
  const changed = normalizeIds(changedArtifactIds, "changedArtifactIds", ARTIFACT_PATTERN);
  for (const artifactId of changed) {
    if (!knownArtifacts.has(artifactId)) {
      fail("QX_TEST_REPORT_UNKNOWN_ARTIFACT", "Changed artifact is not present in the build plan: " + artifactId);
    }
  }
  if (scope === "affected" && changed.length === 0) {
    fail("QX_TEST_REPORT_INVALID", "Affected test scope requires at least one changed artifact ID");
  }

  const selected = normalizedCases.filter(testCase =>
    scope === "all" || testCase.required ||
    testCase.artifactIds.some(artifactId => changed.includes(artifactId))
  );
  const selectedIds = new Set(selected.map(testCase => testCase.id));
  const results = [];

  for (const testCase of normalizedCases) {
    if (!selectedIds.has(testCase.id)) {
      results.push({
        testId: testCase.id,
        level: testCase.level,
        required: testCase.required,
        status: "not_run",
        summary: "Not selected by the requested affected-test scope",
        error: null
      });
      continue;
    }
    try {
      const outcome = await executeTest(Object.freeze({
        testCase: freezeDeep({ ...testCase, artifactIds: [...testCase.artifactIds] }),
        project,
        buildPlan: plan,
        fileDigests: Object.freeze({ ...normalizedDigests })
      }));
      if (!isPlainObject(outcome) || !["passed", "failed", "skipped"].includes(outcome.status)) {
        fail("QX_TEST_EXECUTOR_RESULT_INVALID", "Executor for " + testCase.id + " returned an invalid result contract");
      }
      const summary = requireText(outcome.summary, "executor summary", 1000);
      if (outcome.status === "skipped" && !outcome.reason) {
        fail("QX_TEST_EXECUTOR_RESULT_INVALID", "Skipped test " + testCase.id + " must include a reason");
      }
      results.push({
        testId: testCase.id,
        level: testCase.level,
        required: testCase.required,
        status: outcome.status,
        summary,
        error: outcome.status === "failed" ? {
          name: "TestFailure",
          code: null,
          message: typeof outcome.reason === "string" ? outcome.reason.slice(0, 1000) : summary
        } : outcome.status === "skipped" ? {
          name: "TestSkipped",
          code: null,
          message: String(outcome.reason).slice(0, 1000)
        } : null
      });
    } catch (error) {
      results.push({
        testId: testCase.id,
        level: testCase.level,
        required: testCase.required,
        status: "failed",
        summary: "Test executor failed",
        error: summarizeError(error)
      });
    }
  }

  const summary = {
    total: results.length,
    selected: selected.length,
    passed: results.filter(result => result.status === "passed").length,
    failed: results.filter(result => result.status === "failed").length,
    skipped: results.filter(result => result.status === "skipped").length,
    notRun: results.filter(result => result.status === "not_run").length,
    requiredUnsuccessful: results.filter(result =>
      result.required && result.status !== "passed"
    ).length
  };
  const status = summary.failed > 0 ? "failed" :
    summary.requiredUnsuccessful > 0 ? "incomplete" : "passed";
  const content = {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    buildPlanDigest: plan.digest,
    fileDigests: normalizedDigests,
    scope,
    selectedTestIds: selected.map(testCase => testCase.id),
    results,
    summary,
    status
  };
  return freezeDeep({ ...content, digest: digest(content) });
}
