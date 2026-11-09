import { createHash } from "node:crypto";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_REQUIREMENTS = 200;
const MAX_PAGES = 100;
const MAX_TEXT_LENGTH = 4000;

export class QXProjectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QXProjectError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function cloneJSON(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("QX_PROJECT_INVALID", "Project data must contain finite numbers");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) {
    fail("QX_PROJECT_INVALID", "Project data must be acyclic JSON data");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter(key => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) =>
      key !== String(index) || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value"))) {
      fail("QX_PROJECT_INVALID", "Project arrays must be dense data arrays");
    }
    const result = value.map(item => cloneJSON(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) fail("QX_PROJECT_INVALID", "Project objects must be plain JSON objects");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")) {
      fail("QX_PROJECT_INVALID", "Project objects may contain only enumerable string data properties");
    }
    Object.defineProperty(result, key, {
      value: cloneJSON(descriptor.value, seen),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  seen.delete(value);
  return result;
}

function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(canonicalJSON(value), "utf8").digest("hex");
}

function requireText(value, field, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail("QX_PROJECT_INVALID", field + " must be a non-empty string of at most " + maximum + " characters");
  }
  return value.trim();
}

function stringList(value, field, maximum = MAX_REQUIREMENTS) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("QX_PROJECT_INVALID", field + " must be an array with at most " + maximum + " entries");
  }
  return value.map((item, index) => requireText(item, field + "[" + index + "]"));
}

function normalizePages(value) {
  if (!Array.isArray(value) || value.length > MAX_PAGES) {
    fail("QX_PROJECT_INVALID", "pages must be an array with at most " + MAX_PAGES + " entries");
  }
  const seen = new Set();
  return value.map((page, index) => {
    if (!isPlainObject(page) ||
        Object.keys(page).some(key => !["id", "title", "description"].includes(key)) ||
        !Object.hasOwn(page, "id") || !Object.hasOwn(page, "title")) {
      fail("QX_PROJECT_INVALID", "Each page must contain only id, title, and optional description");
    }
    const id = requireText(page.id, "pages[" + index + "].id", 64);
    if (!PAGE_ID_PATTERN.test(id) || seen.has(id)) {
      fail("QX_PROJECT_INVALID", "Page IDs must be unique and use letters, numbers, underscores, or hyphens");
    }
    seen.add(id);
    return {
      id,
      title: requireText(page.title, "pages[" + index + "].title", 120),
      description: page.description === undefined ? "" :
        requireText(page.description, "pages[" + index + "].description")
    };
  });
}

function projectContent(project) {
  return {
    schemaVersion: project.schemaVersion,
    projectId: project.projectId,
    revision: project.revision,
    title: project.title,
    description: project.description,
    requirements: project.requirements,
    pages: project.pages,
    dataRequirements: project.dataRequirements,
    integrationRequirements: project.integrationRequirements,
    openQuestions: project.openQuestions
  };
}

function seal(project, status, approval = null) {
  const content = projectContent(project);
  return freezeDeep({
    ...content,
    status,
    digest: digest(content),
    approval
  });
}

function assertProject(project) {
  if (!isPlainObject(project) || project.schemaVersion !== "1.0.0" ||
      !Number.isSafeInteger(project.revision) || project.revision < 1 ||
      typeof project.digest !== "string" || project.digest !== digest(projectContent(project))) {
    fail("QX_PROJECT_INVALID", "Project manifest is malformed or its content digest does not match");
  }
}

export function createProjectDraft(input) {
  if (!isPlainObject(input)) fail("QX_PROJECT_INVALID", "Project draft input must be an object");
  const allowed = [
    "projectId", "title", "description", "requirements", "pages",
    "dataRequirements", "integrationRequirements", "openQuestions"
  ];
  if (Object.keys(input).some(key => !allowed.includes(key)) ||
      !["projectId", "title", "description"].every(key => Object.hasOwn(input, key))) {
    fail("QX_PROJECT_INVALID", "Project draft contains unsupported fields or is missing required fields");
  }
  const projectId = requireText(input.projectId, "projectId", 128);
  if (!PROJECT_ID_PATTERN.test(projectId)) fail("QX_PROJECT_INVALID", "projectId format is invalid");
  const project = {
    schemaVersion: "1.0.0",
    projectId,
    revision: 1,
    title: requireText(input.title, "title", 120),
    description: requireText(input.description, "description"),
    requirements: stringList(input.requirements ?? [], "requirements"),
    pages: normalizePages(input.pages ?? []),
    dataRequirements: stringList(input.dataRequirements ?? [], "dataRequirements"),
    integrationRequirements: stringList(input.integrationRequirements ?? [], "integrationRequirements"),
    openQuestions: stringList(input.openQuestions ?? [], "openQuestions")
  };
  return seal(project, "draft");
}

