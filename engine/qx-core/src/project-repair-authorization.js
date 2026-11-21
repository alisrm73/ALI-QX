import {
  createHash,
  createPublicKey,
  randomUUID,
  verify
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { assertProjectApproved, QXProjectError } from "./project-model.js";

const AUTHORIZATIONS = new WeakMap();
const PENDING_APPROVAL_CHALLENGES = new Map();
const MAX_CHANGES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_AUTHORIZATION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_APPROVAL_CHALLENGE_LIFETIME_MS = 2 * 60 * 1000;
const MAX_PENDING_APPROVAL_CHALLENGES = 1000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/;
const APPROVAL_PUBLIC_KEY_ENV = "QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY";

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

function assertChangesMatchProposal(proposal, normalizedChanges) {
  const proposalPaths = proposal.changes.map(change => change.filePath);
  if (normalizedChanges.length !== proposalPaths.length ||
      normalizedChanges.some((change, index) => change.relativePath !== proposalPaths[index])) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Approved change paths and order must exactly match the repair proposal");
  }
}

function assertChallengePayload(challenge) {
  const allowed = [
    "schemaVersion", "challengeId", "projectId",
    "projectDigest", "proposalId", "changesDigest"
  ];
  if (!plainObject(challenge) || Object.keys(challenge).length !== allowed.length ||
      Object.keys(challenge).some(key => !allowed.includes(key)) ||
      challenge.schemaVersion !== "1.0.0" ||
      typeof challenge.challengeId !== "string" || !UUID.test(challenge.challengeId) ||
      typeof challenge.projectId !== "string" || challenge.projectId.length === 0 ||
      typeof challenge.projectDigest !== "string" || !DIGEST.test(challenge.projectDigest) ||
      typeof challenge.proposalId !== "string" ||
      !/^qxrepair:[a-f0-9]{64}$/.test(challenge.proposalId) ||
      typeof challenge.changesDigest !== "string" || !DIGEST.test(challenge.changesDigest)) {
    fail("QX_PROJECT_REPAIR_APPROVAL_REQUIRED",
      "A valid host approval challenge and Ed25519 signature are required");
  }
}

function cleanupPendingChallenges(now) {
  for (const [challengeId, state] of PENDING_APPROVAL_CHALLENGES) {
    if (now >= state.expiresAt) PENDING_APPROVAL_CHALLENGES.delete(challengeId);
  }
}

function readTrustedApprovalPublicKey() {
  const pem = process.env[APPROVAL_PUBLIC_KEY_ENV];
  if (typeof pem !== "string" || pem.length === 0 || pem.length > 16 * 1024) {
    fail("QX_PROJECT_REPAIR_APPROVAL_KEY_REQUIRED",
      "The host must configure its trusted Ed25519 public key in " + APPROVAL_PUBLIC_KEY_ENV);
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    fail("QX_PROJECT_REPAIR_APPROVAL_KEY_INVALID",
      "The configured host approval public key is not valid PEM");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail("QX_PROJECT_REPAIR_APPROVAL_KEY_INVALID",
      "The configured host approval public key must use Ed25519");
  }
  return key;
}

/**
 * Creates a short-lived, process-local challenge for a trusted host.
 * The host must display the exact proposal and changes to the user, obtain
 * explicit confirmation, and sign the serialized challenge with its private
 * Ed25519 key. The private key must never be exposed to qx-core or the client.
 */
export function createProjectRepairApprovalChallenge({
  project,
  expectedProjectDigest,
  proposal,
  changes,
  expiresInMs = MAX_APPROVAL_CHALLENGE_LIFETIME_MS
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1 ||
      expiresInMs > MAX_APPROVAL_CHALLENGE_LIFETIME_MS) {
    fail("QX_PROJECT_REPAIR_APPROVAL_REQUIRED",
      "Approval challenge lifetime must be between 1 ms and 2 minutes");
  }
  assertProposal(proposal, project);
  const normalizedChanges = normalizeChanges(changes);
  assertChangesMatchProposal(proposal, normalizedChanges);
  const changesDigest = changeSetDigest(normalizedChanges);
  const issuedAt = performance.now();
  cleanupPendingChallenges(issuedAt);
  if (PENDING_APPROVAL_CHALLENGES.size >= MAX_PENDING_APPROVAL_CHALLENGES) {
    fail("QX_PROJECT_REPAIR_APPROVAL_CAPACITY",
      "Too many pending host approval challenges; retry after existing challenges expire");
  }

  const challenge = Object.freeze({
    schemaVersion: "1.0.0",
    challengeId: randomUUID(),
    projectId: project.projectId,
    projectDigest: project.digest,
    proposalId: proposal.id,
    changesDigest
  });
  PENDING_APPROVAL_CHALLENGES.set(challenge.challengeId, {
    serialized: canonicalJSON(challenge),
    issuedAt,
    expiresAt: issuedAt + expiresInMs,
    projectId: project.projectId,
    projectDigest: project.digest,
    proposalId: proposal.id,
    changesDigest,
    changes: normalizedChanges
  });
  return challenge;
}

/**
 * Returns the canonical UTF-8 text the host must sign with Ed25519.
 * The signature is supplied to authorizeProjectRepair as base64url.
 */
export function serializeProjectRepairApprovalChallenge(challenge) {
  assertChallengePayload(challenge);
  return canonicalJSON(challenge);
}

