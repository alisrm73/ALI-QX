import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, parse, QXLexError, QXParseError } from "../src/index.js";

const types = source => tokenize(source).map(token => token.type);

test("lexes commands, literals, lists, comments, and line boundaries", () => {
  assert.deepEqual(types('DATA.CREATE(colors, ["Red", "Blue"]) // note\n'), [
    "IDENTIFIER","DOT","IDENTIFIER","LPAREN","IDENTIFIER","COMMA",
    "LBRACKET","STRING","COMMA","STRING","RBRACKET","RPAREN","NEWLINE","EOF"
  ]);
});

test("recognizes Arabic keyword aliases", () => {
  assert.deepEqual(types('إذا (العمر >= 18)\n  الواجهات.عرض("مسموح")\nنهاية'), [
    "IF","LPAREN","IDENTIFIER","GT_EQ","NUMBER","RPAREN","NEWLINE",
    "IDENTIFIER","DOT","IDENTIFIER","LPAREN","STRING","RPAREN","NEWLINE","END","EOF"
  ]);
});

test("normalizes identifiers to NFC", () => {
  assert.equal(tokenize("cafe\u0301")[0].value, "café");
});

test("rejects mixed Arabic and Latin identifier scripts", () => {
  assert.throws(() => tokenize("abمرحبا"), error => error instanceof QXLexError && error.code === "QX1009");
});

test("rejects unsupported escapes, invisible identifiers, and semicolon terminators", () => {
  assert.throws(() => tokenize('"bad\\q"'), error => error.code === "QX1005");
  assert.throws(() => tokenize("DATA.CREATE(x\u200e, 1)"), error => error.code === "QX1007");
  assert.throws(() => tokenize("DATA.CREATE(x, 1);"), error => error.code === "QX1001");
});

test("parses commands, expressions, conditions, loops, and functions", () => {
  const program = [
    "DATA.CREATE(total, 0)",
    "FUNCTION calculate(price, quantity)",
    "    DATA.CREATE(result, price * quantity)",
    "    RETURN result",
    "END",
    "IF (active AND score >= 50)",
    "    WHILE (total < 3)",
    "        PROCESS.ADD(total, 1)",
    "    END",
    "ELSE",
    '    UI.SHOW("No")',
    "END",
    "DATA.CREATE(answer, calculate(10, 3))"
  ].join("\n");
  const ast = parse(program);
  assert.equal(ast.type, "Program");
  assert.equal(ast.body.length, 4);
  assert.equal(ast.body[1].type, "FunctionDeclaration");
  assert.equal(ast.body[1].params.length, 2);
  assert.equal(ast.body[2].type, "IfStatement");
  assert.equal(ast.body[2].consequent[0].type, "WhileStatement");
  assert.equal(ast.body[2].alternate[0].type, "CommandStatement");
  assert.equal(ast.body[3].args[1].type, "CallExpression");
});

test("parses mixed Arabic and English statements", () => {
  const ast = parse([
    'البيانات.إنشاء(الاسم, "Ali")',
    "IF (نشط و صحيح)",
    "    UI.SHOW(الاسم)",
    "END"
  ].join("\n"));
  assert.equal(ast.body.length, 2);
  assert.equal(ast.body[1].test.operator, "AND");
});

test("rejects multiple statements on one line and chained comparisons", () => {
  assert.throws(() => parse("DATA.CREATE(a, 1) DATA.CREATE(b, 2)"), QXParseError);
  assert.throws(() => parse("IF (1 < 2 < 3)\nEND"), error => error.code === "QX2008");
});

test("reports missing END and missing RETURN values", () => {
  assert.throws(() => parse("WHILE (TRUE)\nUI.SHOW(1)"), error => error.code === "QX2007");
  assert.throws(() => parse("FUNCTION f()\nRETURN\nEND"), error => error.code === "QX2006");
});

test("requires block headers and ELSE on their own lines", () => {
  assert.throws(() => parse("IF (TRUE) UI.SHOW(1)\nEND"), error => error.code === "QX2010");
  assert.throws(() => parse("IF (TRUE)\nUI.SHOW(1) END"), error => error.code === "QX2003");
  assert.throws(() => parse("IF (TRUE)\nELSE UI.SHOW(1)\nEND"), error => error.code === "QX2010");
});

test("handles escaped strings and CRLF source locations", () => {
  const tokens = tokenize('DATA.CREATE(message, "A\\nB")\r\nUI.SHOW(message)');
  assert.equal(tokens[6].value, "A\nB");
  assert.equal(tokens.at(-2).line, 2);
});
