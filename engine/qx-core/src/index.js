export { createProjectDiagnostic, createProjectDiagnostics, PROJECT_DIAGNOSTIC_PHASES, PROJECT_DIAGNOSTIC_CERTAINTIES } from "./project-diagnostics.js";
export { createProjectRepairProposal, PROJECT_REPAIR_RISKS } from "./project-repair.js";
export {
  authorizeProjectRepair,
  createProjectRepairApprovalChallenge,
  createProjectRepairChangeSetDigest,
  serializeProjectRepairApprovalChallenge,
  requestProjectRepairApproval
} from "./project-repair-authorization.js";
export { executeProjectRepair } from "./project-repair-execution.js";
export { executeProjectRepairAndVerify } from "./project-repair-verification.js";
export { GEOMETRIC_SYMBOLS, GEOMETRIC_SYMBOL_BY_GLYPH } from "./geometric-symbols.js";
export { Lexer, QXLexError, tokenize } from "./lexer.js";
export { Parser, QXParseError, parse } from "./parser.js";
export { COMMAND_DOMAINS, COMMAND_REGISTRY, isCommandEnabled, resolveCommand } from "./command-registry.js";
export { analyze } from "./semantic-analyzer.js";
export { lowerToQIR, validateQIR, serializeQIR, parseQIR } from "./qir.js";
export { runQIR, runQIRAsync, QXVMError } from "./vm.js";

export { buildWebProject, generateWebAssets, QXWebBuildError } from "./web-backend.js";
export { createIntegrationBroker, QXIntegrationError } from "./integration-broker.js";
export { QXUIRegistryError, createUIComponentRegistry } from "./ui-component-registry.js";
export {
  QXUIError,
  UI_TREE_LIMITS,
  createDefaultUILock,
  getUIComponentRegistry,
  validateUIComponentTree,
  validateUIComponentTreeWithRegistry
} from "./ui-component-runtime.js";

export {
  createUIComponentLifecycleRegistry,
  validateUIComponentTreeWithLifecycle
} from "./ui-component-lifecycle.js";

export { proposeUIComponentUpgrade } from "./ui-component-upgrade.js";
export { proposeUIComponentRollback } from "./ui-component-rollback.js";

export { generateQXSourceFromProject } from "./project-source-generator.js";
export { runProjectBuildWorkflow } from "./project-build-workflow.js";

export {
  QXProjectError,
  createProjectDraft,
  submitProjectForReview,
  approveProjectDraft,
  rejectProjectDraft,
  reviseProjectDraft,
  assertProjectApproved
} from "./project-model.js";

export {
  createBuildPlan,
  assertBuildPlanForProject,
  selectBuildTasks
} from "./build-plan.js";

export {
  openProjectWorkspace,
  readProjectFile,
  writeProjectFile,
  restoreProjectFile,
  readProjectChangeLog
} from "./project-workspace.js";

export {
  runProjectTestSuite,
  assertProjectTestReport
} from "./project-test-suite.js";

export {
  runProjectSmartTestRunner,
  assertProjectSmartTestRunnerConfig,
  assertProjectSmartTestReport
} from "./project-smart-test-runner.js";

export {
  createProjectDeliveryPackage,
  assertProjectDeliveryReport,
  assertProjectDeliveryPackage
} from "./project-delivery.js";

export {
  assertRequirementCoverageInput,
  createRequirementCoverageReport,
  assertRequirementCoverageReport
} from "./requirement-coverage.js";

export { analyzeProjectIdea, QXIdeaAnalysisError } from "./idea-analyzer.js";

export { analyzeProjectIdeaDetails, QXIdeaDetailsError } from "./idea-analysis-details.js";

export {
  analyzeProjectIdeaReviewPackage,
  QXIdeaReviewPackageError
} from "./idea-review-package.js";

export {
  createProjectIdeaReviewSession,
  answerProjectIdeaReviewQuestion,
  decideProjectIdeaReviewItem,
  completeProjectIdeaReviewSession,
  reanalyzeProjectIdeaReviewSession,
  QXIdeaReviewSessionError
} from "./idea-review-session.js";

export {
  createRequirementBuildMap,
  assertRequirementBuildMapForProject
} from "./requirement-build-map.js";

export {
  createBuildBlueprint,
  assertBuildBlueprintForProject
} from "./build-blueprint.js";

export { exportProjectDeliveryPackage, PROJECT_EXPORT_LIMITS } from "./project-export.js";
