# UI Component Tree Contract — Phase 6

**Status:** Proposed normative contract for review; documentation only.  
**Scope:** A declarative, data-only component tree for future UI extensions.  
**Compatibility:** Does not change QIR 1.0–1.3 or the existing `UI.TEXT` / `UI.SHOW` behavior.

## 1. Design decisions

1. The tree structure is independent of component types. New registered component types can be introduced without changing the tree envelope or node grammar.
2. The tree is declarative data, not executable code. It cannot contain HTML, JavaScript, callbacks, closures, host objects, or executable expressions.
3. A component is usable only when its type is present in the host's approved component registry and its exact contract version is supported.
4. This contract defines structure and validation only. It does not itself enable new components, input, events, navigation, styling, network access, or host capabilities.
5. Existing `UI.TEXT` and `UI.SHOW` remain append-only output commands. They are not silently reinterpreted as component-tree commands.

## 2. Tree envelope

A tree is represented by a single root envelope:

```json
{
  "schema": "QX.UI.TREE",
  "version": "1.0",
  "children": []
}
```

- `schema` is the exact discriminator `QX.UI.TREE`.
- `version` is the tree-schema version, independent of component versions and QIR versions.
- `children` is an ordered array of child nodes.
- The envelope is not a renderable component and has no component-specific properties.
- An empty root is valid and renders no component content.

The root envelope is deliberately separate from component types so the component catalog can evolve independently.

## 3. Node grammar

Only two node kinds are permitted.

### 3.1 Component node

```json
{
  "kind": "component",
  "id": "stable-node-id",
  "type": "namespace.component",
  "version": "1.0",
  "props": {},
  "children": []
}
```

- `kind` is exactly `component`.
- `id` is a non-empty, bounded string unique across the entire tree.
- `type` is a canonical, case-sensitive identifier resolved only through the approved registry.
- `version` pins the component contract version for this node. It MUST exactly match the `contractVersion` in the single lock entry selected by this node's canonical `type`; a mismatch is rejected before rendering.
- `props` is a JSON object validated against that component version's property schema. An empty object is used when no properties are required.
- `children` is a REQUIRED ordered array of text or component nodes. Use an empty array when the component has no children. A component contract may restrict whether children are allowed and which child categories are valid.

### 3.2 Text node

```json
{
  "kind": "text",
  "value": "literal text"
}
```

- `kind` is exactly `text`.
- `value` is a bounded Unicode string.
- A text node is a leaf and MUST NOT contain `id`, `type`, `version`, `props`, or `children`.
- Text is always rendered as literal text, never parsed as HTML, markup, a template, or code.

Text nodes are structural children, not component types. This keeps literal content independent of the registered component catalog.

## 4. Ordering, identity, and validation

1. Child order is significant and MUST be preserved by validation, serialization, and rendering.
2. Component IDs MUST be unique across the full tree, not merely among siblings.
3. IDs are stable identity within one submitted tree. They do not imply persistence across separate renders or executions.
4. A component's `key` is not part of the initial schema. If reconciliation later requires keys, that must be introduced by a separately versioned tree-schema extension with explicit duplicate and stability rules. Do not add an ignored or advisory key field now.
5. Unknown fields are rejected rather than silently ignored. This prevents misspelled or unsupported properties from appearing to succeed.
6. Unknown component types and unsupported component versions are rejected.
7. The validator rejects invalid node kinds, malformed identifiers, duplicate IDs, invalid property values, invalid child relationships, and unsupported tree versions before rendering.
8. The tree is parsed as bounded JSON data. Cyclic object graphs, non-JSON values, prototype-bearing objects, and special runtime objects are not valid inputs.

## 5. Property value model

The common property value domain is restricted to JSON values:

- string;
- finite number;
- boolean;
- null, only when explicitly allowed by the component property schema;
- arrays and plain objects composed recursively from the same allowed values.

Component schemas MUST additionally define, per property: type, required/optional status, nullability, default behavior, enum/range/length constraints, and whether nested objects or arrays are allowed.

The following are forbidden in all properties:

- functions, event callbacks, executable expressions, or code strings interpreted as code;
- raw HTML, DOM nodes, browser objects, or host objects;
- implicit resource references or URLs that grant capabilities;
- secret values, credentials, access tokens, or private keys.

A string that resembles HTML or script remains plain text and MUST never be evaluated or inserted as markup.

## 6. Children policy

