# ALI-QX 13 — Host approval and content-race contract

Status: implementation contract for stage 3; host UI integration remains a host responsibility.

## 1. Explicit human approval boundary

`qx-core` is a library and does not own a user interface. It cannot independently prove that a human clicked an approval control. The trusted host is therefore the human-approval boundary.

The supported flow is:

1. The host prepares the exact proposal and complete proposed file contents.
2. `requestProjectRepairApproval()` creates a short-lived challenge bound to the project, project digest, proposal ID, and canonical change-set digest.
3. The host callback receives the frozen review packet: proposal, paths, modes, complete UTF-8 content, expected current-content digests, content digests, challenge, and canonical challenge text.
4. The host MUST display the complete change set and obtain an explicit user decision. It MUST NOT auto-approve, approve on timeout, or sign in a background flow without an explicit user action.
5. Only after approval, the host signs the exact canonical challenge with its Ed25519 private key and returns `{ approved: true, signature }`.
6. `authorizeProjectRepair()` verifies the signature against the configured trusted public key and issues a single-use, expiring capability.

Denial, callback failure, malformed decisions, missing signatures, invalid signatures, expired challenges, or challenge reuse fail closed. The private key remains exclusively in the host and is never passed to `qx-core`.

**Trust limitation:** the callback and host application are trusted computing-base components. The library validates the callback contract and cryptographic binding; it cannot prove that the host UI actually rendered the review packet or that the user physically interacted with it. A real product host must implement and separately test that UI interaction.

## 2. Current-content digest and concurrency guarantee

For replacement, the approved change set contains the SHA-256 digest of the expected current file. Workspace re-reads and verifies that digest under its per-file coordination lock immediately before the atomic replacement. It also checks the target identity while preparing the backup and refuses stale content.

This provides:
- rejection when the file content differs from the approved digest at the checks;
- serialization among writers that use the same Workspace lock protocol;
- atomic replacement of one file where the platform's rename behavior supports the existing implementation.

This does **not** provide an OS-level compare-and-swap operation. A process that bypasses Workspace and can write the filesystem directly may change the file after the final digest check and before the replacement. The per-file lock does not constrain that external process. No guarantee against this race is claimed.

Multi-file repair is also not transactional: if a later file fails, the report is `partial` and lists applied and remaining files. No all-or-nothing guarantee is claimed.

## 3. Validation evidence required

Run on the exact branch head in free Google Colab with Node.js 22:

- focused repair execution tests, including explicit host callback approval and denial;
- Workspace failure and concurrency tests, including digest mismatch and held-lock behavior;
- public export import check;
- complete `qx-core` test suite.

Record the exact tested commit SHA and all test counts, skipped/cancelled counts, and exit codes. Do not use GitHub Actions.
