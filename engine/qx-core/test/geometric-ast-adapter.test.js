import test from "node:test";
import assert from "node:assert/strict";
import { adaptGeometricAst, analyze, lowerToQIR, parse } from "../src/index.js";
import { GEOMETRIC_SYMBOLS } from "../src/geometric-symbols.js";

const approvedDefinitions = new Map([
  ["ORIGIN", "OriginDeclaration"],
  ["FORM", "FormDefinition"],
  ["CORE", "CoreEntityDeclaration"],
  ["SEED", "ComponentDeclaration"],
  ["ROOT", "RootSelectionDeclaration"],
  ["IDENTITY", "IdentityDeclaration"]
]);

test("maps the six approved definition statements to their specialized AST types", () => {
  for (const symbol of GEOMETRIC_SYMBOLS.filter(item => item.group === "CREATION_DEFINITION")) {
    const raw = parse(`${symbol.glyph}("sample")`);
    const adapted = adaptGeometricAst(raw);
    const node = adapted.body[0];

    assert.equal(node.type, approvedDefinitions.get(symbol.name));
    assert.equal(node.parentType, "DefinitionDeclaration");
    assert.equal(node.syntaxType, "GeometricStatement");
    assert.equal(node.symbol, symbol.name);
    assert.equal(node.glyph, symbol.glyph);
    assert.equal(node.group, symbol.group);
    assert.deepEqual(node.args, raw.body[0].args);
    assert.deepEqual(node.location, raw.body[0].location);
  }
});

test("preserves nested statements and every existing geometric node field", () => {
  const raw = parse([
    '⬡("app") {',
    '  ⬢("shape") {',
    '    ◉(users)',
    '  }',
    '}'
  ].join("\n"));
  const adapted = adaptGeometricAst(raw);

  assert.equal(adapted.body[0].type, "OriginDeclaration");
  assert.equal(adapted.body[0].body[0].type, "FormDefinition");
  assert.equal(adapted.body[0].body[0].body[0].type, "GeometricStatement");
  assert.deepEqual(adapted.body[0].body[0].body[0].args, raw.body[0].body[0].body[0].args);

  // The parser's original AST remains untouched and independently inspectable.
  assert.equal(raw.body[0].type, "GeometricStatement");
  assert.equal(raw.body[0].body[0].type, "GeometricStatement");
});

test("does not map expression calls or symbols outside the approved first group", () => {
  const raw = parse([
    '⬡(⧬(1 + 2))',
    '◉("users")'
  ].join("\n"));
  const adapted = adaptGeometricAst(raw);

  assert.equal(adapted.body[0].type, "OriginDeclaration");
  assert.equal(adapted.body[0].args[0].type, "GeometricCallExpression");
  assert.equal(adapted.body[1].type, "GeometricStatement");
  assert.equal(adapted.body[1].symbol, "DATA");
});

test("semantic analysis recognizes the approved AST types but blocks unresolved contracts", () => {
  for (const symbol of GEOMETRIC_SYMBOLS.filter(item => item.group === "CREATION_DEFINITION")) {
    const ast = parse(`${symbol.glyph}()`);
    const semantic = analyze(ast);

    assert.equal(semantic.valid, false);
    assert.ok(
      semantic.diagnostics.some(item =>
        item.code === "QX3028" &&
        item.message.includes("has no approved semantic contract")
      ),
      symbol.name
    );
    assert.throws(
      () => lowerToQIR(ast, semantic),
      error => error.code === "QIR_E_SEMANTIC_ERRORS"
    );
  }
});

test("enforces statement-only usage for the six approved Group 1 symbols", () => {
  for (const symbol of GEOMETRIC_SYMBOLS.filter(item => item.group === "CREATION_DEFINITION")) {
    const ast = parse(`DATA.CREATE(value, ${symbol.glyph}())`);
    const semantic = analyze(ast);

    assert.equal(semantic.valid, false, symbol.name);
    assert.ok(
      semantic.diagnostics.some(item =>
        item.code === "QX3028" &&
        item.message.includes("is statement-only and cannot be used as an expression")
      ),
      `expression position: ${symbol.name}`
    );
    assert.throws(
      () => lowerToQIR(ast, semantic),
      error => error.code === "QIR_E_SEMANTIC_ERRORS"
    );
  }
});

