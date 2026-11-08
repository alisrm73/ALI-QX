import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, parse, QXLexError, QXParseError } from "../src/index.js";

test("reserved English keywords are case-insensitive", () => {
  const ast = parse('if (true)\n  UI.SHOW("ok")\nend');
  assert.equal(ast.body[0].type, "IfStatement");
  assert.equal(ast.body[0].test.value, true);
});

test("identifiers allow underscores and digits after the first letter", () => {
  const tokens = tokenize("user_name2");
  assert.equal(tokens[0].type, "IDENTIFIER");
  assert.equal(tokens[0].value, "user_name2");
});

test("multiline argument lists and empty lists are parsed", () => {
  const ast = parse([
    "DATA.CREATE(values, [",
    '  "one",',
    '  "two"',
    "])",
    "DATA.CREATE(empty, [])"
  ].join("\n"));
  assert.equal(ast.body[0].args[1].type, "ListLiteral");
  assert.equal(ast.body[0].args[1].elements.length, 2);
  assert.equal(ast.body[1].args[1].elements.length, 0);
});

test("CRLF and standalone carriage returns produce consistent line locations", () => {
  const crlf = tokenize("DATA.CREATE(a, 1)\r\nUI.SHOW(a)");
  assert.equal(crlf.find(token => token.value === "UI").line, 2);
  assert.equal(crlf.find(token => token.value === "UI").column, 1);

  const cr = tokenize("DATA.CREATE(a, 1)\rUI.SHOW(a)");
  assert.equal(cr.find(token => token.value === "UI").line, 2);
  assert.equal(cr.find(token => token.value === "UI").column, 1);
});

test("unsupported numeric notation and single-character equality are rejected", () => {
  assert.throws(() => parse("DATA.CREATE(value, 1e3)"), QXParseError);
  assert.throws(() => parse("DATA.CREATE(value, 1.)"), QXParseError);
  assert.throws(() => tokenize("a=b"), error => error instanceof QXLexError && error.code === "QX1001");
});

test("unterminated and newline-containing strings report lexical errors", () => {
  assert.throws(() => tokenize('"unfinished'), error => error instanceof QXLexError && error.code === "QX1004");
  assert.throws(() => tokenize('"line\nbreak"'), error => error instanceof QXLexError && error.code === "QX1004");
  assert.throws(() => tokenize('"trailing\\'), error => error instanceof QXLexError && error.code === "QX1005");
});

test("nested blocks match their own END and reject a second ELSE", () => {
  const ast = parse([
    "IF (TRUE)",
    "  WHILE (FALSE)",
    "    UI.SHOW(1)",
    "  END",
    "ELSE",
    "  UI.SHOW(2)",
    "END"
  ].join("\n"));
  assert.equal(ast.body[0].consequent[0].type, "WhileStatement");
  assert.equal(ast.body[0].alternate.length, 1);

  assert.throws(
    () => parse("IF (TRUE)\nELSE\nELSE\nEND"),
    QXParseError
  );
});
