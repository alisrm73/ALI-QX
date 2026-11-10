import { createHash } from "node:crypto";
import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { assertBuildPlanForProject } from "./build-plan.js";
import { assertRequirementBuildMapForProject } from "./requirement-build-map.js";

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function assertPlainDataTree(value, field, seen = new Set()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object" || seen.has(value)) {
    fail("QX_BUILD_BLUEPRINT_INVALID", field + " must contain only acyclic JSON data");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors).filter(key => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) =>
      key !== String(index) || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value"))) {
      fail("QX_BUILD_BLUEPRINT_INVALID", field + " must contain dense data arrays");
    }
    for (let index = 0; index < value.length; index += 1) {
      assertPlainDataTree(descriptors[String(index)].value, field + "[" + index + "]", seen);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail("QX_BUILD_BLUEPRINT_INVALID", field + " must contain plain data objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")) {
        fail("QX_BUILD_BLUEPRINT_INVALID", field + " contains an unsupported field or accessor");
      }
      assertPlainDataTree(descriptor.value, field + "." + key, seen);
    }
  }
  seen.delete(value);
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

function blueprintContent(blueprint) {
  return {
    schemaVersion: blueprint.schemaVersion,
    projectId: blueprint.projectId,
    projectRevision: blueprint.projectRevision,
    projectDigest: blueprint.projectDigest,
    buildPlanDigest: blueprint.buildPlanDigest,
    requirementBuildMapDigest: blueprint.requirementBuildMapDigest,
    externalInputs: blueprint.externalInputs,
    order: blueprint.order,
    tasks: blueprint.tasks,
    files: blueprint.files,
    requirements: blueprint.requirements
  };
}

/**
 * Combines an approved build plan and its verified requirement map into one immutable,
 * deterministic pre-generation blueprint. This API is descriptive and never writes files
 * or executes tasks.
 */
export function createBuildBlueprint(project, {
  expectedProjectDigest,
  buildPlan,
  requirementBuildMap
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  assertBuildPlanForProject(project, buildPlan);
  assertRequirementBuildMapForProject(project, buildPlan, requirementBuildMap);

  const requirementKeysByTask = new Map(buildPlan.tasks.map(task => [task.id, []]));
  const requirementKeysByFile = new Map(requirementBuildMap.fileBindings.map(file => [file.path, []]));

  for (const entry of requirementBuildMap.entries) {
    const key = entry.category + ":" + entry.requirementIndex;
    for (const taskId of entry.taskIds) requirementKeysByTask.get(taskId).push(key);
    for (const filePath of entry.filePaths) requirementKeysByFile.get(filePath).push(key);
  }

  const files = requirementBuildMap.fileBindings.map(file => ({
    path: file.path,
    artifactId: file.artifactId,
    taskId: file.taskId,
    componentIds: file.componentIds,
    requirementKeys: requirementKeysByFile.get(file.path).sort()
  }));

  const tasks = buildPlan.order.map(id => {
    const task = buildPlan.tasks.find(item => item.id === id);
    return {
      id: task.id,
      dependsOn: task.dependsOn,
      inputs: task.inputs,
      outputs: task.outputs,
      filePaths: files.filter(file => file.taskId === id).map(file => file.path),
      requirementKeys: requirementKeysByTask.get(id).sort()
    };
  });

  const requirements = requirementBuildMap.entries.map(entry => ({
    key: entry.category + ":" + entry.requirementIndex,
    category: entry.category,
    requirementIndex: entry.requirementIndex,
    requirement: entry.requirement,
    componentIds: entry.componentIds,
    filePaths: entry.filePaths,
    taskIds: entry.taskIds
  }));

  const content = {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    buildPlanDigest: buildPlan.digest,
    requirementBuildMapDigest: requirementBuildMap.digest,
    externalInputs: buildPlan.externalInputs,
    order: buildPlan.order,
    tasks,
    files,
    requirements
  };
  return freezeDeep({ ...content, digest: digest(content) });
}

export function assertBuildBlueprintForProject(project, buildPlan, requirementBuildMap, blueprint) {
  assertPlainDataTree(blueprint, "blueprint");
  if (blueprint === null || Array.isArray(blueprint) ||
      Object.getPrototypeOf(blueprint) !== Object.prototype ||
      typeof blueprint.digest !== "string") {
    fail("QX_BUILD_BLUEPRINT_INVALID", "Build blueprint is malformed");
  }
  assertProjectApproved(project, { expectedDigest: blueprint.projectDigest });
  assertBuildPlanForProject(project, buildPlan);
  assertRequirementBuildMapForProject(project, buildPlan, requirementBuildMap);

  const content = blueprintContent(blueprint);
  if (blueprint.digest !== digest(content)) {
    fail("QX_BUILD_BLUEPRINT_INVALID", "Build blueprint digest does not match its content");
  }
  const rebuilt = createBuildBlueprint(project, {
    expectedProjectDigest: project.digest,
    buildPlan,
    requirementBuildMap
  });
  if (canonicalJSON(rebuilt) !== canonicalJSON(blueprint)) {
    fail("QX_BUILD_BLUEPRINT_INVALID", "Build blueprint does not match the approved project, build plan, and requirement map");
  }
  return blueprint;
}
