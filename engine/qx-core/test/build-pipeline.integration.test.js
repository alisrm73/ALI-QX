import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDraft,
  submitProjectForReview,
  approveProjectDraft,
  createBuildPlan,
  assertBuildPlanForProject,
  createRequirementBuildMap,
  assertRequirementBuildMapForProject,
  createBuildBlueprint,
  assertBuildBlueprintForProject
} from "../src/index.js";

function approvedProject(title = "Integrated build pipeline") {
  const draft = createProjectDraft({
    projectId: "integrated-build-pipeline",
    title,
    description: "A project used to verify the complete pre-build planning pipeline",
    requirements: [
      "Visitors can read the home overview",
      "Visitors can submit a contact request"
    ],
    dataRequirements: ["Store submitted contact requests"],
    integrationRequirements: ["Deliver contact requests through an email service"],
    pages: [
      { id: "home", title: "Home" },
      { id: "contact", title: "Contact" }
    ]
  });
  const reviewed = submitProjectForReview(draft).project;
  return approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
}

function pipelineFixture() {
  const project = approvedProject();
  const buildPlan = createBuildPlan(project, {
    expectedProjectDigest: project.digest,
    externalInputs: ["approved-manifest"],
    tasks: [
      {
        id: "ui",
        dependsOn: [],
        inputs: ["approved-manifest"],
        outputs: ["home-ui", "contact-ui"]
      },
      {
        id: "web",
        dependsOn: ["ui"],
        inputs: ["home-ui", "contact-ui"],
        outputs: ["index-html", "app-js"]
      },
      {
        id: "package",
        dependsOn: ["web"],
        inputs: ["index-html", "app-js"],
        outputs: ["web-package", "integration-config"]
      }
    ]
  });
  const fileBindings = [
    {
      path: "dist/index.html",
      artifactId: "index-html",
      taskId: "web",
      componentIds: ["home-page"]
    },
    {
      path: "dist/app.js",
      artifactId: "app-js",
      taskId: "web",
      componentIds: ["contact-form"]
    },
    {
      path: "config/integrations.json",
      artifactId: "integration-config",
      taskId: "package",
      componentIds: ["contact-form"]
    }
  ];
  const mappings = [
    {
      category: "requirement",
      requirementIndex: 0,
      componentIds: ["home-page"],
      filePaths: ["dist/index.html"]
    },
    {
      category: "requirement",
      requirementIndex: 1,
      componentIds: ["contact-form"],
      filePaths: ["dist/app.js"]
    },
    {
      category: "data",
      requirementIndex: 0,
      componentIds: ["contact-form"],
      filePaths: ["dist/app.js"]
    },
    {
      category: "integration",
      requirementIndex: 0,
      componentIds: ["contact-form"],
      filePaths: ["config/integrations.json"]
    }
  ];
  const requirementBuildMap = createRequirementBuildMap(project, {
    expectedProjectDigest: project.digest,
    buildPlan,
    mappings,
    fileBindings
  });
  const blueprint = createBuildBlueprint(project, {
    expectedProjectDigest: project.digest,
    buildPlan,
    requirementBuildMap
  });
  return { project, buildPlan, mappings, fileBindings, requirementBuildMap, blueprint };
}

