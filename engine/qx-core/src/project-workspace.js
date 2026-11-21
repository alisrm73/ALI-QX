import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertProjectApproved, QXProjectError } from "./project-model.js";

const METADATA_DIR = ".qx-workspace";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BACKUP_RECORD_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 16 * 1024;
const OPEN_WORKSPACES = new WeakSet();

function assertWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || !OPEN_WORKSPACES.has(workspace)) {
    fail("QX_WORKSPACE_CONFIG_INVALID", "Workspace must be created by openProjectWorkspace");
  }
}

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function hash(data) {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function projectKey(projectId) {
  return createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 32);
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 ||
      value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    fail("QX_WORKSPACE_PATH_INVALID", "A project file path must be a safe relative POSIX path");
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..") ||
      segments[0] === METADATA_DIR) {
    fail("QX_WORKSPACE_PATH_INVALID", "Project file path contains a forbidden path segment");
  }
  return segments.join("/");
}

function assertPermission(permission, { operation, relativePath, project }) {
  if (!permission || permission.operation !== operation ||
      permission.relativePath !== relativePath ||
      permission.approvedProjectDigest !== project.digest) {
    fail("QX_WORKSPACE_PERMISSION_REQUIRED",
      "An explicit permission matching the operation, exact path, and approved project digest is required");
  }
}

async function assertDirectoryNoSymlink(targetPath, expectedRoot) {
  let info;
  try {
    info = await fs.lstat(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      fail("QX_WORKSPACE_PARENT_MISSING", "Parent directories must already exist inside the selected workspace");
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("QX_WORKSPACE_PATH_UNSAFE", "A workspace directory is missing, not a directory, or is a symbolic link");
  }
  const actual = await fs.realpath(targetPath);
  if (!isWithinRoot(expectedRoot, actual)) {
    fail("QX_WORKSPACE_PATH_UNSAFE", "Workspace path resolves outside the selected root");
  }
  return info;
}

async function resolveTarget(workspace, relativePath) {
  const segments = normalizeRelativePath(relativePath).split("/");
  let parent = workspace.root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    await assertDirectoryNoSymlink(parent, workspace.root);
  }
  const target = path.join(parent, segments.at(-1));
  const normalized = path.resolve(target);
  if (normalized !== workspace.root && !normalized.startsWith(workspace.root + path.sep)) {
    fail("QX_WORKSPACE_PATH_UNSAFE", "Resolved project path escapes the selected root");
  }
  return { target: normalized, relativePath: segments.join("/") };
}

