import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertProjectApproved, QXProjectError } from "./project-model.js";

const METADATA_DIR = ".qx-workspace";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function hash(data) {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
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
  const info = await fs.lstat(targetPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("QX_WORKSPACE_PATH_UNSAFE", "A workspace directory is missing, not a directory, or is a symbolic link");
  }
  const actual = await fs.realpath(targetPath);
  if (actual !== expectedRoot && !actual.startsWith(expectedRoot + path.sep)) {
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
  return { projectDir, backupDir, logPath: path.join(projectDir, "changes.jsonl") };
}

async function appendChangeLog(workspace, event) {
  const { projectDir, logPath } = await ensureMetadata(workspace);
  await assertDirectoryNoSymlink(projectDir, workspace.root);
  const info = await inspectRegularTarget(logPath);
  if (info === null) {
    const handle = await fs.open(logPath, "wx", 0o600);
    await handle.close();
  }
  await fs.appendFile(logPath, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n", { encoding: "utf8" });
}

async function writeAtomic(target, data) {
  const temporary = path.join(path.dirname(target), ".qx-tmp-" + randomUUID());
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
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
    record = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    fail("QX_WORKSPACE_BACKUP_INVALID", "Backup record cannot be read");
  }
  if (record.schemaVersion !== "1.0.0" || record.backupId !== backupId ||
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
  return Object.freeze({ root: canonicalRoot, projectId });
}

export async function writeProjectFile(workspace, {
  project, expectedProjectDigest, relativePath, content, permission
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
  const resolved = await resolveTarget(workspace, relativePath);
  assertPermission(permission, { operation: "write", relativePath: resolved.relativePath, project });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(
    typeof content === "string" ? content : fail("QX_WORKSPACE_CONTENT_INVALID", "File content must be a string or Buffer"),
    "utf8"
  );
  if (bytes.length > MAX_FILE_BYTES) fail("QX_WORKSPACE_CONTENT_INVALID", "File exceeds the 10 MiB workspace limit");

  const current = await inspectRegularTarget(resolved.target);
  if (permission.mode === "create" && current) {
    fail("QX_WORKSPACE_FILE_EXISTS", "Create permission cannot overwrite an existing file");
  }
  if (permission.mode === "replace" && !current) {
    fail("QX_WORKSPACE_FILE_MISSING", "Replace permission requires an existing file");
  }
  if (permission.mode !== "create" && permission.mode !== "replace") {
    fail("QX_WORKSPACE_PERMISSION_REQUIRED", "Write permission mode must be create or replace");
  }

  await appendChangeLog(workspace, {
    event: "write_started", relativePath: resolved.relativePath,
    projectDigest: project.digest, operation: permission.mode
  });

  let backupId = null;
  if (current) {
    const existing = await fs.readFile(resolved.target);
    backupId = await saveBackup(workspace, resolved.relativePath, existing, "before_replace");
  }
  const rechecked = await inspectRegularTarget(resolved.target);
  if ((current === null && rechecked !== null) ||
      (current !== null && (!rechecked || current.dev !== rechecked.dev || current.ino !== rechecked.ino))) {
    fail("QX_WORKSPACE_CONCURRENT_CHANGE", "Target changed while the write was being prepared");
  }
  await writeAtomic(resolved.target, bytes);
  const result = {
    relativePath: resolved.relativePath,
    contentDigest: hash(bytes),
    backupId
  };
  await appendChangeLog(workspace, {
    event: "write_completed", ...result, projectDigest: project.digest
  });
  return Object.freeze(result);
}

export async function restoreProjectFile(workspace, {
  project, expectedProjectDigest, backupId, relativePath, permission
} = {}) {
  assertProjectApproved(project, { expectedDigest: expectedProjectDigest });
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
  await appendChangeLog(workspace, {
    event: "restore_started", relativePath: resolved.relativePath,
    backupId, projectDigest: project.digest
  });
  const currentBytes = await fs.readFile(resolved.target);
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
  await appendChangeLog(workspace, {
    event: "restore_completed", ...result, projectDigest: project.digest
  });
  return Object.freeze(result);
}

export async function readProjectChangeLog(workspace) {
  const { projectDir, logPath } = await ensureMetadata(workspace);
  await assertDirectoryNoSymlink(projectDir, workspace.root);
  const info = await inspectRegularTarget(logPath);
  if (!info) return Object.freeze([]);
  const content = await fs.readFile(logPath, "utf8");
  const entries = content.split("\n").filter(Boolean).map(line => JSON.parse(line));
  return Object.freeze(entries.map(entry => Object.freeze(entry)));
}
