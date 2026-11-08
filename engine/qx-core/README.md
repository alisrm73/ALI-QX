# QX Core — Lexer and Parser (Phase 2)

A dependency-free JavaScript ES module implementing the first executable slice of the QX V1 language core.

## Requirements

- Node.js 22 or later.

## Run tests

```sh
npm test
```

## Use

```js
import { tokenize, parse } from "@ali-qx/core";

const tokens = tokenize('DATA.CREATE(name, "Ali")');
const ast = parse('DATA.CREATE(name, "Ali")');
```

## Implemented in this phase

- Tokenization of command names, domains, punctuation, numeric and string literals, lists, comments, operators, and line boundaries.
- Arabic and English keyword aliases from the QX V1 specification.
- NFC normalization of identifiers and rejection of mixed Arabic/Latin identifiers and default-ignorable characters.
- Parsing of domain commands, function calls, expressions, list literals, `IF/ELSE/END`, `WHILE/END`, `FUNCTION/RETURN/END`.
- Structured lexer/parser diagnostics with stable error codes and source locations.

## Explicit boundaries

This phase does not implement semantic analysis, symbol tables, type checking, QIR, VM, code generation, or execution. It does not claim that parsed programs are semantically valid.

The Unicode property escapes are supplied by the JavaScript runtime. The runtime version is exposed by `Lexer.unicodeVersion`; Node 22 currently reports Unicode 16.0, so exact Unicode 18.0 identifier conformance remains an open compatibility requirement and must be addressed with pinned Unicode 18.0 tables before claiming full V1 conformance.

Diagnostics currently use English messages with stable codes. Arabic localization is a later diagnostics-layer task.
