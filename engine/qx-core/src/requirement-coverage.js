import { createHash } from "node:crypto";
import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { assertProjectTestReport } from "./project-test-suite.js";
import { assertProjectDeliveryReport } from "./project-delivery.js";
import { assertProjectDeliveryReport } from "./project-delivery.js";

const CATEGORIES = Object.freeze(["requirement", "data", "integration"]);
const MAX_ENTRIES = 600;
const MAX_CRITERIA = 1000;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

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

function requireText(value, field, maximum = 4000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail("QX_REQUIREMENT_COVERAGE_INVALID", field + " must be non-empty text of at most " + maximum + " characters");
  }
  return value.trim();
}

function safeEvidencePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}

function requirementsOf(project) {
  return [
    ...project.requirements.map((value, index) => ({ category: "requirement", index, value })),
    ...project.dataRequirements.map((value, index) => ({ category: "data", index, value })),
    ...project.integrationRequirements.map((value, index) => ({ category: "integration", index, value }))
  ];
}

function coverageContent(report) {
  return {
    schemaVersion: report.schemaVersion,
    projectId: report.projectId,
    projectRevision: report.projectRevision,
    projectDigest: report.projectDigest,
    testReportDigest: report.testReportDigest,
    deliveryReportDigest: report.deliveryReportDigest,
    entries: report.entries,
    summary: report.summary,
    status: report.status
  };
}