export function submitProjectForReview(project) {
  assertProject(project);
  if (project.status !== "draft" && project.status !== "needs_clarification") {
    fail("QX_PROJECT_INVALID_TRANSITION", "Only a draft can be submitted for review");
  }
  const diagnostics = [];
  if (project.requirements.length === 0) {
    diagnostics.push({ code: "QX_PROJECT_REQUIREMENTS_MISSING", message: "At least one project requirement is required" });
  }
  if (project.pages.length === 0) {
    diagnostics.push({ code: "QX_PROJECT_PAGES_MISSING", message: "At least one page must be described" });
  }
  for (const question of project.openQuestions) {
    diagnostics.push({ code: "QX_PROJECT_CLARIFICATION_REQUIRED", message: question });
  }
  const status = diagnostics.length === 0 ? "ready_for_review" : "needs_clarification";
  return Object.freeze({
    project: seal(project, status),
    diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item)))
  });
}

export function approveProjectDraft(project, { approvedDigest } = {}) {
  assertProject(project);
  if (project.status !== "ready_for_review") {
    fail("QX_PROJECT_APPROVAL_BLOCKED", "Project must be ready for review before approval");
  }
  if (typeof approvedDigest !== "string" || approvedDigest !== project.digest) {
    fail("QX_PROJECT_APPROVAL_STALE", "Approval must reference the exact reviewed project digest");
  }
  return seal(project, "approved", Object.freeze({ digest: project.digest }));
}

export function rejectProjectDraft(project, { reviewedDigest, reason } = {}) {
  assertProject(project);
  if (project.status !== "ready_for_review") {
    fail("QX_PROJECT_INVALID_TRANSITION", "Only a project ready for review can be rejected");
  }
  if (typeof reviewedDigest !== "string" || reviewedDigest !== project.digest) {
    fail("QX_PROJECT_APPROVAL_STALE", "Rejection must reference the exact reviewed project digest");
  }
  return seal(project, "rejected", Object.freeze({
    digest: project.digest,
    reason: requireText(reason, "reason", 1000)
  }));
}

export function reviseProjectDraft(project, changes) {
  assertProject(project);
  if (!["draft", "needs_clarification", "ready_for_review", "approved", "rejected"].includes(project.status)) {
    fail("QX_PROJECT_INVALID_TRANSITION", "Project cannot be revised from its current state");
  }
  if (!isPlainObject(changes)) fail("QX_PROJECT_INVALID", "Project revision changes must be an object");
  const allowed = [
    "title", "description", "requirements", "pages",
    "dataRequirements", "integrationRequirements", "openQuestions"
  ];
  if (Object.keys(changes).length === 0 || Object.keys(changes).some(key => !allowed.includes(key))) {
    fail("QX_PROJECT_INVALID", "Revision must contain supported project content changes");
  }
  const merged = {
    projectId: project.projectId,
    title: changes.title ?? project.title,
    description: changes.description ?? project.description,
    requirements: changes.requirements ?? project.requirements,
    pages: changes.pages ?? project.pages,
    dataRequirements: changes.dataRequirements ?? project.dataRequirements,
    integrationRequirements: changes.integrationRequirements ?? project.integrationRequirements,
    openQuestions: changes.openQuestions ?? project.openQuestions
  };
  const next = createProjectDraft(merged);
  return seal({ ...projectContent(next), revision: project.revision + 1 }, "draft");
}

export function assertProjectApproved(project, { expectedDigest } = {}) {
  assertProject(project);
  if (project.status !== "approved" || !project.approval ||
      project.approval.digest !== project.digest ||
      (expectedDigest !== undefined && expectedDigest !== project.digest)) {
    fail("QX_PROJECT_BUILD_NOT_APPROVED", "Project build is blocked until this exact project revision is approved");
  }
  return project;
}
