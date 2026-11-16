# 7.7 — Deterministic Project-to-QX Source Generator

**Status:** The bounded static generator and its supported-UI expansion, including `UI.CONTAINER@1.1.0` and `UI.DIVIDER@1.0.0`, are merged into `main`. PR #27 established the initial phase-7 implementation; PR #54 hardened manifest inputs; PR #55 added the divider and focused regression/browser-renderer assertions. The generator remains intentionally limited to static Web UI, and phase 7 is not closed.
**Current branch:** `main` (the implementation is merged; the former feature branch is historical, not the active target).
**Parent work:** PR #27 is closed and merged as `c683ff476a0b8290c0d8c144374f114c5edb495f`.

## 1. Decision

The primary ALI-QX project path generates QX source from the exact approved project manifest. Supplying QX source manually remains a supported advanced/developer input, but is not the default project-creation path.

## 2. First vertical slice (intentionally bounded)

The first generator supports the existing static Web UI target only, using the currently registered built-in components:

- `UI.CONTAINER@1.0.0` for page containers
- `UI.CONTAINER@1.1.0` for the project root that contains the divider
- `UI.HEADING@1.0.0`
- `UI.TEXT_BLOCK@1.0.0`
- `UI.DIVIDER@1.0.0` for a visual separator between the project summary and generated pages

It maps the approved manifest's existing fields into a deterministic static UI tree:

- Project `title` becomes the top-level heading.
- Project `description` becomes top-level descriptive text.
- Each manifest `pages[]` entry becomes a `UI.CONTAINER@1.0.0` with a heading and, when non-empty, descriptive text.
- A single `UI.DIVIDER@1.0.0` separates the project summary from the page list; its parent uses `UI.CONTAINER@1.1.0`.
- Stable node IDs are derived only from validated page IDs and fixed prefixes.
- All user-provided strings are JSON-serialized as data; they are never interpolated as executable QX syntax.

The generator returns a structured result containing the generated QX source, serialized UI tree, exact UI component lock, and a frozen `unmappedRequirements` list. Requirements, data requirements, and integration requirements are explicitly listed there because this static slice does not implement their behavior; they must not be mistaken for completed features. The generated source is a single `UI.TREE(<JSON text>)` statement compatible with the existing parser, semantic analyzer, QIR, VM, and static Web Backend.

## 3. Determinism and approval boundary

- Accept only a valid project manifest approved for its exact digest.
- Reject stale/mismatched approval before generation.
- Same approved manifest and same built-in registry must produce byte-for-byte identical source, tree JSON, and lock JSON.
- The generated result records the project ID, revision, and digest it was derived from.
- A revised manifest requires fresh review and approval; generated output from the prior digest must not be treated as current.
- The generator is pure: no filesystem writes, shell execution, network access, or implicit build execution.

## 4. Validation contract

The generator must validate its generated tree against the existing UI registry and lock contract before returning. The end-to-end caller must still run the established pipeline explicitly:

1. Generate source from approved manifest.
2. Parse and semantically analyze QX source.
3. Lower to QIR and validate QIR.
4. Execute QIR with the generated exact UI lock.
5. Build static web assets with `buildWebProject`.
6. Write only through the already-protected project workspace APIs and explicit per-path permissions.
7. Run the existing project test suite and delivery checks.

This slice does not silently claim that steps 5–7 have been integrated until a real end-to-end orchestration test proves them.

## 5. Explicit non-goals

This initial generator does not claim support for arbitrary project types or arbitrary web applications. It does not generate interactive controls, forms, navigation, routes, data behavior, authentication, integrations, network calls, custom CSS, or Android/Windows projects. It does not invent missing requirements or infer functionality from vague descriptions. Unsupported or unrepresented requirements must remain visible as limitations for clarification rather than being silently discarded or represented as implemented.

No QX V1 grammar, command registry, UI component contract, lifecycle policy, existing project manifest schema, or existing project files are changed by this specification.

## 6. Acceptance criteria

- [x] Reject unapproved, stale, malformed, or modified project manifests.
- [x] Produce a valid static UI tree for a minimal approved project with one or more pages.
- [x] Use all currently supported static generator UI components, including the versioned root container and divider, with an exact lock and browser-renderer assertion.
- [x] Preserve all source text as JSON data, including quotes, backslashes, newlines, Arabic, and Unicode.
- [x] Produce stable IDs and byte-identical outputs for repeated generation from the same manifest.
- [x] Validate the tree using the exact UI registry and lock.
- [x] Generated source passes parse, semantic analysis, QIR lowering/validation, and VM execution.
- [x] Generated source builds static `index.html`, `styles.css`, and `app.js` through the existing Web Backend.
- [x] Negative tests prove unsupported/invalid component trees, stale approval, and unexpected manifest fields are rejected.
- [x] Requirements not implemented by this static generator are returned explicitly in `unmappedRequirements` and never silently discarded.
- [x] No filesystem mutation occurs in the generator itself.
- [x] A subsequent orchestration slice proves the complete approved-manifest-to-delivery path before phase 7 can close.

**CI evidence on the verified generator head:** Phase 3 run `42588610378`, phase 4 run `42588610532`, phase 5 Chromium run `42588610230`, phase 6 run `42588610284`, and phase 7 project workflow run `42588610283` all completed successfully.

The follow-on integrated workflow is specified separately in `QX/spec/PHASE-7.8-INTEGRATED-PROJECT-WORKFLOW.md` and is not yet verified.

## 7. Compatibility

Manual QX source remains available through the existing parser/backend APIs. This generator adds a higher-level default path and does not remove or change those lower-level APIs.
