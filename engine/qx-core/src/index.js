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
