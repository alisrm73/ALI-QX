import { createHash } from "node:crypto";
import {
  assertBuildPlanForProject
} from "./build-plan.js";
import {
  assertProjectApproved,
  QXProjectError
} from "./project-model.js";
import {
  assertProjectTestReport
} from "./project-test-suite.js";
import { readProjectFile } from "./project-workspace.js";

const MAX_DELIVERABLES = 500;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
}

function hash(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function digest(value) {
  return hash(canonicalJSON(value));
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function requireRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 ||
      value.startsWith("/") || value.includes("\\") ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
    fail("QX_DELIVERY_INVALID", "Deliverable paths must be safe relative POSIX paths");
  }
  return value;
}

function reportContent(report) {
  return {
    schemaVersion: report.schemaVersion,
    projectId: report.projectId,
    projectRevision: report.projectRevision,
    projectDigest: report.projectDigest,
    buildPlanDigest: report.buildPlanDigest,
    testReportDigest: report.testReportDigest,
    items: report.items,
    summary: report.summary,
    issues: report.issues,
    packageDigest: report.packageDigest,
    status: report.status
  };
}

function packageContent(project, plan, testReport, files) {
  return {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    buildPlanDigest: plan.digest,
    testReportDigest: testReport.digest,
    files
  };
}

export function assertProjectDeliveryReport(project, plan, testReport, report) {
  assertProjectApproved(project, { expectedDigest: report?.projectDigest });
  assertBuildPlanForProject(project, plan);
  assertProjectTestReport(project, plan, testReport);
  if (!isPlainObject(report) || report.schemaVersion !== "1.0.0" ||
      report.projectId !== project.projectId ||
      report.projectRevision !== project.revision ||
      report.projectDigest !== project.digest ||
      report.buildPlanDigest !== plan.digest ||
      report.testReportDigest !== testReport.digest ||
      !Array.isArray(report.items) || !isPlainObject(report.summary) ||
      !Array.isArray(report.issues) ||
      !["ready", "blocked"].includes(report.status) ||
      typeof report.digest !== "string" ||
      report.digest !== digest(reportContent(report))) {
    fail("QX_DELIVERY_INVALID", "Delivery report is malformed, stale, or its digest does not match");
  }
  return report;
}

export async function createProjectDeliveryPackage(workspace, project, plan, testReport, {
  expectedProjectDigest,
  deliverables
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertBuildPlanForProject(project, plan);
  assertProjectTestReport(project, plan, testReport);
  if (!Array.isArray(deliverables) || deliverables.length === 0 ||
      deliverables.length > MAX_DELIVERABLES) {
    fail("QX_DELIVERY_INVALID", "deliverables must contain between 1 and " + MAX_DELIVERABLES + " entries");
  }

  const seen = new Set();
  const normalized = deliverables.map((item, index) => {
    if (!isPlainObject(item) ||
        Object.keys(item).some(key => !["path", "required"].includes(key)) ||
        !Object.hasOwn(item, "path") || !Object.hasOwn(item, "required") ||
        typeof item.required !== "boolean") {
      fail("QX_DELIVERY_INVALID", "Each deliverable must contain only path and required");
    }
    const filePath = requireRelativePath(item.path);
    if (seen.has(filePath)) fail("QX_DELIVERY_INVALID", "Duplicate deliverable path: " + filePath);
    seen.add(filePath);
    return { path: filePath, required: item.required, index };
  }).sort((a, b) => a.path.localeCompare(b.path));

  const items = [];
  const packageFiles = [];
  const issues = [];
  let totalBytes = 0;
  for (const item of normalized) {
    try {
      const file = await readProjectFile(workspace, {
        project, expectedProjectDigest, relativePath: item.path
      });
      totalBytes += file.size;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        fail("QX_DELIVERY_SIZE_LIMIT", "Project delivery package exceeds the 50 MiB total size limit");
      }
      const testedDigest = testReport.fileDigests[item.path];
      const matchesTests = testedDigest === file.contentDigest;
      if (!matchesTests) {
        issues.push({
          code: "QX_DELIVERY_FILE_NOT_VERIFIED",
          path: item.path,
          message: "File is missing from the test report's file digest set or has changed since testing"
        });
      }
      const entry = {
        path: item.path,
        required: item.required,
        status: matchesTests ? "included" : "unverified",
        contentDigest: file.contentDigest,
        size: file.size
      };
      items.push(entry);
      if (matchesTests) {
        packageFiles.push({
          path: item.path,
          contentDigest: file.contentDigest,
          size: file.size,
          contentBase64: file.content.toString("base64")
        });
      }
    } catch (error) {
      if (error.code !== "QX_WORKSPACE_FILE_MISSING") throw error;
      items.push({
        path: item.path,
        required: item.required,
        status: "missing",
        contentDigest: null,
        size: 0
      });
      if (item.required) {
        issues.push({
          code: "QX_DELIVERY_REQUIRED_FILE_MISSING",
          path: item.path,
          message: "A required deliverable file is missing"
        });
      }
    }
  }

  if (testReport.status !== "passed" || testReport.summary.failed > 0 ||
      testReport.summary.requiredUnsuccessful > 0) {
    issues.push({
      code: "QX_DELIVERY_TESTS_NOT_PASSED",
      path: null,
      message: "The project test report is not in a fully passing state"
    });
  }
  const status = issues.length === 0 ? "ready" : "blocked";
  const packageValue = status === "ready"
    ? packageContent(project, plan, testReport, packageFiles)
    : null;
  const packageDigest = packageValue ? digest(packageValue) : null;
  const packaged = packageValue ? freezeDeep({ ...packageValue, digest: packageDigest }) : null;
  const packageJson = packaged ? canonicalJSON(packaged) : null;

  const content = {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    buildPlanDigest: plan.digest,
    testReportDigest: testReport.digest,
    items,
    summary: {
      total: items.length,
      included: items.filter(item => item.status === "included").length,
      missing: items.filter(item => item.status === "missing").length,
      unverified: items.filter(item => item.status === "unverified").length,
      requiredMissing: items.filter(item => item.required && item.status === "missing").length,
      totalBytes
    },
    issues,
    packageDigest,
    status
  };
  const report = freezeDeep({ ...content, digest: digest(content) });
  return Object.freeze({
    report,
    package: packaged,
    packageJson
  });
}
