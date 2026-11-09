# UI Registry Multi-Version Lifecycle — Technical Design

**Status:** Approved design baseline; implementation not authorized by this document  
**Scope:** Registry architecture, lifecycle policy, diagnostics, explicit upgrade and rollback contracts  
**Baseline:** `main` at `3c79779688d5e3497a3d4165b2d1783854f5eb52`  
**Runtime status:** The current runtime supports one registered release per component type. This document specifies the next design; it does not claim that multi-release lifecycle behavior exists.

## 1. Goals

Introduce a host-controlled registry that can retain multiple immutable releases of the same component type and resolve the exact release pinned by a project's `qx.ui-lock.json`.

The design MUST preserve these invariants:

1. Exact pins only; no ranges, aliases, `latest`, or fallback.
2. Published component releases are immutable.
3. Build and runtime validation never rewrite a project lock.
4. Deprecated-but-supported releases remain runnable when exactly pinned.
5. Retired or unavailable releases fail clearly.
6. Upgrade and rollback are explicit project-change operations.
7. Project data cannot register components, supply renderers, or grant host capabilities.
8. Existing QIR 1.0–1.4 behavior and static rendering boundaries remain unchanged unless a separately reviewed change explicitly alters them.

## 2. Non-goals

This design does not authorize:
- new UI component types;
- interactive components, event handlers, navigation, network, filesystem, storage, or arbitrary DOM capabilities;
- remote registry fetching or package installation;
- automatic migration or background lock rewriting;
- changing the QX project manifest convention;
- changing the UI tree envelope or QIR version;
- removing existing component contracts.

Registry distribution, signing, trust roots, and administrative publication are separate host-security work and must be designed before any remote registry is introduced.

## 3. Current implementation boundary

At the approved baseline, `engine/qx-core/src/ui-component-runtime.js` defines one constant registry release and a `Map` keyed only by component type. Each type resolves to one definition. Lock validation requires that single registry release and exact registered contract version.

The public helpers include `getUIComponentRegistry()`, `createDefaultUILock()`, and `validateUIComponentTree(input, lockInput, limits)`. The current validator accepts a third argument for resource limits. The multi-release design MUST preserve the existing call shape or introduce a separately versioned API; it MUST NOT silently reinterpret the third argument.

The three built-in static contracts remain:
- `UI.CONTAINER@1.0.0`
- `UI.TEXT_BLOCK@1.0.0`
- `UI.HEADING@1.0.0`

The existing lock format remains `QX.UI.COMPONENT-LOCK` version `1.0` unless a separately reviewed migration proves a format change is necessary.

## 4. Registry data model

The host registry stores immutable release records. A logical key is the pair `(type, contractVersion)`; the registry release identifies the immutable publication snapshot containing that record.

Each release record contains:

| Field | Meaning |
|---|---|
| `type` | Canonical case-sensitive component type |
| `contractVersion` | Exact SemVer 2.0.0 contract version |
| `registryRelease` | Immutable registry snapshot identifier |
| `schemaDigest` | SHA-256 digest of the canonical contract schema |
| `schema` | Immutable property and child contract |
| `renderer` | Host-owned renderer identifier |
| `lifecycle` | `active`, `deprecated`, or `retired` |
| `supported` | Whether this host build permits execution of the release |
| `compatibility` | Documented compatibility metadata |
| `deprecation` | Optional structured notice and replacement guidance |

The registry release record MUST also have a unique immutable identifier and a deterministic snapshot digest. Re-publishing the same `(type, contractVersion)` with a different schema digest is forbidden. A changed contract requires a new contract version.

Lifecycle metadata may evolve only through a new registry snapshot. Historical snapshots remain immutable and addressable for audit and deterministic resolution, subject to the host's explicit support policy.

## 5. Registry interface

The proposed host-side API is:

- `resolve(type, contractVersion, registryRelease)`: return the exact record or a typed failure.
- `getRelease(registryRelease)`: retrieve one immutable registry snapshot.
- `getLifecycle(type, contractVersion, registryRelease)`: retrieve lifecycle metadata for the exact record.
- `listReleases(type, registryRelease?)`: enumerate known records deterministically; this is informational and MUST NOT participate in implicit resolution.
- `createSnapshot()`: return an immutable, deterministic view of a registry snapshot.

All returned records and nested schemas MUST be deeply immutable. Enumeration order MUST be deterministic (canonical type, then SemVer precedence, then stable tie-break where build metadata is present). Resolution MUST never select a record by enumeration order.

The exact exported JavaScript names and whether the API is a class or factory are implementation decisions to settle during the implementation plan. They must not weaken the semantics above.

## 6. Lifecycle semantics

### 6.1 Active

An `active` release is eligible for exact resolution when its registry snapshot is available, it is supported by the host, and all lock fields match.

### 6.2 Deprecated

A `deprecated` release remains eligible for exact resolution while `supported === true`. Resolution succeeds and returns a deprecation diagnostic. It does not change the lock or select a suggested replacement.

The diagnostic should identify the pinned component and include a concise migration notice when supplied by trusted registry metadata. It MUST NOT include host paths, secrets, or renderer internals.

