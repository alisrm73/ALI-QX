import test from "node:test";
import assert from "node:assert/strict";
import {
  QXProjectError, createProjectDraft, submitProjectForReview,
  approveProjectDraft, rejectProjectDraft, reviseProjectDraft, assertProjectApproved
} from "../src/project-model.js";

function completeDraft(overrides = {}) {
  return createProjectDraft({
    projectId: "demo-site",
    title: "Demo site",
    description: "A small informational website",
    requirements: ["Visitors can read the overview"],
    pages: [{ id: "home", title: "Home", description: "Overview page" }],
    ...overrides
  });
}

test("creates a deterministic immutable project draft with a content digest", () => {
  const first = completeDraft(), second = completeDraft();
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.status, "draft");
  assert.equal(first.revision, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.pages[0]), true);
  assert.throws(() => { first.pages[0].title = "Changed"; }, TypeError);
});

test("rejects malformed manifests, duplicate page IDs, and unsupported fields", () => {
  assert.throws(() => completeDraft({ unexpected: true }), { name: "QXProjectError", code: "QX_PROJECT_INVALID" });
  assert.throws(() => completeDraft({ pages: [{ id: "home", title: "Home" }, { id: "home", title: "Duplicate" }] }), { code: "QX_PROJECT_INVALID" });
  assert.throws(() => createProjectDraft({ projectId: "bad id", title: "Demo", description: "Invalid ID" }), { code: "QX_PROJECT_INVALID" });
});

test("blocks review approval when requirements or pages are missing or questions remain", () => {
  const result = submitProjectForReview(completeDraft({ requirements: [], pages: [], openQuestions: ["Which audience should the site serve?"] }));
  assert.equal(result.project.status, "needs_clarification");
  assert.deepEqual(result.diagnostics.map(item => item.code), [
    "QX_PROJECT_REQUIREMENTS_MISSING", "QX_PROJECT_PAGES_MISSING", "QX_PROJECT_CLARIFICATION_REQUIRED"
  ]);
  assert.throws(() => approveProjectDraft(result.project, { approvedDigest: result.project.digest }), { code: "QX_PROJECT_APPROVAL_BLOCKED" });
});

test("allows review only after all required planning details are supplied", () => {
  const result = submitProjectForReview(completeDraft());
  assert.equal(result.project.status, "ready_for_review");
  assert.deepEqual(result.diagnostics, []);
});

test("requires explicit approval of the exact reviewed digest before build access", () => {
  const reviewed = submitProjectForReview(completeDraft()).project;
  assert.throws(() => assertProjectApproved(reviewed), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
  assert.throws(() => approveProjectDraft(reviewed, { approvedDigest: "sha256:stale" }), { code: "QX_PROJECT_APPROVAL_STALE" });
  const approved = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approval.digest, approved.digest);
  assert.equal(assertProjectApproved(approved), approved);
  assert.throws(() => assertProjectApproved(approved, { expectedDigest: "sha256:other" }), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
});

test("rejection records a reason and remains tied to the reviewed digest", () => {
  const reviewed = submitProjectForReview(completeDraft()).project;
  const rejected = rejectProjectDraft(reviewed, { reviewedDigest: reviewed.digest, reason: "The scope needs revision" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.approval.reason, "The scope needs revision");
  assert.throws(() => assertProjectApproved(rejected), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
});

test("revision increments the revision and invalidates an earlier approval", () => {
  const reviewed = submitProjectForReview(completeDraft()).project;
  const approved = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const revised = reviseProjectDraft(approved, { requirements: ["Visitors can read the overview", "Visitors can contact the team"] });
  assert.equal(revised.revision, 2);
  assert.equal(revised.status, "draft");
  assert.notEqual(revised.digest, approved.digest);
  assert.equal(revised.approval, null);
  assert.throws(() => assertProjectApproved(revised), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
});

test("rejects tampered manifests before review or approval", () => {
  const tampered = { ...completeDraft(), title: "Tampered" };
  assert.throws(() => submitProjectForReview(tampered), { name: "QXProjectError", code: "QX_PROJECT_INVALID" });
});

test("exposes typed project errors", () => {
  assert.throws(() => submitProjectForReview({}), error =>
    error instanceof QXProjectError && error.code === "QX_PROJECT_INVALID");
});
