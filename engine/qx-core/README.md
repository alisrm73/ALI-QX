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
- Semantic contracts for `DATA.COUNT`, `DATA.ADD`, `DATA.REMOVE`, `UI.SHOW`, `UI.TEXT`, `PROCESS.ADD`, `PROCESS.CALCULATE`, `PROCESS.COMPARE`, and `INTEGRATION.REQUEST`. `DATA.ADD` and `DATA.REMOVE` are expression-only immutable list operations introduced by the QIR 1.1 extension. `PROCESS.ADD` increments an existing NUM target using QIR 1.0 load-add-store lowering; `UI.SHOW` and `UI.TEXT` are statement-only output effects in the QIR 1.2 extension; `DATA.GET` remains disabled.

A procedure without RETURN may be called as a standalone statement, but cannot supply a value to an expression. A successful parse alone does not prove semantic correctness.

## QIR — phase 3

The QIR V1 normative specification is maintained at `QX/spec/QIR-V1.md`.

`lowerToQIR(program, semanticAnalysis)` converts a semantically valid Program AST to QIR V1. `validateQIR(module)` returns structured diagnostics; `serializeQIR(module)` emits canonical JSON; `parseQIR(json)` parses and validates serialized QIR. The module initializer is `fn_0`; source functions receive stable `fn_1` onward identifiers in source order. The QIR module carries the Unicode 18.0.0 version marker and source start locations.

The phase-3 QIR 1.0 implementation is consumed by the phase-4 VM described below. QIR 1.0 remains unchanged; modules using `DATA.ADD` or `DATA.REMOVE` are emitted as QIR 1.1 under `QX/spec/QIR-DATA-LIST-EXTENSION-1.1.md`; modules using `UI.SHOW` or `UI.TEXT` use QIR 1.2 under `QX/spec/QIR-UI-OUTPUT-EXTENSION-1.2.md`.

## QX Virtual Machine — phase 4 (complete)

The QIR interpreter is exported as `runQIR`; QIR 1.2 UI effects are collected in the returned `outputs` array:

```js
import { parse, analyze, lowerToQIR, runQIR } from "./src/index.js";

const ast = parse('DATA.CREATE(total, 4 + 5)');
const semantic = analyze(ast);
if (!semantic.valid) throw new Error(JSON.stringify(semantic.diagnostics));
const qir = lowerToQIR(ast, semantic);
const result = runQIR(qir);
```

The VM executes the module initializer, local/global storage, constants, unary/binary operations, lists, function calls, branches, jumps, returns, `DATA.COUNT`, `DATA.ADD`, `DATA.REMOVE`, `UI.SHOW`, and `UI.TEXT`. ADD/REMOVE return deep-copied lists and never mutate their inputs; REMOVE validates a zero-based safe-integer index. Runtime limits cover instruction count, call depth, list length, and string length. The VM has no host I/O, filesystem, network, or dynamic code execution interface.

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

The registry contains 17 QX V1 command names. Nine commands currently have enabled semantic contracts: `DATA.COUNT`, `DATA.ADD`, `DATA.REMOVE`, `UI.SHOW`, `UI.TEXT`, `PROCESS.ADD`, `PROCESS.CALCULATE`, `PROCESS.COMPARE`, and `INTEGRATION.REQUEST`. `DATA.GET` remains pending and disabled.

Use `resolveCommand(domain, command)` to resolve an English or Arabic alias to its canonical entry, and `isCommandEnabled(domain, command)` to inspect registry enablement. Enablement here denotes an approved semantic contract, not runtime availability; execution remains unimplemented until the VM phase.


## Verification

The phase-4 validation baseline contained **90 passing tests**. The phase-6 DATA/PROCESS/UI implementation branch currently runs **114 core tests** on Node.js 22.16.0, including QIR 1.1/1.2, immutable list behavior, UI output effects, Web Backend build, output-safety, browser-runtime, and pinned Unicode normalization coverage. A separate Chromium smoke test also passes against the generated site. The official Unicode 18.0.0 NFC conformance file has **100,855 passing checks and 0 failures**. Execution-time integer validation for remainder operations remains a runtime concern, not a semantic-analysis guarantee.

