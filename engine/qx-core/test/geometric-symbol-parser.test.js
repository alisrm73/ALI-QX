import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/index.js";
import { GEOMETRIC_SYMBOLS } from "../src/geometric-symbols.js";

test("parses an invocation for every approved geometric symbol", () => {
  for (const symbol of GEOMETRIC_SYMBOLS) {
    const ast = parse(`${symbol.glyph}()\n`);
    assert.equal(ast.body.length, 1, symbol.name);
    assert.equal(ast.body[0].type, "GeometricStatement", symbol.name);
    assert.equal(ast.body[0].symbol, symbol.name);
    assert.equal(ast.body[0].glyph, symbol.glyph);
    assert.equal(ast.body[0].group, symbol.group);
    assert.deepEqual(ast.body[0].args, []);
    assert.equal(ast.body[0].body, null);
  }
});

test("parses nested geometric calls, expressions, and structural blocks", () => {
  const ast = parse([
    '⬡("app") {',
    '  ◉(users)',
    '  ⊙(total, ⧬(price * quantity))',
    '  ⟡(⟥(age, 18)) {',
    '    ⊢("Allowed")',
    '  }',
    '}'
  ].join("\n"));
  assert.equal(ast.body[0].type, "GeometricStatement");
  assert.equal(ast.body[0].body.length, 3);
  assert.equal(ast.body[0].body[1].args[1].type, "GeometricCallExpression");
  assert.equal(ast.body[0].body[2].body[0].symbol, "DISPLAY");
});

test("rejects an unclosed geometric block", () => {
  assert.throws(() => parse('⬡() {\n  ⊢("x")'), error => error.code === "QX2001");
});

test("rejects an unmatched geometric block terminator", () => {
  assert.throws(() => parse('}\n'), error => error.code === "QX2002");
});

test("attaches geometric ELSE_IF and ELSE branches to their IF statement", () => {
  const ast = parse([
    "⟡(⟤(status, 1)) {",
    '  ⊢("one")',
    "} ",
    "⟣(⟤(status, 2)) {",
    '  ⊢("two")',
    "}",
    "⟢() {",
    '  ⊢("other")',
    "}"
  ].join("\\n"));
  const conditional = ast.body[0];
  assert.equal(conditional.symbol, "IF");
  assert.equal(conditional.alternate.symbol, "ELSE_IF");
  assert.equal(conditional.alternate.alternate.symbol, "ELSE");
});
