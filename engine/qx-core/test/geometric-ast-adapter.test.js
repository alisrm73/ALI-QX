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
    '  ⬣("component")',
    '}'
  ].join("\n")));

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.filter(item => item.code === "QX3028").length, 2);
});


test("enforces approved usage positions for the six Group 2 symbols", () => {
  const statementOnly = new Set(["DATA", "STORE", "VALUE", "RECORD", "COLLECTION"]);
  const validStatements = {
    DATA: "◉(item, 1)",
    STORE: "◉(item, 1)\n◍(item, 2)",
    VALUE: "⊙(item, 1)",
    RECORD: '⊚(item, {})',
    COLLECTION: "⊛(items)"
  };

  for (const symbol of GEOMETRIC_SYMBOLS.filter(item => item.group === "DATA_STORAGE")) {
    if (symbol.name === "FETCH") {
      const statement = analyze(parse("◉(item, 1)\n◌(item)"));
      assert.ok(statement.diagnostics.some(item =>
        item.code === "QX3028" && item.message.includes("FETCH is expression-only")
      ));
      const expression = analyze(parse("◉(item, 1)\nDATA.CREATE(copy, ◌(item))"));
      assert.equal(expression.valid, true, JSON.stringify(expression.diagnostics));
      continue;
    }

    const statement = analyze(parse(validStatements[symbol.name]));
    if (["DATA", "STORE", "VALUE", "RECORD", "COLLECTION"].includes(symbol.name)) {
      assert.equal(statement.valid, true, symbol.name + ": " + JSON.stringify(statement.diagnostics));
    } else {
      assert.ok(statement.diagnostics.some(item =>
        item.code === "QX3028" && item.message.includes(symbol.name)
      ), symbol.name + " remains blocked");
    }

    const expression = analyze(parse("DATA.CREATE(result, " + symbol.glyph + "(item, 1))"));
    assert.ok(expression.diagnostics.some(item =>
      item.code === "QX3028" &&
      item.message.includes("is statement-only and cannot be used as an expression")
    ), "expression position: " + symbol.name);
  }
});

test("enforces exact Group 2 geometric argument counts and AST node types", () => {
  const validStatements = [
    ["DATA", '◉(name, 1)', true],
    ["STORE", '◉(target, 1)\n◍(target, 2)', true],
    ["VALUE", '⊙(name, 1)', true],
    ["RECORD", '⊚(record, {})', true],
    ["COLLECTION", '⊛(items)', true]
  ];

  for (const [name, source, expectedValid] of validStatements) {
    const semantic = analyze(parse(source));
    assert.equal(semantic.valid, expectedValid, name + ": " + JSON.stringify(semantic.diagnostics));
    assert.equal(
      semantic.diagnostics.some(item => item.message.includes("expects exactly") || item.message.includes("must be Identifier") || item.message.includes("must be Expression")),
      false,
      name + " should satisfy its approved argument schema"
    );
  }

  const fetchAst = parse("◉(source, 1)\nDATA.CREATE(result, ◌(source))");
  const fetchSemantic = analyze(fetchAst);
  assert.equal(fetchSemantic.valid, true, JSON.stringify(fetchSemantic.diagnostics));
});

