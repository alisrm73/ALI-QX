import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProjectDraft,
  submitProjectForReview,
  approveProjectDraft
} from "../src/project-model.js";
import { createProjectDiagnostic } from "../src/project-diagnostics.js";
import { createProjectRepairProposal } from "../src/project-repair.js";
import {
  authorizeProjectRepair,
  requestProjectRepairApproval
} from "../src/project-repair-authorization.js";
import { executeProjectRepair } from "../src/project-repair-execution.js";
import {
  openProjectWorkspace,
  readProjectFile
} from "../src/project-workspace.js";

function sha256(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

test("integrates diagnostic, reviewed proposal, explicit host approval, safe repair, and post-repair test", async t => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qx-repair-lifecycle-"));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const projectRoot = path.join(temporaryRoot, "project");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });

  const before = "const ready = false;\n";
  const after = "const ready = true;\n";
  const relativePath = "src/app.js";
  await fs.writeFile(path.join(projectRoot, relativePath), before, "utf8");

  const draft = createProjectDraft({
    projectId: "repair-lifecycle-integration",
    title: "Repair lifecycle integration",
    description: "A static project used to verify the complete repair lifecycle",
    requirements: ["The application readiness flag must be true"],
    pages: [{ id: "home", title: "Home", description: "Repair lifecycle fixture" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  const project = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const workspace = await openProjectWorkspace({
    root: projectRoot,
    projectId: project.projectId
  });

  // Capture a real failing assertion as the source of the diagnostic.
  let originalTestError;
  try {
    assert.match(before, /const ready = true;/);
  } catch (error) {
    originalTestError = error;
  }
  assert.ok(originalTestError, "the fixture must begin with a failing test");

  const diagnostic = createProjectDiagnostic({
    error: originalTestError,
    phase: "test",
    source: "repair lifecycle integration test",
    certainty: "confirmed",
    filePath: relativePath,
    evidence: [{
      kind: "test_assertion",
      message: "The readiness assertion failed against the original file content"
    }]
  });

  const proposal = createProjectRepairProposal({
    diagnostic,
    projectDigest: project.digest,
    basis: "The failing assertion and inspected file content identify the readiness flag as false.",
    risk: "low",
    changes: [{
      filePath: relativePath,
      scope: "Change only the readiness flag from false to true.",
      rationale: "The file content directly contradicts the required readiness assertion."
    }],
    tests: [{
      name: "readiness assertion",
      purpose: "Re-read the repaired file from Workspace and assert that readiness is true."
    }]
  });

  const changes = [{
    relativePath,
    mode: "replace",
    content: after,
    expectedContentDigest: sha256(before)
  }];

  const approvalKeys = generateKeyPairSync("ed25519");
  const approvalPublicKeyPem = approvalKeys.publicKey.export({
    type: "spki",
    format: "pem"
  }).toString();
  const previousPublicKey = process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY;
  process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY = approvalPublicKeyPem;

  try {
    const approval = await requestProjectRepairApproval({
      project,
      expectedProjectDigest: project.digest,
      proposal,
      changes,
      requestExplicitUserApproval: async request => {
        // This callback is a test double for the trusted host boundary. It
        // verifies the exact material presented before signing the challenge.
        assert.equal(request.action, "project_repair");
        assert.equal(request.proposal.id, proposal.id);
        assert.equal(request.proposal.projectDigest, project.digest);
        assert.deepEqual(request.changes.map(change => ({
          relativePath: change.relativePath,
          mode: change.mode,
          content: change.content,
          expectedContentDigest: change.expectedContentDigest
        })), changes);
        return {
          approved: true,
          signature: sign(
            null,
            Buffer.from(request.serializedChallenge, "utf8"),
            approvalKeys.privateKey
          ).toString("base64url")
        };
      }
    });

    const authorization = authorizeProjectRepair({
      project,
      expectedProjectDigest: project.digest,
      proposal,
      changes,
      approval
    });

    const repairResult = await executeProjectRepair({
      authorization,
      workspace,
      project,
      expectedProjectDigest: project.digest
    });

    assert.equal(repairResult.status, "applied");
    assert.equal(repairResult.failure, null);
    assert.deepEqual(repairResult.writes.map(write => write.relativePath), [relativePath]);
    assert.deepEqual(repairResult.fileEvidence, [{
      relativePath,
      expectedContentDigest: sha256(before),
      contentMatch: true,
      postContentDigest: sha256(after),
      status: "applied"
    }]);

    // Re-read through Workspace after the write; do not test the in-memory
    // proposed content as a substitute for the actual persisted file.
    const persisted = await readProjectFile(workspace, {
      project,
      expectedProjectDigest: project.digest,
      relativePath
    });
    const persistedContent = persisted.content.toString("utf8");
    assert.equal(persisted.contentDigest, sha256(after));
    assert.match(persistedContent, /const ready = true;/);

    // The same assertion that failed before repair must now pass.
    assert.doesNotThrow(() => assert.match(persistedContent, /const ready = true;/));
  } finally {
    if (previousPublicKey === undefined) {
      delete process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY;
    } else {
      process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY = previousPublicKey;
    }
  }
});
