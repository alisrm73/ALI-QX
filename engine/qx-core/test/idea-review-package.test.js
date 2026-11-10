import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeProjectIdeaReviewPackage,
  QXIdeaReviewPackageError
} from "../src/idea-review-package.js";

const idea = "Visitors can read community news. Editors can publish news.";

function projectAnalysis(overrides = {}) {
  return {
    title: "Community website",
    description: "A website for community news.",
    requirements: ["Visitors can read community news", "Editors can publish news"],
    pages: [{ id: "home", title: "Home", description: "Community news" }],
    dataRequirements: [],
    integrationRequirements: [],
    openQuestions: [],
    ...overrides
  };
}

function detailsAnalysis(overrides = {}) {
  return {
    functions: [{
      id: "read-news",
      name: "Read news",
      description: "Visitors read published news.",
      actor: "Visitor",
      trigger: "Visitor opens the news page.",
      inputs: ["Selected news item"],
      outputs: ["News content"],
      certainty: "explicit",
      evidence: ["Visitors can read community news"]
    }],
    userFlows: [{
      id: "browse-news",
      name: "Browse news",
      actor: "Visitor",
      steps: ["Open the news page", "Read a news item"],
      outcome: "News is displayed.",
      certainty: "explicit",
      evidence: ["Visitors can read community news"]
    }],
    businessRules: [{
      id: "publish-news",
      statement: "Editors may publish news.",
      certainty: "explicit",
      evidence: ["Editors can publish news"]
    }],
    design: {
      visualDirection: [],
      layoutRequirements: [],
      accessibilityRequirements: [],
      certainty: "unspecified",
      evidence: []
    },
    conflicts: [],
    openQuestions: [],
    ...overrides
  };
}

function callbacks(project = projectAnalysis(), details = detailsAnalysis()) {
  return {
    analyzeProject: async () => project,
    analyzeDetails: async () => details
  };
}

test("packages project draft and detailed report for the same idea", async () => {
  const result = await analyzeProjectIdeaReviewPackage({
    projectId: "community-site",
    idea,
    ...callbacks()
  });

  assert.equal(result.schemaVersion, "1.0.0");
  assert.match(result.ideaDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.project.status, "ready_for_review");
  assert.equal(result.status, "ready_for_review");
  assert.equal(result.details.functions[0].id, "read-news");
  assert.deepEqual(result.consistency.unmatchedProjectRequirements, []);
  assert.deepEqual(result.consistency.unmatchedDetailedItems, []);
  assert.equal(result.consistency.comparisonMethod, "normalized_text_overlap_only");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.consistency), true);
  assert.equal(Object.isFrozen(result.consistency.openQuestions), true);
  assert.equal(result.project.approval, null);
});

test("reports unmatched project requirements and detailed items without auto-resolving them", async () => {
  const project = projectAnalysis({
    requirements: ["Visitors can read community news", "Admins can export reports"]
  });
  const details = detailsAnalysis({
    businessRules: [{
      id: "publish-news",
      statement: "Editors may publish news.",
      certainty: "explicit",
      evidence: ["Editors can publish news"]
    }],
    conflicts: [{
      id: "news-conflict",
      description: "Publishing permissions need confirmation.",
      relatedItemIds: ["read-news"],
      question: "Who may publish news?",
      evidence: ["Visitors can read community news"]
    }],
    openQuestions: ["Should news be moderated?"]
  });

  const result = await analyzeProjectIdeaReviewPackage({
    projectId: "community-site",
    idea,
    ...callbacks(project, details)
  });

  assert.deepEqual(result.consistency.unmatchedProjectRequirements, [
    { id: "requirement-1", text: "Admins can export reports" }
  ]);
  assert.deepEqual(result.consistency.unmatchedDetailedItems, [
    { id: "publish-news", type: "businessRule", label: "Editors may publish news." }
  ]);
  assert.equal(result.consistency.conflicts[0].id, "news-conflict");
  assert.deepEqual(result.consistency.openQuestions, [
    { source: "details", question: "Should news be moderated?" }
  ]);
  assert.equal(result.status, "ready_for_review");
  assert.equal(result.project.approval, null);
});

test("keeps project and detailed-analysis clarification questions together", async () => {
  const project = projectAnalysis({ openQuestions: ["Which news categories are required?"] });
  const details = detailsAnalysis({ openQuestions: ["Should visitors create accounts?"] });

  const result = await analyzeProjectIdeaReviewPackage({
    projectId: "community-site",
    idea,
    ...callbacks(project, details)
  });

  assert.equal(result.status, "needs_clarification");
  assert.deepEqual(result.consistency.openQuestions, [
    { source: "project", question: "Which news categories are required?" },
    { source: "details", question: "Should visitors create accounts?" }
  ]);
});

test("requires both trusted analyzer callbacks and validates timeout", async () => {
  await assert.rejects(analyzeProjectIdeaReviewPackage({
    projectId: "community-site",
    idea,
    analyzeProject: async () => projectAnalysis()
  }), error => {
    assert.ok(error instanceof QXIdeaReviewPackageError);
    assert.equal(error.code, "QX_IDEA_REVIEW_ANALYZERS_REQUIRED");
    return true;
  });

  await assert.rejects(analyzeProjectIdeaReviewPackage({
    projectId: "community-site",
    idea,
    timeoutMs: 0,
    ...callbacks()
  }), { code: "QX_IDEA_REVIEW_INVALID_INPUT" });
});

test("preserves existing analyzer failures without converting them into a review package", async () => {
  await assert.rejects(analyzeProjectIdeaReviewPackage({
    projectId: "community-site",
    idea,
    analyzeProject: async () => { throw new Error("private host detail"); },
    analyzeDetails: async () => detailsAnalysis()
  }), error => {
    assert.equal(error.code, "QX_IDEA_ANALYSIS_FAILED");
    assert.equal(error.message.includes("private host detail"), false);
    return true;
  });
});
