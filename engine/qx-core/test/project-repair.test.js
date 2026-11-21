import test from "node:test";
import assert from "node:assert/strict";
import { createProjectDiagnostic } from "../src/project-diagnostics.js";
import {
  createProjectRepairProposal,
  PROJECT_REPAIR_RISKS
} from "../src/project-repair.js";

const projectDigest = "sha256:" + "a".repeat(64);

function diagnostic(certainty = "confirmed") {
  return createProjectDiagnostic({
    error: Object.assign(new Error("Unexpected token"), { code: "QX2005" }),
    phase: "parser",
    source: "QX parser",
    certainty
  });
}

function input(overrides = {}) {
  return {
    diagnostic: diagnostic(),
    projectDigest,
    basis: "The parser diagnostic identifies an unexpected token at the reported source location.",
    changes: [{
      filePath: "src/main.qx",
      scope: "Correct the malformed expression around the reported token.",
      lineRange: { startLine: 4, endLine: 4 },
      rationale: "The proposed edit is limited to the source range identified by the diagnostic."
    }],
    tests: [{
      name: "parser regression test",
      purpose: "Confirm the corrected source parses and the original parser error is absent."
    }],
    ...overrides
  };
}

test("creates an immutable review-only proposal tied to diagnostic and project digests", () => {
  const proposal = createProjectRepairProposal(input());
  assert.match(proposal.id, /^qxrepair:[a-f0-9]{64}$/);
  assert.equal(proposal.diagnosticId, diagnostic().id);
  assert.equal(proposal.projectDigest, projectDigest);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.application, "not_applied");
  assert.equal(proposal.changes[0].lineRange.startLine, 4);
  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.changes[0]), true);
});

test("proposal identifiers are stable for identical proposal content", () => {
  assert.equal(
    createProjectRepairProposal(input()).id,
    createProjectRepairProposal(input()).id
  );
});

test("rejects diagnostics that lack sufficient information", () => {
  assert.throws(() => createProjectRepairProposal(input({
    diagnostic: diagnostic("insufficient_information")
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
});

test("rejects malformed diagnostics and stale or malformed project digests", () => {
  assert.throws(() => createProjectRepairProposal(input({
    diagnostic: { id: "qxdiag:bad", certainty: "confirmed" }
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
  assert.throws(() => createProjectRepairProposal(input({
    projectDigest: "not-a-digest"
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
});

test("rejects unsafe paths, duplicate paths, and invalid line ranges", () => {
  assert.throws(() => createProjectRepairProposal(input({
    changes: [{ filePath: "../outside.js", scope: "edit", rationale: "unsafe" }]
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
  assert.throws(() => createProjectRepairProposal(input({
    changes: [
      { filePath: "src/main.qx", scope: "edit", rationale: "first" },
      { filePath: "src/main.qx", scope: "edit", rationale: "duplicate" }
    ]
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
  assert.throws(() => createProjectRepairProposal(input({
    changes: [{
      filePath: "src/main.qx", scope: "edit", rationale: "bad range",
      lineRange: { startLine: 0, endLine: 1 }
    }]
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
});

test("requires at least one explicit verification test", () => {
  assert.throws(() => createProjectRepairProposal(input({ tests: [] })),
    { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
});

test("enforces bounded change and test collections", () => {
  assert.throws(() => createProjectRepairProposal(input({
    changes: Array.from({ length: 21 }, (_, index) => ({
      filePath: "src/file" + index + ".qx",
      scope: "limited edit",
      rationale: "bounded test"
    }))
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
  assert.throws(() => createProjectRepairProposal(input({
    tests: Array.from({ length: 31 }, () => ({
      name: "test", purpose: "verify"
    }))
  })), { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
});

test("exposes only the documented risk levels", () => {
  assert.deepEqual(PROJECT_REPAIR_RISKS, ["low", "medium", "high"]);
  assert.throws(() => createProjectRepairProposal(input({ risk: "automatic" })),
    { code: "QX_PROJECT_REPAIR_PROPOSAL_INVALID" });
});