test("rejects non-Program input without mutating caller data", () => {
  const input = { type: "ExpressionStatement" };
  assert.throws(() => adaptGeometricAst(input), TypeError);
  assert.deepEqual(input, { type: "ExpressionStatement" });
});


test("rejects unresolved geometric symbols uniformly in statement and expression positions", () => {
  for (const symbol of GEOMETRIC_SYMBOLS) {
    const statement = analyze(parse(`${symbol.glyph}()`));
    assert.equal(statement.valid, false, symbol.name);
    assert.ok(
      statement.diagnostics.some(item =>
        item.code === "QX3028" && item.message.includes(symbol.name)
      ),
      `statement: ${symbol.name}`
    );
    assert.throws(
      () => lowerToQIR(parse(`${symbol.glyph}()`), statement),
      error => error.code === "QIR_E_SEMANTIC_ERRORS"
    );

    const expressionAst = parse(`DATA.CREATE(value, ${symbol.glyph}())`);
    const expression = analyze(expressionAst);
    assert.equal(expression.valid, false, `expression: ${symbol.name}`);
    assert.ok(
      expression.diagnostics.some(item =>
        item.code === "QX3028" && item.message.includes(symbol.name)
      ),
      `expression: ${symbol.name}`
    );
    assert.throws(
      () => lowerToQIR(expressionAst, expression),
      error => error.code === "QIR_E_SEMANTIC_ERRORS"
    );
  }
});

test("continues rejecting unresolved geometric symbols nested in geometric blocks", () => {
  const result = analyze(parse([
    '⬡("app") {',
    '  ◉("users")',
    '}'
  ].join("\n")));

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.filter(item => item.code === "QX3028").length, 2);
});


test("enforces approved usage positions for the six Group 2 symbols", () => {
  const statementOnly = new Set(["DATA", "STORE", "VALUE", "RECORD", "COLLECTION"]);
  for (const symbol of GEOMETRIC_SYMBOLS.filter(item => item.group === "DATA_STORAGE")) {
    const statementAst = parse(`${symbol.glyph}()`);
    const statement = analyze(statementAst);
    assert.equal(statement.valid, false, symbol.name);
    if (symbol.name === "FETCH") {
      assert.ok(statement.diagnostics.some(item =>
        item.code === "QX3028" &&
        item.message.includes("is expression-only and cannot be used as a statement")
      ), `statement position: ${symbol.name}`);
    } else {
      assert.ok(statement.diagnostics.some(item =>
        item.code === "QX3028" && item.message.includes("has no approved semantic contract")
      ), `statement contract remains blocked: ${symbol.name}`);
    }
    assert.throws(() => lowerToQIR(statementAst, statement),
      error => error.code === "QIR_E_SEMANTIC_ERRORS");

    const expressionAst = parse(`DATA.CREATE(value, ${symbol.glyph}())`);
    const expression = analyze(expressionAst);
    assert.equal(expression.valid, false, symbol.name);
    if (statementOnly.has(symbol.name)) {
      assert.ok(expression.diagnostics.some(item =>
        item.code === "QX3028" &&
        item.message.includes("is statement-only and cannot be used as an expression")
      ), `expression position: ${symbol.name}`);
    } else {
      assert.ok(expression.diagnostics.some(item =>
        item.code === "QX3028" && item.message.includes("has no approved semantic contract")
      ), `expression contract remains blocked: ${symbol.name}`);
    }
    assert.throws(() => lowerToQIR(expressionAst, expression),
      error => error.code === "QIR_E_SEMANTIC_ERRORS");
  }
});
