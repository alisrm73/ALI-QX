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

  await assert.rejects(readProjectChangeLog(workspace), { code: "QX_WORKSPACE_CHANGE_LOG_INVALID" });
});

test("rejects syntactically valid JSON values that are not change-log events", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/seed.js",
    content: "seed",
    permission: permission(project, "write", "src/seed.js", { mode: "create" })
  });
  const metadataRoot = path.join(projectRoot, ".qx-workspace");
  const projectDir = (await fs.readdir(metadataRoot))[0];
  const logPath = path.join(metadataRoot, projectDir, "changes.jsonl");

  for (const invalidRecord of ["null", "[]", "17", "{}", '{"event":"unknown"}',
    JSON.stringify({ timestamp: new Date().toISOString(), event: "write_started",
      relativePath: "../escape", projectDigest: project.digest, operation: "create" })]) {
    await fs.writeFile(logPath, invalidRecord + "\n", "utf8");
    await assert.rejects(readProjectChangeLog(workspace), {
      code: "QX_WORKSPACE_CHANGE_LOG_INVALID"
    });
  }
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

test("rejects replacing an existing file larger than the backup and restore limit", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/large-existing.bin");
  const original = Buffer.alloc(10 * 1024 * 1024 + 1, 0x5a);
  await fs.writeFile(target, original);

  await assert.rejects(writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest,
    relativePath: "src/large-existing.bin",
    content: "small replacement",
    permission: permission(project, "write", "src/large-existing.bin", { mode: "replace" })
  }), { code: "QX_WORKSPACE_CONTENT_INVALID" });

  assert.deepEqual(await fs.readFile(target), original);
  await assert.rejects(fs.lstat(path.join(projectRoot, ".qx-workspace")), {
    code: "ENOENT"
  });
});


test("reports a completion-log warning when a write succeeds but its completion event fails", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/write-log-failure.js");
  await fs.writeFile(target, "before");
  const originalAppendFile = fs.appendFile;
  let appendCalls = 0;
  fs.appendFile = async (...args) => {
    appendCalls += 1;
    if (appendCalls === 2) {
      const error = new Error("simulated completion log failure");
      error.code = "EIO";
      throw error;
    }
    return originalAppendFile(...args);
  };
  let result;
  try {
    result = await writeProjectFile(workspace, {
      project, expectedProjectDigest: project.digest,
      relativePath: "src/write-log-failure.js", content: "after",
      permission: permission(project, "write", "src/write-log-failure.js", { mode: "replace" })
    });
  } finally {
    fs.appendFile = originalAppendFile;
  }

  assert.equal(await fs.readFile(target, "utf8"), "after");
  assert.equal(result.changeLogWarning.code, "EIO");
  assert.match(result.changeLogWarning.message, /was written/);
});

test("reports a completion-log warning when a restore succeeds but its completion event fails", async t => {
  const { project, workspace, projectRoot, target, backupId } = await createBackupFixture(t);
  const originalAppendFile = fs.appendFile;
  let appendCalls = 0;
  fs.appendFile = async (...args) => {
    appendCalls += 1;
    if (appendCalls === 2) {
      const error = new Error("simulated completion log failure");
      error.code = "EIO";
      throw error;
    }
    return originalAppendFile(...args);
  };
  let result;
  try {
    result = await restoreProjectFile(workspace, {
      project, expectedProjectDigest: project.digest, backupId,
      relativePath: "src/app.js",
      permission: permission(project, "restore", "src/app.js", { backupId })
    });
  } finally {
    fs.appendFile = originalAppendFile;
  }

  assert.equal(await fs.readFile(target, "utf8"), "before");
  assert.equal(result.changeLogWarning.code, "EIO");
  assert.match(result.changeLogWarning.message, /was restored/);
});

