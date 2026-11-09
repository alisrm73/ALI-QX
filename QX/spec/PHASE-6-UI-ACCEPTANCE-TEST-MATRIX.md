# Phase 6 UI Tree and Registry — Acceptance Test Matrix

**Status:** Acceptance matrix for the static UI runtime merged through PR #12; broader acceptance remains gated by the cases below.  
**Applies to:** `PHASE-6-UI-COMPONENT-TREE-CONTRACT.md` and `PHASE-6-UI-REGISTRY-VERSIONING-CONTRACT.md`.  
**Runtime status:** A host registry, lock validator, bounded tree validator, VM `UI.TREE` path, and safe static-browser renderer are merged into `main` through PR #12.  
**Compatibility invariant:** QIR 1.0–1.3 remain unchanged; QIR 1.4 retains existing `UI.TEXT` / `UI.SHOW` behavior while adding `UI.TREE`.

## 1. Purpose and execution gate

This matrix turns the two UI contracts into observable acceptance cases. It remains the normative acceptance checklist; executable coverage is added in `engine/qx-core/test/ui-component-runtime.test.js`, `qir.test.js`, `vm.test.js`, and `web-backend-runtime.test.js`.

No additional component types may be activated until their contracts, serialization boundaries, and host registry interfaces are reviewed. The project lock-file convention is `qx.ui-lock.json` at the QX project root. The sample at `engine/qx-core/examples/ui-tree-static/` demonstrates this sidecar separately from `engine/qx-core/package.json`.

Some cases are now automated for the three registered static components. A case is **not passed** merely because its expected behavior is documented or because unrelated existing tests pass; the remaining acceptance rows continue to gate broader component registration.

## 2. Test conventions

- **Positive:** valid input is accepted and the specified observable result is produced.
- **Negative:** invalid input is rejected with the specified stable error category; no partial tree is rendered.
- **Determinism:** identical inputs and the same pinned registry state produce identical outcomes.
- **Isolation:** tests use an explicit in-memory host registry fixture; no external network, filesystem access, or project-supplied executable code is permitted.
- **No implicit defaults:** a fixture must state every version and registry identity needed for resolution.
- **Lock-file fixture:** use the exact `QX.UI.COMPONENT-LOCK` schema and `qx.ui-lock.json` project-root sidecar convention; each component node's `version` must equal the matched lock entry's `contractVersion`.
- **Resource tests:** use small configurable limits in test fixtures; production defaults must be separately justified and documented before activation.

Error identifiers below are semantic categories. The current implementation exposes stable UI diagnostic codes; this matrix does not yet map every row to one exact code and payload shape.

## 3. Tree-envelope and node-schema cases

| ID | Case | Fixture / action | Expected result |
|---|---|---|---|
| TREE-001 | Empty root | Valid `QX.UI.TREE` envelope with version `1.0` and empty children | Accept; render no component content |
| TREE-002 | Single component | One registered component with valid ID, exact type/version, props, and empty children | Accept |
| TREE-003 | Nested components | Valid parent and permitted nested child | Accept; preserve hierarchy |
| TREE-004 | Literal text | Text node containing ordinary Unicode text | Accept; preserve exact value |
| TREE-005 | Mixed ordered children | Interleave text and component nodes | Accept; preserve source order |
| TREE-006 | Missing discriminator | Omit `schema` | Reject invalid envelope |
| TREE-007 | Unknown discriminator | Use an unrecognized schema value | Reject invalid envelope |
| TREE-008 | Unsupported tree version | Use an unregistered tree-schema version | Reject unsupported version |
| TREE-009 | Unknown envelope field | Add an undeclared root field | Reject unknown field |
| TREE-010 | Unknown node kind | Use a node kind other than component or text | Reject invalid node |
| TREE-011 | Missing required node field | Omit a required component/text field | Reject malformed node |
| TREE-012 | Unknown node field | Add an undeclared node field | Reject unknown field |
| TREE-013 | Duplicate IDs | Reuse a component ID anywhere in the same tree | Reject duplicate identity |
| TREE-014 | Empty/oversized ID | Use empty ID or exceed the specified bound | Reject invalid ID |
| TREE-015 | Invalid component type | Use malformed or non-canonical type identity | Reject invalid/unknown type |
| TREE-016 | Invalid text value | Use a non-string text value | Reject invalid text |
| TREE-017 | Forbidden executable data | Include function-like, callback, host-object, or executable-expression data | Reject forbidden value |
| TREE-018 | Markup-looking text | Supply text such as `<img ...>` as a literal text-node value | Accept as data; never interpret as markup |

