import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import { createBuildPlan } from "../src/build-plan.js";
import { createRequirementBuildMap } from "../src/requirement-build-map.js";
import {
  createBuildBlueprint,
  assertBuildBlueprintForProject
} from "../src/build-blueprint.js";

function fixture() {
  const draft = createProjectDraft({
    projectId: "blueprint-demo",
    title: "Blueprint demo",
    description: "A project used to verify the unified pre-build blueprint",
    requirements: ["Show a home overview", "Accept a contact request"],
    dataRequirements: ["Store contact requests"],
    integrationRequirements: ["Send contact requests by email"],
    pages: [{ id: "home", title: "Home" }, { id: "contact", title: "Contact" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  const project = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const buildPlan = createBuildPlan(project, {
    expectedProjectDigest: project.digest,
    externalInputs: ["approved-manifest"],
    tasks: [
      { id: "ui", dependsOn: [], inputs: ["approved-manifest"], outputs: ["home-ui", "contact-ui"] },
      { id: "web", dependsOn: ["ui"], inputs: ["home-ui", "contact-ui"], outputs: ["index-html", "app-js"] },
      { id: "package", dependsOn: ["web"], inputs: ["index-html", "app-js"], outputs: ["web-package", "integration-config"] }
    ]
  });
  const fileBindings = [
    { path: "dist/index.html", artifactId: "index-html", taskId: "web", componentIds: ["home-page"] },
    { path: "dist/app.js", artifactId: "app-js", taskId: "web", componentIds: ["contact-form"] },
    { path: "config/integrations.json", artifactId: "integration-config", taskId: "package", componentIds: ["contact-form"] }
  ];
  const mappings = [
    { category: "requirement", requirementIndex: 0, componentIds: ["home-page"], filePaths: ["dist/index.html"] },
    { category: "requirement", requirementIndex: 1, componentIds: ["contact-form"], filePaths: ["dist/app.js"] },
    { category: "data", requirementIndex: 0, componentIds: ["contact-form"], filePaths: ["dist/app.js"] },
    { category: "integration", requirementIndex: 0, componentIds: ["contact-form"], filePaths: ["config/integrations.json"] }
  ];
  const requirementBuildMap = createRequirementBuildMap(project, {
    expectedProjectDigest: project.digest, buildPlan, mappings, fileBindings
  });
  return { project, buildPlan, requirementBuildMap };
}

test("combines plan, files, requirements, and dependency chains into one verified blueprint", () => {
  const state = fixture();
  const blueprint = createBuildBlueprint(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    requirementBuildMap: state.requirementBuildMap
  });

  assert.deepEqual(blueprint.order, ["ui", "web", "package"]);
  assert.deepEqual(blueprint.tasks[2].dependsOn, ["web"]);
  assert.deepEqual(blueprint.tasks[2].filePaths, ["config/integrations.json"]);
  assert.deepEqual(blueprint.tasks[2].requirementKeys, ["integration:0"]);
  assert.deepEqual(blueprint.files.map(file => file.path), [
    "config/integrations.json", "dist/app.js", "dist/index.html"
  ]);
  assert.equal(blueprint.requirements.length, 4);
  assert.deepEqual(
    blueprint.requirements.find(item => item.key === "requirement:0").taskIds,
    ["ui", "web"]
  );
  assert.equal(blueprint.projectDigest, state.project.digest);
  assert.equal(blueprint.buildPlanDigest, state.buildPlan.digest);
  assert.equal(blueprint.requirementBuildMapDigest, state.requirementBuildMap.digest);
  assert.equal(Object.isFrozen(blueprint), true);
  assert.equal(Object.isFrozen(blueprint.tasks[0]), true);
  assert.equal(assertBuildBlueprintForProject(
    state.project, state.buildPlan, state.requirementBuildMap, blueprint
  ), blueprint);
});

test("is deterministic and independent of source map file-binding order", () => {
  const state = fixture();
  const first = createBuildBlueprint(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    requirementBuildMap: state.requirementBuildMap
  });
  const reorderedMap = createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    mappings: [...state.requirementBuildMap.entries].reverse().map(entry => ({
      category: entry.category,
      requirementIndex: entry.requirementIndex,
      componentIds: entry.componentIds,
      filePaths: entry.filePaths
    })),
    fileBindings: [...state.requirementBuildMap.fileBindings].reverse()
  });
  const second = createBuildBlueprint(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    requirementBuildMap: reorderedMap
  });
  assert.equal(first.digest, second.digest);
});

test("rejects tampered, stale, or mismatched blueprint inputs", () => {
  const state = fixture();
  const blueprint = createBuildBlueprint(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    requirementBuildMap: state.requirementBuildMap
  });
  assert.throws(() => assertBuildBlueprintForProject(
    state.project, state.buildPlan, state.requirementBuildMap,
    { ...blueprint, files: blueprint.files.slice(1) }
  ), { code: "QX_BUILD_BLUEPRINT_INVALID" });

  const revisedDraft = createProjectDraft({
    projectId: "blueprint-demo",
    title: "Revised blueprint demo",
    description: "A revised project with a new approved digest",
    requirements: ["Show a revised home overview"],
    pages: [{ id: "home", title: "Home" }]
  });
  const revisedReview = submitProjectForReview(revisedDraft).project;
  const revisedProject = approveProjectDraft(revisedReview, {
    approvedDigest: revisedReview.digest
  });
  assert.throws(() => assertBuildBlueprintForProject(
    revisedProject, state.buildPlan, state.requirementBuildMap, blueprint
  ));
});

test("rejects accessor-backed blueprint data without invoking the accessor", () => {
  const state = fixture();
  const blueprint = createBuildBlueprint(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    requirementBuildMap: state.requirementBuildMap
  });
  let invoked = false;
  const malformed = { ...blueprint };
  Object.defineProperty(malformed, "unsafe", {
    enumerable: true,
    get() { invoked = true; throw new Error("must not run"); }
  });
  assert.throws(() => assertBuildBlueprintForProject(
    state.project, state.buildPlan, state.requirementBuildMap, malformed
  ), { code: "QX_BUILD_BLUEPRINT_INVALID" });
  assert.equal(invoked, false);
});