function normalizeEntries(project, entries, testReport, deliveryReport) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) {
    fail("QX_REQUIREMENT_COVERAGE_INVALID", "entries must be an array with at most " + MAX_ENTRIES + " mappings");
  }
  const required = requirementsOf(project);
  const expected = new Map(required.map(item => [item.category + ":" + item.index, item]));
  const seen = new Set();
  let criteriaCount = 0;
  const testResults = new Map(testReport.results.map(item => [item.testId, item]));
  const evidence = new Map(deliveryReport.items
    .filter(item => item.status === "included")
    .map(item => [item.path, item.contentDigest]));

  const normalized = entries.map((raw, entryIndex) => {
    if (!isPlainObject(raw) ||
        Object.keys(raw).some(key => !["category", "requirementIndex", "acceptanceCriteria", "clarification"].includes(key)) ||
        !["category", "requirementIndex", "acceptanceCriteria"].every(key => Object.hasOwn(raw, key)) ||
        !CATEGORIES.includes(raw.category) ||
        !Number.isSafeInteger(raw.requirementIndex) || raw.requirementIndex < 0) {
      fail("QX_REQUIREMENT_COVERAGE_INVALID", "Each mapping must identify a valid requirement category and index");
    }
    const key = raw.category + ":" + raw.requirementIndex;
    const source = expected.get(key);
    if (!source || seen.has(key)) {
      fail("QX_REQUIREMENT_COVERAGE_INVALID", "Requirement mappings must cover each project requirement exactly once without unknown entries");
    }
    seen.add(key);
    if (typeof raw.acceptanceCriteria !== "object" || !Array.isArray(raw.acceptanceCriteria) ||
        raw.acceptanceCriteria.length > MAX_CRITERIA) {
      fail("QX_REQUIREMENT_COVERAGE_INVALID", "acceptanceCriteria must be an array");
    }
    criteriaCount += raw.acceptanceCriteria.length;
    if (criteriaCount > MAX_CRITERIA) {
      fail("QX_REQUIREMENT_COVERAGE_INVALID", "Total acceptance criteria exceed the supported limit");
    }
    const criteriaIds = new Set();
    const criteria = raw.acceptanceCriteria.map((criterion, criterionIndex) => {
      if (!isPlainObject(criterion) ||
          Object.keys(criterion).some(key => !["id", "description", "testIds", "evidencePaths"].includes(key)) ||
          !["id", "description", "testIds", "evidencePaths"].every(key => Object.hasOwn(criterion, key)) ||
          typeof criterion.id !== "string" || !ID_PATTERN.test(criterion.id) || criteriaIds.has(criterion.id)) {
        fail("QX_REQUIREMENT_COVERAGE_INVALID", "Acceptance criteria require unique valid IDs, descriptions, tests, and evidence paths");
      }
      criteriaIds.add(criterion.id);
      const description = requireText(criterion.description, "acceptanceCriteria[" + criterionIndex + "].description", 1000);
      if (!Array.isArray(criterion.testIds) || criterion.testIds.length > 100 ||
          criterion.testIds.some(id => typeof id !== "string" || !ID_PATTERN.test(id)) ||
          new Set(criterion.testIds).size !== criterion.testIds.length) {
        fail("QX_REQUIREMENT_COVERAGE_INVALID", "Each acceptance criterion must declare unique test IDs");
      }
      if (!Array.isArray(criterion.evidencePaths) || criterion.evidencePaths.length > 100 ||
          criterion.evidencePaths.some(path => !safeEvidencePath(path)) ||
          new Set(criterion.evidencePaths).size !== criterion.evidencePaths.length) {
        fail("QX_REQUIREMENT_COVERAGE_INVALID", "Each acceptance criterion must declare safe, unique evidence paths");
      }
      const testsPassed = criterion.testIds.length > 0 &&
        criterion.testIds.every(id => testResults.get(id)?.status === "passed");
      const evidenceVerified = criterion.evidencePaths.length > 0 &&
        criterion.evidencePaths.every(path =>
          Object.hasOwn(testReport.fileDigests, path) &&
          evidence.get(path) === testReport.fileDigests[path]
        );
      return {
        id: criterion.id,
        description,
        testIds: [...criterion.testIds].sort(),
        evidencePaths: [...criterion.evidencePaths].sort(),
        status: testsPassed && evidenceVerified ? "covered" :
          criterion.testIds.length === 0 && criterion.evidencePaths.length === 0 ? "uncovered" : "partially_covered"
      };
    });
    const clarification = raw.clarification === undefined ? null :
      requireText(raw.clarification, "clarification", 1000);
    const status = clarification ? "needs_clarification" :
      criteria.length === 0 ? "uncovered" :
      criteria.every(item => item.status === "covered") ? "covered" :
      criteria.every(item => item.status === "uncovered") ? "uncovered" : "partially_covered";
    return {
      category: source.category,
      requirementIndex: source.index,
      requirement: source.value,
      acceptanceCriteria: criteria,
      clarification,
      status
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.requirementIndex - b.requirementIndex);

  if (seen.size !== required.length) {
    fail("QX_REQUIREMENT_COVERAGE_INCOMPLETE", "Every project requirement, data requirement, and integration requirement must have an explicit mapping");
  }
  return normalized;
}

export function assertRequirementCoverageReport(project, plan, testReport, deliveryReport, report) {
  assertProjectApproved(project, { expectedDigest: report?.projectDigest });
  assertProjectTestReport(project, plan, testReport);
  assertProjectDeliveryReport(project, plan, testReport, deliveryReport);
  if (!isPlainObject(report) || report.schemaVersion !== "1.0.0" ||
      report.projectId !== project.projectId ||
      report.projectRevision !== project.revision ||
      report.projectDigest !== project.digest ||
      report.testReportDigest !== testReport.digest ||
      report.deliveryReportDigest !== deliveryReport?.digest ||
      !Array.isArray(report.entries) || report.entries.some(item => !isPlainObject(item) ||
        !Array.isArray(item.acceptanceCriteria)) || !isPlainObject(report.summary) ||
      !["covered", "partially_covered", "uncovered", "needs_clarification"].includes(report.status) ||
      typeof report.digest !== "string" || report.digest !== digest(coverageContent(report))) {
    fail("QX_REQUIREMENT_COVERAGE_INVALID", "Requirement coverage report is malformed, stale, or has an invalid digest");
  }
  const recomputedEntries = normalizeEntries(project, report.entries.map(item => ({
    category: item.category,
    requirementIndex: item.requirementIndex,
    acceptanceCriteria: item.acceptanceCriteria.map(criterion => ({
      id: criterion.id,
      description: criterion.description,
      testIds: criterion.testIds,
      evidencePaths: criterion.evidencePaths
    })),
    ...(item.clarification === null ? {} : { clarification: item.clarification })
  })), testReport, deliveryReport);
  if (canonicalJSON(recomputedEntries) !== canonicalJSON(report.entries)) {
    fail("QX_REQUIREMENT_COVERAGE_INVALID", "Requirement coverage entries do not match verified test and delivery evidence");
  }
  const covered = report.entries.filter(item => item.status === "covered").length;
  const partiallyCovered = report.entries.filter(item => item.status === "partially_covered").length;
  const uncovered = report.entries.filter(item => item.status === "uncovered").length;
  const needsClarification = report.entries.filter(item => item.status === "needs_clarification").length;
  if (canonicalJSON(report.summary) !== canonicalJSON({
    total: report.entries.length, covered, partiallyCovered, uncovered, needsClarification
  }) || report.status !== (needsClarification > 0 ? "needs_clarification" :
    uncovered === report.entries.length && report.entries.length > 0 ? "uncovered" :
    covered === report.entries.length && report.entries.length > 0 ? "covered" :
    partiallyCovered > 0 || covered > 0 ? "partially_covered" : "uncovered")) {
    fail("QX_REQUIREMENT_COVERAGE_INVALID", "Requirement coverage summary is inconsistent");
  }
  return report;
}


export function assertRequirementCoverageInput(project, entries) {
  const required = requirementsOf(project);
  if (!Array.isArray(entries) || entries.length !== required.length) {
    fail("QX_REQUIREMENT_COVERAGE_INCOMPLETE", "Every project requirement, data requirement, and integration requirement must be mapped before build writes");
  }
  const expected = new Set(required.map(item => item.category + ":" + item.index));
  const seen = new Set();
  for (const entry of entries) {
    if (!isPlainObject(entry) || !CATEGORIES.includes(entry.category) ||
        !Number.isSafeInteger(entry.requirementIndex) || entry.requirementIndex < 0) {
      fail("QX_REQUIREMENT_COVERAGE_INVALID", "Each requirement mapping needs a valid category and requirement index");
    }
    const key = entry.category + ":" + entry.requirementIndex;
    if (!expected.has(key) || seen.has(key)) {
      fail("QX_REQUIREMENT_COVERAGE_INVALID", "Requirement mappings contain an unknown or duplicate requirement");
    }
    seen.add(key);
  }
  return true;
}

export function createRequirementCoverageReport(project, plan, testReport, deliveryReport, {
  expectedProjectDigest,
  entries
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertProjectTestReport(project, plan, testReport);
  assertProjectDeliveryReport(project, plan, testReport, deliveryReport);
  if (!isPlainObject(deliveryReport) || deliveryReport.projectDigest !== project.digest ||
      deliveryReport.testReportDigest !== testReport?.digest ||
      !Array.isArray(deliveryReport.items)) {
    fail("QX_REQUIREMENT_COVERAGE_INVALID", "A matching delivery report is required to verify evidence files");
  }
  const normalized = normalizeEntries(project, entries, testReport, deliveryReport);
  const summary = {
    total: normalized.length,
    covered: normalized.filter(item => item.status === "covered").length,
    partiallyCovered: normalized.filter(item => item.status === "partially_covered").length,
    uncovered: normalized.filter(item => item.status === "uncovered").length,
    needsClarification: normalized.filter(item => item.status === "needs_clarification").length
  };
  const status = summary.needsClarification > 0 ? "needs_clarification" :
    summary.uncovered === summary.total && summary.total > 0 ? "uncovered" :
    summary.covered === summary.total && summary.total > 0 ? "covered" :
    summary.partiallyCovered > 0 || summary.covered > 0 ? "partially_covered" : "uncovered";
  const content = {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    testReportDigest: testReport.digest,
    deliveryReportDigest: deliveryReport.digest,
    entries: normalized,
    summary,
    status
  };
  return freezeDeep({ ...content, digest: digest(content) });
}
