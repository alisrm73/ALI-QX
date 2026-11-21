import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProjectDraft, submitProjectForReview, approveProjectDraft
} from "../src/project-model.js";
import {
  openProjectWorkspace, readProjectFile, writeProjectFile, restoreProjectFile, readProjectChangeLog
} from "../src/project-workspace.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qx-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  await fs.mkdir(path.join(projectRoot, "src"));
  const draft = createProjectDraft({
    projectId: "workspace-demo", title: "Workspace demo", description: "Workspace tests",
    requirements: ["A home page exists"], pages: [{ id: "home", title: "Home" }]
  });
  const reviewed = submitProjectForReview(draft).project;
  const project = approveProjectDraft(reviewed, { approvedDigest: reviewed.digest });
  const workspace = await openProjectWorkspace({ root: projectRoot, projectId: project.projectId });
  return { root, projectRoot, project, workspace };
}

function permission(project, operation, relativePath, extra = {}) {
  return { operation, relativePath, approvedProjectDigest: project.digest, ...extra };
}

test("requires an existing absolute root and canonicalizes it", async t => {
  const { projectRoot, project } = await fixture(t);
  const workspace = await openProjectWorkspace({ root: projectRoot, projectId: project.projectId });
  assert.equal(workspace.root, await fs.realpath(projectRoot));
  await assert.rejects(openProjectWorkspace({ root: "relative/path", projectId: project.projectId }), {
    code: "QX_WORKSPACE_CONFIG_INVALID"
  });
  await assert.rejects(openProjectWorkspace({ root: path.join(projectRoot, "missing"), projectId: project.projectId }), {
    code: "QX_WORKSPACE_CONFIG_INVALID"
  });
});



test("binds workspace operations to the approved project identity", async t => {
  const { workspace } = await fixture(t);
  const otherDraft = createProjectDraft({
    projectId: "different-project", title: "Other", description: "Another project",
    requirements: ["A page"], pages: [{ id: "home", title: "Home" }]
  });
  const otherProject = approveProjectDraft(
    submitProjectForReview(otherDraft).project,
    { approvedDigest: submitProjectForReview(otherDraft).project.digest }
  );
  await assert.rejects(writeProjectFile(workspace, {
    project: otherProject, expectedProjectDigest: otherProject.digest,
    relativePath: "src/other.js", content: "blocked",
    permission: permission(otherProject, "write", "src/other.js", { mode: "create" })
  }), { code: "QX_WORKSPACE_PROJECT_MISMATCH" });
});

test("does not create missing parent directories or accept forged workspace handles", async t => {
  const { project, workspace } = await fixture(t);
  const relativePath = "new-folder/app.js";
  await assert.rejects(writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath, content: "blocked",
    permission: permission(project, "write", relativePath, { mode: "create" })
  }), { code: "QX_WORKSPACE_PARENT_MISSING" });
  await assert.rejects(writeProjectFile({
    root: workspace.root, projectId: project.projectId
  }, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js", content: "blocked",
    permission: permission(project, "write", "src/app.js", { mode: "create" })
  }), { code: "QX_WORKSPACE_CONFIG_INVALID" });
});


test("reads only approved regular files and returns their content digest", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  await fs.writeFile(path.join(projectRoot, "src/readme.txt"), "delivery artifact");
  const result = await readProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/readme.txt"
  });
  assert.equal(result.content.toString("utf8"), "delivery artifact");
  assert.match(result.contentDigest, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(readProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/missing.txt"
  }), { code: "QX_WORKSPACE_FILE_MISSING" });
  await assert.rejects(readProjectFile(workspace, {
    project: { ...project, title: "tampered" }, expectedProjectDigest: project.digest,
    relativePath: "src/readme.txt"
  }), { code: "QX_PROJECT_INVALID" });
});

test("requires exact approval and explicit create permission for each write", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  await assert.rejects(writeProjectFile(workspace, {
    project, relativePath: "src/app.js", content: "one"
  }), { code: "QX_WORKSPACE_PERMISSION_REQUIRED" });
  await assert.rejects(writeProjectFile(workspace, {
    project: { ...project, title: "tampered" }, expectedProjectDigest: project.digest,
    relativePath: "src/app.js", content: "one",
    permission: permission(project, "write", "src/app.js", { mode: "create" })
  }), { code: "QX_PROJECT_INVALID" });
  const result = await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js", content: "one",
    permission: permission(project, "write", "src/app.js", { mode: "create" })
  });
  assert.equal(result.backupId, null);
  assert.equal(await fs.readFile(path.join(projectRoot, "src/app.js"), "utf8"), "one");
});