## 4. Component property and child-policy cases

| ID | Case | Fixture / action | Expected result |
|---|---|---|---|
| PROP-001 | Valid declared props | Supply all required props with valid values | Accept |
| PROP-002 | Missing required prop | Omit one required property | Reject missing property |
| PROP-003 | Unknown prop | Supply a property absent from the pinned schema | Reject unknown property |
| PROP-004 | Wrong primitive type | Supply string where number/boolean is required, or vice versa | Reject invalid property value |
| PROP-005 | Out-of-range value | Supply value outside declared bounds | Reject invalid property value |
| PROP-006 | Invalid enum | Supply undeclared enum member | Reject invalid property value |
| PROP-007 | Invalid nested data | Supply malformed object/array according to the prop schema | Reject invalid property value |
| CHILD-001 | Permitted child | Supply a child allowed by the component's child policy | Accept |
| CHILD-002 | Forbidden child | Supply a child type disallowed by the parent | Reject child-policy violation |
| CHILD-003 | Child count boundary | Test exactly at and one over any declared child-count limit | Accept at limit; reject above limit |
| CHILD-004 | Leaf component children | Add children to a component declared as a leaf | Reject child-policy violation |
| CHILD-005 | Missing/null children array | Omit `children` or supply `null` on a component node | Reject malformed node; `children: []` is required when empty |

## 5. Resource-boundary cases

For every configured limit, test the exact boundary and the first value beyond it. The implementation must validate bounded input before expensive rendering work and reject the whole tree rather than partially rendering it.

| ID | Limit | Required cases | Expected result |
|---|---|---|---|
| LIMIT-001 | Serialized tree bytes | At limit; one byte over | Accept at limit; reject over |
| LIMIT-002 | Total node count | At limit; one node over | Accept at limit; reject over |
| LIMIT-003 | Nesting depth | At limit; one level over | Accept at limit; reject over |
| LIMIT-004 | Text length per node | At limit; one character over | Accept at limit; reject over |
| LIMIT-005 | Aggregate text length | At limit; one character over | Accept at limit; reject over |
| LIMIT-006 | Property count | At limit; one property over | Accept at limit; reject over |
| LIMIT-007 | Aggregate property bytes | At limit; one byte over | Accept at limit; reject over |
| LIMIT-008 | Array/object nesting | At limit; one level over | Accept at limit; reject over |
| LIMIT-009 | Whole-tree rejection | Place an invalid/over-limit node after valid earlier siblings | Reject entire tree; render nothing |

## 6. Registry identity and version-lock cases

Use controlled registry snapshots. A release fixture includes canonical type, exact semantic version, schema digest, registry release ID, property schema, child policy, renderer identity, and compatibility metadata.