async function inspectRegularTarget(target) {
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail("QX_WORKSPACE_PATH_UNSAFE", "Target must be a regular file and must not be a symbolic link");
    }
    return info;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegularFileBounded(target, {
  maxBytes, initialInfo, sizeErrorCode, sizeErrorMessage
}) {
  let handle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(target, flags);
    const opened = await handle.stat();
    if (!opened.isFile()) {
      fail("QX_WORKSPACE_PATH_UNSAFE", "Target must be a regular file");
    }
    if (initialInfo && (opened.dev !== initialInfo.dev || opened.ino !== initialInfo.ino)) {
      fail("QX_WORKSPACE_CONCURRENT_CHANGE", "Target changed while it was being opened");
    }
    if (opened.size > maxBytes) {
      fail(sizeErrorCode, sizeErrorMessage);
    }

    const bounded = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(
        bounded, bytesRead, bounded.length - bytesRead, bytesRead
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) {
      fail(sizeErrorCode, sizeErrorMessage);
    }
    const finalInfo = await handle.stat();
    if (bytesRead !== finalInfo.size ||
        finalInfo.dev !== opened.dev || finalInfo.ino !== opened.ino) {
      fail("QX_WORKSPACE_CONCURRENT_CHANGE", "Target changed while it was being read");
    }
    return bounded.subarray(0, bytesRead);
  } catch (error) {
    if (error.code === "ELOOP") {
      fail("QX_WORKSPACE_PATH_UNSAFE", "Symbolic-link targets are not permitted");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureMetadata(workspace) {
  const root = path.join(workspace.root, METADATA_DIR);
  try {
    await fs.mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await assertDirectoryNoSymlink(root, workspace.root);

  const projectDir = path.join(root, projectKey(workspace.projectId));
  try {
    await fs.mkdir(projectDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await assertDirectoryNoSymlink(projectDir, workspace.root);

  const backupDir = path.join(projectDir, "backups");
  try {
    await fs.mkdir(backupDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await assertDirectoryNoSymlink(backupDir, workspace.root);

  const lockDir = path.join(root, "locks");
  try {
    await fs.mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await assertDirectoryNoSymlink(lockDir, workspace.root);
  return { projectDir, backupDir, lockDir, logPath: path.join(projectDir, "changes.jsonl") };
}

async function acquireWriteLock(workspace, relativePath) {
  const { lockDir } = await ensureMetadata(workspace);
  await assertDirectoryNoSymlink(lockDir, workspace.root);
  const lockKey = createHash("sha256").update(relativePath, "utf8").digest("hex");
  const lockPath = path.join(lockDir, lockKey + ".lock");
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail("QX_WORKSPACE_CONCURRENT_CHANGE",
        "Another workspace mutation holds this file lock; stale locks require manual inspection");
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({
      schemaVersion: "1.0.0",
      relativePath,
      createdAt: new Date().toISOString()
    }), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  return async () => {
    await handle.close();
    try {
      await fs.rm(lockPath);
    } catch (error) {
      fail("QX_WORKSPACE_LOCK_RELEASE_FAILED",
        "Workspace mutation completed or failed, but its coordination lock could not be removed");
    }
  };
}

async function appendChangeLog(workspace, event) {
  const { projectDir, logPath } = await ensureMetadata(workspace);
  await assertDirectoryNoSymlink(projectDir, workspace.root);
  const info = await inspectRegularTarget(logPath);
  if (info === null) {
    try {
      const handle = await fs.open(logPath, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Another writer may have created the log after our initial inspection.
      // Re-inspect it before appending so symlinks and non-files remain rejected.
      const racedInfo = await inspectRegularTarget(logPath);
      if (racedInfo === null) throw error;
    }
  }
  await fs.appendFile(logPath, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n", { encoding: "utf8" });
}

async function writeAtomic(target, data) {
  const temporary = path.join(path.dirname(target), ".qx-tmp-" + randomUUID());
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeAtomicCreate(target, data) {
  const temporary = path.join(path.dirname(target), ".qx-tmp-" + randomUUID());
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Hard-link publication is atomic and fails if the destination already exists.
      await fs.link(temporary, target);
    } catch (error) {
      if (error.code === "EEXIST") {
        fail("QX_WORKSPACE_FILE_EXISTS", "Create permission cannot overwrite an existing file");
      }
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function saveBackup(workspace, relativePath, bytes, reason) {
  const { backupDir } = await ensureMetadata(workspace);
  const backupId = randomUUID();
  const record = {
    schemaVersion: "1.0.0",
    backupId,
    projectId: workspace.projectId,
    relativePath,
    reason,
    createdAt: new Date().toISOString(),
    contentDigest: hash(bytes),
    contentBase64: bytes.toString("base64")
  };
  await writeAtomic(path.join(backupDir, backupId + ".json"), JSON.stringify(record));
  return backupId;
}

async function readBackup(workspace, backupId) {
  if (typeof backupId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(backupId)) {
    fail("QX_WORKSPACE_BACKUP_INVALID", "Backup identifier is invalid");
  }
  const { backupDir } = await ensureMetadata(workspace);
  const file = path.join(backupDir, backupId + ".json");
  const info = await inspectRegularTarget(file);
  if (!info) fail("QX_WORKSPACE_BACKUP_NOT_FOUND", "Backup does not exist");
  let record;
  try {
    const serialized = await readRegularFileBounded(file, {
      maxBytes: MAX_BACKUP_RECORD_BYTES,
      initialInfo: info,
      sizeErrorCode: "QX_WORKSPACE_BACKUP_INVALID",
      sizeErrorMessage: "Backup record exceeds the maximum permitted size"
    });
    record = JSON.parse(serialized.toString("utf8"));
  } catch (error) {
    if (error instanceof QXProjectError) throw error;
    fail("QX_WORKSPACE_BACKUP_INVALID", "Backup record cannot be read");
  }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      record.schemaVersion !== "1.0.0" || record.backupId !== backupId ||
      record.projectId !== workspace.projectId || typeof record.contentBase64 !== "string") {
    fail("QX_WORKSPACE_BACKUP_INVALID", "Backup record metadata is invalid");
  }
  const bytes = Buffer.from(record.contentBase64, "base64");
  if (bytes.length > MAX_FILE_BYTES || hash(bytes) !== record.contentDigest) {
    fail("QX_WORKSPACE_BACKUP_CORRUPT", "Backup content digest does not match");
  }
  return { record, bytes };
}

export async function openProjectWorkspace({ root, projectId } = {}) {
  if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root) ||
      typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) {
    fail("QX_WORKSPACE_CONFIG_INVALID", "An absolute existing root and a valid project ID are required");
  }
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(root);
    const info = await fs.lstat(canonicalRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail("QX_WORKSPACE_CONFIG_INVALID", "Selected root must resolve to an existing directory");
    }
  } catch (error) {
    if (error instanceof QXProjectError) throw error;
    fail("QX_WORKSPACE_CONFIG_INVALID", "Selected workspace root does not exist or cannot be accessed");
  }
  const workspace = Object.freeze({ root: canonicalRoot, projectId });
  OPEN_WORKSPACES.add(workspace);
  return workspace;
}

export async function readProjectFile(workspace, { project, expectedProjectDigest, relativePath } = {}) {
  assertWorkspace(workspace);
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (project.projectId !== workspace.projectId) {
    fail("QX_WORKSPACE_PROJECT_MISMATCH", "Approved project ID does not match the selected workspace");
  }
  const resolved = await resolveTarget(workspace, relativePath);
  const initial = await inspectRegularTarget(resolved.target);
  if (!initial) fail("QX_WORKSPACE_FILE_MISSING", "Requested project file does not exist");
  if (initial.size > MAX_FILE_BYTES) {
    fail("QX_WORKSPACE_CONTENT_INVALID", "File exceeds the 10 MiB workspace read limit");
  }
  const content = await readRegularFileBounded(resolved.target, {
    maxBytes: MAX_FILE_BYTES,
    initialInfo: initial,
    sizeErrorCode: "QX_WORKSPACE_CONTENT_INVALID",
    sizeErrorMessage: "File exceeds the 10 MiB workspace read limit"
  });
  return Object.freeze({
    relativePath: resolved.relativePath,
    content,
    contentDigest: hash(content),
    size: content.length
  });
}

async function writeProjectFileUnlocked(workspace, options = {}) {
  const {
    project, expectedProjectDigest, relativePath, content, permission,
    expectedContentDigest
  } = options;
  const hasExpectedContentDigest = Object.hasOwn(options, "expectedContentDigest");
  assertWorkspace(workspace);
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (project.projectId !== workspace.projectId) {
    fail("QX_WORKSPACE_PROJECT_MISMATCH", "Approved project ID does not match the selected workspace");
  }
  const resolved = await resolveTarget(workspace, relativePath);
  assertPermission(permission, { operation: "write", relativePath: resolved.relativePath, project });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(
    typeof content === "string" ? content : fail("QX_WORKSPACE_CONTENT_INVALID", "File content must be a string or Buffer"),
    "utf8"
  );
  if (bytes.length > MAX_FILE_BYTES) fail("QX_WORKSPACE_CONTENT_INVALID", "File exceeds the 10 MiB workspace limit");

  const current = await inspectRegularTarget(resolved.target);
  if (current && current.size > MAX_FILE_BYTES) {
    fail("QX_WORKSPACE_CONTENT_INVALID",
      "Existing file exceeds the 10 MiB workspace backup and restore limit");
  }
  if (permission.mode === "create" && current) {
    fail("QX_WORKSPACE_FILE_EXISTS", "Create permission cannot overwrite an existing file");
  }
  if (permission.mode === "replace" && !current) {
    fail("QX_WORKSPACE_FILE_MISSING", "Replace permission requires an existing file");
  }
  if (permission.mode !== "create" && permission.mode !== "replace") {
    fail("QX_WORKSPACE_PERMISSION_REQUIRED", "Write permission mode must be create or replace");
  }

  if (hasExpectedContentDigest) {
    if (permission.mode === "create" && expectedContentDigest !== null) {
      fail("QX_WORKSPACE_CONTENT_PRECONDITION_INVALID",
        "Create operations must explicitly expect an absent target (null digest)");
    }
    if (permission.mode === "replace") {
      if (typeof expectedContentDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(expectedContentDigest)) {
        fail("QX_WORKSPACE_CONTENT_PRECONDITION_INVALID",
          "Replace operations require the expected SHA-256 digest of the current file");
      }
      const currentBytes = await readRegularFileBounded(resolved.target, {
        maxBytes: MAX_FILE_BYTES,
        initialInfo: current,
        sizeErrorCode: "QX_WORKSPACE_CONTENT_INVALID",
        sizeErrorMessage: "Existing file exceeds the 10 MiB workspace backup and restore limit"
      });
      if (hash(currentBytes) !== expectedContentDigest) {
        fail("QX_WORKSPACE_CONTENT_STALE",
          "Current file content no longer matches the approved content digest");
      }
    }
  }

  await appendChangeLog(workspace, {
    event: "write_started", relativePath: resolved.relativePath,
    projectDigest: project.digest, operation: permission.mode
  });

  let backupId = null;
  if (current) {
    const existing = await readRegularFileBounded(resolved.target, {
      maxBytes: MAX_FILE_BYTES,
      initialInfo: current,
      sizeErrorCode: "QX_WORKSPACE_CONTENT_INVALID",
      sizeErrorMessage: "Existing file exceeds the 10 MiB workspace backup and restore limit"
    });
    backupId = await saveBackup(workspace, resolved.relativePath, existing, "before_replace");
  }
  const rechecked = await inspectRegularTarget(resolved.target);
  if ((current === null && rechecked !== null) ||
      (current !== null && (!rechecked || current.dev !== rechecked.dev || current.ino !== rechecked.ino))) {
    fail("QX_WORKSPACE_CONCURRENT_CHANGE", "Target changed while the write was being prepared");
  }

  if (hasExpectedContentDigest && permission.mode === "replace") {
    const latestBytes = await readRegularFileBounded(resolved.target, {
      maxBytes: MAX_FILE_BYTES,
      initialInfo: rechecked,
      sizeErrorCode: "QX_WORKSPACE_CONTENT_INVALID",
      sizeErrorMessage: "Existing file exceeds the 10 MiB workspace backup and restore limit"
    });
    if (hash(latestBytes) !== expectedContentDigest) {
      fail("QX_WORKSPACE_CONTENT_STALE",
        "Current file content changed after the approved content was checked");
    }
  }
  if (permission.mode === "create") {
    await writeAtomicCreate(resolved.target, bytes);
  } else {
    await writeAtomic(resolved.target, bytes);
  }
  const result = {
    relativePath: resolved.relativePath,
    contentDigest: hash(bytes),
    backupId
  };
  let changeLogWarning = null;
  try {
    await appendChangeLog(workspace, {
      event: "write_completed", ...result, projectDigest: project.digest
    });
  } catch (error) {
    changeLogWarning = Object.freeze({
      code: typeof error.code === "string" ? error.code : "QX_WORKSPACE_CHANGE_LOG_FAILED",
      message: "File content was written, but the completion event could not be recorded"
    });
  }
  return Object.freeze(changeLogWarning ? { ...result, changeLogWarning } : result);
}

export async function writeProjectFile(workspace, options = {}) {
  const { project, expectedProjectDigest, relativePath, permission } = options;
  assertWorkspace(workspace);
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (project.projectId !== workspace.projectId) {
    fail("QX_WORKSPACE_PROJECT_MISMATCH", "Approved project ID does not match the selected workspace");
  }
  const resolved = await resolveTarget(workspace, relativePath);
  assertPermission(permission, { operation: "write", relativePath: resolved.relativePath, project });
  const releaseLock = await acquireWriteLock(workspace, resolved.relativePath);
  try {
    return await writeProjectFileUnlocked(workspace, options);
  } finally {
    await releaseLock();
  }
}


export async function restoreProjectFile(workspace, options = {}) {
  const { project, expectedProjectDigest, relativePath, permission } = options;
  assertWorkspace(workspace);
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (project.projectId !== workspace.projectId) {
    fail("QX_WORKSPACE_PROJECT_MISMATCH", "Approved project ID does not match the selected workspace");
  }
  const resolved = await resolveTarget(workspace, relativePath);
  assertPermission(permission, { operation: "restore", relativePath: resolved.relativePath, project });
  const releaseLock = await acquireWriteLock(workspace, resolved.relativePath);
  try {
    return await restoreProjectFileUnlocked(workspace, options);
  } finally {
    await releaseLock();
  }
}
async function restoreProjectFileUnlocked(workspace, options = {}) {
  const { project, expectedProjectDigest, backupId, relativePath, permission } = options;
  assertWorkspace(workspace);
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  if (project.projectId !== workspace.projectId) {
    fail("QX_WORKSPACE_PROJECT_MISMATCH", "Approved project ID does not match the selected workspace");
  }
  const resolved = await resolveTarget(workspace, relativePath);
  assertPermission(permission, { operation: "restore", relativePath: resolved.relativePath, project });
  if (permission.backupId !== backupId) {
    fail("QX_WORKSPACE_PERMISSION_REQUIRED", "Restore permission must name the exact backup identifier");
  }
  const { record, bytes } = await readBackup(workspace, backupId);
  if (record.relativePath !== resolved.relativePath) {
    fail("QX_WORKSPACE_BACKUP_PATH_MISMATCH", "Backup belongs to a different project file path");
  }
  const current = await inspectRegularTarget(resolved.target);
  if (!current) fail("QX_WORKSPACE_FILE_MISSING", "Restore only replaces an existing regular file");
  if (current.size > MAX_FILE_BYTES) {
    fail("QX_WORKSPACE_CONTENT_INVALID",
      "Existing file exceeds the 10 MiB workspace backup and restore limit");
  }
  await appendChangeLog(workspace, {
    event: "restore_started", relativePath: resolved.relativePath,
    backupId, projectDigest: project.digest
  });
  const currentBytes = await readRegularFileBounded(resolved.target, {
    maxBytes: MAX_FILE_BYTES,
    initialInfo: current,
    sizeErrorCode: "QX_WORKSPACE_CONTENT_INVALID",
    sizeErrorMessage: "Existing file exceeds the 10 MiB workspace backup and restore limit"
  });
  const safetyBackupId = await saveBackup(workspace, resolved.relativePath, currentBytes, "before_restore");
  const rechecked = await inspectRegularTarget(resolved.target);
  if (!rechecked || current.dev !== rechecked.dev || current.ino !== rechecked.ino) {
    fail("QX_WORKSPACE_CONCURRENT_CHANGE", "Target changed while restore was being prepared");
  }
  await writeAtomic(resolved.target, bytes);
  const result = {
    relativePath: resolved.relativePath,
    contentDigest: record.contentDigest,
    restoredBackupId: backupId,
    safetyBackupId
  };
  let changeLogWarning = null;
  try {
    await appendChangeLog(workspace, {
      event: "restore_completed", ...result, projectDigest: project.digest
    });
  } catch (error) {
    changeLogWarning = Object.freeze({
      code: typeof error.code === "string" ? error.code : "QX_WORKSPACE_CHANGE_LOG_FAILED",
      message: "File content was restored, but the completion event could not be recorded"
    });
  }
  return Object.freeze(changeLogWarning ? { ...result, changeLogWarning } : result);
}

function isValidChangeLogEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const { timestamp, event, relativePath, projectDigest } = entry;
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp ||
      typeof relativePath !== "string" || typeof projectDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(projectDigest)) return false;
  try {
    normalizeRelativePath(relativePath);
  } catch {
    return false;
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const digest = /^sha256:[0-9a-f]{64}$/;
  const shapes = {
    write_started: entry.operation === "create" || entry.operation === "replace"
      ? ["timestamp", "event", "relativePath", "projectDigest", "operation"] : null,
    write_completed: typeof entry.contentDigest === "string" && digest.test(entry.contentDigest) &&
      (entry.backupId === null || (typeof entry.backupId === "string" && uuid.test(entry.backupId)))
      ? ["timestamp", "event", "relativePath", "projectDigest", "contentDigest", "backupId"] : null,
    restore_started: typeof entry.backupId === "string" && uuid.test(entry.backupId)
      ? ["timestamp", "event", "relativePath", "projectDigest", "backupId"] : null,
    restore_completed: typeof entry.contentDigest === "string" && digest.test(entry.contentDigest) &&
      typeof entry.restoredBackupId === "string" && uuid.test(entry.restoredBackupId) &&
      typeof entry.safetyBackupId === "string" && uuid.test(entry.safetyBackupId)
      ? ["timestamp", "event", "relativePath", "projectDigest", "contentDigest", "restoredBackupId", "safetyBackupId"] : null
  };
  const expectedKeys = shapes[event];
  return Array.isArray(expectedKeys) &&
    Object.keys(entry).length === expectedKeys.length &&
    expectedKeys.every(key => Object.hasOwn(entry, key));
}

export async function readProjectChangeLog(workspace) {
  assertWorkspace(workspace);
  const projectDir = path.join(workspace.root, METADATA_DIR, projectKey(workspace.projectId));
  const logPath = path.join(projectDir, "changes.jsonl");
  try {
    await assertDirectoryNoSymlink(path.join(workspace.root, METADATA_DIR), workspace.root);
    await assertDirectoryNoSymlink(projectDir, workspace.root);
  } catch (error) {
    if (error.code === "QX_WORKSPACE_PARENT_MISSING") return Object.freeze([]);
    throw error;
  }
  const info = await inspectRegularTarget(logPath);
  if (!info) return Object.freeze([]);
  if (info.size > MAX_FILE_BYTES) {
    fail("QX_WORKSPACE_CHANGE_LOG_INVALID", "Change log exceeds the 10 MiB read limit");
  }

  let handle;
  let content;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(logPath, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino ||
        opened.size > MAX_FILE_BYTES) {
      fail("QX_WORKSPACE_CONCURRENT_CHANGE", "Change log changed or became unsafe while it was being opened");
    }
    const bounded = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_FILE_BYTES) {
      fail("QX_WORKSPACE_CHANGE_LOG_INVALID", "Change log exceeds the 10 MiB read limit");
    }
    const finalInfo = await handle.stat();
    if (bytesRead !== finalInfo.size) {
      fail("QX_WORKSPACE_CONCURRENT_CHANGE", "Change log changed while it was being read");
    }
    content = bounded.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (error.code === "ELOOP") {
      fail("QX_WORKSPACE_PATH_UNSAFE", "Symbolic-link targets are not permitted");
    }
    throw error;
  } finally {
    await handle?.close();
  }

  let entries;
  try {
    entries = content.split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    fail("QX_WORKSPACE_CHANGE_LOG_INVALID", "Change log contains malformed JSON");
  }
  if (!entries.every(isValidChangeLogEntry)) {
    fail("QX_WORKSPACE_CHANGE_LOG_INVALID", "Change log contains an invalid event record");
  }
  return Object.freeze(entries.map(entry => Object.freeze(entry)));
}