test("integrates approved project, build plan, requirement map, and blueprint end to end", () => {
  const state = pipelineFixture();

  assert.equal(assertBuildPlanForProject(state.project, state.buildPlan), state.buildPlan);
  assert.equal(
    assertRequirementBuildMapForProject(state.project, state.buildPlan, state.requirementBuildMap),
    state.requirementBuildMap
  );
  assert.equal(
    assertBuildBlueprintForProject(
      state.project,
      state.buildPlan,
      state.requirementBuildMap,
      state.blueprint
    ),
    state.blueprint
  );

  assert.deepEqual(state.blueprint.order, ["ui", "web", "package"]);
  assert.deepEqual(
    state.blueprint.requirements.map(entry => entry.key),
    ["data:0", "integration:0", "requirement:0", "requirement:1"]
  );
  assert.deepEqual(
    state.blueprint.requirements.find(entry => entry.key === "requirement:0").taskIds,
    ["ui", "web"]
  );
  assert.deepEqual(
    state.blueprint.tasks.find(task => task.id === "package").filePaths,
    ["config/integrations.json"]
  );
  assert.equal(state.blueprint.projectDigest, state.project.digest);
  assert.equal(state.blueprint.buildPlanDigest, state.buildPlan.digest);
  assert.equal(state.blueprint.requirementBuildMapDigest, state.requirementBuildMap.digest);
  assert.equal(Object.isFrozen(state.blueprint), true);
  assert.equal(Object.isFrozen(state.blueprint.requirements[0]), true);
});

test("blocks the pipeline when even one approved requirement is not mapped", () => {
  const state = pipelineFixture();

  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: state.mappings.slice(1)
  }), { code: "QX_REQUIREMENT_BUILD_MAP_INCOMPLETE" });
});

test("rejects a plan and downstream artifacts after approved project content changes", () => {
  const state = pipelineFixture();
  const revisedProject = approvedProject("Revised integrated build pipeline");

  assert.notEqual(revisedProject.digest, state.project.digest);
  assert.throws(
    () => assertBuildPlanForProject(revisedProject, state.buildPlan),
    { code: "QX_PROJECT_BUILD_NOT_APPROVED" }
  );
  assert.throws(
    () => assertRequirementBuildMapForProject(
      revisedProject,
      state.buildPlan,
      state.requirementBuildMap
    ),
    { code: "QX_PROJECT_BUILD_NOT_APPROVED" }
  );
  assert.throws(
    () => assertBuildBlueprintForProject(
      revisedProject,
      state.buildPlan,
      state.requirementBuildMap,
      state.blueprint
    ),
    { code: "QX_PROJECT_BUILD_NOT_APPROVED" }
  );
});

test("rejects tampering at each hand-off boundary in the integrated pipeline", () => {
  const state = pipelineFixture();

  const tamperedPlan = {
    ...state.buildPlan,
    order: ["package", "web", "ui"]
  };
  assert.throws(
    () => assertBuildPlanForProject(state.project, tamperedPlan),
    { code: "QX_BUILD_PLAN_INVALID" }
  );

  const tamperedMap = {
    ...state.requirementBuildMap,
    entries: state.requirementBuildMap.entries.slice(1)
  };
  assert.throws(
    () => assertRequirementBuildMapForProject(
      state.project,
      state.buildPlan,
      tamperedMap
    ),
    { code: "QX_REQUIREMENT_BUILD_MAP_INVALID" }
  );
  assert.throws(
    () => createBuildBlueprint(state.project, {
      expectedProjectDigest: state.project.digest,
      buildPlan: state.buildPlan,
      requirementBuildMap: tamperedMap
    }),
    { code: "QX_REQUIREMENT_BUILD_MAP_INVALID" }
  );

  const tamperedBlueprint = {
    ...state.blueprint,
    files: state.blueprint.files.slice(1)
  };
  assert.throws(
    () => assertBuildBlueprintForProject(
      state.project,
      state.buildPlan,
      state.requirementBuildMap,
      tamperedBlueprint
    ),
    { code: "QX_BUILD_BLUEPRINT_INVALID" }
  );
});

test("rejects accessor-backed data at the blueprint boundary without invoking it", () => {
  const state = pipelineFixture();
  let invoked = false;
  const malformedBlueprint = { ...state.blueprint };
  Object.defineProperty(malformedBlueprint, "untrusted", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("Untrusted accessor must not execute");
    }
  });

  assert.throws(
    () => assertBuildBlueprintForProject(
      state.project,
      state.buildPlan,
      state.requirementBuildMap,
      malformedBlueprint
    ),
    { code: "QX_BUILD_BLUEPRINT_INVALID" }
  );
  assert.equal(invoked, false);
});
