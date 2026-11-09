import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft, reviseProjectDraft
} from "../src/project-model.js";
import { generateQXSourceFromProject } from "../src/project-source-generator.js";
import {
  analyze, buildWebProject, lowerToQIR, parse, runQIR, validateQIR
} from "../src/index.js";

function approvedProject(overrides = {}) {
  const draft = createProjectDraft({
    projectId: "generated-site",
    title: "موقعي التجريبي",
    description: "موقع تعريفي بسيط",
    requirements: ["عرض معلومات تعريفية"],
    pages: [
      { id: "home", title: "الرئيسية", description: "مرحباً بالعالم" },
      { id: "about", title: "من نحن", description: "صفحة تعريفية" }
    ],
    ...overrides
  });
  const reviewed = submitProjectForReview(draft).project;
  return approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
}

test("generates deterministic QX source and exact UI lock from an approved manifest", () => {
  const project = approvedProject();
  const first = generateQXSourceFromProject(project);
  const second = generateQXSourceFromProject(project);
  assert.equal(first.qxSource, second.qxSource);
  assert.equal(first.treeJson, second.treeJson);
  assert.deepEqual(first.uiLock, second.uiLock);
  assert.equal(first.projectDigest, project.digest);
  assert.equal(first.projectRevision, project.revision);
});

test("requires approval for the exact manifest digest", () => {
  const project = approvedProject();
  assert.throws(() => generateQXSourceFromProject({ ...project, status: "draft" }), {
    code: "QX_PROJECT_BUILD_NOT_APPROVED"
  });
  assert.throws(() => generateQXSourceFromProject(project, {
    expectedProjectDigest: "sha256:" + "0".repeat(64)
  }), { code: "QX_PROJECT_BUILD_NOT_APPROVED" });
  const revised = reviseProjectDraft(project, { title: "Revised title" });
  assert.throws(() => generateQXSourceFromProject(revised), {
    code: "QX_PROJECT_BUILD_NOT_APPROVED"
  });
});

test("serializes quotes, backslashes, newlines, Arabic, and markup as text data", () => {
  const project = approvedProject({
    title: 'عنوان "آمن" \\',
    description: "السطر الأول\n<script>alert(1)</script>",
    pages: [{ id: "unicode", title: "العربية \"QX\"", description: "مسار \\ جديد\nنص" }]
  });
  const generated = generateQXSourceFromProject(project);
  const ast = parse(generated.qxSource);
  const semantic = analyze(ast);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.diagnostics));
  assert.ok(generated.treeJson.includes("<script>alert(1)</script>"));
  assert.ok(generated.treeJson.includes("\\n"));
});

test("rejects malformed approved page data and empty page collections", () => {
  const malformed = {
    ...approvedProject(),
    pages: [{ id: "bad id", title: "Bad", description: "" }]
  };
  assert.throws(() => generateQXSourceFromProject(malformed), {
    code: "QX_PROJECT_INVALID"
  });
});

test("generated source passes parser, semantic analysis, QIR, VM, and static web build", () => {
  const generated = generateQXSourceFromProject(approvedProject());
  const ast = parse(generated.qxSource);
  const semantic = analyze(ast);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.diagnostics));
  const qir = lowerToQIR(ast, semantic);
  assert.deepEqual(validateQIR(qir), []);
  const vmResult = runQIR(qir, { uiLock: generated.uiLock });
  assert.equal(vmResult.outputs.length, 1);
  assert.equal(vmResult.outputs[0].component, "TREE");
  const webProject = buildWebProject(generated.qxSource, {
    title: "Generated Project",
    uiLock: generated.uiLock
  });
  assert.deepEqual(Object.keys(webProject.files).sort(), ["app.js", "index.html", "styles.css"]);
  assert.match(webProject.files["index.html"], /Generated Project/);
});