| ID | Case | Fixture / action | Expected result |
|---|---|---|---|
| REG-001 | Exact resolution | Lock entry matches one published immutable release exactly | Resolve that release |
| REG-002 | Newer release present | Registry contains pinned release plus a newer release | Continue resolving the pinned release |
| REG-003 | Missing lock entry | Tree references a component absent from the lock | Reject before rendering |
| REG-004 | Duplicate lock entry | Two entries claim the same `(type, contractVersion)` pair | Reject lock manifest |
| REG-005 | Unknown component | Tree and lock reference a type absent from host registry | Reject unknown type |
| REG-006 | Unavailable release | Lock references a release not present in registry | Reject unavailable release |
| REG-007 | Version mismatch | Locked version differs from resolved release | Reject mismatch |
| REG-008 | Digest mismatch | Version/type match but schema digest differs | Reject digest mismatch |
| REG-009 | Registry release mismatch | Registry release identifier does not match lock | Reject mismatch |
| REG-010 | Unknown lock field | Add undeclared field to lock manifest or entry | Reject unknown field |
| REG-011 | Unsupported lock format | Use unsupported lock-manifest format version | Reject unsupported format |
| REG-012 | Version range/wildcard | Use `latest`, wildcard, range, or omitted exact version | Reject non-exact pin |
| REG-013 | Conflicting duplicate publication | Publish same canonical type/version with different digest | Registry publication rejected |
| REG-014 | Immutable publication | Attempt to mutate an already published release | Reject mutation; require a new release |
| REG-015 | No silent fallback | Remove the pinned release while a newer release exists | Reject unavailable pin; do not substitute |
| REG-016 | Unused lock entry | Include a valid lock entry unused by the tree | Resolution unchanged; optional warning only |
| REG-017 | Node/lock version mismatch | Tree node `version` differs from the matched lock entry `contractVersion` | Reject before rendering; no fallback to another version |

## 7. Upgrade, deprecation, and rollback cases

| ID | Case | Fixture / action | Expected result |
|---|---|---|---|
| LIFE-001 | Explicit compatible upgrade | Validate tree against a proposed compatible release, then update pin explicitly | Upgrade succeeds only after validation and tests |
| LIFE-002 | Breaking upgrade | Proposed major release changes a required contract | Existing tree rejected until explicitly migrated |
| LIFE-003 | Deprecated pinned release | Resolve a deprecated but still supported exact release | Continue resolving with deprecation metadata |
| LIFE-004 | Retired pinned release | Resolve a release no longer supported by host | Clear unsupported-release error; no substitution |
| LIFE-005 | Rollback | Restore the prior reviewed lock state | Prior supported release resolves again |
| LIFE-006 | No background rewrite | Run build/startup with a newer registry release available | Project lock remains byte-for-byte unchanged |

## 8. Serialization, rendering, and security cases

| ID | Case | Fixture / action | Expected result |
|---|---|---|---|
| SER-001 | Round trip | Serialize then parse a valid tree | Preserve node order, IDs, text, props, and exact versions |
| SER-002 | Canonical output | Serialize semantically identical valid data | Produce deterministic canonical representation |
| SER-003 | Invalid serialized input | Parse malformed or invalidly encoded data | Reject safely with stable diagnostic |
| RENDER-001 | Literal text rendering | Render markup-looking text | Display as text; no element creation from the value |
| RENDER-002 | Safe property rendering | Supply hostile strings to text-valued properties | Treat as data according to the component contract |
| SEC-001 | No script execution | Include script-like strings or executable payloads | Reject executable data or render literal text only |
| SEC-002 | No project callbacks | Attempt to supply callback/event-handler values | Reject |
| SEC-003 | No arbitrary DOM authority | Attempt to reference arbitrary DOM nodes or APIs | Reject / no such capability exposed |
| SEC-004 | No network authority | Attempt to encode a network request or URL fetch action in a presentation-only tree | Reject / no network access |
| SEC-005 | No filesystem or storage authority | Attempt to access host files or storage from tree data | Reject / no such capability exposed |
| SEC-006 | No navigation authority | Attempt to trigger navigation through presentation-only data | Reject / no navigation capability exposed |
| SEC-007 | No project renderer | Attempt to supply renderer code or override renderer identity | Reject |
| SEC-008 | No capability escalation | Declare a capability without a separately granted host permission | Deny by default |
| SEC-009 | No partial render on failure | Cause validation/resolution failure after earlier valid nodes | No node is rendered |

