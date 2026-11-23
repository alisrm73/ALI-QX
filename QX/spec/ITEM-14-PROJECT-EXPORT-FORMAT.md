# Item 14 — Project delivery export format

## Scope

This specification describes the implemented local export path in `engine/qx-core/src/project-export.js`. It writes an already-created and verified project delivery package to one caller-selected local file. It does not rebuild the project, regenerate build/test reports, publish to the internet, upload to a service, or create an APK.

## File format

- The exported artifact is one UTF-8 JSON file containing the canonical JSON serialization of the delivery package.
- The package schema version is `1.0.0`.
- The package includes `projectId`, `projectRevision`, `projectDigest`, `buildPlanDigest`, `testReportDigest`, `files`, and a package `digest`.
- Each file entry includes its normalized relative `path`, `size` in bytes, `contentDigest` (SHA-256), and `contentBase64`.
- The package digest is computed from canonical JSON with object keys sorted. The export result also returns the absolute destination, byte size, file SHA-256, project digest, and package digest.
- This is not a ZIP archive. No ZIP compatibility or archive extraction behavior is claimed.

## Limits

- Maximum deliverable count: 500.
- Maximum individual delivered file size: 10 MiB.
- Maximum combined raw delivered file bytes: 50 MiB.
- Maximum serialized export file size: 70 MiB. This is an outer serialization guard; the 50 MiB raw package limit applies first.
- The export function requires the destination's parent directory to exist already.

## Destination and authorization rules

- The destination must be a normalized absolute file path.
- The parent directory must be a real directory and must not be a symbolic link.
- The caller must provide an explicit permission object matching the exact destination path, approved project digest, package digest, operation `export`, and mode `create`.
- The file is created exclusively with mode `0600`; an existing destination is never overwritten.
- The target is created directly with exclusive-create semantics; it is not an atomic rename publication, so a concurrent reader may observe a partially written file before the write and sync complete. After writing and syncing, the exporter reopens the file, checks file identity and size, compares the bytes and SHA-256 digest, parses JSON, and validates the delivery package and its embedded file digests.
- If verification fails, cleanup is limited to the exact file inode created by this operation and only while the original parent directory identity still matches.

## Known limitations

- Export is local filesystem output only. It does not provide cloud storage, external distribution, ZIP, or APK generation.
- The destination parent must exist; the exporter does not create directories.
- The delivery package is JSON with Base64 file content, so it is larger than the raw files.
- The current implementation validates the package against the approved project, build plan, test report, and delivery report before writing. The serialized package carries the project, build-plan, and test-report digests; the export operation's returned receipt carries the package and file digests.
- Workspace's exclusive-create fallback prevents overwriting but is not atomic publication. On filesystems where hard links are unavailable, a concurrent reader may observe a partially written file. This limitation belongs to Workspace file creation, not to the exporter's final create-and-verify protocol.
- Passing unit tests does not itself prove an export to a user's real destination. Closure requires an actual authorized export followed by read-back verification, with the command, output, and resulting file evidence recorded.

## Verification commands

Run from `engine/qx-core` with Node.js 22 or later:

```sh
node --test test/project-export.test.js test/project-delivery.test.js test/project-workspace.test.js
npm test
```

Record the exact commit SHA, Node.js version, commands, full test counts, failures/cancellations/skips, exit codes, and the actual export/read-back evidence. Do not attribute local test results to GitHub Actions or CI unless those systems were actually used.
