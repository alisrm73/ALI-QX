# QIR Data List Operations Extension 1.1

**QX Intermediate Representation — compatible extension 1.1**

- Status: implementation candidate on `feature/phase6-data-ops`; must pass CI and review before merge.
- Base: QIR V1.0 remains unchanged and valid.
- Scope: expressive immutable list operations `DATA.ADD` and `DATA.REMOVE` only.
- Unicode: 18.0.0.

## 1. Compatibility and version selection

A module that does not use the new list operations remains QIR `1.0`. A module containing either `DATA.ADD` or `DATA.REMOVE` is emitted as QIR `1.1`.

A 1.0 module may contain only the existing `DATA.COUNT` command call. A 1.1 module may contain `DATA.COUNT`, `DATA.ADD`, and `DATA.REMOVE`. The 1.1 extension does not change any existing 1.0 opcode, operand, or runtime meaning.

## 2. Command-call contracts

The existing `COMMAND_CALL` opcode is reused; no new opcode is introduced.

| Command | Arguments | Result | Semantics |
|---|---|---|---|
| `DATA.COUNT` | one LIST | NUM | number of direct elements |
| `DATA.ADD` | LIST, any QX value (NUM/TXT/BOOL/LIST/NULL) | LIST | append one value to the end |
| `DATA.REMOVE` | LIST, NUM | LIST | remove one element at a zero-based index |

For ADD and REMOVE, the instruction must have a result value of type LIST. COUNT retains its existing V1 statement and expression forms.

## 3. Immutable value semantics

- Source lists are never mutated.
- ADD returns a new list containing deep-cloned source elements followed by a deep clone of the added value.
- REMOVE returns a new list containing deep clones of all source elements except the element at the selected index.
- Nested lists are copied recursively. The result must not share nested array objects with the source.
- Relative ordering of retained elements is preserved.
- No implicit conversion or coercion is performed.

## 4. Runtime validation and limits

- The first argument must be LIST.
- ADD requires exactly two arguments and fails with the list-limit error if the result would exceed `maxListLength`.
- REMOVE requires exactly two arguments. Its index must be a safe integer, non-negative, and strictly less than the source list length.
- An invalid REMOVE index fails with `QX_VM_LIST_INDEX`; it never silently returns the original list.
- A non-list first argument fails with `QX_VM_COMMAND_ARGUMENT`.
- Unsupported command calls remain rejected.
- Both VM and generated Web Runtime must implement identical behavior and error codes.
- These operations require no host I/O, filesystem, network, or external permissions.

## 5. Static semantic checks

- ADD and REMOVE are value-returning expressions, not command statements.
- Both require exactly two arguments and a LIST first argument.
- ADD accepts any QX value as its second argument, including NULL and LIST.
- REMOVE requires NUM as its second argument; integer/range validation remains a runtime check because NUM includes integer and fractional values.
- Both expressions have static result type LIST.

## 6. Acceptance tests

The implementation must verify:
1. Empty and non-empty list append.
2. All supported value types, including nested lists and NULL.
3. Original list remains unchanged after ADD and REMOVE.
4. Deep-copy isolation for nested lists.
5. Removal at first, middle, and last valid indices.
6. Rejection of negative, fractional, and out-of-range indices.
7. List-size limit enforcement.
8. QIR 1.0 compatibility and QIR 1.1 serialization round-trip.
9. Equivalent VM and Web Runtime results and error codes.
10. Existing QIR V1 tests remain green.

## 7. Explicit non-goals

- DATA.GET remains disabled and deferred; mixed-list element reads need a separately designed type contract.
- No insertion at an arbitrary index.
- No removal by value or removal of all duplicate values.
- No list mutation in place.
- No changes to QIR V1.0 normative semantics.
