import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import { createBuildPlan } from "../src/build-plan.js";
import { createProjectDiagnostic } from "../src/project-diagnostics.js";
import { createProjectRepairProposal } from "../src/project-repair.js";
import {
  requestProjectRepairApproval, authorizeProjectRepair
} from "../src/project-repair-authorization.js";
import { executeProjectRepairAndVerify } from "../src/project-repair-verification.js";
import { openProjectWorkspace, readProjectFile } from "../src/project-workspace.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const previousKey = process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY;
process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY = publicKey;

test.after(() => {
  if (previousKey === undefined) delete process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY;
  else process.env.QX_PROJECT_REPAIR_APPROVAL_PUBLIC_KEY = previousKey;
});

function sha(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qx-repair-verify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  const before = "export const ready = false;\n";
  const after = "export const ready = true;\n";
  await fs.writeFile(path.join(root, "src/app.js"), before);
  const draft = createProjectDraft({
    projectId: "repair-verification-demo",
    title: "Repair verification demo",
    description: "Verify a repair before reporting success",
    requirements: ["Readiness must be true"],
    pages: [{ id: "home", title: "Home" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  const project = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const buildPlan = createBuildPlan(project, {
    externalInputs: ["source"],
    tasks: [{ id: "compile", dependsOn: [], inputs: ["source"], outputs: ["compiled"] }]
  });
  const workspace = await openProjectWorkspace({ root, projectId: project.projectId });
  const diagnostic = createProjectDiagnostic({
    error: new Error("Readiness assertion failed"),
    phase: "test",
    source: "repair verification test",
    certainty: "confirmed",
    filePath: "src/app.js"
  });
  const proposal = createProjectRepairProposal({
    diagnostic,
    projectDigest: project.digest,
    basis: "The readiness assertion identifies the incorrect flag.",
    changes: [{
      filePath: "src/app.js",
      scope: "Set readiness to true.",
      rationale: "The required assertion expects true."
    }],
    tests: [{ name: "readiness", purpose: "Verify persisted readiness." }]
  });
  const changes = [{
    relativePath: "src/app.js",
    mode: "replace",
    content: after,
    expectedContentDigest: sha(before)
  }];
  const approval = await requestProjectRepairApproval({
    project,
    expectedProjectDigest: project.digest,
    proposal,
    changes,
    requestExplicitUserApproval: async request => ({
      approved: true,
      signature: sign(null, Buffer.from(request.serializedChallenge), keys.privateKey)
        .toString("base64url")
    })
  });
  const authorization = authorizeProjectRepair({
    project,
    expectedProjectDigest: project.digest,
    proposal,
    changes,
    approval
  });
  return { root, project, buildPlan, workspace, authorization, after };
}

function runArgs(fixture, executor, overrides = {}) {
  return {
    authorization: fixture.authorization,
    workspace: fixture.workspace,
    project: fixture.project,
    expectedProjectDigest: fixture.project.digest,
    buildPlan: fixture.buildPlan,
    testCases: [{
      id: "component.readiness",
      level: "component",
      title: "Persisted readiness",
      required: true,
      artifactIds: ["compiled"]
    }],
    testCapabilities: ["component"],
    testExecutors: { component: executor },
    ...overrides
  };
}

test("reports verified only after the complete required test suite passes against persisted files", async t => {
  const fixture = await setup(t);
  const result = await executeProjectRepairAndVerify(runArgs(fixture, async context => {
    assert.equal(context.fileDigests["src/app.js"], sha(fixture.after));
    const persisted = await readProjectFile(fixture.workspace, {
      project: fixture.project,
      expectedProjectDigest: fixture.project.digest,
      relativePath: "src/app.js"
    });
    assert.equal(persisted.content.toString("utf8"), fixture.after);
    return { status: "passed", summary: "Persisted readiness is true" };
  }));
  assert.equal(result.status, "verified");
  assert.equal(result.repairReport.status, "applied");
  assert.equal(result.smartTestReport.status, "passed");
  assert.ok(result.digest.startsWith("sha256:"));
});

test("does not report verified when a required test fails", async t => {
  const fixture = await setup(t);
  const result = await executeProjectRepairAndVerify(runArgs(fixture, async () => ({
    status: "failed", summary: "Readiness regression remains", reason: "Assertion failed"
  })));
  assert.equal(result.status, "verification_failed");
  assert.equal(result.repairReport.status, "applied");
  assert.equal(result.smartTestReport.summary.requiredUnsuccessful, 1);
});

test("does not report verified when a required adapter is unavailable", async t => {
  const fixture = await setup(t);
  const result = await executeProjectRepairAndVerify(runArgs(fixture, async () => ({
    status: "passed", summary: "unused"
  }), { testCapabilities: [], testExecutors: {} }));
  assert.equal(result.status, "verification_incomplete");
  assert.equal(result.smartTestReport.status, "incomplete");
  assert.equal(result.smartTestReport.summary.skipped, 1);
});

test("does not run tests or report verified when repair writing fails", async t => {
  const fixture = await setup(t);
  await fs.rm(path.join(fixture.root, "src/app.js"));
  await fs.mkdir(path.join(fixture.root, "src/app.js"));
  let testCalled = false;
  const result = await executeProjectRepairAndVerify(runArgs(fixture, async () => {
    testCalled = true;
    return { status: "passed", summary: "Must not run" };
  }));
  assert.equal(testCalled, false);
  assert.equal(result.status, "repair_failed");
  assert.equal(result.smartTestReport, null);
});

test("rejects invalid test configuration before consuming repair authorization", async t => {
  const fixture = await setup(t);
  await assert.rejects(executeProjectRepairAndVerify(runArgs(fixture, async () => ({
    status: "passed", summary: "unused"
  }), { testTimeoutMs: 0 })), { code: "QX_SMART_TEST_TIMEOUT_INVALID" });
  const result = await executeProjectRepairAndVerify(runArgs(fixture, async () => ({
    status: "passed", summary: "Readiness verified"
  })));
  assert.equal(result.status, "verified");
});

test("classifies cancellation during verification separately from a successful repair", async t => {
  const fixture = await setup(t);
  const controller = new AbortController();
  const result = await executeProjectRepairAndVerify(runArgs(fixture, async () => {
    controller.abort(new Error("Host cancelled"));
    return new Promise(() => {});
  }, { signal: controller.signal }));
  assert.equal(result.status, "verification_cancelled");
  assert.equal(result.repairReport.status, "applied");
  assert.equal(result.smartTestReport.status, "cancelled");
});
