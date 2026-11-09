import { createHash } from "node:crypto";
import { assertProjectApproved, QXProjectError } from "./project-model.js";

const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const MAX_TASKS = 500;
const MAX_LIST = 200;

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

function normalizeId(value, field, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("QX_BUILD_PLAN_INVALID", field + " has an invalid identifier");
  }
  return value;
}

function normalizeList(value, field, pattern) {
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    fail("QX_BUILD_PLAN_INVALID", field + " must be an array with at most " + MAX_LIST + " entries");
  }
  const result = value.map((item, index) => normalizeId(item, field + "[" + index + "]", pattern));
  if (new Set(result).size !== result.length) {
    fail("QX_BUILD_PLAN_INVALID", field + " must not contain duplicates");
  }
  return result.sort();
}

function planContent(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    projectId: plan.projectId,
    projectRevision: plan.projectRevision,
    projectDigest: plan.projectDigest,
    externalInputs: plan.externalInputs,
    tasks: plan.tasks,
    order: plan.order
  };
}

function assertPlan(plan) {
  if (!isPlainObject(plan) || plan.schemaVersion !== "1.0.0" ||
      !Array.isArray(plan.tasks) || !Array.isArray(plan.order) ||
      typeof plan.digest !== "string" || plan.digest !== digest(planContent(plan))) {
    fail("QX_BUILD_PLAN_INVALID", "Build plan is malformed or its digest does not match");
  }
}

function topologicalOrder(tasksById) {
  const indegree = new Map();
  const dependents = new Map();
  for (const [id, task] of tasksById) {
    indegree.set(id, task.dependsOn.length);
    dependents.set(id, []);
  }
  for (const [id, task] of tasksById) {
    for (const dependency of task.dependsOn) dependents.get(dependency).push(id);
  }
  for (const list of dependents.values()) list.sort();

  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const dependent of dependents.get(id)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== tasksById.size) {
    const cycleMembers = [...indegree].filter(([, count]) => count > 0).map(([id]) => id).sort();
    fail("QX_BUILD_PLAN_CYCLE", "Build dependency cycle detected among: " + cycleMembers.join(", "));
  }
  return { order, dependents };
}

export function createBuildPlan(project, { expectedProjectDigest, tasks, externalInputs = [] } = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_TASKS) {
    fail("QX_BUILD_PLAN_INVALID", "tasks must contain between 1 and " + MAX_TASKS + " entries");
  }

  const tasksById = new Map();
  for (const [index, raw] of tasks.entries()) {
    if (!isPlainObject(raw) ||
        Object.keys(raw).some(key => !["id", "dependsOn", "inputs", "outputs"].includes(key)) ||
        !["id", "dependsOn", "inputs", "outputs"].every(key => Object.hasOwn(raw, key))) {
      fail("QX_BUILD_PLAN_INVALID", "Each task must contain only id, dependsOn, inputs, and outputs");
    }
    const id = normalizeId(raw.id, "tasks[" + index + "].id", TASK_ID_PATTERN);
    if (tasksById.has(id)) fail("QX_BUILD_PLAN_INVALID", "Duplicate build task ID: " + id);
    tasksById.set(id, {
      id,
      dependsOn: normalizeList(raw.dependsOn, "tasks[" + index + "].dependsOn", TASK_ID_PATTERN),
      inputs: normalizeList(raw.inputs, "tasks[" + index + "].inputs", ARTIFACT_ID_PATTERN),
      outputs: normalizeList(raw.outputs, "tasks[" + index + "].outputs", ARTIFACT_ID_PATTERN)
    });
  }

  const outputOwners = new Map();
  for (const task of tasksById.values()) {
    for (const dependency of task.dependsOn) {
      if (!tasksById.has(dependency)) {
        fail("QX_BUILD_PLAN_MISSING_DEPENDENCY", "Task " + task.id + " depends on missing task " + dependency);
      }
    }
    for (const output of task.outputs) {
      if (outputOwners.has(output)) {
        fail("QX_BUILD_PLAN_OUTPUT_CONFLICT", "Artifact " + output + " is produced by both " + outputOwners.get(output) + " and " + task.id);
      }
      outputOwners.set(output, task.id);
    }
  }

  const normalizedExternalInputs = normalizeList(externalInputs, "externalInputs", ARTIFACT_ID_PATTERN);
  const externalSet = new Set(normalizedExternalInputs);
  for (const artifact of normalizedExternalInputs) {
    if (outputOwners.has(artifact)) {
      fail("QX_BUILD_PLAN_INPUT_CONFLICT", "Artifact " + artifact + " cannot be both external and produced by a task");
    }
  }

  const { order } = topologicalOrder(tasksById);
  const ancestors = new Map();
  for (const id of order) {
    const task = tasksById.get(id);
    const taskAncestors = new Set();
    for (const dependency of task.dependsOn) {
      taskAncestors.add(dependency);
      for (const ancestor of ancestors.get(dependency)) taskAncestors.add(ancestor);
    }
    ancestors.set(id, taskAncestors);
  }
  for (const task of tasksById.values()) {
    for (const input of task.inputs) {
      const producer = outputOwners.get(input);
      if (!producer && !externalSet.has(input)) {
        fail("QX_BUILD_PLAN_MISSING_INPUT", "Task " + task.id + " consumes artifact with no producer or external declaration: " + input);
      }
      if (producer && !ancestors.get(task.id).has(producer)) {
        fail("QX_BUILD_PLAN_UNDECLARED_DEPENDENCY", "Task " + task.id + " consumes " + input + " from " + producer + " without declaring its dependency chain");
      }
    }
  }

  const content = {
    schemaVersion: "1.0.0",
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    externalInputs: normalizedExternalInputs,
    tasks: order.map(id => tasksById.get(id)),
    order
  };
  return freezeDeep({ ...content, digest: digest(content) });
}

export function assertBuildPlanForProject(project, plan) {
  assertProjectApproved(project, { expectedDigest: plan?.projectDigest });
  assertPlan(plan);
  if (plan.projectId !== project.projectId ||
      plan.projectRevision !== project.revision ||
      plan.projectDigest !== project.digest) {
    fail("QX_BUILD_PLAN_STALE", "Build plan does not match the currently approved project revision");
  }
  return plan;
}

export function selectBuildTasks(plan, { changedTaskIds } = {}) {
  assertPlan(plan);
  if (!Array.isArray(changedTaskIds) || changedTaskIds.length === 0) {
    fail("QX_BUILD_PLAN_INVALID", "changedTaskIds must contain at least one task ID");
  }
  const changed = normalizeList(changedTaskIds, "changedTaskIds", TASK_ID_PATTERN);
  const tasksById = new Map(plan.tasks.map(task => [task.id, task]));
  for (const id of changed) {
    if (!tasksById.has(id)) fail("QX_BUILD_PLAN_UNKNOWN_TASK", "Unknown changed task: " + id);
  }

  const dependents = new Map(plan.tasks.map(task => [task.id, []]));
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency).push(task.id);
  }

  const affected = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const dependent of dependents.get(id)) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  const required = new Set(affected);
  const addPrerequisites = id => {
    for (const dependency of tasksById.get(id).dependsOn) {
      if (!required.has(dependency)) {
        required.add(dependency);
        addPrerequisites(dependency);
      }
    }
  };
  for (const id of affected) addPrerequisites(id);

  return freezeDeep({
    planDigest: plan.digest,
    changedTaskIds: changed,
    taskIds: plan.order.filter(id => required.has(id)),
    affectedTaskIds: plan.order.filter(id => affected.has(id))
  });
}
