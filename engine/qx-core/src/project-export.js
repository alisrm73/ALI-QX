import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertProjectDeliveryPackage,
  assertProjectDeliveryReport
} from "./project-delivery.js";
import { QXProjectError } from "./project-model.js";

const MAX_EXPORT_BYTES = 70 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function fail(code, message) {
  throw new QXProjectError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
}

function hash(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function assertExportTarget(destinationPath) {
  if (typeof destinationPath !== "string" || destinationPath.length === 0 ||
      destinationPath.length > 4096 || destinationPath.includes("\0") ||
      !path.isAbsolute(destinationPath) || path.resolve(destinationPath) !== destinationPath ||
      path.basename(destinationPath) === "." || path.basename(destinationPath) === "..") {
    fail("QX_EXPORT_PATH_INVALID", "Export destination must be a normalized absolute file path");
  }
  return destinationPath;
}

async function assertSafeParent(destinationPath) {
  const parent = path.dirname(destinationPath);
  let info;
  try {
    info = await fs.lstat(parent);
  } catch (error) {
    if (error.code === "ENOENT") {
      fail("QX_EXPORT_PARENT_MISSING", "Export destination parent directory must already exist");
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("QX_EXPORT_PATH_UNSAFE", "Export destination parent must be a real directory, not a symbolic link");
  }
  const actual = await fs.realpath(parent);
  if (actual !== parent) {
    fail("QX_EXPORT_PATH_UNSAFE", "Export destination path must not traverse symbolic links");
  }
  return { parent, info };
}

async function readBackAndVerify(destinationPath, expectedBytes, expectedPackage, project, plan, testReport) {
  let handle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(destinationPath, flags);
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expectedBytes.length || info.size > MAX_EXPORT_BYTES) {
      fail("QX_EXPORT_VERIFY_FAILED", "Exported file size or file type does not match the package");
    }
    const actualBytes = await handle.readFile();
    if (!actualBytes.equals(expectedBytes) || hash(actualBytes) !== hash(expectedBytes)) {
      fail("QX_EXPORT_VERIFY_FAILED", "Exported file bytes do not match the generated package");
    }
    let parsed;
    try {
      parsed = JSON.parse(actualBytes.toString("utf8"));
    } catch {
      fail("QX_EXPORT_VERIFY_FAILED", "Exported package is not valid JSON");
    }
    assertProjectDeliveryPackage(project, plan, testReport, parsed);
    if (parsed.digest !== expectedPackage.digest) {
      fail("QX_EXPORT_VERIFY_FAILED", "Exported package digest does not match the approved package");
    }
    return info;
  } catch (error) {
    if (error.code === "ELOOP") {
      fail("QX_EXPORT_PATH_UNSAFE", "Symbolic-link export targets are not permitted");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Writes a verified delivery package to one explicitly authorized, new file.
 * Existing files are never replaced. The parent directory must already exist.
 */
export async function exportProjectDeliveryPackage({
  project,
  plan,
  testReport,
  deliveryReport,
  packageValue,
  destinationPath,
  permission
} = {}) {
  assertExportTarget(destinationPath);
  assertProjectDeliveryReport(project, plan, testReport, deliveryReport);
  if (deliveryReport.status !== "ready" ||
      deliveryReport.packageDigest !== packageValue?.digest) {
    fail("QX_EXPORT_BLOCKED", "Only a ready delivery report matching the package can be exported");
  }
  assertProjectDeliveryPackage(project, plan, testReport, packageValue);

  if (!isPlainObject(permission) ||
      Object.keys(permission).some(key => ![
        "operation", "destinationPath", "approvedProjectDigest", "packageDigest", "mode"
      ].includes(key)) ||
      permission.operation !== "export" ||
      permission.destinationPath !== destinationPath ||
      permission.approvedProjectDigest !== project.digest ||
      permission.packageDigest !== packageValue.digest ||
      permission.mode !== "create") {
    fail("QX_EXPORT_PERMISSION_REQUIRED",
      "Explicit export permission must match the exact destination, approved project, package digest, and create-only mode");
  }

  const serialized = canonicalJSON(packageValue);
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_EXPORT_BYTES) {
    fail("QX_EXPORT_SIZE_LIMIT", "Serialized delivery package exceeds the 70 MiB export limit");
  }

  const parentBefore = await assertSafeParent(destinationPath);
  try {
    await fs.lstat(destinationPath);
    fail("QX_EXPORT_TARGET_EXISTS", "Export refuses to replace an existing destination file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let handle;
  let createdInfo;
  try {
    // wx makes creation exclusive: an existing file or symlink is never overwritten.
    handle = await fs.open(destinationPath, "wx", 0o600);
    createdInfo = await handle.stat();
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    const parentAfter = await assertSafeParent(destinationPath);
    if (parentAfter.info.dev !== parentBefore.info.dev ||
        parentAfter.info.ino !== parentBefore.info.ino) {
      fail("QX_EXPORT_PATH_UNSAFE", "Export destination parent changed during the operation");
    }

    const verifiedInfo = await readBackAndVerify(
      destinationPath, bytes, packageValue, project, plan, testReport
    );
    if (verifiedInfo.dev !== createdInfo.dev || verifiedInfo.ino !== createdInfo.ino) {
      fail("QX_EXPORT_VERIFY_FAILED", "Export destination was replaced during verification");
    }

    return freezeDeep({
      schemaVersion: "1.0.0",
      status: "exported",
      projectId: project.projectId,
      projectRevision: project.revision,
      projectDigest: project.digest,
      packageDigest: packageValue.digest,
      destinationPath,
      size: bytes.length,
      fileDigest: hash(bytes)
    });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (createdInfo) {
      try {
        const current = await fs.lstat(destinationPath);
        if (current.isFile() && !current.isSymbolicLink() &&
            current.dev === createdInfo.dev && current.ino === createdInfo.ino) {
          await fs.unlink(destinationPath);
        }
      } catch {
        // Preserve the original export error; never remove a different file.
      }
    }
    throw error;
  }
}

export const PROJECT_EXPORT_LIMITS = Object.freeze({
  maxBytes: MAX_EXPORT_BYTES,
  overwrite: false,
  requiresExistingParent: true
});