test("blocks traversal, absolute paths, metadata access, and symbolic links", async t => {
  const { project, workspace, projectRoot, root } = await fixture(t);
  const write = relativePath => writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath, content: "blocked",
    permission: permission(project, "write", relativePath, { mode: "create" })
  });
  for (const invalid of ["../outside.txt", "/tmp/outside.txt", "src/../../outside", ".qx-workspace/changes.jsonl", "src\\escape.js"]) {
    await assert.rejects(write(invalid), { code: "QX_WORKSPACE_PATH_INVALID" });
  }
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(projectRoot, "linked"));
  await assert.rejects(write("linked/escape.txt"), { code: "QX_WORKSPACE_PATH_UNSAFE" });
  await fs.symlink(path.join(root, "outside.txt"), path.join(projectRoot, "link-file"));
  await assert.rejects(write("link-file"), { code: "QX_WORKSPACE_PATH_UNSAFE" });
});

test("backs up before replacement and requires explicit replace permission", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/app.js");
  await fs.writeFile(target, "before");
  await assert.rejects(writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js", content: "after",
    permission: permission(project, "write", "src/app.js", { mode: "create" })
  }), { code: "QX_WORKSPACE_FILE_EXISTS" });
  const result = await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js", content: "after",
    permission: permission(project, "write", "src/app.js", { mode: "replace" })
  });
  assert.ok(result.backupId);
  assert.equal(await fs.readFile(target, "utf8"), "after");
});

test("restores only the named backup and records a safety backup of the current version", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/app.js");
  await fs.writeFile(target, "version one");
  const replaced = await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js", content: "version two",
    permission: permission(project, "write", "src/app.js", { mode: "replace" })
  });
  await assert.rejects(restoreProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, backupId: replaced.backupId,
    relativePath: "other.js",
    permission: permission(project, "restore", "other.js", { backupId: replaced.backupId })
  }), { code: "QX_WORKSPACE_BACKUP_PATH_MISMATCH" });
  await assert.rejects(restoreProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, backupId: replaced.backupId,
    relativePath: "src/app.js",
    permission: permission(project, "restore", "src/app.js", { backupId: "00000000-0000-0000-0000-000000000000" })
  }), { code: "QX_WORKSPACE_PERMISSION_REQUIRED" });
  const restored = await restoreProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, backupId: replaced.backupId,
    relativePath: "src/app.js",
    permission: permission(project, "restore", "src/app.js", { backupId: replaced.backupId })
  });
  assert.equal(await fs.readFile(target, "utf8"), "version one");
  assert.ok(restored.safetyBackupId);
  const log = await readProjectChangeLog(workspace);
  assert.deepEqual(log.map(entry => entry.event), [
    "write_started", "write_completed", "restore_started", "restore_completed"
  ]);
});

test("refuses to restore corrupted backup records", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/app.js");
  await fs.writeFile(target, "old");
  const replaced = await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js", content: "new",
    permission: permission(project, "write", "src/app.js", { mode: "replace" })
  });
  const metadataRoot = path.join(projectRoot, ".qx-workspace");
  const projectDir = (await fs.readdir(metadataRoot))[0];
  const backupPath = path.join(metadataRoot, projectDir, "backups", replaced.backupId + ".json");
  const record = JSON.parse(await fs.readFile(backupPath, "utf8"));
  record.contentBase64 = Buffer.from("tampered").toString("base64");
  await fs.writeFile(backupPath, JSON.stringify(record));
  await assert.rejects(restoreProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, backupId: replaced.backupId,
    relativePath: "src/app.js",
    permission: permission(project, "restore", "src/app.js", { backupId: replaced.backupId })
  }), { code: "QX_WORKSPACE_BACKUP_CORRUPT" });
});


test("returns an empty change log when workspace metadata has not been created", async t => {
  const { workspace } = await fixture(t);
  assert.deepEqual(await readProjectChangeLog(workspace), []);
});

test("returns an empty change log when the project metadata directory is missing", async t => {
  const { workspace, projectRoot } = await fixture(t);
  await fs.mkdir(path.join(projectRoot, ".qx-workspace"));
  assert.deepEqual(await readProjectChangeLog(workspace), []);
});