/**
 * Issues an opaque, single-use capability only after a pending challenge has
 * been signed by the trusted host key configured at process startup/runtime.
 * This verifies the host key holder, not a human click by itself: the host
 * application must sign only after its explicit user-confirmation event.
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
      Object.keys(approval).length !== 2 ||
      Object.keys(approval).some(key => !["challenge", "signature"].includes(key)) ||
      typeof approval.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(approval.signature)) {
    fail("QX_PROJECT_REPAIR_APPROVAL_REQUIRED",
      "A valid host approval challenge and Ed25519 signature are required");
  }
  assertChallengePayload(approval.challenge);

  const normalizedChanges = normalizeChanges(changes);
  assertChangesMatchProposal(proposal, normalizedChanges);
  const actualChangesDigest = changeSetDigest(normalizedChanges);
  const serializedChallenge = canonicalJSON(approval.challenge);
  const challengeState = PENDING_APPROVAL_CHALLENGES.get(approval.challenge.challengeId);
  if (!challengeState || performance.now() >= challengeState.expiresAt ||
      challengeState.serialized !== serializedChallenge) {
    if (challengeState && performance.now() >= challengeState.expiresAt) {
      PENDING_APPROVAL_CHALLENGES.delete(approval.challenge.challengeId);
      fail("QX_PROJECT_REPAIR_APPROVAL_CHALLENGE_EXPIRED",
        "Host approval challenge expired; request a new user confirmation");
    }
    fail("QX_PROJECT_REPAIR_APPROVAL_CHALLENGE_INVALID",
      "Host approval challenge is unknown, altered, or already consumed");
  }
  if (approval.challenge.projectId !== project.projectId ||
      approval.challenge.projectDigest !== project.digest ||
      approval.challenge.proposalId !== proposal.id ||
      approval.challenge.changesDigest !== actualChangesDigest ||
      challengeState.projectId !== project.projectId ||
      challengeState.projectDigest !== project.digest ||
      challengeState.proposalId !== proposal.id ||
      challengeState.changesDigest !== actualChangesDigest) {
    fail("QX_PROJECT_REPAIR_APPROVAL_MISMATCH",
      "Host approval does not match the current project, proposal, or exact change contents");
  }

  const publicKey = readTrustedApprovalPublicKey();
  const signature = Buffer.from(approval.signature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== approval.signature ||
      !verify(null, Buffer.from(serializedChallenge, "utf8"), publicKey, signature)) {
    fail("QX_PROJECT_REPAIR_APPROVAL_INVALID",
      "Host approval signature is invalid");
  }

  PENDING_APPROVAL_CHALLENGES.delete(approval.challenge.challengeId);
  const token = Object.freeze(Object.create(null));
  const issuedAt = performance.now();
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

/**
 * Requests approval through a trusted host callback. The callback contract is
 * to present the exact proposal and complete file contents to the user, obtain
 * an explicit human decision, and return a signature only after confirmation.
 * qx-core cannot prove that a UI click occurred; the host callback is a trusted
 * boundary and must not auto-approve or sign unattended.
 */
export async function requestProjectRepairApproval({
  project,
  expectedProjectDigest,
  proposal,
  changes,
  requestExplicitUserApproval,
  expiresInMs = MAX_APPROVAL_CHALLENGE_LIFETIME_MS
} = {}) {
  if (typeof requestExplicitUserApproval !== "function") {
    fail("QX_PROJECT_REPAIR_APPROVAL_REQUIRED",
      "A trusted host explicit-user-approval callback is required");
  }

  const challenge = createProjectRepairApprovalChallenge({
    project,
    expectedProjectDigest,
    proposal,
    changes,
    expiresInMs
  });
  const normalizedChanges = normalizeChanges(changes);
  const request = Object.freeze({
    schemaVersion: "1.0.0",
    action: "project_repair",
    challenge,
    serializedChallenge: serializeProjectRepairApprovalChallenge(challenge),
    proposal,
    changes: normalizedChanges
  });

  let response;
  try {
    response = await requestExplicitUserApproval(request);
  } catch {
    PENDING_APPROVAL_CHALLENGES.delete(challenge.challengeId);
    fail("QX_PROJECT_REPAIR_APPROVAL_FAILED",
      "The host approval request failed; no repair authorization was issued");
  }

  if (!plainObject(response) ||
      Object.keys(response).some(key => !["approved", "signature"].includes(key)) ||
      (response.approved !== true && response.approved !== false)) {
    PENDING_APPROVAL_CHALLENGES.delete(challenge.challengeId);
    fail("QX_PROJECT_REPAIR_APPROVAL_REQUIRED",
      "The host must return an explicit approval or denial decision");
  }
  if (response.approved !== true) {
    PENDING_APPROVAL_CHALLENGES.delete(challenge.challengeId);
    fail("QX_PROJECT_REPAIR_APPROVAL_DENIED",
      "The user did not approve the proposed repair");
  }
  if (typeof response.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(response.signature)) {
    PENDING_APPROVAL_CHALLENGES.delete(challenge.challengeId);
    fail("QX_PROJECT_REPAIR_APPROVAL_REQUIRED",
      "The host must sign the exact challenge after explicit user approval");
  }

  return Object.freeze({ challenge, signature: response.signature });
}

/** Internal capability consumption; deliberately not re-exported by index.js. */
export function consumeProjectRepairAuthorization(token, project, expectedProjectDigest) {
  const state = token && typeof token === "object" ? AUTHORIZATIONS.get(token) : null;
  if (!state || state.consumed) {
    fail("QX_PROJECT_REPAIR_AUTHORIZATION_INVALID",
      "Repair authorization is invalid or has already been consumed");
  }
  state.consumed = true;
  if (performance.now() >= state.expiresAt) {
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
