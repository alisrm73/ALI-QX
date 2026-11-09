# QIR UI Component Tree Extension — Version 1.4

- **Status:** Implementation candidate in ALI-QX PR #12; pending final CI, review, and merge.
- **Base:** QIR 1.0, 1.1, 1.2, and 1.3 remain valid and retain their prior semantics.
- **Scope:** Add the statement-only `UI.TREE(TXT)` effect for validated, declarative static component trees.
- **Security boundary:** Component resolution is host-controlled and exact-version pinned. Tree data is never executable code.

## 1. Version selection

A module containing `UI.TREE` is emitted as QIR 1.4. QIR 1.4 retains the earlier extensions:

- `DATA.ADD` and `DATA.REMOVE` from QIR 1.1;
- `UI.SHOW` and `UI.TEXT` from QIR 1.2;
- `INTEGRATION.REQUEST` from QIR 1.3, still requiring the trusted asynchronous host broker.

A module without `UI.TREE` continues to use the lowest QIR version required by its commands. QIR 1.0–1.3 are not rewritten or reinterpreted.

## 2. Source command and semantic contract

The source form is:

```qx
UI.TREE(treeJson)
```

- Exactly one argument is required.
- The argument must have semantic type `TXT`.
- The TXT value contains UTF-8 JSON for the `QX.UI.TREE` envelope.
- The command is a statement-only effect; it has no QIR result value and cannot be used as an expression.
- The tree is data. HTML, JavaScript, callbacks, executable expressions, host objects, and capability-bearing values are not accepted.

## 3. QIR instruction

The command lowers to one `COMMAND_CALL` instruction:

```json
{
  "opcode": "COMMAND_CALL",
  "operands": {
    "command": "UI.TREE",
    "arguments": ["v_tree_json"]
  }
}
```

The instruction has no `result` and no `type`. The referenced value must be `TXT`. QIR validation rejects this command unless the module version is exactly `1.4`.

## 4. Registry and project lock

Before executing a component tree, the host must supply the project's `qx.ui-lock.json` sidecar as the VM `uiLock` option. A missing lock, unknown component, unavailable exact release, duplicate pin, digest mismatch, or missing node pin rejects the entire tree before output.

The host registry currently contains only these static presentation releases:

| Canonical type | Contract version | Renderer |
|---|---:|---|
| `UI.CONTAINER` | `1.0.0` | Safe `div` container |
| `UI.TEXT_BLOCK` | `1.0.0` | Safe paragraph |
| `UI.HEADING` | `1.0.0` | Heading level 1–6 |

The lock digest is SHA-256 over canonical UTF-8 JSON using RFC 8785 JSON Canonicalization Scheme. Registry releases are immutable. No latest-version lookup, fallback, or silent substitution is permitted.

The core API exports `createDefaultUILock()` for obtaining the exact lock entries for the built-in registry. It does not write or rewrite project files.

## 5. VM behavior

- `runQIR(module, { uiLock })` validates the JSON tree against the host registry and exact lock pins.
- The VM emits a `TREE` output only after the whole tree validates.
- Tree limits include serialized bytes, node count, nesting depth, per-node and aggregate text length, property count, and property bytes.
- Validation failures produce stable UI diagnostic codes; partial output is not emitted.
- No component receives filesystem, network, storage, navigation, event, or arbitrary DOM authority.

## 6. Static browser behavior

`buildWebProject(source, { uiLock })` requires and validates the exact project lock when the QIR contains `UI.TREE`. The generated browser runtime repeats bounded tree validation and renders only host-defined tags using `document.createElement` and literal text nodes.

The renderer does not use `innerHTML`, `eval`, `Function`, dynamic script loading, arbitrary CSS injection, or project-provided event handlers. Static browser builds remain network-disabled. A module containing `INTEGRATION.REQUEST` remains unsupported by the static browser backend.

## 7. Compatibility and acceptance

The implementation must preserve:

1. QIR 1.0–1.3 validation and execution.
2. QIR 1.4 support for prior DATA, UI output, and integration commands.
3. Literal text rendering, including markup-looking strings.
4. Exact registry release and lock digest matching.
5. Whole-tree rejection for malformed nodes, unsupported types/versions, invalid properties, duplicate IDs, child-policy violations, and resource-limit violations.
6. Browser and VM parity for the supported static component tree.

Interactive components, input, events, navigation, arbitrary styles, external packages, and host capabilities are explicitly out of scope. Each requires a separate contract and security review before registration.
