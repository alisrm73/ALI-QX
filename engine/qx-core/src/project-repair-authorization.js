import { createHash } from "node:crypto";
import { assertProjectApproved, QXProjectError } from "./project-model.js";

const AUTHORIZATIONS = new WeakMap();
const MAX_CHANGES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_AUTHORIZATION_LIFETIME_MS = 5 * 60 * 1000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/;

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function plainObject(value) {
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

function normalizeChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Approved changes must contain between 1 and " + MAX_CHANGES + " files");
  }
  const seen = new Set();
  let totalBytes = 0;
  return Object.freeze(changes.map((change, index) => {
    const allowed = ["relativePath", "mode", "content", "expectedContentDigest"];
    if (!plainObject(change) || Object.keys(change).some(key => !allowed.includes(key)) ||
        allowed.some(key => !Object.hasOwn(change, key))) {
      fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
        "Approved change " + index + " has an invalid shape");
    }
    const { relativePath, mode, content, expectedContentDigest } = change;
    if (typeof relativePath !== "string" || relativePath.length > 1024 ||
        !SAFE_PATH.test(relativePath) || relativePath.includes("\\") ||
        relativePath.split("/")[0] === ".qx-workspace" || seen.has(relativePath)) {
      fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
        "Approved change paths must be unique safe relative POSIX paths");
    }
    if (mode !== "create" && mode !== "replace") {
      fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
        "Approved change mode must be create or replace");
    }
    const contentBytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : Infinity;
    if (typeof content !== "string" || contentBytes > MAX_FILE_BYTES) {
      fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
        "Approved file content must be UTF-8 text no larger than 10 MiB");
    }
    totalBytes += contentBytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
        "The complete approved change set must not exceed 20 MiB");
    }
    if (mode === "create" && expectedContentDigest !== null) {
      fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
        "Create changes must expect an absent target (null digest)");
    }
    if (mode === "replace" &&
        (typeof expectedContentDigest !== "string" || !DIGEST.test(expectedContentDigest))) {
      fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
        "Replace changes require the approved current file digest");
    }
    seen.add(relativePath);
    return Object.freeze({
      relativePath,
      mode,
      content,
      expectedContentDigest,
      contentDigest: "sha256:" + createHash("sha256").update(content, "utf8").digest("hex")
    });
  }));
}

function changeSetDigest(normalizedChanges) {
  return digest(normalizedChanges.map(change => ({
    relativePath: change.relativePath,
    mode: change.mode,
    expectedContentDigest: change.expectedContentDigest,
    contentDigest: change.contentDigest
  })));
}

function assertProposal(proposal, project) {
  if (!plainObject(proposal) || proposal.schemaVersion !== "1.0.0" ||
      proposal.projectDigest !== project.digest || proposal.status !== "proposed" ||
      proposal.application !== "not_applied" ||
      typeof proposal.id !== "string" || !/^qxrepair:[a-f0-9]{64}$/.test(proposal.id) ||
      !Array.isArray(proposal.changes) || proposal.changes.length === 0) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Repair proposal is malformed, stale, or is no longer review-only");
  }
  const base = {
    schemaVersion: proposal.schemaVersion,
    diagnosticId: proposal.diagnosticId,
    projectDigest: proposal.projectDigest,
    basis: proposal.basis,
    risk: proposal.risk,
    status: proposal.status,
    changes: proposal.changes,
    tests: proposal.tests,
    application: proposal.application
  };
  if ("qxrepair:" + digest(base).slice("sha256:".length) !== proposal.id) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Repair proposal content does not match its identifier");
  }
}

/**
 * Computes the digest a trusted host must display and bind to its explicit
 * user-confirmation event. The host must call authorizeProjectRepair only
 * after the user has reviewed and confirmed these exact file contents.
 */
export function createProjectRepairChangeSetDigest(changes) {
  return changeSetDigest(normalizeChanges(changes));
}

/**
 * Issues an opaque, single-use capability after the trusted host attests that
 * the user explicitly approved the exact proposal and change-set digest.
 * This is a host trust boundary, not proof of a human click against malicious
 * code running inside the same Node.js process.
 */
export function authorizeProjectRepair({
  project,
  expectedProjectDigest,
  proposal,
  changes,
  approval,
  expiresInMs = 60 * 1000
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1 ||
      expiresInMs > MAX_AUTHORIZATION_LIFETIME_MS) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Authorization lifetime must be between 1 ms and 5 minutes");
  }
  assertProposal(proposal, project);
  if (!plainObject(approval) ||
      Object.keys(approval).some(key =>
        !["confirmed", "proposalId", "projectDigest", "changesDigest"].includes(key)) ||
      Object.keys(approval).length !== 4 ||
      approval.confirmed !== true ||
      approval.proposalId !== proposal.id ||
      approval.projectDigest !== project.digest ||
      typeof approval.changesDigest !== "string" || !DIGEST.test(approval.changesDigest)) {
    fail("QX_PROJECT_REPAIR_APPROVAL_REQUIRED",
      "An explicit host confirmation matching the exact proposal and project is required");
  }

  const normalizedChanges = normalizeChanges(changes);
  const proposalPaths = proposal.changes.map(change => change.filePath);
  if (normalizedChanges.length !== proposalPaths.length ||
      normalizedChanges.some((change, index) => change.relativePath !== proposalPaths[index])) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Approved change paths and order must exactly match the repair proposal");
  }
  const actualChangesDigest = changeSetDigest(normalizedChanges);
  if (approval.changesDigest !== actualChangesDigest) {
    fail("QX_PROJECT_REPAIR_APPROVAL_MISMATCH",
      "Approved change contents do not match the confirmed change-set digest");
  }

  const token = Object.freeze(Object.create(null));
  const issuedAt = Date.now();
  AUTHORIZATIONS.set(token, {
    issuedAt,
    expiresAt: issuedAt + expiresInMs,
    projectId: project.projectId,
    projectDigest: project.digest,
    proposalId: proposal.id,
    changesDigest: actualChangesDigest,
    changes: normalizedChanges,
    consumed: false
  });
  return token;
}

/** Internal capability consumption; deliberately not re-exported by index.js. */
export function consumeProjectRepairAuthorization(token, project, expectedProjectDigest) {
  const state = token && typeof token === "object" ? AUTHORIZATIONS.get(token) : null;
  if (!state || state.consumed) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Repair authorization is invalid or has already been consumed");
  }
  state.consumed = true;
  if (Date.now() >= state.expiresAt) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_EXPIRED",
      "Repair authorization has expired and must be approved again");
  }
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (project.projectId !== state.projectId || project.digest !== state.projectDigest ||
      expectedProjectDigest !== state.projectDigest) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_STALE",
      "Repair authorization belongs to a different project revision");
  }
  return Object.freeze({
    projectId: state.projectId,
    projectDigest: state.projectDigest,
    proposalId: state.proposalId,
    changesDigest: state.changesDigest,
    issuedAt: state.issuedAt,
    expiresAt: state.expiresAt,
    changes: state.changes
  });
}
