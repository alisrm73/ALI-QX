# UI Component Registry and Project Version Pinning — Phase 6

**Status:** Proposed normative policy for review; documentation only.  
**Scope:** Host registry identity, immutable component contract releases, deterministic resolution, and project-level version locks.  
**Compatibility:** Does not change QIR 1.0–1.3, the existing command registry, or the current UI.TEXT/UI.SHOW runtime.

## 1. Goals and non-goals

This policy makes component resolution deterministic and prevents a project from silently changing when the host catalog evolves.

It defines:
- canonical component identity;
- immutable published contract versions;
- project-level exact version pins;
- deterministic validation and failure behavior;
- an explicit upgrade workflow.

It does not implement a component renderer, add UI commands, enable events, fetch packages, or grant host capabilities. The UI tree contract remains a separate structural contract.

## 2. Identity model

A component is identified by its canonical, case-sensitive type, for example `UI.TEXT_BLOCK`. Display names and localized aliases are not identifiers.

Each published component release has:
- canonical type;
- immutable semantic contract version;
- contract schema digest;
- registry release identifier;
- compatibility metadata;
- deprecation metadata, if applicable.

The contract version is independent of the UI tree-schema version and QIR version. A version string alone is not proof of compatibility; the referenced contract schema digest must match the published release.

A published release MUST NOT be edited in place. Any contract change creates a new release.

## 3. Host registry

The host registry is the sole authority for which component types and exact versions are available.

For each release, the registry records:
- property schema, defaults, and validation rules;
- child policy;
- accessibility obligations;
- renderer identity controlled by the host;
- resource limits;
- capability requirements, if any;
- stable validation and runtime error identifiers;
- compatibility and deprecation metadata.

Projects cannot register types, supply renderer code, override schemas, or choose arbitrary renderers through project data.

The registry MUST reject duplicate canonical identities and duplicate release versions with conflicting digests. Registry publication and rollback are host administration operations, not project operations.

## 4. Project lock model

A project that uses component trees MUST carry a separate UTF-8 JSON lock file named **`qx.ui-lock.json` at the root of that QX project**. This is a sidecar file; it is not the repository root, the engine package root, or an assumed field inside another manifest. The current repository exposes `engine/qx-core/package.json` as engine-package metadata but does not define a QX project manifest or an existing component-lock convention. Therefore this contract reserves the sidecar path for future QX projects without creating a project file or changing the engine package metadata in this documentation-only change.

The lock file has this exact top-level shape (entry values below are illustrative):

```json
{
  "schema": "QX.UI.COMPONENT-LOCK",
  "version": "1.0",
  "components": [
    {
      "type": "UI.TEXT_BLOCK",
      "contractVersion": "1.0.0",
      "schemaDigest": "sha256:…",
      "registryRelease": "ui-registry-2026.01"
    }
  ]
}
```

- `schema` is the exact discriminator `QX.UI.COMPONENT-LOCK`.
- `version` is the lock-file format version, independent of QIR and tree-schema versions.
- `components` is an array of exact immutable component-release pins.
- Each entry contains a canonical component `type`, exact semantic `contractVersion`, `schemaDigest`, and exact `registryRelease` identifier.
- `schemaDigest` uses the `sha256:` prefix followed by the lowercase hexadecimal SHA-256 digest of the canonical published component-contract schema.

A lock entry is uniquely identified by the pair `(type, contractVersion)`. Duplicate pairs are invalid; distinct versions of one type may coexist only when each is explicitly pinned. Each component node resolves by the exact pair formed from its `type` and `version`, and that node version MUST equal the lock entry's `contractVersion`. The digest and registry release are taken only from the lock entry and MUST match the immutable host registry record.

Rules:
1. Every component node resolves to exactly one lock entry matching both canonical `type` and exact `version`.
2. Every lock entry resolves to an exact immutable host registry release.
3. Missing entries, duplicate `(type, contractVersion)` pairs, digest mismatches, and unavailable releases are errors.
4. No latest-version lookup, version range, wildcard, fallback renderer, or silent substitution is permitted during build or execution.
5. A project with no component tree does not need `qx.ui-lock.json`.
6. Unused lock entries may be reported as warnings, but MUST NOT change resolution.
7. Entries are serialized in deterministic ascending order by canonical `type`, then `contractVersion`; the `components` array is never used as a fallback or priority order.

