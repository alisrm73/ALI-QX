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

## Not implemented in this phase

QIR, VM, Web Backend, and execution are not implemented. The initial semantic-analysis slice now includes module symbols, primitive/list type inference, expression typing, condition checks, assignment checks, and validation of DATA.COUNT, PROCESS.CALCULATE, and PROCESS.COMPARE. Function parameter and return-type inference remains deferred until its cross-call inference contract is implemented. A successful parse means only that the source matches the implemented grammar; it does not prove semantic correctness.

## Diagnostics note

Diagnostics currently provide stable codes and English messages with source positions. Arabic message localization and project-language selection are later diagnostics-layer work.

## Qualified command expression compatibility slice

The parser recognizes a domain-qualified command call wherever an expression is accepted, including nested arguments, list elements, and binary expressions. For example:

```qx
DATA.CREATE(item, DATA.GET(items, 0))
```

This is a syntax/AST capability only. Semantic validation of command availability, signatures, return types, and permissions remains part of the semantic-analysis phase.


## Command registry — initial semantic-analysis slice

The declarative `src/command-registry.js` catalog contains the 17 named QX V1 commands and their single English/Arabic aliases. Both names resolve to one canonical command identity; English domain and command names are ASCII case-insensitive.

This slice registers names only. All command signatures remain explicitly pending (`signature: null`) and every command remains disabled (`enabled: false`). This is intentional: commands must not become semantically valid or executable until their argument count, argument types, return contract, permissions, and expected errors are specified. No unresolved signature is inferred from examples.

Use `resolveCommand(domain, command)` to look up a registered name. Unknown names return `null`. `isCommandEnabled(domain, command)` remains false for every entry in this initial catalog. Semantic analysis and symbol/type checking are not part of this slice.


## Semantic analysis — initial slice

`analyze(program)` accepts a parsed AST and returns `{ valid, diagnostics, symbols }`. Diagnostics include stable codes and source locations.

Implemented in this slice:
- Infers TXT, NUM, BOOL, and LIST declarations from DATA.CREATE initial values.
- Treats NULL as a special value, not an inferable variable type; DATA.CREATE with NULL is rejected.
- Checks duplicate declarations, undeclared identifiers, assignment type stability, arithmetic/logical/comparison expression types, and BOOL conditions.
- Validates the approved DATA.COUNT, PROCESS.CALCULATE, and PROCESS.COMPARE contracts.
- Does not invent signatures or enable commands whose contracts remain pending.

Function parameter and return-type inference, plus execution-time integer validation for remainder operations, remain outside this initial slice. All commands remain disabled.
