import { createHash } from "node:crypto";
import { assertProjectApproved, QXProjectError } from "./project-model.js";
import { createDefaultUILock, validateUIComponentTree } from "./ui-component-runtime.js";

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function requireText(value, field, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    fail("QX_PROJECT_GENERATION_INVALID", field + " must be a string" + (allowEmpty ? "" : " containing text"));
  }
  return value;
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

export function generateQXSourceFromProject(project, { expectedProjectDigest } = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (!Array.isArray(project.pages) || project.pages.length === 0 ||
      typeof project.title !== "string" || typeof project.description !== "string") {
    fail("QX_PROJECT_GENERATION_INVALID", "An approved project must contain a title, description, and at least one page");
  }

  const pageIds = new Set();
  const generatedIds = new Set(["project-root", "project-title", "project-description"]);
  const pageNodes = project.pages.map((page, index) => {
    if (!page || typeof page !== "object" || Array.isArray(page) ||
        typeof page.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(page.id) ||
        typeof page.title !== "string" || page.title.trim().length === 0 ||
        (page.description !== undefined && typeof page.description !== "string")) {
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
        componentNode("project-title", "UI.HEADING", { level: 1 }, [textNode(requireText(project.title, "title"))]),
        componentNode("project-description", "UI.TEXT_BLOCK", {}, [textNode(requireText(project.description, "description"))]),
        ...pageNodes
      ])
    ]
  };
  const treeJson = JSON.stringify(tree);
  const uiLock = createDefaultUILock();
  validateUIComponentTree(treeJson, uiLock);
  const qxSource = "UI.TREE(" + JSON.stringify(treeJson) + ")";
  return Object.freeze({
    projectId: project.projectId,
    projectRevision: project.revision,
    projectDigest: project.digest,
    qxSource,
    treeJson,
    uiLock
  });
}
