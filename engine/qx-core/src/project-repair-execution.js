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

/**
 * Applies a previously authorized, exact repair change set through Workspace.
 * Execution stops at the first failure; multi-file changes are not transactional.
 */
export async function executeProjectRepair({
  authorization,
  workspace,
  project,
  expectedProjectDigest
} = {}) {
  const grant = consumeProjectRepairAuthorization(
    authorization, project, expectedProjectDigest
  );
  if (!workspace || typeof workspace !== "object") {
    throw new QXProjectError("QX_WORKSPACE_CONFIG_INVALID",
      "An opened project workspace is required for repair execution");
  }

  const writes = [];
  let failed = null;
  for (const change of grant.changes) {
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
      writes.push(Object.freeze({
        relativePath: result.relativePath,
        contentDigest: result.contentDigest,
        backupId: result.backupId,
        changeLogWarning: result.changeLogWarning ?? null
      }));
    } catch (error) {
      failed = failure(error, change.relativePath);
      break;
    }
  }

  const status = failed === null ? "applied" : writes.length === 0 ? "failed" : "partial";
  return Object.freeze({
    schemaVersion: "1.0.0",
    proposalId: grant.proposalId,
    projectDigest: grant.projectDigest,
    changesDigest: grant.changesDigest,
    status,
    writes: Object.freeze(writes),
    failure: failed,
    remainingPaths: Object.freeze(
      grant.changes.slice(writes.length + (failed ? 1 : 0)).map(change => change.relativePath)
    )
  });
}