### 6.3 Retired

A `retired` release is not eligible for execution. An exact pin to it fails with `QX_UI_RELEASE_RETIRED`. The runtime MUST NOT substitute an active release.

### 6.4 Unsupported or unavailable

A missing registry snapshot, missing component release, or release not supported by the running host fails with `QX_UI_RELEASE_UNAVAILABLE`, except that an explicitly retired record uses `QX_UI_RELEASE_RETIRED`.

Lifecycle status and host support are separate: a deprecated record can be supported; an active record can be unavailable in a particular host distribution.

### 6.5 Host-controlled revocation overlay

Immutable historical registry snapshots MUST NOT be edited to record a later retirement. However, historical immutability MUST NOT allow a project to keep executing a release that the host has subsequently revoked.

The host therefore maintains a separate, trusted revocation/support policy overlay, evaluated in addition to the exact historical snapshot:

- The policy key identifies the exact `(registryRelease, type, contractVersion, schemaDigest)` tuple. A broader revocation may be supported only when its scope is explicit and deterministic.
- The overlay is controlled by the host distribution or its authorized administrator. Project files, UI trees, component metadata supplied by a project, and migration proposals MUST NOT create, remove, or override revocations.
- An applicable revocation takes precedence over the lifecycle metadata in the historical snapshot. Resolution MUST reject the exact pin with `QX_UI_RELEASE_RETIRED` when the host policy marks it retired, even if that old snapshot still says `active` or `deprecated`.
- A host support denial without a retirement decision continues to fail with `QX_UI_RELEASE_UNAVAILABLE`.
- The overlay is separate from the immutable registry snapshot and does not alter its digest, historical contents, or audit identity. A later policy change is recorded as a new host-policy revision, not by rewriting an old snapshot.
- Policy evaluation MUST happen before rendering and MUST fail closed if the host cannot establish the applicable policy state. The implementation must define how policy revisions are loaded, authenticated, cached, and refreshed for the supported host deployment; remote distribution and signing details remain outside this design until separately reviewed.
- Rollback and exact historical resolution MUST consult the current host overlay. A historical lock is evidence of what was previously selected, not authority to bypass a current host revocation.

## 7. Exact lock resolution

For every component tree:

1. Parse and validate the existing lock envelope and exact entries.
2. Match each node to exactly one entry by canonical `(type, version)`.
3. Resolve the exact `registryRelease` and component record.
4. Compare type, contract version, registry release, and schema digest.
5. Enforce snapshot lifecycle metadata and the current host-controlled revocation/support overlay.
6. Validate node properties and child policy against that resolved record.
7. Render only after the entire tree passes validation.

No `latest`, semver range, fallback, automatic upgrade, or renderer substitution is allowed. A registry containing newer releases MUST NOT affect a project pinned to an older supported release.

Unused lock entries may remain warnings only, consistent with the current contract. They must not affect resolution.

## 8. Diagnostics and error contract

The following existing identifiers are retained with their current semantic meaning:

| Code | Meaning |
|---|---|
| `QX_UI_RELEASE_UNAVAILABLE` | Exact registry/component release cannot be resolved or is unsupported by this host |
| `QX_UI_DIGEST_MISMATCH` | Pinned schema digest differs from the immutable registry record |

The following new identifiers are approved for the lifecycle and migration work:

| Code | Meaning | Expected behavior |
|---|---|---|
| `QX_UI_RELEASE_RETIRED` | Exact pinned release is retired | Reject before rendering; never substitute |
| `QX_UI_UPGRADE_INCOMPATIBLE` | Proposed explicit upgrade cannot satisfy the target contract | Reject; source lock remains unchanged |
| `QX_UI_ROLLBACK_INVALID` | Rollback input is malformed, incomplete, or fails exact historical validation | Reject; current lock remains unchanged |

A deprecated-but-supported release is not an error. It produces a structured warning/diagnostic while allowing exact pinned execution.

Existing codes such as `QX_UI_LOCK_INVALID`, `QX_UI_LOCK_DUPLICATE`, `QX_UI_UNKNOWN_COMPONENT`, and `QX_UI_VERSION_MISMATCH` retain their existing meanings. Implementation MUST avoid changing an established code's meaning merely to fit the new registry structure.

The exact diagnostic object shape (for example, `warnings` alongside the validated tree versus a separate detailed validation result) is an implementation decision. It MUST preserve the current `validateUIComponentTree` return contract for existing callers, or be introduced through a separately named/versioned API. Do not silently change the return type.

## 9. Explicit upgrade contract

Upgrade is a separate host/tooling operation, never part of tree validation or runtime startup.

Inputs:
- the current validated lock;
- the exact target registry snapshot;
- an explicit mapping from each affected `(type, contractVersion)` to a target release;
- any required explicit tree migration supplied by a trusted migration tool or user-reviewed change.

Required sequence:

1. Validate the source lock against its historical registry snapshot.
2. Resolve every target release exactly.
3. Compare source and target schemas and compatibility metadata.
4. Validate the existing tree against the target contract; if necessary, require an explicit transformed tree and review its diff.
5. Run applicable component, accessibility, security, QIR, browser, and project tests.
6. Generate a new deterministic lock.
7. Return the proposed lock and diagnostics as a proposal; do not overwrite the source file automatically.