test("rejects restoring over an oversized current file before creating a safety backup", async t => {
  const { project, workspace, projectRoot, target, backupId } = await createBackupFixture(t);
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
  await fs.writeFile(target, oversized);

  await assert.rejects(restoreProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, backupId,
    relativePath: "src/app.js",
    permission: permission(project, "restore", "src/app.js", { backupId })
  }), { code: "QX_WORKSPACE_CONTENT_INVALID" });

  assert.deepEqual(await fs.readFile(target), oversized);
  const metadataRoot = path.join(projectRoot, ".qx-workspace");
  const projectDir = (await fs.readdir(metadataRoot))[0];
  const backupDir = path.join(metadataRoot, projectDir, "backups");
  const backups = await fs.readdir(backupDir);
  assert.equal(backups.length, 1);
});


test("allows only one of two concurrent create writes to publish the target", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const relativePath = "src/concurrent-create.js";
  const writes = ["first", "second"].map(content => writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath, content,
    permission: permission(project, "write", relativePath, { mode: "create" })
  }));

  const results = await Promise.allSettled(writes);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.equal(rejected.reason.code, "QX_WORKSPACE_FILE_EXISTS");
  assert.ok(["first", "second"].includes(
    await fs.readFile(path.join(projectRoot, relativePath), "utf8")
  ));

  const log = await readProjectChangeLog(workspace);
  assert.equal(log.filter(entry => entry.event === "write_started").length, 2);
  assert.equal(log.filter(entry => entry.event === "write_completed").length, 1);
});

test("bounds change-log reads to the configured limit when the file grows during reading", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  await writeProjectFile(workspace, {
    project, expectedProjectDigest: project.digest, relativePath: "src/seed.js",
    content: "seed",
    permission: permission(project, "write", "src/seed.js", { mode: "create" })
  });
  const metadataRoot = path.join(projectRoot, ".qx-workspace");
  const projectDir = (await fs.readdir(metadataRoot))[0];
  const logPath = path.join(metadataRoot, projectDir, "changes.jsonl");
  const originalOpen = fs.open;
  const originalAppendFile = fs.appendFile;
  let requestedBytes = 0;

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== logPath) return handle;
    return new Proxy(handle, {
      get(fileHandle, property) {
        if (property === "read") {
          return async (buffer, offset, length, position) => {
            requestedBytes = Math.max(requestedBytes, length);
            if (position === 0) {
              await originalAppendFile(logPath, Buffer.alloc(12 * 1024 * 1024));
            }
            return fileHandle.read(buffer, offset, length, position);
          };
        }
        const value = Reflect.get(fileHandle, property, fileHandle);
        return typeof value === "function" ? value.bind(fileHandle) : value;
      }
    });
  };

  try {
    await assert.rejects(readProjectChangeLog(workspace), {
      code: "QX_WORKSPACE_CHANGE_LOG_INVALID"
    });
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(requestedBytes, 10 * 1024 * 1024 + 1);
  assert.ok((await fs.stat(logPath)).size > requestedBytes);
});

test("rejects a file that grows beyond the read limit while it is being read", async t => {
  const { project, workspace, projectRoot } = await fixture(t);
  const target = path.join(projectRoot, "src/growing-during-read.bin");
  await fs.writeFile(target, "small");
  const originalOpen = fs.open;
  const originalAppendFile = fs.appendFile;

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== target) return handle;
    return new Proxy(handle, {
      get(fileHandle, property) {
        if (property === "readFile") {
          return async (...readArgs) => {
            await originalAppendFile(target, Buffer.alloc(10 * 1024 * 1024 + 1));
            return fileHandle.readFile(...readArgs);
          };
        }
        const value = Reflect.get(fileHandle, property, fileHandle);
        return typeof value === "function" ? value.bind(fileHandle) : value;
      }
    });
  };

  try {
    await assert.rejects(readProjectFile(workspace, {
      project, expectedProjectDigest: project.digest, relativePath: "src/growing-during-read.bin"
    }), { code: "QX_WORKSPACE_CONTENT_INVALID" });
  } finally {
    fs.open = originalOpen;
  }

  assert.ok((await fs.stat(target)).size > 10 * 1024 * 1024);
});
