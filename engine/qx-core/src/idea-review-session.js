import { createHash } from "node:crypto";
import { analyzeProjectIdeaReviewPackage } from "./idea-review-package.js";

const MAX_IDEA_BYTES = 32 * 1024;
const MAX_TEXT_LENGTH = 4000;
const DECISIONS = Object.freeze(["accept", "reject", "request_change"]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class QXIdeaReviewSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QXIdeaReviewSessionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new QXIdeaReviewSessionError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireText(value, field, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_INPUT", field + " must be non-empty bounded text");
  }
  return value.trim();
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneJSON(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_PACKAGE", "Review package must be serializable JSON data");
  }
  if (typeof serialized !== "string") {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_PACKAGE", "Review package must be serializable JSON data");
  }
  try {
    return JSON.parse(serialized);
  } catch {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_PACKAGE", "Review package must be valid JSON data");
  }
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function validateReviewPackage(value) {
  if (!isPlainObject(value) || value.schemaVersion !== "1.0.0" ||
      typeof value.ideaDigest !== "string" || !DIGEST_PATTERN.test(value.ideaDigest) ||
      !isPlainObject(value.project) || typeof value.project.projectId !== "string" ||
      !isPlainObject(value.details) || !isPlainObject(value.consistency) ||
      !Array.isArray(value.consistency.openQuestions) ||
      !Array.isArray(value.consistency.unmatchedProjectRequirements) ||
      !Array.isArray(value.consistency.unmatchedDetailedItems) ||
      !Array.isArray(value.consistency.conflicts)) {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_PACKAGE", "A valid unified idea review package is required");
  }
  return cloneJSON(value);
}

function questionId(question, index) {
  const source = requireText(question.source, "question.source", 32);
  const value = requireText(question.question, "question.question");
  const key = source + "\u0000" + String(index) + "\u0000" + value;
  const suffix = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
  return "question-" + index + "-" + suffix;
}

function buildQuestions(reviewPackage) {
  return reviewPackage.consistency.openQuestions.map((question, index) => {
    if (!isPlainObject(question)) {
      fail("QX_IDEA_REVIEW_SESSION_INVALID_PACKAGE", "Review questions must be plain objects");
    }
    return {
      id: questionId(question, index),
      source: question.source,
      question: question.question,
      answer: null
    };
  });
}

function buildItems(reviewPackage) {
  const items = [
    ...reviewPackage.consistency.unmatchedProjectRequirements.map(item => ({
      id: "project-requirement:" + requireText(item.id, "unmatched requirement id", 160),
      type: "project_requirement",
      label: requireText(item.text, "unmatched requirement text")
    })),
    ...reviewPackage.consistency.unmatchedDetailedItems.map(item => ({
      id: "detailed-item:" + requireText(item.id, "unmatched detailed item id", 160),
      type: "detailed_item",
      label: requireText(item.label, "unmatched detailed item label")
    })),
    ...reviewPackage.consistency.conflicts.map(item => ({
      id: "conflict:" + requireText(item.id, "conflict id", 160),
      type: "conflict",
      label: requireText(item.description, "conflict description")
    }))
  ];
  if (new Set(items.map(item => item.id)).size !== items.length) {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_PACKAGE", "Review item identifiers must be unique");
  }
  return items.map(item => ({ ...item, decision: null, note: null }));
}

function createSession(reviewPackage, { revision = 1, history = [] } = {}) {
  const snapshot = validateReviewPackage(reviewPackage);
  return freezeDeep({
    schemaVersion: "1.0.0",
    revision,
    ideaDigest: snapshot.ideaDigest,
    status: "awaiting_review",
    reviewPackage: snapshot,
    questions: buildQuestions(snapshot),
    items: buildItems(snapshot),
    history: cloneJSON(history),
    approval: null,
    buildAuthorized: false
  });
}

function validateSession(session) {
  if (!isPlainObject(session) || session.schemaVersion !== "1.0.0" ||
      !Number.isSafeInteger(session.revision) || session.revision < 1 ||
      !DIGEST_PATTERN.test(session.ideaDigest) ||
      !["awaiting_review", "review_completed"].includes(session.status) ||
      !Array.isArray(session.questions) || !Array.isArray(session.items) ||
      !Array.isArray(session.history) || !isPlainObject(session.reviewPackage) ||
      session.reviewPackage.ideaDigest !== session.ideaDigest ||
      session.approval !== null || session.buildAuthorized !== false) {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_SESSION", "Review session is malformed or violates its safety contract");
  }
}

function updateSession(session, changes) {
  validateSession(session);
  return freezeDeep({ ...session, ...changes });
}

/** Creates an immutable human-review session from an 8.3 review package. */
export function createProjectIdeaReviewSession({ reviewPackage } = {}) {
  return createSession(reviewPackage);
}

/** Records a user's answer without silently changing the project or resolving other questions. */
export function answerProjectIdeaReviewQuestion({ session, questionId: id, answer } = {}) {
  validateSession(session);
  const questionKey = requireText(id, "questionId", 160);
  const response = requireText(answer, "answer");
  const index = session.questions.findIndex(question => question.id === questionKey);
  if (index < 0) fail("QX_IDEA_REVIEW_SESSION_QUESTION_NOT_FOUND", "The requested review question does not exist");
  const questions = session.questions.map((question, itemIndex) =>
    itemIndex === index ? { ...question, answer: response } : question
  );
  return updateSession(session, { questions, status: "awaiting_review" });
}

/** Records a review decision only; it never mutates the project manifest or starts a build. */
export function decideProjectIdeaReviewItem({
  session,
  itemId,
  decision,
  note = ""
} = {}) {
  validateSession(session);
  const key = requireText(itemId, "itemId", 200);
  if (!DECISIONS.includes(decision)) {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_DECISION", "decision must be accept, reject, or request_change");
  }
  if (typeof note !== "string" || note.length > 1000) {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_INPUT", "note must be text of at most 1000 characters");
  }
  const index = session.items.findIndex(item => item.id === key);
  if (index < 0) fail("QX_IDEA_REVIEW_SESSION_ITEM_NOT_FOUND", "The requested review item does not exist");
  const items = session.items.map((item, itemIndex) =>
    itemIndex === index ? { ...item, decision, note: note.trim() } : item
  );
  return updateSession(session, { items, status: "awaiting_review" });
}

/** Completes the human review only after every question and review item has an explicit response. */
export function completeProjectIdeaReviewSession({ session } = {}) {
  validateSession(session);
  const unanswered = session.questions.filter(question => question.answer === null);
  const undecided = session.items.filter(item => item.decision === null);
  if (unanswered.length || undecided.length) {
    fail("QX_IDEA_REVIEW_SESSION_INCOMPLETE", "Every review question must be answered and every review item must have a decision");
  }
  return updateSession(session, { status: "review_completed" });
}

/**
 * Re-runs both trusted analyzers against a caller-supplied revised idea.
 * The caller must supply the complete revised idea; prior answers are retained in history,
 * never silently appended to or substituted into the new source text.
 */
export async function reanalyzeProjectIdeaReviewSession({
  session,
  idea,
  analyzeProject,
  analyzeDetails,
  timeoutMs
} = {}) {
  validateSession(session);
  const revisedIdea = requireText(idea, "idea", MAX_IDEA_BYTES);
  if (new TextEncoder().encode(revisedIdea).byteLength > MAX_IDEA_BYTES) {
    fail("QX_IDEA_REVIEW_SESSION_INVALID_INPUT", "idea exceeds the 32 KiB limit");
  }
  if (digest(revisedIdea) === session.ideaDigest) {
    fail("QX_IDEA_REVIEW_SESSION_IDEA_UNCHANGED", "Reanalysis requires a revised idea with a new content digest");
  }

  const reviewPackage = await analyzeProjectIdeaReviewPackage({
    projectId: session.reviewPackage.project.projectId,
    idea: revisedIdea,
    analyzeProject,
    analyzeDetails,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });

  const historyEntry = {
    revision: session.revision,
    ideaDigest: session.ideaDigest,
    status: session.status,
    responses: session.questions
      .filter(question => question.answer !== null)
      .map(({ id, source, question, answer }) => ({ id, source, question, answer })),
    decisions: session.items
      .filter(item => item.decision !== null)
      .map(({ id, type, decision, note }) => ({ id, type, decision, note }))
  };
  return createSession(reviewPackage, {
    revision: session.revision + 1,
    history: [...session.history, historyEntry]
  });
}
