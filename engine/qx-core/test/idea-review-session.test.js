import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createProjectIdeaReviewSession,
  answerProjectIdeaReviewQuestion,
  decideProjectIdeaReviewItem,
  completeProjectIdeaReviewSession,
  reanalyzeProjectIdeaReviewSession,
  QXIdeaReviewSessionError
} from "../src/idea-review-session.js";

const idea = "Visitors can read community news. Editors can publish news.";

function digest(value) {
  return "sha256:" + createHash("sha256").update(value.trim(), "utf8").digest("hex");
}

function packageFor(source = idea) {
  return {
    schemaVersion: "1.0.0",
    ideaDigest: digest(source),
    project: {
      schemaVersion: "1.0.0",
      projectId: "community-site",
      status: "ready_for_review",
      requirements: ["Visitors can read community news"],
      approval: null
    },
    diagnostics: [],
    details: { functions: [], userFlows: [], businessRules: [], design: {}, conflicts: [] },
    consistency: {
      comparisonMethod: "normalized_text_overlap_only",
      unmatchedProjectRequirements: [
        { id: "requirement-1", text: "Admins can export reports" }
      ],
      unmatchedDetailedItems: [
        { id: "export-reports", type: "function", label: "Export reports" }
      ],
      conflicts: [
        { id: "publish-access", description: "Publishing access needs confirmation" }
      ],
      openQuestions: [
        { source: "project", question: "Which news categories are required?" },
        { source: "details", question: "Should visitors create accounts?" }
      ]
    },
    status: "ready_for_review"
  };
}

function projectAnalysis() {
  return {
    title: "Community website",
    description: "A website for community news.",
    requirements: ["Visitors can read community news"],
    pages: [{ id: "home", title: "Home", description: "Community news" }],
    dataRequirements: [],
    integrationRequirements: [],
    openQuestions: []
  };
}

function detailsAnalysis(source) {
  return {
    functions: [{
      id: "read-news",
      name: "Read news",
      description: "Visitors read community news.",
      actor: "Visitor",
      trigger: "Visitor opens the news page.",
      inputs: [],
      outputs: ["News content"],
      certainty: "explicit",
      evidence: [source.includes("Visitors can read community news")
        ? "Visitors can read community news"
        : "Readers can browse local updates"]
    }],
    userFlows: [],
    businessRules: [],
    design: {
      visualDirection: [],
      layoutRequirements: [],
      accessibilityRequirements: [],
      certainty: "unspecified",
      evidence: []
    },
    conflicts: [],
    openQuestions: []
  };
}

test("creates a frozen review session without granting approval or build authority", () => {
  const session = createProjectIdeaReviewSession({ reviewPackage: packageFor() });

  assert.equal(session.revision, 1);
  assert.equal(session.status, "awaiting_review");
  assert.equal(session.questions.length, 2);
  assert.equal(session.items.length, 3);
  assert.equal(session.approval, null);
  assert.equal(session.buildAuthorized, false);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.reviewPackage), true);
  assert.equal(Object.isFrozen(session.questions[0]), true);
  assert.equal(Object.isFrozen(session.items[0]), true);
});

test("records answers and decisions immutably, then completes only a fully reviewed session", () => {
  const original = createProjectIdeaReviewSession({ reviewPackage: packageFor() });
  const answered = answerProjectIdeaReviewQuestion({
    session: original,
    questionId: original.questions[0].id,
    answer: "Use local news categories."
  });
  assert.equal(original.questions[0].answer, null);
  assert.equal(answered.questions[0].answer, "Use local news categories.");

  let reviewed = answered;
  for (const item of reviewed.items) {
    reviewed = decideProjectIdeaReviewItem({
      session: reviewed,
      itemId: item.id,
      decision: "request_change",
      note: "Confirm this with the project owner."
    });
  }
  assert.throws(
    () => completeProjectIdeaReviewSession({ session: reviewed }),
    error => error.code === "QX_IDEA_REVIEW_SESSION_INCOMPLETE"
  );

  reviewed = answerProjectIdeaReviewQuestion({
    session: reviewed,
    questionId: reviewed.questions[1].id,
    answer: "Accounts are not required for visitors."
  });
  const completed = completeProjectIdeaReviewSession({ session: reviewed });

  assert.equal(completed.status, "review_completed");
  assert.equal(completed.approval, null);
  assert.equal(completed.buildAuthorized, false);
  assert.equal(reviewed.status, "awaiting_review");
  assert.equal(completed.reviewPackage.project.approval, null);
  assert.equal(Object.isFrozen(completed), true);
});