## 9. Accessibility and event-contract gate

The tree envelope does not authorize interaction. Each interactive component requires a separately reviewed component contract and host event contract before registration.

For every proposed interactive component, add component-specific cases covering:

1. Accessible name, role, state, and semantic exposure.
2. Keyboard operation, focus order, and visible focus.
3. Input constraints, invalid values, and accessible error announcement.
4. Event identifier allowlist and payload-schema validation.
5. Event ordering, cancellation, duplicate delivery, and handler failure behavior.
6. Consent and capability checks for consequential actions.
7. Proof that serialized tree data cannot supply executable handlers.

**Gate:** if any applicable accessibility or event case is absent or failing, that interactive component MUST remain unavailable in the registry. Static presentation components must not inherit interaction capabilities.

## 10. Existing QX compatibility cases

These checks protect already implemented behavior while future UI tree work is developed.

| ID | Case | Required evidence | Expected result |
|---|---|---|---|
| COMPAT-001 | QIR 1.0 fixture suite | Existing QIR validation and execution tests | Unchanged behavior |
| COMPAT-002 | QIR 1.1 fixture suite | Existing list/data extension tests | Unchanged behavior |
| COMPAT-003 | QIR 1.2 fixture suite | Existing UI output extension tests | Unchanged behavior |
| COMPAT-004 | QIR 1.3 fixture suite | Existing integration extension tests | Unchanged behavior |
| COMPAT-005 | UI.TEXT output | Existing semantic, QIR, VM, and browser tests | Same output and diagnostics |
| COMPAT-006 | UI.SHOW output | Existing semantic, QIR, VM, and browser tests | Same output and diagnostics |
| COMPAT-007 | Unknown UI command | Existing command-registry and semantic checks | Remains rejected unless separately approved |
| COMPAT-008 | Static browser boundary | Existing browser backend security tests | No new host capability introduced |

A passing compatibility case must be demonstrated by the existing relevant executable tests on the final implementation commit, not inferred from documentation review.

## 11. End-to-end sample project gate

The static runtime now has a small sample project in `engine/qx-core/examples/ui-tree-static/`. It must continue to satisfy these checks:

- uses only host-registered static components;
- contains nested components and literal text in a meaningful order;
- pins every component to an exact version, digest, and registry release;
- validates and renders deterministically in the supported host;
- contains no project-supplied renderer, executable callback, or undeclared capability;
- demonstrates rejection of at least one invalid tree and one invalid lock manifest;
- preserves the existing QIR 1.0–1.3 and UI.TEXT/UI.SHOW test results.

The sample includes positive VM execution, static browser build, and negative invalid-tree/invalid-lock checks; `ui-tree-example.test.js` runs it under the core test suite. Independent review of the sample remains required. It is not a substitute for the unit and contract cases above.

## 12. Exit criteria for broader UI acceptance

The UI tree and registry/versioning work may be considered fully accepted for broader expansion only when:

1. Every applicable case has an executable test with a traceable requirement.
2. Positive, negative, boundary, determinism, and whole-tree rejection cases pass.
3. The host registry and exact lock-resolution behavior are implemented and tested.
4. The `qx.ui-lock.json` sidecar convention is implemented at the QX project root; it is not conflated with `engine/qx-core/package.json`.
5. Serialization and renderer security tests pass.
6. Accessibility and event contracts exist for every interactive component proposed for registration.
7. QIR 1.0–1.3 and UI.TEXT/UI.SHOW compatibility suites pass on the same final commit.
8. The end-to-end sample project passes and receives independent review.
9. Runtime limits and stable public diagnostics are documented.
10. A final security and compatibility review finds no unresolved release-blocking issue.

The three static presentation components and `UI.TREE` are already implemented in `main`. These conditions remain the gate for declaring the broader UI work complete or registering additional components; they do not authorize interactive behavior, arbitrary styling, or host capabilities.
