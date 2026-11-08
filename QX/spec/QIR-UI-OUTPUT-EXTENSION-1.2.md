# QIR UI Output Extension 1.2

**QX Intermediate Representation — compatible extension 1.2**

- Status: implementation candidate on `feature/phase6-ui-basic`; must pass CI and review before merge.
- Base: QIR 1.0 and the DATA list extension 1.1 remain valid and unchanged.
- Scope: ordered, safe text output through `UI.TEXT` and `UI.SHOW`.
- Unicode: 18.0.0.

## 1. Compatibility and version selection

- Modules without DATA list operations or UI output remain QIR `1.0`.
- Modules using `DATA.ADD` or `DATA.REMOVE`, but no UI output, use QIR `1.1`.
- Any module using `UI.TEXT` or `UI.SHOW` uses QIR `1.2`.
- QIR 1.2 retains the QIR 1.0 instruction set and the QIR 1.1 DATA list command contracts. It does not alter their semantics.

## 2. UI command contracts

Both commands are statements with an observable UI output effect. Neither returns a QX value.

| Command | Arguments | Result | Behavior |
|---|---|---|---|
| `UI.TEXT` | exactly one TXT | none | append a text paragraph containing the exact string |
| `UI.SHOW` | exactly one QX value (NUM/TXT/BOOL/LIST/NULL) | none | append a readable representation of the value |

- `UI.TEXT` rejects every non-TXT argument during semantic analysis.
- `UI.SHOW` accepts all QX value types and does not perform implicit type conversion before execution.
- Both commands are invalid in expression position.
- Output records are appended in execution order, including output emitted from called functions.
- `UI.TEXT` preserves the supplied text. `UI.SHOW` displays TXT directly and serializes other values as readable JSON text.
- Output is append-only in this extension. It does not provide update, removal, layout, styling, event, or input controls.

## 3. QIR representation

The existing `COMMAND_CALL` instruction is reused; no new opcode or QIR value type is introduced.

- `UI.TEXT`: one TXT value reference, no `result`, no `type`.
- `UI.SHOW`: one QX value reference, no `result`, no `type`.
- These command calls are valid only in QIR 1.2.
- QIR validation rejects wrong arity, invalid argument types, result values on effect calls, and UI commands in older QIR versions.

## 4. Runtime behavior and security

- The VM collects immutable output records in `runQIR(...).outputs`; it does not access a host terminal, filesystem, or network.
- The browser runtime creates paragraph/preformatted text nodes and assigns content through `textContent`.
- The browser runtime MUST NOT interpret UI text or values as HTML, script, markup, or executable code.
- No `innerHTML`, dynamic script evaluation, event handlers, network access, filesystem access, or host I/O are introduced.
- Output order is preserved across function calls.
- `UI.TEXT` observes the existing maximum string length limit.
- Output records include the source location associated with the command.

## 5. Acceptance tests

The implementation must verify:

1. Valid UI.TEXT string output and rejection of non-TXT values.
2. UI.SHOW output for NUM, TXT, BOOL, LIST, and NULL.
3. Exact output ordering across statements, branches, loops, and function calls.
4. QIR 1.2 serialization and validation.
5. QIR 1.0 and 1.1 compatibility, including DATA.ADD and DATA.REMOVE inside a 1.2 module.
6. VM output records and browser DOM rendering.
7. Text containing HTML/script-looking characters is rendered literally through textContent.
8. Invalid arity, wrong types, and UI use in expression position are rejected.
9. No network, filesystem, or arbitrary host capabilities are exposed.

## 6. Explicit non-goals

- No PAGE, BUTTON, IMAGE, FIELD, FORM, BOX, CARD, ROW, or COL components are introduced.
- No event handlers, user input, navigation, stateful component tree, CSS props, or custom HTML are supported.
- No UI component version registry or project-level pinning is implemented by this extension.
- No changes to the normative QIR 1.0 specification or the QIR 1.1 DATA extension.
