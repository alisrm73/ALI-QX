import { createHash } from "node:crypto";
import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { createDefaultUILock, validateUIComponentTree } from "./ui-component-runtime.js";

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function assertPlainJSONData(value, field, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("QX_PROJECT_GENERATION_INVALID", field + " must contain finite numbers");
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    fail("QX_PROJECT_GENERATION_INVALID", field + " must contain acyclic JSON data");
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors).filter(key => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) =>
      key !== String(index) || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value"))) {
      fail("QX_PROJECT_GENERATION_INVALID", field + " must contain dense data arrays without extra properties");
    }
    for (let index = 0; index < value.length; index += 1) {
      assertPlainJSONData(descriptors[String(index)].value, field + "[" + index + "]", seen);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail("QX_PROJECT_GENERATION_INVALID", field + " must contain plain data objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")) {
        fail("QX_PROJECT_GENERATION_INVALID", field + " must not contain symbols, hidden fields, or accessors");
      }
      assertPlainJSONData(descriptor.value, field + "." + key, seen);
    }
  }
  seen.delete(value);
}

function assertExactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")) {
    fail("QX_PROJECT_GENERATION_INVALID", field + " contains unsupported or missing fields");
  }
}

function pageNodeId(pageId) {
  return "page-" + createHash("sha256").update(pageId, "utf8").digest("hex").slice(0, 16);
}

function textNode(value) {
  return { kind: "text", value };
}

function componentNode(id, type, props, children) {
  return { kind: "component", id, type, version: "1.0.0", props, children };
}

export function generateQXSourceFromProject(project, options = {}) {
  assertPlainJSONData(options, "options");
  if (Object.keys(options).some(key => key !== "expectedProjectDigest")) {
    fail("QX_PROJECT_GENERATION_INVALID", "options contains unsupported fields");
  }
  assertPlainJSONData(project, "project");

  const expectedKeys = [
    "approval", "dataRequirements", "description", "digest", "integrationRequirements",
    "openQuestions", "pages", "projectId", "requirements", "revision", "schemaVersion",
    "status", "title"
  ];
  assertExactKeys(project, expectedKeys, "Approved project manifest");

  assertProjectApproved(project, { expectedDigest: options.expectedProjectDigest });

  if (!Array.isArray(project.pages) || project.pages.length === 0 ||
      typeof project.title !== "string" || project.title.trim().length === 0 ||
      typeof project.description !== "string" || project.description.trim().length === 0) {
    fail("QX_PROJECT_GENERATION_INVALID", "An approved project must contain a title, description, and at least one page");
  }

  for (const field of ["requirements", "dataRequirements", "integrationRequirements", "openQuestions"]) {
    if (!Array.isArray(project[field]) || project[field].some(value => typeof value !== "string")) {
      fail("QX_PROJECT_GENERATION_INVALID", field + " must be a dense array of strings");
    }
  }

  const pageIds = new Set();
  const generatedIds = new Set(["project-root", "project-title", "project-description"]);
  const pageNodes = project.pages.map((page, index) => {
    assertExactKeys(page, ["id", "title", "description"], "Project page " + index);
    if (typeof page.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(page.id) ||
        typeof page.title !== "string" || page.title.trim().length === 0 ||
        typeof page.description !== "string") {
      fail("QX_PROJECT_GENERATION_INVALID", "Project page " + index + " is malformed");
    }
    if (pageIds.has(page.id)) fail("QX_PROJECT_GENERATION_INVALID", "Project page IDs must be unique");
    pageIds.add(page.id);
    const id = pageNodeId(page.id);
    const ids = [id, id + "-heading", id + "-description"];
    if (ids.some(value => value.length > 64 || generatedIds.has(value))) {
      fail("QX_PROJECT_GENERATION_INVALID", "Generated UI node IDs are invalid or collide");
    }
    ids.forEach(value => generatedIds.add(value));
    const children = [
      componentNode(id + "-heading", "UI.HEADING", { level: 2 }, [textNode(page.title)])
    ];
    if (page.description.length > 0) {
      children.push(componentNode(id + "-description", "UI.TEXT_BLOCK", {}, [textNode(page.description)]));
    }
    return componentNode(id, "UI.CONTAINER", {}, children);
  });

  const tree = {
    schema: "QX.UI.TREE",
    version: "1.0",
    children: [
      componentNode("project-root", "UI.CONTAINER", {}, [
        componentNode("project-title", "UI.HEADING", { level: 1 }, [textNode(project.title)]),
        componentNode("project-description", "UI.TEXT_BLOCK", {}, [textNode(project.description)]),
        ...pageNodes
      ])
    ]
  };
  const treeJson = JSON.stringify(tree);
  const uiLock = createDefaultUILock();
  validateUIComponentTree(treeJson, uiLock);
  const qxSource = "UI.TREE(" + JSON.stringify(treeJson) + ")";
  const unmappedRequirements = Object.freeze([
    ...project.requirements.map(value => Object.freeze({ category: "requirement", value })),
    ...project.dataRequirements.map(value => Object.freeze({ category: "data", value })),
    ...project.integrationRequirements.map(value => Object.freeze({ category: "integration", value }))
  ]);
  return Object.freeze({
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    unmappedRequirements,
    qxSource,
    treeJson,
    uiLock
  });
}