- `children` is REQUIRED on every component node and MUST be an array; use `[]` when there are no children. Omission, `null`, or any non-array value is invalid.
- Text nodes are leaves and MUST NOT contain a `children` field.
- Only the two node kinds defined in section 3 may appear.
- The component registry schema declares whether a component accepts children, whether text children are permitted, and any allowed child component types.
- Components that do not declare child support MUST receive an empty `children` array.
- No implicit wrapping, coercion, or child reordering is performed.

## 7. Registry and component contract boundary

The host registry is authoritative and maps a canonical component type to supported immutable contract versions. Each registered version defines:

- property schema and defaults;
- child policy;
- semantic role and rendering category;
- accessibility requirements;
- resource and complexity limits;
- whether it is pure presentation or requires a separately granted capability;
- deterministic validation and error codes.

A tree cannot register a component, override its schema, choose an arbitrary renderer, or request a capability. Registry updates are host-controlled and do not mutate projects already pinned to a component version.

## 8. Security and resource limits

The implementation MUST use finite, configurable limits, with conservative defaults selected and documented before runtime activation:

- maximum serialized tree bytes;
- maximum node count;
- maximum nesting depth;
- maximum text length per node and total text length;
- maximum property count and aggregate property bytes;
- maximum array/object nesting depth.

Exceeding any limit rejects the whole tree deterministically; partial rendering is not permitted. Limits must be checked before expensive rendering work.

The renderer MUST use safe text and property APIs. It MUST NOT use `innerHTML`, `eval`, `Function`, dynamic script loading, arbitrary CSS injection, or untrusted event handler names. No tree node receives filesystem, network, storage, navigation, or arbitrary DOM authority merely by existing.

## 9. Accessibility and interaction are separate contracts

This tree contract does not define interactive behavior. Before any interactive component is registered, its own contract must define:

- accessible name, role, state, and required keyboard behavior;
- focus order and focus visibility;
- input validation and error announcement, where relevant;
- event names, payload schemas, ordering, cancellation, and error behavior;
- capability checks and user-consent boundaries for any consequential action.

Event handlers are not serialized into the tree. A future event system must use host-defined event identifiers and validated data payloads, not executable callbacks supplied by QX source or a project file.

## 10. Versioning and QIR compatibility

- Tree-schema version, component contract version, and QIR version are independent version axes.
- This document does not introduce a QIR opcode, command, or runtime feature.
- Existing QIR 1.0–1.3 behavior remains unchanged.
- A future QIR bridge for component trees requires a separate extension proposal specifying serialization, validation, VM behavior, browser behavior, compatibility, and tests.
- A breaking tree grammar change requires a new tree-schema major version. Compatible additions require a documented minor version and explicit unknown-field policy.
- Projects pin each component contract version in the project lock manifest described by `PHASE-6-UI-REGISTRY-VERSIONING-CONTRACT.md`; every component node's `version` MUST match its exact lock entry. No automatic upgrade or substitution is allowed.

## 11. Error contract

The future implementation must expose stable, non-sensitive diagnostics for at least:

- invalid tree envelope or unsupported tree version;
- malformed node or unknown node kind;
- missing or duplicate component ID;
- unknown component type or unsupported component version;
- unknown property, missing required property, or invalid property value;
- child-policy violation;
- invalid text value;
- each resource-limit violation.

Diagnostics may include a safe node ID and source location when available. They MUST NOT expose secrets, host paths, internal credentials, or raw adapter exceptions.

## 12. Acceptance criteria before implementation

This contract is not considered implemented until all of the following exist and pass:

1. Schema-level positive fixtures for an empty root, nested components, text nodes, and mixed ordered children.
2. Negative fixtures for unknown fields, unknown types, unsupported versions, duplicate IDs, invalid props, forbidden values, and invalid children.
3. Tests for every configured size/depth/count limit and deterministic whole-tree rejection.
4. Serialization round-trip tests preserving order, IDs, values, and pinned versions.
5. Renderer tests proving text is literal and markup-looking input is not interpreted.
6. Security tests proving no arbitrary script, event callback, network, filesystem, storage, navigation, or DOM authority is exposed.
7. Compatibility tests proving existing QIR 1.0–1.3 and `UI.TEXT` / `UI.SHOW` behavior is unchanged.
8. Accessibility contract tests for every interactive component before that component is enabled.
9. A real sample project using only registered components, followed by independent review.

Until these criteria are met, this document is a design contract only. No new UI component is approved for execution by this document alone.
