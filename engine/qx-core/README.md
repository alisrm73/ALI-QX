# QX Core — Lexer and Parser

This directory contains the first executable QX V1 language-core slice, implemented as dependency-free JavaScript ES modules.

## Requirements

- Node.js 22 or later.

## Run the tests

~~~sh
npm test
~~~

## API

~~~js
import { tokenize, parse } from "./src/index.js";

const tokens = tokenize('DATA.CREATE(name, "Ali")');
const ast = parse('DATA.CREATE(name, "Ali")');
~~~

## Implemented

- Tokenization of domains, command names, punctuation, numeric/string literals, lists, comments, operators, and line boundaries.
- English and Arabic aliases for V1 control keywords and Boolean/null literals.
- NFC normalization, XID identifier properties, Arabic/Latin script separation, and rejection of default-ignorable characters.
- Parsing of domain commands, qualified command calls as expressions, function calls, expressions, list literals, IF/ELSE/END, WHILE/END, and FUNCTION/RETURN/END.
- Qualified command calls use the AST node `CommandCallExpression`, containing `domain`, `command`, `args`, and source `location`.
- Top-level-only function declarations and RETURN statements restricted to function bodies.
- AST nodes with source locations and stable lexer/parser error codes.
- Automated tests for Arabic/English input, nested qualified calls, expressions, blocks, malformed syntax, comments, escapes, and CRLF locations.

## Not implemented in this phase

Semantic analysis, symbol tables, duplicate-name checks, type checking, command signature validation, QIR, VM, Web Backend, and execution are not implemented. A successful parse means only that the source matches the implemented grammar; it does not prove semantic correctness.

## Unicode compatibility note

Identifier properties currently come from the JavaScript runtime. Node.js 22.16.0 reports Unicode 16.0. The QX V1 specification targets Unicode 18.0.0, so exact Unicode 18.0 identifier conformance remains open until the implementation uses pinned Unicode 18.0 tables. The lexer exposes the runtime version as Lexer.unicodeVersion.

## Diagnostics note

Diagnostics currently provide stable codes and English messages with source positions. Arabic message localization and project-language selection are later diagnostics-layer work.

## Qualified command expression compatibility slice

The parser now recognizes a domain-qualified command call wherever an expression is accepted, including nested arguments, list elements, and binary expressions. For example:

~~~qx
DATA.CREATE(item, DATA.GET(items, 0))
~~~

This is a syntax/AST capability only. Semantic validation of command availability, signatures, return types, and permissions remains part of the semantic-analysis phase.
