# QX Core — Lexer and Parser

This directory contains the first executable QX V1 language-core slice, implemented as dependency-free JavaScript ES modules.

## Requirements

- Node.js 22 or later.

## Run the tests

```sh
npm test
```

## API

```js
import { tokenize, parse } from "./src/index.js";

const tokens = tokenize('DATA.CREATE(name, "Ali")');
const ast = parse('DATA.CREATE(name, "Ali")');
```

## Implemented

- Tokenization of domains, command names, punctuation, numeric/string literals, lists, comments, operators, and line boundaries.
- English and Arabic aliases for V1 control keywords and Boolean/null literals.
- Pinned Unicode 18.0.0 XID_Start, XID_Continue, Letter, Latin/Arabic Script, and Default_Ignorable_Code_Point properties.
- Unicode 18.0.0 NFC normalization using ECMAScript canonical decomposition/composition with pinned Unicode 18.0.0 combining classes.
- Parsing of domain commands, qualified command calls as expressions, function calls, expressions, list literals, IF/ELSE/END, WHILE/END, and FUNCTION/RETURN/END.
- Qualified command calls use the AST node `CommandCallExpression`, containing `domain`, `command`, `args`, and source `location`.
- Top-level-only function declarations and RETURN statements restricted to function bodies.
- AST nodes with source locations and stable lexer/parser error codes.
- Automated tests for Arabic/English input, Unicode 18.0.0 identifiers, NFC, nested qualified calls, expressions, blocks, malformed syntax, comments, escapes, and CRLF locations.

## Unicode 18.0.0 data provenance and regeneration

The generated tables in `src/unicode-data.js` are derived from the official Unicode Character Database 18.0.0. The source archive SHA-256 and hashes of the source files are recorded in `src/unicode-data-metadata.json`.

To regenerate the tables from an extracted Unicode 18.0.0 UCD directory:

```sh
python3 scripts/generate-unicode-data.py /path/to/UCD --out-dir src
```

The generator rejects a source directory whose `ReadMe.txt` does not identify Unicode 18.0.0. It also checks that Unicode 17/18 additions introduce no canonical decomposition mappings, which is required by the normalization strategy. Do not hand-edit `src/unicode-data.js`.

To run the official Unicode NFC conformance file:

```sh
node scripts/verify-unicode-normalization.mjs /path/to/NormalizationTest.txt
```

The Unicode 18.0.0 `NormalizationTest.txt` was run during this update: **100,855 NFC checks passed, 0 failed**. The regular project test suite also covers representative canonical composition, Unicode 18 combining-mark reordering, and algorithmic Hangul composition.

## Semantic analysis — phase 2

`analyze(program)` returns `{ valid, diagnostics, symbols, functions }`. Diagnostics have stable codes and source locations.

Implemented:
- Module and function scopes, duplicate declarations, undeclared identifiers, local/global assignment rules, and type-stable assignments.
- TXT, NUM, BOOL, and LIST inference; arithmetic, comparison, Boolean, and condition type constraints.
- Function parameter and return-type inference from body constraints and all call sites, including uncalled functions, forward calls, nested calls, and recursion.
- Validation of every RETURN path, incompatible return types, fallthrough, unresolved parameter types, and procedure/value-use boundaries.
- Semantic contracts for `DATA.COUNT`, `PROCESS.CALCULATE`, and `PROCESS.COMPARE`. These are the only three commands marked enabled in the registry; all other unresolved command contracts remain disabled.

A procedure without RETURN may be called as a standalone statement, but cannot supply a value to an expression. A successful parse alone does not prove semantic correctness.

## Not implemented

QIR, QX Virtual Machine, Web Backend, and runtime execution are not implemented. Registry enablement for the three approved commands records semantic-contract support; it does not claim that a VM or runtime executor exists.

## Diagnostics note

Diagnostics currently provide stable codes and English messages with source positions. Arabic message localization and project-language selection are later diagnostics-layer work.

## Qualified command expression compatibility slice

The parser recognizes a domain-qualified command call wherever an expression is accepted, including nested arguments, list elements, and binary expressions. For example:

```qx
DATA.CREATE(item, DATA.GET(items, 0))
```

This is a syntax/AST capability only. Semantic validation of command availability, signatures, return types, and permissions remains part of the semantic-analysis phase.


## Command registry

The registry contains 17 QX V1 command names. The approved contracts for `DATA.COUNT`, `PROCESS.CALCULATE`, and `PROCESS.COMPARE` are recorded and these three entries alone have `enabled: true`. Other entries retain `signature: null`, `signatureStatus: "pending"`, and `enabled: false`; no signature is inferred from examples.

Use `resolveCommand(domain, command)` to resolve an English or Arabic alias to its canonical entry, and `isCommandEnabled(domain, command)` to inspect registry enablement. Enablement here denotes an approved semantic contract, not runtime availability; execution remains unimplemented until the VM phase.


## Verification

The current core suite contains **63 tests**, all passing on the verified Node.js runtime. The official Unicode 18.0.0 NFC conformance file has **100,855 passing checks and 0 failures**. Execution-time integer validation for remainder operations remains a runtime concern, not a semantic-analysis guarantee.