## 5. Deterministic resolution

Resolution follows this order:
1. Locate `qx.ui-lock.json` at the QX project root; if a component tree exists and the file is missing, reject the project.
2. Validate the lock-file schema discriminator, format version, required fields, and unknown-field policy.
3. Validate each entry's canonical type, exact semantic version, `sha256:` digest syntax, and registry release identifier; reject duplicate `(type, contractVersion)` pairs.
4. For each component node, match exactly one lock entry by `(type, version)`; reject missing or ambiguous matches.
5. Resolve the exact `registryRelease` and component release in the trusted host registry.
6. Compare canonical type, contract version, schema digest, and registry release identifier with the immutable registry record.
7. Validate each tree node against the resolved release's property and child schemas.
8. Apply the release's declared limits before rendering.

Any failure rejects the component tree before rendering. The runtime MUST NOT partially render a tree after a resolution or validation failure.

Resolution MUST NOT access arbitrary network locations or load project-supplied code. Registry distribution and trust establishment are host responsibilities and require a separate implementation/security review.

## 6. Version compatibility and lifecycle

Use semantic versioning for component contracts:
- **MAJOR:** incompatible property, child, accessibility, event, capability, or observable rendering behavior;
- **MINOR:** backward-compatible additions that do not make previously valid project trees invalid;
- **PATCH:** backward-compatible corrections that do not alter the declared contract surface.

A release MUST document its compatibility claim and tests. A compatible version number does not authorize automatic project upgrades.

Deprecation is metadata only. A deprecated release remains resolvable for projects pinned to it while the host continues to support that release. Removal requires an explicit host support policy and a migration path; projects must receive a clear unsupported-release error rather than being silently upgraded.

## 7. Explicit upgrade workflow

An upgrade is a deliberate project change:
1. Inspect the proposed release's contract diff and migration notes.
2. Validate every affected tree against the new release.
3. Run component contract, accessibility, security, and project integration tests.
4. Update the project's exact lock entry and digest as one reviewed change.
5. Preserve the prior lock state in version control for rollback.

No background process, registry refresh, build, or runtime startup may rewrite project pins.

## 8. Errors and diagnostics

The implementation must provide stable, non-sensitive diagnostics for at least:
- invalid lock format or unsupported lock version;
- missing or duplicate lock entry;
- unknown component type;
- exact release unavailable;
- contract digest mismatch;
- invalid or unsupported version;
- deprecated or retired release;
- tree node not matching its pinned contract.

Diagnostics may include a safe component ID and canonical type. They MUST NOT expose host paths, credentials, registry secrets, or internal renderer exceptions.

## 9. Security and capability boundary

A component release cannot grant capabilities merely by declaring them. Any capability requires a separately defined host permission contract, explicit grant, least privilege, and denial by default.

Presentation-only components MUST remain incapable of network, filesystem, storage, navigation, arbitrary DOM, or script execution. Interactive components require separately reviewed event and accessibility contracts before registration.

Project manifests and tree data are untrusted input. They MUST be parsed and validated as bounded data; they MUST NOT be evaluated as code.

## 10. Acceptance criteria before implementation

This policy is not implemented until tests demonstrate:
1. exact version resolution and stable schema-digest matching;
2. rejection of missing, duplicate, unknown, or mismatched lock entries;
3. rejection of unknown registry types and unavailable versions;
4. deterministic behavior when the host registry contains newer releases;
5. no automatic pin rewrite during build or runtime;
6. successful execution of a project pinned to an older supported release after a newer release is published;
7. explicit upgrade and rollback behavior;
8. no project-controlled renderer or capability escalation;
9. compatibility with the UI tree contract and existing QIR 1.0–1.3 behavior.

Until these criteria are implemented and independently verified, this document is a design proposal only. It enables no new runtime behavior.
