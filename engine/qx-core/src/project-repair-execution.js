import { QXProjectError } from "./project-model.js";
import { writeProjectFile } from "./project-workspace.js";
import { consumeProjectRepairAuthorization } from "./project-repair-authorization.js";

function failure(error, relativePath) {
  return Object.freeze({
    relativePath,
    code: typeof error?.code === "string" && error.code.startsWith("QX_")
      ? error.code : "QX_PROJECT_REPAIR_EXECUTION_FAILED",
    message: error instanceof QXProjectError
      ? error.message.slice(0, 1000)
      : "Workspace operation failed; inspect the workspace result before retrying"
  });
}

function assertAbortSignal(signal) {
  if (signal !== undefined && signal !== null &&
      (typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
    throw new QXProjectError("QX_PROJECT_REPAIR_SIGNAL_INVALID",
      "signal must be an AbortSignal-compatible object");
  }
}

function cancellationFailure(relativePath) {
  return Object.freeze({
    relativePath,
    code: "QX_PROJECT_REPAIR_CANCELLED",
    message: "Repair execution was cancelled before the next file write"
  });
}

/**
 * Applies a previously authorized, exact repair change set through Workspace.
 * Execution stops at the first failure or cooperative cancellation. Cancellation
 * is observed between file writes; an in-progress Workspace write is not interrupted.
 * Multi-file changes are not transactional.
 */
export async function executeProjectRepair({
  authorization,
  workspace,
  project,
  expectedProjectDigest,
  signal
} = {}) {
  assertAbortSignal(signal);
  const grant = consumeProjectRepairAuthorization(
    authorization, project, expectedProjectDigest
  );
  if (!workspace || typeof workspace !== "object") {
    throw new QXProjectError("QX_WORKSPACE_CONFIG_INVALID",
      "An opened project workspace is required for repair execution");
  }

  const writes = [];
  const fileEvidence = grant.changes.map(change => ({
    relativePath: change.relativePath,
    expectedContentDigest: change.expectedContentDigest,
    contentMatch: null,
    postContentDigest: null,
    status: "not_run"
  }));
  let failed = null;
  let cancelled = false;
  let remainingStart = 0;

  for (let index = 0; index < grant.changes.length; index += 1) {
    const change = grant.changes[index];
    const evidence = fileEvidence[index];
    if (signal?.aborted === true) {
      cancelled = true;
      evidence.status = "cancelled";
      failed = cancellationFailure(change.relativePath);
      remainingStart = index;
      break;
    }

    try {
      const result = await writeProjectFile(workspace, {
        project,
        expectedProjectDigest,
        relativePath: change.relativePath,
        content: change.content,
        expectedContentDigest: change.expectedContentDigest,
        permission: {
          operation: "write",
          relativePath: change.relativePath,
          approvedProjectDigest: project.digest,
          mode: change.mode
        }
      });
      evidence.contentMatch = true;
      evidence.postContentDigest = result.contentDigest;
      evidence.status = "applied";
      writes.push(Object.freeze({
        relativePath: result.relativePath,
        contentDigest: result.contentDigest,
        backupId: result.backupId,
        changeLogWarning: result.changeLogWarning ?? null
      }));
    } catch (error) {
      evidence.contentMatch = error?.code === "QX_WORKSPACE_CONTENT_STALE"
        ? false : null;
      evidence.status = "failed";
      failed = failure(error, change.relativePath);
      remainingStart = index + 1;
      break;
    }

    if (signal?.aborted === true && index + 1 < grant.changes.length) {
      cancelled = true;
      fileEvidence[index + 1].status = "cancelled";
      failed = cancellationFailure(grant.changes[index + 1].relativePath);
      remainingStart = index + 1;
      break;
    }
  }

  const status = cancelled
    ? (writes.length === 0 ? "cancelled" : "partial")
    : failed === null ? "applied" : writes.length === 0 ? "failed" : "partial";

  return Object.freeze({
    schemaVersion: "1.0.0",
    proposalId: grant.proposalId,
    projectDigest: grant.projectDigest,
    changesDigest: grant.changesDigest,
    status,
    writes: Object.freeze(writes),
    fileEvidence: Object.freeze(fileEvidence.map(entry => Object.freeze(entry))),
    failure: failed,
    remainingPaths: Object.freeze(
      grant.changes.slice(remainingStart).map(change => change.relativePath)
    )
  });
}