## Web Backend — phase 5

The phase-5 Web Backend builds a static, dependency-free web project from valid QX V1 source:

```js
import { buildWebProject } from "./src/index.js";

const project = buildWebProject('DATA.CREATE(total, 4 + 5)', { title: "QX Demo" });
// project.files: index.html, styles.css, app.js
```

The build pipeline parses and semantically analyzes QX, lowers it to QIR 1.0, the compatible QIR 1.1 DATA list extension, QIR 1.2 UI output extension, or QIR 1.3 asynchronous integration extension, then validates the QIR. The static browser runtime supports local execution through QIR 1.2 and rejects modules containing `INTEGRATION.REQUEST`; QIR 1.3 integration requests require a trusted host runtime and broker. UI output is rendered as safe DOM text via `textContent`. It embeds the Unicode 18.0.0 combining-class table so NFC ordering and equality follow the pinned project data. It renders explicit UI output and resulting global values as text. UI output does not expose HTML, event handlers, network, or host APIs.

Generated projects have no network or host integration API, use DOM `textContent` for output, and include a restrictive Content Security Policy. The generated assets are deterministic for identical QIR and title inputs. The browser backend remains network-disabled; host integrations are isolated behind the separately documented broker API and are not available to generated browser projects.


## Host-owned integration broker — phase 6

The isolated broker is available from `src/integration-broker.js` for trusted host code:

```js
import { createIntegrationBroker } from "./src/integration-broker.js";

const broker = createIntegrationBroker({
  connectors: {
    demo: {
      id: "demo",
      version: "1.0.0",
      operations: {
        lookup: {
          permissions: ["demo:read"],
          invoke: async ({ payload, signal }) => JSON.stringify({ received: payload, aborted: signal.aborted })
        }
      }
    }
  },
  grants: [{ connector: "demo", operation: "lookup", permissions: ["demo:read"] }]
});

const responseJson = await broker.request("demo", "lookup", '{"query":"QX"}');
```

The broker denies by default, accepts only registered connector/operation identifiers, enforces JSON byte limits, timeout and concurrency limits, and passes an AbortSignal to trusted adapters. Credentials and destination policy must remain inside host-controlled adapter implementations. The QX language command `INTEGRATION.REQUEST(connector, operation, payloadJson)` is wired as a TXT-valued expression in QIR 1.3. Execute such modules with `runQIRAsync`; synchronous `runQIR` rejects them with `QX_VM_ASYNC_REQUIRED`. The broker remains host-only and browser builds remain network-disabled.


## QIR 1.3 asynchronous integration execution

A source program can use the approved expression form:

```qx
DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{\"id\":1}"))
```

Trusted host code supplies the broker to the async VM API:

```js
import { runQIRAsync, createIntegrationBroker, parse, analyze, lowerToQIR } from "./src/index.js";

const source = 'DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{\\\"id\\\":1}"))';
const ast = parse(source);
const semantic = analyze(ast);
if (!semantic.valid) throw new Error("QX semantic validation failed");
const module = lowerToQIR(ast, semantic);

const integrationBroker = createIntegrationBroker({
  connectors: {
    demo: {
      id: "demo",
      version: "1.0.0",
      operations: {
        lookup: {
          permissions: ["demo:read"],
          invoke: async ({ payload }) => JSON.stringify({ received: payload })
        }
      }
    }
  },
  grants: [{ connector: "demo", operation: "lookup", permissions: ["demo:read"] }]
});

const result = await runQIRAsync(module, { integrationBroker });
```

Only trusted host code registers adapters and grants. Adapter credentials and destination restrictions must remain outside QX source and generated browser assets. No production connector is included.
