import { createHash } from "node:crypto";
import { QXProjectError } from "./project-model.js";

const PHASES = Object.freeze([
  "lexer", "parser", "semantic", "qir", "vm", "web_backend",
  "integration", "test", "workspace", "build", "unknown"
]);
const CERTAINTIES = Object.freeze(["confirmed", "potential", "insufficient_information"]);
const SEVERITIES = Object.freeze(["error", "warning", "info"]);
const MAX_DIAGNOSTICS = 100;
const MAX_EVIDENCE = 32;
const MAX_TEXT = 4000;
const FILE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/;

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function text(value, field, maximum = 1000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail("QX_PROJECT_DIAGNOSTIC_INVALID", field + " must be a non-empty string of at most " + maximum + " characters");
  }
  return value.trim();
}

function optionalText(value, field, maximum = 1000) {
  if (value === undefined || value === null) return null;
  return text(value, field, maximum);
}

function safeLocation(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail("QX_PROJECT_DIAGNOSTIC_INVALID", "location must be a plain object");
  const allowed = ["line", "column", "offset"];
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    fail("QX_PROJECT_DIAGNOSTIC_INVALID", "location contains unsupported fields");
  }
  const result = {};
  for (const key of allowed) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key] < (key === "offset" ? 0 : 1)) {
        fail("QX_PROJECT_DIAGNOSTIC_INVALID", "location." + key + " is invalid");
      }
      result[key] = value[key];
    }
  }
  if (Object.keys(result).length === 0) fail("QX_PROJECT_DIAGNOSTIC_INVALID", "location must contain line, column, or offset");
  return Object.freeze(result);
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

function normalizeEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) {
    fail("QX_PROJECT_DIAGNOSTIC_INVALID", "evidence must be an array with at most " + MAX_EVIDENCE + " entries");
  }
  return value.map((item, index) => {
    if (!isPlainObject(item) ||
        Object.keys(item).some(key => !["kind", "message", "location"].includes(key)) ||
        !Object.hasOwn(item, "kind") || !Object.hasOwn(item, "message")) {
      fail("QX_PROJECT_DIAGNOSTIC_INVALID", "evidence[" + index + "] has an invalid shape");
    }
    return Object.freeze({
      kind: text(item.kind, "evidence[" + index + "].kind", 80),
      message: text(item.message, "evidence[" + index + "].message", MAX_TEXT),
      location: safeLocation(item.location)
    });
  });
}

/**
 * Creates a stable, bounded diagnostic record from an existing engine error.
 * The caller must identify the phase, source, and certainty; this function does
 * not infer a file path or claim a root cause from an error code or message.
 */
export function createProjectDiagnostic({
  error,
  phase,
  source,
  certainty,
  severity = "error",
  filePath,
  artifactId,
  evidence
} = {}) {
  if (!error || (typeof error !== "object" && typeof error !== "string")) {
    fail("QX_PROJECT_DIAGNOSTIC_INVALID", "error must be an Error-like object or string");
  }
  if (!PHASES.includes(phase)) fail("QX_PROJECT_DIAGNOSTIC_INVALID", "phase is unsupported");
  if (!CERTAINTIES.includes(certainty)) fail("QX_PROJECT_DIAGNOSTIC_INVALID", "certainty must be explicit");
  if (!SEVERITIES.includes(severity)) fail("QX_PROJECT_DIAGNOSTIC_INVALID", "severity is unsupported");

  const message = typeof error === "string" ? text(error, "error", MAX_TEXT) :
    text(error.message, "error.message", MAX_TEXT);
  const name = typeof error === "object" && typeof error.name === "string"
    ? text(error.name, "error.name", 120) : "Error";
  const code = typeof error === "object" ? optionalText(error.code, "error.code", 120) : null;
  const location = typeof error === "object" ? safeLocation(error.location) : null;
  const normalizedPath = optionalText(filePath, "filePath", 1024);
  if (normalizedPath !== null && (!FILE_PATH.test(normalizedPath) ||
      normalizedPath.includes("\\") || normalizedPath.startsWith("/"))) {
    fail("QX_PROJECT_DIAGNOSTIC_INVALID", "filePath must be a safe relative POSIX path");
  }

  const normalizedEvidence = normalizeEvidence(evidence);
  const base = {
    schemaVersion: "1.0.0",
    phase,
    source: text(source, "source", 120),
    severity,
    certainty,
    code,
    message,
    errorName: name,
    filePath: normalizedPath,
    artifactId: optionalText(artifactId, "artifactId", 128),
    location,
    context: Object.freeze({
      function: typeof error?.function === "string" ? error.function.slice(0, 120) : null,
      block: typeof error?.block === "string" ? error.block.slice(0, 120) : null,
      instruction: typeof error?.instruction === "string" ? error.instruction.slice(0, 120) : null
    }),
    evidence: Object.freeze(normalizedEvidence)
  };
  const id = "qxdiag:" + digest(base).slice("sha256:".length);
  return Object.freeze({ id, ...base });
}

export function createProjectDiagnostics({
  error,
  phase,
  source,
  certainty,
  severity = "error",
  filePath,
  artifactId
} = {}) {
  const nested = error && typeof error === "object" && Array.isArray(error.diagnostics)
    ? error.diagnostics : null;
  if (!nested || nested.length === 0) {
    return Object.freeze([createProjectDiagnostic({
      error, phase, source, certainty, severity, filePath, artifactId
    })]);
  }
  if (nested.length > MAX_DIAGNOSTICS) {
    fail("QX_PROJECT_DIAGNOSTIC_INVALID", "error contains too many nested diagnostics");
  }
  return Object.freeze(nested.map((item, index) => createProjectDiagnostic({
    error: {
      name: error.name || "Diagnostic",
      code: item?.code ?? error.code ?? null,
      message: item?.message,
      location: item?.location ?? null
    },
    phase,
    source,
    certainty,
    severity,
    filePath,
    artifactId,
    evidence: [{
      kind: "parent_error",
      message: text(error.message || "Parent build error", "parent error", MAX_TEXT)
    }]
  })));
}

export const PROJECT_DIAGNOSTIC_PHASES = PHASES;
export const PROJECT_DIAGNOSTIC_CERTAINTIES = CERTAINTIES;
