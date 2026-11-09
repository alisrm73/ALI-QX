import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { assertBuildPlanForProject } from "./build-plan.js";
import { buildWebProject } from "./web-backend.js";
import { generateQXSourceFromProject } from "./project-source-generator.js";
import { writeProjectFile } from "./project-workspace.js";
import { runProjectTestSuite } from "./project-test-suite.js";
import { createProjectDeliveryPackage } from "./project-delivery.js";

const OUTPUTS = Object.freeze([
  Object.freeze({ artifactId: "web-index", path: "dist/index.html", file: "index.html" }),
  Object.freeze({ artifactId: "web-css", path: "dist/styles.css", file: "styles.css" }),
  Object.freeze({ artifactId: "web-app", path: "dist/app.js", file: "app.js" })
]);

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function validateWritePermissions(permissions, project) {
  if (!Array.isArray(permissions) || permissions.length !== OUTPUTS.length) {
    fail("QX_WORKSPACE_PERMISSION_REQUIRED", "Exactly one explicit write permission is required for each generated web asset");
  }
  const byPath = new Map();
  for (const permission of permissions) {
    if (!permission || typeof permission !== "object" || Array.isArray(permission) ||
        Object.keys(permission).some(key => !["operation", "relativePath", "approvedProjectDigest", "mode"].includes(key)) ||
        permission.operation !== "write" ||
        !OUTPUTS.some(output => output.path === permission.relativePath) ||
        permission.approvedProjectDigest !== project.digest ||
        !["create", "replace"].includes(permission.mode) ||
        byPath.has(permission.relativePath)) {
      fail("QX_WORKSPACE_PERMISSION_REQUIRED", "Each generated asset requires one exact path-scoped create or replace permission for this approved project digest");
    }
    byPath.set(permission.relativePath, permission);
  }
  if (OUTPUTS.some(output => !byPath.has(output.path))) {
    fail("QX_WORKSPACE_PERMISSION_REQUIRED", "Write permissions must cover index.html, styles.css, and app.js");
  }
  return byPath;
}

/**
 * Runs the first integrated approved-manifest -> static-web -> test -> delivery path.
 * Workspace writes require explicit per-file permissions and existing parent directories.
 * Test behavior is delegated to the caller-provided executeTest callback.
 */
export async function runProjectBuildWorkflow({
  workspace,
  project,
  expectedProjectDigest,
  buildPlan,
  writePermissions,
  testCases,
  executeTest,
  scope = "all",
  changedArtifactIds = []
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertBuildPlanForProject(project, buildPlan);
  if (!workspace || typeof workspace !== "object") {
    fail("QX_WORKSPACE_CONFIG_INVALID", "An opened project workspace is required");
  }
  const permissions = validateWritePermissions(writePermissions, project);
  if (typeof executeTest !== "function" || !Array.isArray(testCases) || testCases.length === 0) {
    fail("QX_TEST_EXECUTOR_REQUIRED", "A non-empty test case list and caller-provided test executor are required before project files are written");
  }
  if (scope !== "all" && scope !== "affected") {
    fail("QX_TEST_REPORT_INVALID", "scope must be all or affected");
  }
  if (!Array.isArray(changedArtifactIds)) {
    fail("QX_TEST_REPORT_INVALID", "changedArtifactIds must be an array");
  }
  const producedArtifacts = new Set(buildPlan.tasks.flatMap(task => task.outputs));
  if (OUTPUTS.some(output => !producedArtifacts.has(output.artifactId))) {
    fail("QX_PROJECT_WORKFLOW_PLAN_INVALID", "Build plan must declare web-index, web-css, and web-app as produced artifacts");
  }

  const generated = generateQXSourceFromProject(project, {
    expectedProjectDigest
  });
  const webProject = buildWebProject(generated.qxSource, {
    title: project.title,
    uiLock: generated.uiLock
  });
  const writes = [];
  const fileDigests = {};
  for (const output of OUTPUTS) {
    const content = webProject.files[output.file];
    if (typeof content !== "string") {
      fail("QX_PROJECT_WORKFLOW_BUILD_INVALID", "Web backend did not produce the expected " + output.file + " asset");
    }
    const permission = permissions.get(output.path);
    const result = await writeProjectFile(workspace, {
      project,
      expectedProjectDigest,
      relativePath: output.path,
      content,
      permission
    });
    writes.push(result);
    fileDigests[output.path] = result.contentDigest;
  }

  const testReport = await runProjectTestSuite(project, buildPlan, {
    expectedProjectDigest,
    testCases,
    executeTest,
    fileDigests,
    scope,
    changedArtifactIds
  });
  const delivery = await createProjectDeliveryPackage(workspace, project, buildPlan, testReport, {
    expectedProjectDigest,
    deliverables: OUTPUTS.map(output => ({ path: output.path, required: true }))
  });

  const status = delivery.report.status !== "ready" ? "blocked" :
    generated.unmappedRequirements.length > 0 ? "requires_requirement_review" : "ready";
  return Object.freeze({
    status,
    generated,
    webProject,
    writes: Object.freeze(writes),
    fileDigests: Object.freeze(fileDigests),
    testReport,
    delivery
  });
}
