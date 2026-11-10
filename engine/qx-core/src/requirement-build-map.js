import { createHash } from "node:crypto";
import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { assertBuildPlanForProject } from "./build-plan.js";

const CATEGORIES = Object.freeze(["requirement", "data", "integration"]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const MAX_MAPPINGS = 600;
const MAX_FILE_BINDINGS = 600;
const MAX_COMPONENTS = 200;

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

function digest(value) {
  return "sha256:" + createHash("sha256").update(canonicalJSON(value), "utf8").digest("hex");
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeIds(value, field, maximum = MAX_COMPONENTS) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", field + " must contain between 1 and " + maximum + " identifiers");
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !ID_PATTERN.test(item)) {
      fail("QX_REQUIREMENT_BUILD_MAP_INVALID", field + "[" + index + "] has an invalid identifier");
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", field + " must not contain duplicates");
  }
  return result.sort();
}

function normalizePaths(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", field + " must contain between 1 and 100 paths");
  }
  const result = value.map(path => {
    if (!safeProjectPath(path)) {
      fail("QX_REQUIREMENT_BUILD_MAP_INVALID", field + " must contain safe relative project paths");
    }
    return path;
  });
  if (new Set(result).size !== result.length) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", field + " must not contain duplicate paths");
  }
  return result.sort();
}

function safeProjectPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !value.startsWith("/") && !value.includes("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function requirementsOf(project) {
  return [
    ...project.requirements.map((value, index) => ({ category: "requirement", requirementIndex: index, requirement: value })),
    ...project.dataRequirements.map((value, index) => ({ category: "data", requirementIndex: index, requirement: value })),
    ...project.integrationRequirements.map((value, index) => ({ category: "integration", requirementIndex: index, requirement: value }))
  ];
}

function contentOf(map) {
  return {
    schemaVersion: map.schemaVersion,
    projectId: map.projectId,
    projectRevision: map.projectRevision,
    projectDigest: map.projectDigest,
    buildPlanDigest: map.buildPlanDigest,
    fileBindings: map.fileBindings,
    entries: map.entries
  };
}

