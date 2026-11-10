import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft, reviseProjectDraft
} from "../src/project-model.js";
import { createBuildPlan } from "../src/build-plan.js";
import {
  createRequirementBuildMap,
  assertRequirementBuildMapForProject
} from "../src/requirement-build-map.js";

function approvedProject() {
  const draft = createProjectDraft({
    projectId: "traceability-demo",
    title: "Traceability demo",
    description: "A project used to verify requirement-to-build traceability",
    requirements: [
      "Visitors can read the home overview",
      "Visitors can submit a contact request"
    ],
    dataRequirements: ["Store submitted contact requests"],
    integrationRequirements: [],
    pages: [{ id: "home", title: "Home" }, { id: "contact", title: "Contact" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  return approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
}

function fixture() {
  const project = approvedProject();
  const buildPlan = createBuildPlan(project, {
    expectedProjectDigest: project.digest,
    externalInputs: ["approved-manifest"],
    tasks: [
      { id: "ui", dependsOn: [], inputs: ["approved-manifest"], outputs: ["home-ui", "contact-ui"] },
      { id: "web", dependsOn: ["ui"], inputs: ["home-ui", "contact-ui"], outputs: ["index-html", "app-js"] },
      { id: "package", dependsOn: ["web"], inputs: ["index-html", "app-js"], outputs: ["web-package"] }
    ]
  });
  const fileBindings = [
    { path: "dist/index.html", artifactId: "index-html", taskId: "web", componentIds: ["home-page"] },
    { path: "dist/app.js", artifactId: "app-js", taskId: "web", componentIds: ["home-page", "contact-form"] }
  ];
  const mappings = [
    { category: "requirement", requirementIndex: 0, componentIds: ["home-page"], filePaths: ["dist/index.html"] },
    { category: "requirement", requirementIndex: 1, componentIds: ["contact-form"], filePaths: ["dist/app.js"] },
    { category: "data", requirementIndex: 0, componentIds: ["contact-form"], filePaths: ["dist/app.js"] }
  ];
  return { project, buildPlan, fileBindings, mappings };
}

test("maps every approved project requirement to components, files, producer tasks, and prerequisites", () => {
  const state = fixture();
  const map = createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: state.mappings
  });

  const home = map.entries.find(entry => entry.category === "requirement" && entry.requirementIndex === 0);
  assert.equal(map.entries.length, 3);
  assert.deepEqual(home.taskIds, ["ui", "web"]);
  assert.deepEqual(home.componentIds, ["home-page"]);
  assert.deepEqual(home.filePaths, ["dist/index.html"]);
  assert.equal(map.projectDigest, state.project.digest);
  assert.equal(map.buildPlanDigest, state.buildPlan.digest);
  assert.equal(Object.isFrozen(map), true);
  assert.equal(Object.isFrozen(home), true);
  assert.equal(assertRequirementBuildMapForProject(state.project, state.buildPlan, map), map);
});

test("produces deterministic mappings independent of input order", () => {
  const state = fixture();
  const first = createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: state.mappings
  });
  const second = createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: [...state.fileBindings].reverse(),
    mappings: [...state.mappings].reverse()
  });
  assert.equal(first.digest, second.digest);
});

test("requires complete, unique mapping for requirements, data, and integrations", () => {
  const state = fixture();
  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: state.mappings.slice(1)
  }), { code: "QX_REQUIREMENT_BUILD_MAP_INCOMPLETE" });

  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: [...state.mappings, state.mappings[0]]
  }), { code: "QX_REQUIREMENT_BUILD_MAP_INVALID" });
});

test("rejects missing files, unknown components, and unsafe paths", () => {
  const state = fixture();
  const replaceFirst = patch => state.mappings.map((item, index) => index === 0 ? { ...item, ...patch } : item);

  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: replaceFirst({ filePaths: ["dist/missing.html"] })
  }), { code: "QX_REQUIREMENT_BUILD_MAP_MISSING_FILE" });

  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: replaceFirst({ componentIds: ["not-in-file"] })
  }), { code: "QX_REQUIREMENT_BUILD_MAP_COMPONENT_MISMATCH" });

  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: replaceFirst({ filePaths: ["../outside.html"] })
  }), { code: "QX_REQUIREMENT_BUILD_MAP_INVALID" });
});

test("rejects file ownership conflicts and artifacts not produced by their declared task", () => {
  const state = fixture();
  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: [...state.fileBindings, { ...state.fileBindings[0], taskId: "package", artifactId: "web-package" }],
    mappings: state.mappings
  }), { code: "QX_REQUIREMENT_BUILD_MAP_FILE_CONFLICT" });

  assert.throws(() => createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: [{ ...state.fileBindings[0], artifactId: "missing-artifact" }, state.fileBindings[1]],
    mappings: state.mappings
  }), { code: "QX_REQUIREMENT_BUILD_MAP_ARTIFACT_MISMATCH" });
});

test("rejects stale approvals, mismatched plans, and tampered maps", () => {
  const state = fixture();
  const map = createRequirementBuildMap(state.project, {
    expectedProjectDigest: state.project.digest,
    buildPlan: state.buildPlan,
    fileBindings: state.fileBindings,
    mappings: state.mappings
  });
  const revised = reviseProjectDraft(state.project, { title: "Revised" });
  assert.throws(() => assertRequirementBuildMapForProject(revised, state.buildPlan, map), {
    code: "QX_PROJECT_BUILD_NOT_APPROVED"
  });
  assert.throws(() => assertRequirementBuildMapForProject(state.project, state.buildPlan, {
    ...map,
    entries: map.entries.slice(1)
  }), { code: "QX_REQUIREMENT_BUILD_MAP_INVALID" });
});
