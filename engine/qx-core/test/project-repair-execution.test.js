import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import { createProjectDiagnostic } from "../src/project-diagnostics.js";
import { createProjectRepairProposal } from "../src/project-repair.js";
import {
  authorizeProjectRepair,
  createProjectRepairChangeSetDigest
} from "../src/project-repair-authorization.js";
import { executeProjectRepair } from "../src/project-repair-execution.js";
import { openProjectWorkspace } from "../src/project-workspace.js";

function sha(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

async function fixture(t, fileContents = { "src/app.js": "before" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qx-repair-execution-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  for (const [relativePath, content] of Object.entries(fileContents)) {
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), content);
  }
  const draft = createProjectDraft({
    projectId: "repair-execution-demo",
    title: "Repair execution demo",
    description: "A project for repair authorization tests",
    requirements: ["A home page is available"],
    pages: [{ id: "home", title: "Home" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  const project = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const workspace = await openProjectWorkspace({ root, projectId: project.projectId });
  const diagnostic = createProjectDiagnostic({
    error: Object.assign(new Error("Unexpected token"), { code: "QX2005" }),
    phase: "parser",
    source: "QX parser",
    certainty: "confirmed"
  });
  return { root, project, workspace, diagnostic };
}

function proposalFor(project, paths) {
  return createProjectRepairProposal({
    diagnostic: createProjectDiagnostic({
      error: Object.assign(new Error("Unexpected token"), { code: "QX2005" }),
      phase: "parser",
      source: "QX parser",
      certainty: "confirmed"
    }),
    projectDigest: project.digest,
    basis: "The diagnostic identifies the source file requiring a bounded correction.",
    changes: paths.map(filePath => ({
      filePath,
      scope: "Replace the diagnosed file with the reviewed correction.",
      rationale: "The proposed change is limited to the named file."
    })),
    tests: [{ name: "repair regression", purpose: "Verify the corrected file." }]
  });
}

function authorize(project, proposal, changes, options = {}) {
  const changesDigest = createProjectRepairChangeSetDigest(changes);
  return authorizeProjectRepair({
    project,
    expectedProjectDigest: project.digest,
    proposal,
    changes,
    ...options,
    approval: {
      confirmed: true,
      proposalId: proposal.id,
      projectDigest: project.digest,
      changesDigest
    }
  });
}

test("requires an explicit host confirmation bound to the exact proposal and change digest", async t => {
  const { project } = await fixture(t);
  const proposal = proposalFor(project, ["src/app.js"]);
  const changes = [{
    relativePath: "src/app.js",
    mode: "replace",
    content: "after",
    expectedContentDigest: sha("before")
  }];
  const changesDigest = createProjectRepairChangeSetDigest(changes);
  assert.throws(() => authorizeProjectRepair({
    project,
    expectedProjectDigest: project.digest,
    proposal,
    changes,
    approval: {
      confirmed: false,
      proposalId: proposal.id,
      projectDigest: project.digest,
      changesDigest
    }
  }), { code: "QX_PROJECT_REPAIR_APPROVAL_REQUIRED" });
  assert.throws(() => authorizeProjectRepair({
    project,
    expectedProjectDigest: project.digest,
    proposal,
    changes,
    approval: {
      confirmed: true,
      proposalId: proposal.id,
      projectDigest: project.digest,
      changesDigest: sha("different")
    }
  }), { code: "QX_PROJECT_REPAIR_APPROVAL_MISMATCH" });
});

test("applies an approved repair through Workspace and consumes authorization once", async t => {
  const { root, project, workspace } = await fixture(t);
  const proposal = proposalFor(project, ["src/app.js"]);
  const changes = [{
    relativePath: "src/app.js",
    mode: "replace",
    content: "after",
    expectedContentDigest: sha("before")
  }];
  const authorization = authorize(project, proposal, changes);
  const result = await executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest
  });
  assert.equal(result.status, "applied");
  assert.equal(result.writes.length, 1);
  assert.ok(result.writes[0].backupId);
  assert.equal(await fs.readFile(path.join(root, "src/app.js"), "utf8"), "after");
  await assert.rejects(executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest
  }), { code: "QX_PROJECT_REPAIR_AUTHORIZATION_INVALID" });
});

test("rejects a changed file after approval without overwriting the new content", async t => {
  const { root, project, workspace } = await fixture(t);
  const proposal = proposalFor(project, ["src/app.js"]);
  const changes = [{
    relativePath: "src/app.js",
    mode: "replace",
    content: "approved repair",
    expectedContentDigest: sha("before")
  }];
  const authorization = authorize(project, proposal, changes);
  await fs.writeFile(path.join(root, "src/app.js"), "external change");
  const result = await executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "QX_WORKSPACE_CONTENT_STALE");
  assert.equal(await fs.readFile(path.join(root, "src/app.js"), "utf8"), "external change");
});

