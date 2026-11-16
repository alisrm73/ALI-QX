# 7.8 — Integrated Approved Project Build Workflow

**Status:** Implemented and verified on head `6581963403750f916360990d676bc1a327e753e5`; all five compatibility workflows passed. The implementation was merged into `main` through PR #27 (`c683ff476a0b8290c0d8c144374f114c5edb495f`). Subsequent generator hardening and supported-divider changes were merged through PRs #54 (`6830bc9ff2e79d28ba1b3417de0c44d57ee161a1`) and #55 (`182be800eb629d64e1e6b0d1bd7deafb048c6025`). This is the verified initial static-Web workflow, not closure of all phase-7 requirements.
**Parent:** Phase 7 / PR #27 (closed and merged).

## 1. Goal

Connect the approved project manifest, deterministic QX source generator, existing Web Backend, protected workspace, test-suite contract, and delivery package into one explicit orchestration entry point. The workflow also supports optional, evidence-backed requirement coverage so readiness can be withheld until every declared requirement is mapped to acceptance criteria, passing tests, and packaged files.

## 2. Public entry point

`runProjectBuildWorkflow({...})` performs this sequence:

1. Validate the exact approved project digest and matching build-plan digest.
2. Require an already-open workspace.
3. Require exactly three explicit path-scoped write permissions for:
   - `dist/index.html`
   - `dist/styles.css`
   - `dist/app.js`
4. Require the build plan to declare the corresponding produced artifacts: `web-index`, `web-css`, and `web-app`.
5. Generate QX source from the approved manifest and validate the generated UI tree against the exact built-in component lock.
6. Build the static Web assets through the existing `buildWebProject`.
7. Write the three assets through `writeProjectFile`; no directories are created by the workflow.
8. Run the supplied test cases through the caller-provided `executeTest` callback, binding results to the actual written-file digests.
9. Package all three generated assets through `createProjectDeliveryPackage`.
10. When `requirementCoverage` is supplied, verify before the first workspace write that every requirement, data requirement, and integration requirement is mapped to acceptance criteria referencing declared tests and safe evidence paths; after tests and packaging, bind the coverage report to the actual test and delivery digests.

## 3. Result semantics

- `blocked`: required tests failed/incomplete, or delivery validation blocked the package.
- `requires_requirement_review`: tests and delivery package are ready, but the generator has requirements it cannot prove it implemented. The package is available for review, but the overall workflow is not represented as fully accepted.
- `ready`: delivery is ready and the generator reports no unmapped requirements. This is reserved for future coverage-aware generator contracts.

The project manifest stores natural-language requirement strings without built-in structured coverage links. The generator therefore always exposes requirements outside its static implementation in `unmappedRequirements`. If `requirementCoverage` is omitted, the workflow remains `requires_requirement_review` (unless blocked). If supplied, every project requirement, data requirement, and integration requirement must be mapped to acceptance criteria backed by passing declared tests and matching files included in the delivery package. Only a fully covered report with no open project questions can yield `ready`; partial, missing, or clarification-dependent coverage cannot.

## 4. Explicit permissions and side effects

- Every output path requires a matching `operation: "write"`, approved project digest, and `mode: "create"` or `mode: "replace"` permission.
- Permission validation for all three paths occurs before the first write.
- Workspace root and `dist` directory must already exist.
- Each write uses the existing workspace backup/change-log protections.
- Writes are sequential, not a multi-file transaction. If a later filesystem operation fails, earlier writes may remain; replacements have the backups provided by the workspace layer.
- No delete, move, directory creation, deployment, upload, or automatic permission grant occurs.

## 5. Test boundary

- The caller must provide a non-empty test case list and an `executeTest` callback.
- The workflow binds the report to the exact generated file digests.
- The callback receives the test case, approved project, build plan, and file digest map. It remains responsible for running meaningful assertions, including reading the workspace or launching an explicitly supplied test environment.
- The workflow does not claim that a browser or external application was tested unless the callback actually does so.

## 6. Acceptance criteria

- [x] Stale/unapproved projects and mismatched plans are rejected before writes.
- [x] Missing, duplicate, unexpected, or wrong-digest output permissions are rejected before writes.
- [x] The plan must produce all three generated web artifacts.
- [x] Approved manifest generates source and deterministic static web assets.
- [x] All three files are written only through the protected workspace API.
- [x] Tests run with actual written-file digests and required failures block delivery.
- [x] Delivery package contains all three generated assets and validates against the same project, plan, and test report.
- [x] Unmapped requirements force `requires_requirement_review` when no complete evidence-backed coverage mapping is supplied.
- [x] Optional requirement coverage validates complete mappings and acceptance criteria before writes, then binds coverage to passing tests and packaged file digests; partial or clarification-dependent coverage cannot yield `ready`.
- [x] Partial write failure semantics and non-transactional behavior are documented.
- [x] All phase 3–7 and browser compatibility workflows pass on the final head.

**CI evidence on verified head:** Phase 3 run `42589582059`, phase 4 run `42589582064`, phase 5 Chromium run `42589582087`, phase 6 run `42589582038`, and phase 7 project workflow run `42589582060` all completed successfully. The phase 7 suite reported 258 tests passed and 0 failed.

## 7. Limits

This orchestration slice is a static-web vertical path, not a general project executor. It does not generate interactive behavior, forms, navigation, persistence, integrations, authentication, Android or Windows targets, or arbitrary project types. It does not synthesize acceptance tests from natural-language requirements. Manual QX source remains supported through the lower-level parser/backend APIs.
