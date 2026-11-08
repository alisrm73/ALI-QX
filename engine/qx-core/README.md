# QX Core — Lexer, Parser, Semantic Analysis, and QIR

This directory contains the first executable QX V1 language-core slice, implemented as dependency-free JavaScript ES modules.

## Requirements

- Node.js 22 or later.

## Run the tests

```sh
npm test
```

## API

```js
import { tokenize, parse, analyze, lowerToQIR, validateQIR, serializeQIR, parseQIR } from "./src/index.js";

const source = 'DATA.CREATE(name, "Ali")';
const tokens = tokenize(source);
const ast = parse(source);
const semantic = analyze(ast);
if (semantic.valid) {
  const qir = lowerToQIR(ast, semantic);
  const diagnostics = validateQIR(qir);
  const serialized = serializeQIR(qir);
  const restored = parseQIR(serialized);
}
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
- AST-to-QIR lowering for constants, variables, lists, unary/binary expressions, function calls, approved command calls, IF/ELSE, WHILE, and RETURN.
- Explicit control-flow blocks and terminators; AND/OR lower through conditional branches to preserve short-circuit evaluation.
- QIR validation for module/function/block structure, opcode contracts, value types, variable storage, control-flow targets, dominance, source locations, control-flow-aware definite-assignment dataflow, global reads at initializer call sites, typed LOAD/STORE/RETURN/CALL contracts, and same-block value-use ordering.
- Canonical JSON serialization and validated QIR parsing; QIR remains pinned to Unicode 18.0.0.

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
- Rejects commands whose semantic contracts are still pending instead of silently accepting them as statements.
- Semantic contracts for `DATA.COUNT`, `PROCESS.CALCULATE`, and `PROCESS.COMPARE`. These are the only three commands marked enabled in the registry; all other unresolved command contracts remain disabled.

A procedure without RETURN may be called as a standalone statement, but cannot supply a value to an expression. A successful parse alone does not prove semantic correctness.

## QIR — phase 3

The QIR V1 normative specification is maintained at `QX/spec/QIR-V1.md`.

`lowerToQIR(program, semanticAnalysis)` converts a semantically valid Program AST to QIR V1. `validateQIR(module)` returns structured diagnostics; `serializeQIR(module)` emits canonical JSON; `parseQIR(json)` parses and validates serialized QIR. The module initializer is `fn_0`; source functions receive stable `fn_1` onward identifiers in source order. The QIR module carries the Unicode 18.0.0 version marker and source start locations.

The phase-3 QIR implementation is consumed by the phase-4 VM described below. Registry enablement for the three approved commands records semantic-contract support; runtime availability is separately enforced by the VM.

## QX Virtual Machine — phase 4 (complete)

The phase-4 QIR V1 interpreter is exported as `runQIR`:

```js
import { parse, analyze, lowerToQIR, runQIR } from "./src/index.js";

const ast = parse('DATA.CREATE(total, 4 + 5)');
const semantic = analyze(ast);
if (!semantic.valid) throw new Error(JSON.stringify(semantic.diagnostics));
const qir = lowerToQIR(ast, semantic);
const result = runQIR(qir);
```

The VM executes the module initializer, local/global storage, constants, unary/binary operations, lists, function calls, branches, jumps, returns, and the approved `DATA.COUNT` expression. Runtime limits cover instruction count, call depth, list length, and string length. The VM has no host I/O, filesystem, network, or dynamic code execution interface.

LIST equality remains deliberately rejected because QIR V1 does not define its equality semantics. Phase 4 was merged into `main`; its original validation suite contained 90 passing tests.

## Diagnostics note

Diagnostics currently provide stable codes and English messages with source positions. Arabic message localization and project-language selection are later diagnostics-layer work.

## Qualified command expression compatibility slice

The parser recognizes a domain-qualified command call wherever an expression is accepted, including nested arguments, list elements, and binary expressions. For example:

```qx
DATA.CREATE(item, DATA.GET(items, 0))
```

This parser capability is syntax/AST only. Phase 2 validates the three approved command contracts; remaining pending signatures and runtime permission enforcement are not implemented.


## Command registry

The registry contains 17 QX V1 command names. The approved contracts for `DATA.COUNT`, `PROCESS.CALCULATE`, and `PROCESS.COMPARE` are recorded and these three entries alone have `enabled: true`. Other entries retain `signature: null`, `signatureStatus: "pending"`, and `enabled: false`; no signature is inferred from examples.

Use `resolveCommand(domain, command)` to resolve an English or Arabic alias to its canonical entry, and `isCommandEnabled(domain, command)` to inspect registry enablement. Enablement here denotes an approved semantic contract, not runtime availability; execution remains unimplemented until the VM phase.


## Verification

The phase-4 validation baseline contained **90 passing tests**. The phase-5 pull request extends the complete core suite with Web Backend build, output-safety, browser-runtime, and Unicode normalization coverage. The official Unicode 18.0.0 NFC conformance file has **100,855 passing checks and 0 failures**. Execution-time integer validation for remainder operations remains a runtime concern, not a semantic-analysis guarantee.

## Web Backend — phase 5

The phase-5 Web Backend builds a static, dependency-free web project from valid QX V1 source:

```js
import { buildWebProject } from "./src/index.js";

const project = buildWebProject('DATA.CREATE(total, 4 + 5)', { title: "QX Demo" });
// project.files: index.html, styles.css, app.js
```

The build pipeline parses and semantically analyzes QX, lowers it to QIR V1, validates the QIR, and emits a self-contained browser runtime. The browser runtime supports the existing QIR V1 instruction set and approved `DATA.COUNT` command only. It embeds the Unicode 18.0.0 combining-class table so NFC ordering and equality follow the pinned project data. It renders resulting global values as text; QX UI commands remain disabled and are not implemented by this phase.

Generated projects have no network or host integration API, use DOM `textContent` for output, and include a restrictive Content Security Policy. The generated assets are deterministic for identical QIR and title inputs. This phase does not add commands, alter QX syntax, or implement integrations.