function normalizeFileBindings(buildPlan, value) {
  if (!Array.isArray(value) || value.length > MAX_FILE_BINDINGS) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "fileBindings must be an array within the supported limit");
  }
  const tasks = new Map(buildPlan.tasks.map(task => [task.id, task]));
  const paths = new Set();
  const artifacts = new Set();
  return value.map((raw, index) => {
    if (!isPlainObject(raw) ||
        Object.keys(raw).some(key => !["path", "artifactId", "taskId", "componentIds"].includes(key)) ||
        !["path", "artifactId", "taskId", "componentIds"].every(key => Object.hasOwn(raw, key)) ||
        !safeProjectPath(raw.path) ||
        typeof raw.artifactId !== "string" || !ID_PATTERN.test(raw.artifactId) ||
        typeof raw.taskId !== "string" || !ID_PATTERN.test(raw.taskId)) {
      fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "fileBindings[" + index + "] must declare a safe path, artifact, producer task, and components");
    }
    if (paths.has(raw.path)) {
      fail("QX_REQUIREMENT_BUILD_MAP_FILE_CONFLICT", "A project file path may be bound only once: " + raw.path);
    }
    if (artifacts.has(raw.artifactId)) {
      fail("QX_REQUIREMENT_BUILD_MAP_FILE_CONFLICT", "An output artifact may be bound to only one project file: " + raw.artifactId);
    }
    const task = tasks.get(raw.taskId);
    if (!task || !task.outputs.includes(raw.artifactId)) {
      fail("QX_REQUIREMENT_BUILD_MAP_ARTIFACT_MISMATCH", "File " + raw.path + " must reference an artifact produced by its declared task");
    }
    paths.add(raw.path);
    artifacts.add(raw.artifactId);
    return {
      path: raw.path,
      artifactId: raw.artifactId,
      taskId: raw.taskId,
      componentIds: normalizeIds(raw.componentIds, "fileBindings[" + index + "].componentIds")
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function dependencyClosure(plan, producerTaskIds) {
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  const included = new Set();
  const visit = id => {
    if (included.has(id)) return;
    const task = tasks.get(id);
    if (!task) fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "A mapped file references an unknown producer task");
    included.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
  };
  producerTaskIds.forEach(visit);
  return plan.order.filter(id => included.has(id));
}

function normalizeMappings(project, buildPlan, mappings, fileBindings) {
  if (!Array.isArray(mappings) || mappings.length > MAX_MAPPINGS) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "mappings must be an array within the supported limit");
  }
  const required = requirementsOf(project);
  const expected = new Map(required.map(item => [item.category + ":" + item.requirementIndex, item]));
  const bindings = new Map(fileBindings.map(item => [item.path, item]));
  const seen = new Set();

  const entries = mappings.map((raw, index) => {
    if (!isPlainObject(raw) ||
        Object.keys(raw).some(key => !["category", "requirementIndex", "componentIds", "filePaths"].includes(key)) ||
        !["category", "requirementIndex", "componentIds", "filePaths"].every(key => Object.hasOwn(raw, key)) ||
        !CATEGORIES.includes(raw.category) ||
        !Number.isSafeInteger(raw.requirementIndex) || raw.requirementIndex < 0) {
      fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "mappings[" + index + "] must identify a valid project requirement");
    }
    const key = raw.category + ":" + raw.requirementIndex;
    const requirement = expected.get(key);
    if (!requirement || seen.has(key)) {
      fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "Each project requirement must be mapped exactly once without unknown or duplicate entries");
    }
    seen.add(key);

    const componentIds = normalizeIds(raw.componentIds, "mappings[" + index + "].componentIds");
    const filePaths = normalizePaths(raw.filePaths, "mappings[" + index + "].filePaths");
    const selectedBindings = filePaths.map(path => {
      const binding = bindings.get(path);
      if (!binding) fail("QX_REQUIREMENT_BUILD_MAP_MISSING_FILE", "Mapped project file has no declared producer: " + path);
      return binding;
    });
    const availableComponents = new Set(selectedBindings.flatMap(item => item.componentIds));
    if (componentIds.some(id => !availableComponents.has(id))) {
      fail("QX_REQUIREMENT_BUILD_MAP_COMPONENT_MISMATCH", "Every mapped component must be associated with at least one mapped project file");
    }
    const producerTaskIds = [...new Set(selectedBindings.map(item => item.taskId))];
    return {
      ...requirement,
      componentIds,
      filePaths,
      taskIds: dependencyClosure(buildPlan, producerTaskIds)
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.requirementIndex - b.requirementIndex);

  if (seen.size !== required.length) {
    fail("QX_REQUIREMENT_BUILD_MAP_INCOMPLETE", "Every project, data, and integration requirement must be mapped before build execution");
  }
  return entries;
}

/**
 * Creates an immutable, pre-build traceability map for every approved project requirement.
 * Component identifiers are declarative references; this API does not resolve or activate UI components.
 */
export function createRequirementBuildMap(project, {
  expectedProjectDigest,
  buildPlan,
  mappings,
  fileBindings
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertBuildPlanForProject(project, buildPlan);
  const normalizedBindings = normalizeFileBindings(buildPlan, fileBindings);
  const entries = normalizeMappings(project, buildPlan, mappings, normalizedBindings);
  const content = {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    buildPlanDigest: buildPlan.digest,
    fileBindings: normalizedBindings,
    entries
  };
  return freezeDeep({ ...content, digest: digest(content) });
}

export function assertRequirementBuildMapForProject(project, buildPlan, map) {
  assertProjectApproved(project, { expectedDigest: map?.projectDigest });
  assertBuildPlanForProject(project, buildPlan);
  if (!isPlainObject(map) || map.schemaVersion !== "1.0.0" ||
      map.projectId !== project.projectId ||
      map.projectRevision !== project.revision ||
      map.projectDigest !== project.digest ||
      map.buildPlanDigest !== buildPlan.digest ||
      typeof map.digest !== "string" ||
      map.digest !== digest(contentOf(map))) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "Requirement build map is malformed, stale, or has an invalid digest");
  }
  const rebuilt = createRequirementBuildMap(project, {
    expectedProjectDigest: project.digest,
    buildPlan,
    fileBindings: map.fileBindings,
    mappings: map.entries.map(entry => ({
      category: entry.category,
      requirementIndex: entry.requirementIndex,
      componentIds: entry.componentIds,
      filePaths: entry.filePaths
    }))
  });
  if (canonicalJSON(rebuilt) !== canonicalJSON(map)) {
    fail("QX_REQUIREMENT_BUILD_MAP_INVALID", "Requirement build map does not match its verified project and build-plan references");
  }
  return map;
}