test("reports partial application and stops after the first failed file", async t => {
  const { root, project, workspace } = await fixture(t, {
    "src/first.js": "first-before",
    "src/second.js": "second-before"
  });
  const proposal = proposalFor(project, ["src/first.js", "src/second.js"]);
  const changes = [
    {
      relativePath: "src/first.js", mode: "replace", content: "first-after",
      expectedContentDigest: sha("first-before")
    },
    {
      relativePath: "src/second.js", mode: "replace", content: "second-after",
      expectedContentDigest: sha("approved-old-content")
    }
  ];
  const authorization = authorize(project, proposal, changes);
  const result = await executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest
  });
  assert.equal(result.status, "partial");
  assert.equal(result.writes.length, 1);
  assert.equal(result.failure.code, "QX_WORKSPACE_CONTENT_STALE");
  assert.deepEqual(result.remainingPaths, []);
  assert.equal(await fs.readFile(path.join(root, "src/first.js"), "utf8"), "first-after");
  assert.equal(await fs.readFile(path.join(root, "src/second.js"), "utf8"), "second-before");
});

test("rejects forged authorization objects and proposal path mismatches", async t => {
  const { project, workspace } = await fixture(t);
  await assert.rejects(executeProjectRepair({
    authorization: Object.freeze({ projectDigest: project.digest }),
    workspace, project, expectedProjectDigest: project.digest
  }), { code: "QX_PROJECT_REPAIR_AUTHORIZATION_INVALID" });
  const proposal = proposalFor(project, ["src/app.js"]);
  assert.throws(() => authorize(project, proposal, [{
    relativePath: "src/other.js", mode: "replace", content: "after",
    expectedContentDigest: sha("before")
  }]), { code: "QX_PROJECT_REPAIR_AUTHORIZATION_INVALID" });
});


test("expires repair authorization and requires a fresh approval", async t => {
  const { project, workspace } = await fixture(t);
  const proposal = proposalFor(project, ["src/app.js"]);
  const changes = [{
    relativePath: "src/app.js",
    mode: "replace",
    content: "after",
    expectedContentDigest: sha("before")
  }];
  const authorization = authorize(project, proposal, changes, { expiresInMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest
  }), { code: "QX_PROJECT_REPAIR_AUTHORIZATION_EXPIRED" });
});


test("cancels before the first write without changing any file", async t => {
  const { root, project, workspace } = await fixture(t, {
    "src/first.js": "first-before",
    "src/second.js": "second-before"
  });
  const proposal = proposalFor(project, ["src/first.js", "src/second.js"]);
  const changes = [
    {
      relativePath: "src/first.js", mode: "replace", content: "first-after",
      expectedContentDigest: sha("first-before")
    },
    {
      relativePath: "src/second.js", mode: "replace", content: "second-after",
      expectedContentDigest: sha("second-before")
    }
  ];
  const authorization = authorize(project, proposal, changes);
  const controller = new AbortController();
  controller.abort();

  const result = await executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest,
    signal: controller.signal
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.failure.code, "QX_PROJECT_REPAIR_CANCELLED");
  assert.equal(result.writes.length, 0);
  assert.deepEqual(result.remainingPaths, ["src/first.js", "src/second.js"]);
  assert.equal(await fs.readFile(path.join(root, "src/first.js"), "utf8"), "first-before");
  assert.equal(await fs.readFile(path.join(root, "src/second.js"), "utf8"), "second-before");
  await assert.rejects(executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest
  }), { code: "QX_PROJECT_REPAIR_AUTHORIZATION_INVALID" });
});

test("stops between file writes after cooperative cancellation and reports partial application", async t => {
  const { root, project, workspace } = await fixture(t, {
    "src/first.js": "first-before",
    "src/second.js": "second-before"
  });
  const proposal = proposalFor(project, ["src/first.js", "src/second.js"]);
  const changes = [
    {
      relativePath: "src/first.js", mode: "replace", content: "first-after",
      expectedContentDigest: sha("first-before")
    },
    {
      relativePath: "src/second.js", mode: "replace", content: "second-after",
      expectedContentDigest: sha("second-before")
    }
  ];
  const authorization = authorize(project, proposal, changes);
  let reads = 0;
  const signal = {
    get aborted() {
      reads += 1;
      // The executor validates the signal once before entering the write loop.
      return reads >= 3;
    }
  };

  const result = await executeProjectRepair({
    authorization, workspace, project, expectedProjectDigest: project.digest,
    signal
  });

  assert.equal(result.status, "partial");
  assert.equal(result.failure.code, "QX_PROJECT_REPAIR_CANCELLED");
  assert.equal(result.writes.length, 1);
  assert.deepEqual(result.remainingPaths, ["src/second.js"]);
  assert.equal(await fs.readFile(path.join(root, "src/first.js"), "utf8"), "first-after");
  assert.equal(await fs.readFile(path.join(root, "src/second.js"), "utf8"), "second-before");
});
