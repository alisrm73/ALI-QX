import { analyzeProjectIdea } from "./idea-analyzer.js";
import { analyzeProjectIdeaDetails } from "./idea-analysis-details.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export class QXIdeaReviewPackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QXIdeaReviewPackageError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new QXIdeaReviewPackageError(code, message);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function normalized(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

function overlaps(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  return a === b || a.includes(b) || b.includes(a);
}

function createConsistency(project, report) {
  const evidence = [
    ...report.functions.flatMap(item => item.evidence),
    ...report.userFlows.flatMap(item => item.evidence),
    ...report.businessRules.flatMap(item => item.evidence),
    ...report.design.evidence
  ];

  const projectRequirements = [
    ...project.requirements.map((text, index) => ({ id: "requirement-" + index, text })),
    ...project.dataRequirements.map((text, index) => ({ id: "data-" + index, text })),
    ...project.integrationRequirements.map((text, index) => ({ id: "integration-" + index, text }))
  ];

  const projectStatements = [
    ...projectRequirements,
    ...project.pages.flatMap(page => [
      { id: "page-" + page.id + "-title", text: page.title },
      ...(page.description ? [{ id: "page-" + page.id + "-description", text: page.description }] : [])
    ])
  ];

  const unmatchedProjectRequirements = projectRequirements
    .filter(item => !evidence.some(fragment => overlaps(item.text, fragment)))
    .map(item => ({ id: item.id, text: item.text }));

  const detailedItems = [
    ...report.functions.map(item => ({ id: item.id, type: "function", label: item.name, evidence: item.evidence })),
    ...report.userFlows.map(item => ({ id: item.id, type: "userFlow", label: item.name, evidence: item.evidence })),
    ...report.businessRules.map(item => ({ id: item.id, type: "businessRule", label: item.statement, evidence: item.evidence })),
    ...report.design.visualDirection.map((label, index) => ({
      id: "design-visual-" + index, type: "design", label, evidence: report.design.evidence
    })),
    ...report.design.layoutRequirements.map((label, index) => ({
      id: "design-layout-" + index, type: "design", label, evidence: report.design.evidence
    })),
    ...report.design.accessibilityRequirements.map((label, index) => ({
      id: "design-accessibility-" + index, type: "design", label, evidence: report.design.evidence
    }))
  ];

  const unmatchedDetailedItems = detailedItems
    .filter(item => !item.evidence.some(fragment =>
      projectStatements.some(statement => overlaps(fragment, statement.text))))
    .map(({ id, type, label }) => ({ id, type, label }));

  const openQuestions = [
    ...project.openQuestions.map(question => ({ source: "project", question })),
    ...report.openQuestions.map(question => ({ source: "details", question }))
  ];

  return freezeDeep({
    comparisonMethod: "normalized_text_overlap_only",
    unmatchedProjectRequirements,
    unmatchedDetailedItems,
    conflicts: report.conflicts,
    openQuestions
  });
}

/**
 * Runs both existing idea-analysis contracts and packages their immutable results.
 * Text-overlap findings are review hints only; they never resolve semantic differences.
 */
export async function analyzeProjectIdeaReviewPackage({
  projectId,
  idea,
  analyzeProject,
  analyzeDetails,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof analyzeProject !== "function" || typeof analyzeDetails !== "function") {
    fail("QX_IDEA_REVIEW_ANALYZERS_REQUIRED", "Trusted project and detailed analyzers are both required");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    fail("QX_IDEA_REVIEW_INVALID_INPUT", "timeoutMs must be an integer between 1 and 120000");
  }

  const [projectResult, detailsResult] = await Promise.all([
    analyzeProjectIdea({ projectId, idea, analyze: analyzeProject, timeoutMs }),
    analyzeProjectIdeaDetails({ idea, analyze: analyzeDetails, timeoutMs })
  ]);

  if (projectResult.ideaDigest !== detailsResult.ideaDigest) {
    fail("QX_IDEA_REVIEW_DIGEST_MISMATCH", "Project and detailed analysis must refer to the same normalized idea");
  }

  return freezeDeep({
    schemaVersion: "1.0.0",
    ideaDigest: projectResult.ideaDigest,
    project: projectResult.project,
    diagnostics: projectResult.diagnostics,
    details: detailsResult.report,
    consistency: createConsistency(projectResult.project, detailsResult.report),
    status: projectResult.status
  });
}
