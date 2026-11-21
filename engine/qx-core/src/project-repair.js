import { createHash } from "node:crypto";
import { QXProjectError } from "./project-model.js";

const MAX_CHANGES = 20;
const MAX_TESTS = 30;
const MAX_TEXT = 2000;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/;
const RISKS = Object.freeze(["low", "medium", "high"]);

function fail(message) {
  throw new QXProjectError("QX_PROJECT_REPAIR_PROPOSAL_INVALID", message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, allowed, required, field) {
  if (!plainObject(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail(field + " has an invalid object shape");
  }
}

function boundedText(value, field, maximum = MAX_TEXT) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail(field + " must be a non-empty string of at most " + maximum + " characters");
  }
  return value.trim();
}

function normalizeChange(change, index) {
  exactKeys(change,
    ["filePath", "scope", "lineRange", "rationale"],
    ["filePath", "scope", "rationale"],
    "changes[" + index + "]");
  const filePath = boundedText(change.filePath, "changes[" + index + "].filePath", 1024);
  if (!SAFE_PATH.test(filePath) || filePath.includes("\\") || filePath.startsWith("/")) {
    fail("changes[" + index + "].filePath must be a safe relative POSIX path");
  }
  let lineRange = null;
  if (change.lineRange !== undefined && change.lineRange !== null) {
    exactKeys(change.lineRange, ["startLine", "endLine"], ["startLine", "endLine"],
      "changes[" + index + "].lineRange");
    const { startLine, endLine } = change.lineRange;
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
        startLine < 1 || endLine < startLine) {
      fail("changes[" + index + "].lineRange must contain a valid inclusive line range");
    }
    lineRange = Object.freeze({ startLine, endLine });
  }
  return Object.freeze({
    filePath,
    scope: boundedText(change.scope, "changes[" + index + "].scope", 500),
    lineRange,
    rationale: boundedText(change.rationale, "changes[" + index + "].rationale", 1000)
  });
}

function normalizeTest(item, index) {
  exactKeys(item, ["name", "purpose"], ["name", "purpose"], "tests[" + index + "]");
  return Object.freeze({
    name: boundedText(item.name, "tests[" + index + "].name", 160),
    purpose: boundedText(item.purpose, "tests[" + index + "].purpose", 1000)
  });
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

/**
 * Creates a review-only repair proposal. It never edits files, grants authority,
 * or asserts that the proposed cause or change has been verified.
 */
export function createProjectRepairProposal({
  diagnostic,
  projectDigest,
  basis,
  changes,
  tests,
  risk = "medium"
} = {}) {
  exactKeys(diagnostic, [
    "id", "schemaVersion", "phase", "source", "severity", "certainty",
    "code", "message", "errorName", "filePath", "artifactId",
    "location", "context", "evidence"
  ], ["id", "schemaVersion", "phase", "source", "severity", "certainty",
    "code", "message", "errorName"], "diagnostic");

  if (diagnostic.schemaVersion !== "1.0.0" ||
      typeof diagnostic.id !== "string" || !/^qxdiag:sha256:[a-f0-9]{64}$/.test(diagnostic.id) ||
      !["confirmed", "potential"].includes(diagnostic.certainty) ||
      !["error", "warning"].includes(diagnostic.severity)) {
    fail("diagnostic must be a supported actionable diagnostic; insufficient information cannot produce a repair proposal");
  }
  if (typeof projectDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(projectDigest)) {
    fail("projectDigest must be a SHA-256 project digest");
  }
  if (!RISKS.includes(risk)) fail("risk must be low, medium, or high");
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    fail("changes must contain between 1 and " + MAX_CHANGES + " entries");
  }
  if (!Array.isArray(tests) || tests.length === 0 || tests.length > MAX_TESTS) {
    fail("tests must contain between 1 and " + MAX_TESTS + " entries");
  }

  const normalizedChanges = changes.map(normalizeChange);
  const paths = normalizedChanges.map(change => change.filePath);
  if (new Set(paths).size !== paths.length) fail("changes must not repeat a file path");
  const normalizedTests = tests.map(normalizeTest);
  const base = Object.freeze({
    schemaVersion: "1.0.0",
    diagnosticId: diagnostic.id,
    projectDigest,
    basis: boundedText(basis, "basis", 1500),
    risk,
    status: "proposed",
    changes: Object.freeze(normalizedChanges),
    tests: Object.freeze(normalizedTests),
    application: "not_applied"
  });
  const id = "qxrepair:" + digest(base).slice("sha256:".length);
  return Object.freeze({ id, ...base });
}

export const PROJECT_REPAIR_RISKS = RISKS;
