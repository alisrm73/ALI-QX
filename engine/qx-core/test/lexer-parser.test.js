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

test("rejects non-letter Unicode XID_Start characters", () => {
  assert.throws(() => tokenize("℘name"), error => error instanceof QXLexError && error.code === "QX1008");
  assert.throws(() => tokenize("ᢅname"), error => error instanceof QXLexError && error.code === "QX1008");
});

test("rejects unsupported escapes, invisible identifiers, and semicolon terminators", () => {
  assert.throws(() => tokenize('"bad\\q"'), error => error.code === "QX1005");
  assert.throws(() => tokenize("DATA.CREATE(x\u200e, 1)"), error => error.code === "QX1007");
  assert.equal(tokenize('DATA.CREATE(text, "A\u200eB")')[6].type, "STRING");
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

test("restricts function declarations to top level and RETURN to functions", () => {
  assert.throws(() => parse("RETURN 1"), error => error.code === "QX2012");
  assert.throws(() => parse("IF (TRUE)\nFUNCTION nested()\nEND\nEND"), error => error.code === "QX2011");
});

test("parses qualified command calls as expression arguments", () => {
  const ast = parse("DATA.CREATE(item, DATA.GET(items, 0))");
  const call = ast.body[0].args[1];
  assert.equal(call.type, "CommandCallExpression");
  assert.equal(call.domain, "DATA");
  assert.equal(call.command, "GET");
  assert.equal(call.args[0].name, "items");
  assert.equal(call.args[1].value, 0);
  assert.deepEqual(call.location, { line: 1, column: 19, offset: 18 });
});

test("parses Arabic qualified command calls and nested command calls", () => {
  const ast = parse("البيانات.إنشاء(عنصر, البيانات.جلب(العناصر, البيانات.عدد(العناصر)))");
  const outer = ast.body[0].args[1];
  assert.equal(outer.type, "CommandCallExpression");
  assert.equal(outer.domain, "البيانات");
  assert.equal(outer.command, "جلب");
  assert.equal(outer.args[1].type, "CommandCallExpression");
  assert.equal(outer.args[1].command, "عدد");
});

test("parses qualified command calls inside lists and binary expressions", () => {
  const ast = parse("DATA.CREATE(values, [DATA.GET(items, 0), DATA.GET(items, 1) + 2])");
  const list = ast.body[0].args[1];
  assert.equal(list.type, "ListLiteral");
  assert.equal(list.elements[0].type, "CommandCallExpression");
  assert.equal(list.elements[1].type, "BinaryExpression");
  assert.equal(list.elements[1].left.type, "CommandCallExpression");
});

test("requires a call after a qualified command expression", () => {
  assert.throws(() => parse("DATA.CREATE(value, DATA.GET)"), error => error.code === "QX2013");
});