test("rejects Group 2 geometric calls with incorrect argument arity or AST node types", () => {
  const invalidCases = [
    ["DATA", "◉()", "expects exactly 2 argument(s), received 0"],
    ["STORE", "◍(target)", "expects exactly 2 argument(s), received 1"],
    ["VALUE", "⊙(1, 2)", "argument 1 must be Identifier"],
    ["RECORD", "⊚(record, 1, 2)", "expects exactly 2 argument(s), received 3"],
    ["RECORD", "⊚(record, [])", "argument 2 must be RecordLiteral"],
    ["COLLECTION", "⊛(1)", "argument 1 must be Identifier"]
  ];

  for (const [name, source, expectedMessage] of invalidCases) {
    const ast = parse(source);
    const semantic = analyze(ast);
    assert.ok(semantic.diagnostics.some(item =>
      item.code === "QX3028" && item.message.includes(expectedMessage)
    ), name);
    assert.throws(() => lowerToQIR(ast, semantic),
      error => error.code === "QIR_E_SEMANTIC_ERRORS");
  }

  const fetchAst = parse("DATA.CREATE(result, ◌(1))");
  const fetchSemantic = analyze(fetchAst);
  assert.ok(fetchSemantic.diagnostics.some(item =>
    item.code === "QX3028" && item.message.includes("FETCH argument 1 must be Identifier")
  ));
  assert.throws(() => lowerToQIR(fetchAst, fetchSemantic),
    error => error.code === "QIR_E_SEMANTIC_ERRORS");
});


test("accepts DATA declarations with initialized supported values and rejects duplicate or NULL bindings", () => {
  for (const source of ["◉(count, 1)", '◉(name, "QX")', "◉(enabled, TRUE)", "◉(items, [1, \"x\"])"]) {
    const semantic = analyze(parse(source));
    assert.equal(semantic.valid, true, source + ": " + JSON.stringify(semantic.diagnostics));
  }

  for (const [source, code] of [
    ["◉(count, NULL)", "QX"],
    ["◉(count, 1)\n◉(count, 2)", "QX3001"]
  ]) {
    const semantic = analyze(parse(source));
    assert.equal(semantic.valid, false, source);
    if (code === "QX3001") assert.ok(semantic.diagnostics.some(item => item.code === code));
  }
});

test("enforces STORE existence, mutability, exact type, and function scope", () => {
  const valid = analyze(parse("◉(count, 1)\n◍(count, 2)"));
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));

  const missing = analyze(parse("◍(count, 2)"));
  assert.ok(missing.diagnostics.some(item => item.code === "QX3003"));

  const mismatch = analyze(parse('◉(count, 1)\n◍(count, "two")'));
  assert.ok(mismatch.diagnostics.some(item => item.code === "QX3022"));

  const globalWrite = analyze(parse([
    "◉(count, 1)",
    "FUNCTION update()",
    "◍(count, 2)",
    "END"
  ].join("\n")));
  assert.ok(globalWrite.diagnostics.some(item => item.code === "QX3020"));
});

test("resolves FETCH as a typed expression and rejects missing or unsupported bindings", () => {
  const valid = analyze(parse("◉(count, 1)\nDATA.CREATE(copy, ◌(count))"));
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));

  const missing = analyze(parse("DATA.CREATE(copy, ◌(absent))"));
  assert.ok(missing.diagnostics.some(item => item.code === "QX3003"));
});

test("creates COLLECTION as an initialized mutable LIST binding", () => {
  const valid = analyze(parse([
    "⊛(items)",
    "DATA.CREATE(count, DATA.COUNT(◌(items)))",
    "◍(items, [1, \"two\", TRUE])"
  ].join("\n")));
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));

  const mismatch = analyze(parse("⊛(items)\n◍(items, 1)"));
  assert.ok(mismatch.diagnostics.some(item => item.code === "QX3022"));
});

test("accepts VALUE as an immutable binding through QIR lowering", () => {
  const ast = parse("⊙(constant, 1)");
  const semantic = analyze(ast);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.diagnostics));
  const qir = lowerToQIR(ast, semantic);
  assert.equal(qir.version, "1.5");
  assert.equal(qir.globals[0].mutable, false);
});

test("rejects bodies for Group 2 symbols whose contracts forbid blocks", () => {
  const semantic = analyze(parse([
    "◉(count, 1) {",
    "  ◉(nested, 2)",
    "}"
  ].join("\n")));
  assert.equal(semantic.valid, false);
  assert.ok(semantic.diagnostics.some(item =>
    item.code === "QX3028" && item.message.includes("body")
  ));
});
