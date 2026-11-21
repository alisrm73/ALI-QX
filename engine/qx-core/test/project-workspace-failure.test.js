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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qx-workspace-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  await fs.mkdir(path.join(projectRoot, "src"));
  const draft = createProjectDraft({
    projectId: "workspace-failure-demo", title: "Workspace failure demo",
    description: "Workspace failure-path tests",
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

async function createBackupFixture(t) {
  const state = await fixture(t);
  const { project, workspace, projectRoot } = state;
  const target = path.join(projectRoot, "src/app.js");
  await fs.writeFile(target, "before");
  const replaced = await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js",
    content: "after",
    permission: permission(project, "write", "src/app.js", { mode: "replace" })
  });
  return { ...state, target, backupId: replaced.backupId };
}

test("rejects a symbolic-link backup and preserves the current target", async t => {
  const { root, project, workspace, projectRoot, target, backupId } =
    await createBackupFixture(t);
  const metadataRoot = path.join(projectRoot, ".qx-workspace");
  const projectDir = (await fs.readdir(metadataRoot))[0];
  const backupPath = path.join(metadataRoot, projectDir, "backups", backupId + ".json");
  const outsideBackup = path.join(root, "outside-backup.json");
  await fs.writeFile(outsideBackup, JSON.stringify({
    schemaVersion: "1.0.0", backupId, projectId: project.projectId,
    relativePath: "src/app.js", contentDigest: "sha256:" + "0".repeat(64),
    contentBase64: Buffer.from("outside").toString("base64")
  }));
  await fs.rm(backupPath);
  await fs.symlink(outsideBackup, backupPath);

  await assert.rejects(restoreProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, backupId,
    relativePath: "src/app.js",
    permission: permission(project, "restore", "src/app.js", { backupId })
  }), { code: "QX_WORKSPACE_PATH_UNSAFE" });
  assert.equal(await fs.readFile(target, "utf8"), "after");
});

test("rejects a malformed change-log record instead of returning partial history", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/seed.js",
    content: "seed",
    permission: permission(project, "write", "src/seed.js", { mode: "create" })
  });
  const metadataRoot = path.join(projectRoot, ".qx-workspace");
  const projectDir = (await fs.readdir(metadataRoot))[0];
  const logPath = path.join(metadataRoot, projectDir, "changes.jsonl");
  await fs.writeFile(logPath, "{malformed-json}\n", "utf8");

  await assert.rejects(readProjectChangeLog(workspace), SyntaxError);
});

test("rejects oversized files during read", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/large.bin");
  await fs.writeFile(target, Buffer.alloc(10 * 1024 * 1024 + 1));

  await assert.rejects(readProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/large.bin"
  }), { code: "QX_WORKSPACE_CONTENT_INVALID" });
});

test("rejects oversized replacement before changing the target or creating metadata", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/app.js");
  await fs.writeFile(target, "preserve-me");

  await assert.rejects(writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js",
    content: Buffer.alloc(10 * 1024 * 1024 + 1),
    permission: permission(project, "write", "src/app.js", { mode: "replace" })
  }), { code: "QX_WORKSPACE_CONTENT_INVALID" });

  assert.equal(await fs.readFile(target, "utf8"), "preserve-me");
  await assert.rejects(fs.lstat(path.join(projectRoot, ".qx-workspace")), {
    code: "ENOENT"
  });
});

test("rejects unsupported content types without creating a target", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  await assert.rejects(writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/app.js",
    content: { unexpected: true },
    permission: permission(project, "write", "src/app.js", { mode: "create" })
  }), { code: "QX_WORKSPACE_CONTENT_INVALID" });

  await assert.rejects(fs.lstat(path.join(projectRoot, "src/app.js")), {
    code: "ENOENT"
  });
});