test("rejects unknown questions, items, and unsupported decisions", () => {
  const session = createProjectIdeaReviewSession({ reviewPackage: packageFor() });
  assert.throws(
    () => answerProjectIdeaReviewQuestion({ session, questionId: "missing", answer: "Answer" }),
    error => error.code === "QX_IDEA_REVIEW_SESSION_QUESTION_NOT_FOUND"
  );
  assert.throws(
    () => decideProjectIdeaReviewItem({ session, itemId: "missing", decision: "accept" }),
    error => error.code === "QX_IDEA_REVIEW_SESSION_ITEM_NOT_FOUND"
  );
  assert.throws(
    () => decideProjectIdeaReviewItem({
      session, itemId: session.items[0].id, decision: "approve"
    }),
    error => error.code === "QX_IDEA_REVIEW_SESSION_INVALID_DECISION"
  );
});

test("rejects malformed review packages and incomplete session structures", () => {
  assert.throws(
    () => createProjectIdeaReviewSession({ reviewPackage: { schemaVersion: "1.0.0" } }),
    error => error instanceof QXIdeaReviewSessionError &&
      error.code === "QX_IDEA_REVIEW_SESSION_INVALID_PACKAGE"
  );
  const session = createProjectIdeaReviewSession({ reviewPackage: packageFor() });
  assert.throws(
    () => completeProjectIdeaReviewSession({ session: { ...session, approval: { digest: session.ideaDigest } } }),
    error => error.code === "QX_IDEA_REVIEW_SESSION_INVALID_SESSION"
  );
});

test("reanalyzes only a changed idea and preserves the previous review record", async () => {
  const original = createProjectIdeaReviewSession({ reviewPackage: packageFor() });
  const answered = answerProjectIdeaReviewQuestion({
    session: original,
    questionId: original.questions[0].id,
    answer: "Use local news categories."
  });
  const decided = decideProjectIdeaReviewItem({
    session: answered,
    itemId: answered.items[0].id,
    decision: "request_change",
    note: "Add a clear export requirement."
  });
  await assert.rejects(
    reanalyzeProjectIdeaReviewSession({
      session: decided,
      idea,
      analyzeProject: async () => projectAnalysis(),
      analyzeDetails: async ({ idea: revised }) => detailsAnalysis(revised)
    }),
    error => error.code === "QX_IDEA_REVIEW_SESSION_IDEA_UNCHANGED"
  );

  const revisedIdea = "Readers can browse local updates. Editors can publish news.";
  let analyzerInput;
  const next = await reanalyzeProjectIdeaReviewSession({
    session: decided,
    idea: revisedIdea,
    analyzeProject: async request => {
      analyzerInput = request.idea;
      return {
        ...projectAnalysis(),
        requirements: ["Readers can browse local updates"]
      };
    },
    analyzeDetails: async request => detailsAnalysis(request.idea)
  });

  assert.equal(analyzerInput, revisedIdea);
  assert.equal(next.revision, 2);
  assert.notEqual(next.ideaDigest, decided.ideaDigest);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].responses[0].answer, "Use local news categories.");
  assert.equal(next.history[0].decisions[0].decision, "request_change");
  assert.equal(next.status, "awaiting_review");
  assert.equal(next.approval, null);
  assert.equal(next.buildAuthorized, false);
  assert.equal(decided.revision, 1);
  assert.equal(decided.reviewPackage.project.approval, null);
});