A compatible SemVer claim alone is insufficient to approve an upgrade. The actual target schema and tree must validate. If any target is incompatible or unavailable, fail with `QX_UI_UPGRADE_INCOMPATIBLE` or the more specific underlying resolution/validation error. The original lock and tree must remain byte-for-byte unchanged on failure.

## 10. Explicit rollback contract

Rollback restores a previously reviewed lock and, where required, its corresponding tree revision. It does not infer a prior version from the current registry.

Inputs must identify the exact prior lock content or trusted version-control revision and the registry snapshot needed to validate it.

The operation MUST:
1. parse the candidate prior lock;
2. validate its schema and exact pins;
3. resolve every pin against its exact historical registry snapshot;
4. verify the recorded schema digests;
5. return a rollback proposal without mutating project files.

If the candidate cannot be validated, fail with `QX_UI_ROLLBACK_INVALID` (or a more specific underlying diagnostic) and leave the current project unchanged. A rollback cannot make a retired or unsupported release executable; the current host-controlled revocation/support overlay still applies, even when the historical snapshot predates that policy decision.

## 11. Compatibility requirements

- Keep the current lock schema at version `1.0` for this design unless implementation evidence demonstrates that multiple registry releases cannot be represented safely by its existing per-entry `registryRelease` field.
- Preserve QIR 1.0–1.4 semantics and the current `UI.TREE` command contract.
- Preserve static-only component capabilities.
- Preserve current exported helper behavior for existing callers.
- Do not change browser rendering, VM async behavior, or integration broker behavior as part of registry lifecycle work.
- Existing projects pinned to the current built-in releases must continue to validate without lock rewrites.

If lock-format evolution becomes necessary, it must be a separate proposal with migration fixtures, compatibility tests, and explicit approval.

## 12. Security and resource boundaries

Registry records are trusted host data; project locks and UI trees are untrusted input. Parsing and validation remain bounded by existing resource limits and any separately reviewed additions.

The registry MUST NOT evaluate project-supplied code, load project renderers, or perform network/file access during resolution. Component renderer identifiers are resolved only through a host-owned allowlist.

Registry snapshots and lock data must be deterministic and immutable after publication. The host revocation/support overlay is a separate trusted policy input; project data cannot modify it. Policy state must be authenticated and its freshness/availability rules must be explicit for each host deployment. Error messages must not expose sensitive host details. No lifecycle metadata or policy entry may grant a capability.

## 13. Acceptance test plan

The implementation must add executable tests for:

1. Two or more versions of one component type coexist in one registry snapshot.
2. Exact resolution selects the pinned release even when newer releases exist.
3. Same type/version with conflicting schema digests cannot be published.
4. Registry snapshots and nested release records are immutable.
5. Active exact pin resolves successfully.
6. Deprecated supported exact pin resolves and emits a warning without changing the lock.
7. Retired exact pin fails with `QX_UI_RELEASE_RETIRED`.
8. Unsupported or missing exact pin fails with `QX_UI_RELEASE_UNAVAILABLE`.
9. Digest mismatch retains `QX_UI_DIGEST_MISMATCH`.
10. No implicit fallback occurs when the pinned release is absent.
11. Compatible explicit upgrade returns a new lock proposal.
12. Incompatible upgrade fails and leaves source lock/tree unchanged.
13. Rollback validates and returns the exact prior lock proposal.
14. Invalid rollback fails and leaves current project unchanged.
15. Runtime validation never mutates the lock or tree.
16. Existing three static component contracts continue to pass all current tests.
17. QIR 1.0–1.4, VM, browser, and integration tests remain green.
18. A historical snapshot that marks a release active is still rejected when the current host overlay revokes that exact release.\n19. Project-supplied lock/tree data cannot add, remove, or bypass a host revocation.\n20. Host policy unavailability or unverifiable policy state fails closed before rendering.

Tests must use isolated in-memory host registry fixtures and must not require network access.

## 14. Delivery phases and gates

**Phase A — Contract review:** review this design, settle diagnostic result shape and registry snapshot identity, and approve implementation scope.

**Phase B — Registry core:** add immutable multi-release registry records and exact resolution while retaining a compatibility adapter for the current built-in registry API.

**Phase C — Lifecycle diagnostics:** implement active/deprecated/retired semantics and host-support checks.

**Phase D — Upgrade proposal:** implement explicit validation and deterministic lock proposal generation; no automatic file writes.

**Phase E — Rollback proposal:** implement exact historical lock validation and rollback proposal generation.

**Phase F — Verification:** add the acceptance tests, run all relevant QX checks, and open a separate implementation PR.

Each phase must be reviewed against its acceptance criteria. No phase authorizes merging or deployment by itself.

## 15. Explicit implementation boundary

This file is a design artifact only. It does not implement the registry, alter runtime behavior, add tests, change lock files, publish components, or authorize a merge. Implementation requires a subsequent explicit approval after review of this specification.
