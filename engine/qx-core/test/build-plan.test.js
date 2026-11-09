import test from "node:test";
import assert from "node:assert/strict";
import { createProjectDraft, submitProjectForReview, approveProjectDraft } from "../src/project-model.js";
import { createBuildPlan, assertBuildPlanForProject, selectBuildTasks } from "../src/build-plan.js";

function approvedProject() {
  const draft = createProjectDraft({
    projectId: "build-demo", title: "Build demo", description: "A project for build planning tests",
    requirements: ["The site has a home page"], pages: [{ id: "home", title: "Home" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  return approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
}

const tasks = [
  { id: "bundle", dependsOn: ["compile"], inputs: ["compiled-app"], outputs: ["web-bundle"] },
  { id: "compile", dependsOn: ["lint"], inputs: ["source-tree"], outputs: ["compiled-app"] },
  { id: "lint", dependsOn: [], inputs: ["source-tree"], outputs: ["lint-report"] },
  { id: "assets", dependsOn: [], inputs: ["asset-source"], outputs: ["static-assets"] },
  { id: "package", dependsOn: ["bundle", "assets"], inputs: ["web-bundle", "static-assets"], outputs: ["delivery-package"] }
];

test("creates a deterministic topological plan tied to the approved project revision", () => {
  const project = approvedProject();
  const first = createBuildPlan(project, { expectedProjectDigest: project.digest, tasks, externalInputs: ["source-tree", "asset-source"] });
  const second = createBuildPlan(project, { expectedProjectDigest: project.digest, tasks: [...tasks].reverse(), externalInputs: ["source-tree", "asset-source"] });
  assert.deepEqual(first.order, ["assets", "lint", "compile", "bundle", "package"]);
  assert.equal(first.digest, second.digest);
  assert.equal(first.projectDigest, project.digest);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.tasks[0]), true);
  assert.equal(assertBuildPlanForProject(project, first), first);
});

test("requires an approved exact project revision before creating a plan", () => {
  const draft = createProjectDraft({
    projectId: "build-demo", title: "Build demo", description: "Not approved",
    requirements: ["Home"], pages: [{ id: "home", title: "Home" }]
  });
  assert.throws(() => createBuildPlan(draft, { tasks }), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
  const approved = approvedProject();
  assert.throws(() => createBuildPlan(approved, { expectedProjectDigest: "sha256:stale", tasks }), {
    code: "QX_PROJECT_BUILD_NOT_APPROVED"
  });
});

test("rejects missing dependencies, duplicate tasks, and output collisions", () => {
  const project = approvedProject();
  assert.throws(() => createBuildPlan(project, { tasks: [
    { id: "compile", dependsOn: ["missing"], inputs: [], outputs: ["compiled"] }
  ] }), { code: "QX_BUILD_PLAN_MISSING_DEPENDENCY" });
  assert.throws(() => createBuildPlan(project, { tasks: [
    { id: "compile", dependsOn: [], inputs: [], outputs: ["compiled"] },
    { id: "compile", dependsOn: [], inputs: [], outputs: ["other"] }
  ] }), { code: "QX_BUILD_PLAN_INVALID" });
  assert.throws(() => createBuildPlan(project, { tasks: [
    { id: "compile", dependsOn: [], inputs: [], outputs: ["same"] },
    { id: "bundle", dependsOn: ["compile"], inputs: [], outputs: ["same"] }
  ] }), { code: "QX_BUILD_PLAN_OUTPUT_CONFLICT" });
});


test("requires every task input to have a producer or an explicit external declaration", () => {
  const project = approvedProject();
  assert.throws(() => createBuildPlan(project, { tasks: [
    { id: "compile", dependsOn: [], inputs: ["missing-source"], outputs: ["compiled"] }
  ] }), { code: "QX_BUILD_PLAN_MISSING_INPUT" });
  assert.throws(() => createBuildPlan(project, { tasks: [
    { id: "produce", dependsOn: [], inputs: [], outputs: ["generated"] },
    { id: "consume", dependsOn: [], inputs: ["generated"], outputs: ["result"] }
  ] }), { code: "QX_BUILD_PLAN_UNDECLARED_DEPENDENCY" });
  assert.throws(() => createBuildPlan(project, {
    externalInputs: ["generated"],
    tasks: [{ id: "produce", dependsOn: [], inputs: [], outputs: ["generated"] }]
  }), { code: "QX_BUILD_PLAN_INPUT_CONFLICT" });
});

test("detects dependency cycles", () => {
  const project = approvedProject();
  assert.throws(() => createBuildPlan(project, { tasks: [
    { id: "alpha", dependsOn: ["beta"], inputs: [], outputs: ["a"] },
    { id: "beta", dependsOn: ["alpha"], inputs: [], outputs: ["b"] }
  ] }), { code: "QX_BUILD_PLAN_CYCLE" });
});

test("rejects tampered build plans", () => {
  const project = approvedProject();
  const plan = createBuildPlan(project, { tasks, externalInputs: ["source-tree", "asset-source"] });
  assert.throws(() => assertBuildPlanForProject(project, { ...plan, order: ["package"] }), {
    code: "QX_BUILD_PLAN_INVALID"
  });
});

test("partial selection includes changed tasks, downstream impact, and their prerequisites", () => {
  const project = approvedProject();
  const plan = createBuildPlan(project, { tasks, externalInputs: ["source-tree", "asset-source"] });
  const selection = selectBuildTasks(plan, { changedTaskIds: ["compile"] });
  assert.deepEqual(selection.affectedTaskIds, ["compile", "bundle", "package"]);
  assert.deepEqual(selection.taskIds, ["assets", "lint", "compile", "bundle", "package"]);
  assert.deepEqual(selectBuildTasks(plan, { changedTaskIds: ["assets"] }).taskIds, [
    "assets", "lint", "compile", "bundle", "package"
  ]);
});

test("rejects unknown changed tasks and malformed build plan inputs", () => {
  const project = approvedProject();
  assert.throws(() => createBuildPlan(project, { tasks: [] }), { code: "QX_BUILD_PLAN_INVALID" });
  const plan = createBuildPlan(project, { tasks, externalInputs: ["source-tree", "asset-source"] });
  assert.throws(() => selectBuildTasks(plan, { changedTaskIds: ["not-a-task"] }), {
    code: "QX_BUILD_PLAN_UNKNOWN_TASK"
  });
  assert.throws(() => selectBuildTasks(plan, { changedTaskIds: [] }), {
    code: "QX_BUILD_PLAN_INVALID"
  });
});
