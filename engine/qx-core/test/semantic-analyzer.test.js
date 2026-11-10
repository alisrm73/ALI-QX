import test from "node:test";
import assert from "node:assert/strict";
import { analyze, parse } from "../src/index.js";

const check = source => analyze(parse(source));

test("infers primitive and heterogeneous list declaration types", () => {
  const result = check([
    'DATA.CREATE(title, "QX")',
    "DATA.CREATE(price, 12.5)",
    "DATA.CREATE(active, TRUE)",
    'DATA.CREATE(items, ["x", 1, FALSE])'
  ].join("\n"));
  assert.equal(result.valid, true);
  assert.deepEqual(result.symbols.map(item => item.type), ["TXT", "NUM", "BOOL", "LIST"]);
});

test("rejects NULL as an initial value because it has no inferable base type", () => {
  const result = check("DATA.CREATE(value, NULL)");
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, "QX3018");
});

test("rejects duplicate and undeclared variables", () => {
  const result = check(["DATA.CREATE(value, 1)", "DATA.CREATE(value, 2)", "DATA.SET(missing, 3)"].join("\n"));
  assert.deepEqual(result.diagnostics.map(item => item.code), ["QX3001", "QX3003"]);
});

test("enforces assignment type stability", () => {
  const result = check(['DATA.CREATE(value, 1)', 'DATA.SET(value, "text")'].join("\n"));
  assert.equal(result.diagnostics[0].code, "QX3022");
});

test("infers arithmetic, comparison, logic, and DATA.COUNT expression types", () => {
  const result = check([
    "DATA.CREATE(values, [1, 2])",
    "DATA.CREATE(total, DATA.COUNT(values) + 1)",
    "DATA.CREATE(ready, total >= 2 AND TRUE)"
  ].join("\n"));
  assert.equal(result.valid, true);
  assert.deepEqual(result.symbols.map(item => item.type), ["LIST", "NUM", "BOOL"]);
});

test("rejects invalid operators and non-BOOL conditions", () => {
  const result = check([
    'DATA.CREATE(bad, 1 + "x")',
    "IF (1)\nEND",
    "DATA.CREATE(flag, TRUE AND 2)"
  ].join("\n"));
  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics.map(item => item.code), ["QX3007", "QX3026", "QX3008"]);
});

test("validates CALCULATE and COMPARE target and expression types", () => {
  const result = check([
    "DATA.CREATE(total, 0)",
    "DATA.CREATE(ready, FALSE)",
    "PROCESS.CALCULATE(total, 2 + 3)",
    "PROCESS.COMPARE(ready, total > 3)"
  ].join("\n"));
  assert.equal(result.valid, true);
});

test("rejects unknown commands in expression position and does not invent return contracts", () => {
  const result = check("DATA.CREATE(value, UI.SHOW(1))");
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, "QX3045");
});


test("validates UI.SHOW and UI.TEXT statement contracts", () => {
  const result = check([
    'UI.TEXT("Hello from QX")',
    "DATA.CREATE(items, [1, 2])",
    "UI.SHOW(items)",
    "UI.SHOW(TRUE)",
    "UI.SHOW(NULL)"
  ].join("\n"));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));

  const badText = check("UI.TEXT(42)");
  assert.ok(badText.diagnostics.some(item => item.code === "QX3047"));
  const badArity = check('UI.SHOW("one", "two")');
  assert.ok(badArity.diagnostics.some(item => item.code === "QX3046"));
  const expression = check('DATA.CREATE(value, UI.TEXT("not a value"))');
  assert.ok(expression.diagnostics.some(item => item.code === "QX3045"));
});

test("does not cascade type diagnostics after an earlier ERROR", () => {
  const result = check([
    "DATA.CREATE(value, missing)",
    "DATA.SET(value, 1)",
    "IF (anotherMissing)",
    "END"
  ].join("\n"));
  assert.deepEqual(result.diagnostics.map(item => item.code), ["QX3003", "QX3003"]);
});

test("returns source locations in semantic diagnostics", () => {
  const result = check("\nDATA.CREATE(value, NULL)");
  assert.deepEqual(result.diagnostics[0].location, { line: 2, column: 20, offset: 20 });
});


test("infers parameter and return types from a function body without call sites", () => {
  const result = check("FUNCTION addOne(value)\n RETURN value + 1\nEND");
  assert.equal(result.valid, true);
  assert.deepEqual(result.functions[0], {
    name: "addOne", parameters: [{ name: "value", type: "NUM" }], returnType: "NUM", kind: "function"
  });
});

test("infers unused parameters from call sites, but rejects unresolved unused parameters", () => {
  const inferred = check("FUNCTION keep(value)\n RETURN 1\nEND\nDATA.CREATE(result, keep(\"x\"))");
  assert.equal(inferred.valid, true);
  assert.equal(inferred.functions[0].parameters[0].type, "TXT");
  const unresolved = check("FUNCTION keep(value)\n RETURN 1\nEND");
  assert.equal(unresolved.valid, false);
  assert.ok(unresolved.diagnostics.some(item => item.code === "QX3036"));
});

test("analyzes uncalled function bodies and rejects unknown types", () => {
  const result = check("FUNCTION unused(value)\n RETURN value\nEND");
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === "QX3036"));
});

test("infers forward and nested function calls", () => {
  const result = check([
    "FUNCTION outer(value)",
    " RETURN inner(value)",
    "END",
    "FUNCTION inner(item)",
    " RETURN item * 2",
    "END",
    "DATA.CREATE(answer, outer(3))"
  ].join("\n"));
  assert.equal(result.valid, true);
  assert.deepEqual(result.functions.map(fn => fn.returnType), ["NUM", "NUM"]);
});

test("infers recursive function parameter and return types", () => {
  const result = check([
    "FUNCTION factorial(n)",
    " IF (n <= 1)",
    "  RETURN 1",
    " ELSE",
    "  RETURN n * factorial(n - 1)",
    " END",
    "END",
    "DATA.CREATE(answer, factorial(5))"
  ].join("\n"));
  assert.equal(result.valid, true);
  assert.equal(result.functions[0].returnType, "NUM");
  assert.equal(result.functions[0].parameters[0].type, "NUM");
});

test("requires compatible return types on every path and rejects fallthrough paths", () => {
  const mixed = check("FUNCTION choose(flag)\n IF (flag)\n RETURN 1\n ELSE\n RETURN \"x\"\n END\nEND");
  assert.equal(mixed.valid, false);
  assert.ok(mixed.diagnostics.some(item => item.code === "QX3038"));
  const partial = check("FUNCTION maybe(flag)\n IF (flag)\n RETURN 1\n END\nEND");
  assert.equal(partial.valid, false);
  assert.ok(partial.diagnostics.some(item => item.code === "QX3032"));
});

test("recognizes procedures without RETURN and prevents using them as values", () => {
  const procedure = check("FUNCTION log(value)\n\nEND\nlog(1)");
  assert.equal(procedure.valid, true);
  assert.equal(procedure.functions[0].kind, "procedure");
  const asValue = check("FUNCTION log(value)\n\nEND\nDATA.CREATE(result, log(1))");
  assert.equal(asValue.valid, false);
  assert.ok(asValue.diagnostics.some(item => item.code === "QX3018"));
});

test("infers types through DATA.COUNT and PROCESS commands inside functions", () => {
  const result = check([
    "FUNCTION countItems(items)",
    " DATA.CREATE(total, DATA.COUNT(items))",
    " DATA.CREATE(ready, FALSE)",
    " PROCESS.CALCULATE(total, total + 1)",
    " PROCESS.COMPARE(ready, total > 0)",
    " RETURN total",
    "END"
  ].join("\n"));
  assert.equal(result.valid, true);
  assert.equal(result.functions[0].parameters[0].type, "LIST");
  assert.equal(result.functions[0].returnType, "NUM");
});

test("rejects incompatible call arguments and return types", () => {
  const result = check("FUNCTION add(value)\n RETURN value + 1\nEND\nDATA.CREATE(answer, add(\"x\"))");
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === "QX3007" || item.code === "QX3037"));
});

test("rejects procedure calls embedded in value expressions", () => {
  const result = check("FUNCTION log(value)\n\nEND\nDATA.CREATE(answer, log(1) + 2)");
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === "QX3039"));
});

test("rejects NULL return values as non-inferable function results", () => {
  const result = check("FUNCTION missing()\n RETURN NULL\nEND");
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === "QX3038"));
});

test("rejects procedure calls in value positions even through lists and forward returns", () => {
  const listValue = check([
    "DATA.CREATE(items, [log()])",
    "FUNCTION log()",
    ' UI.SHOW("x")',
    "END"
  ].join("\n"));
  assert.equal(listValue.valid, false);
  assert.ok(listValue.diagnostics.some(item => item.code === "QX3039"));

  const returnedProcedure = check([
    "FUNCTION outer()",
    " RETURN log()",
    "END",
    "FUNCTION log()",
    ' UI.SHOW("x")',
    "END"
  ].join("\n"));
  assert.equal(returnedProcedure.valid, false);
  assert.ok(returnedProcedure.diagnostics.some(item => item.code === "QX3039"));
  assert.ok(returnedProcedure.diagnostics.some(item => item.code === "QX3038"));
});


test("validates DATA.ADD and DATA.REMOVE expression contracts", () => {
  const valid = check([
    "DATA.CREATE(items, [1, 2])",
    "DATA.CREATE(added, DATA.ADD(items, NULL))",
    "DATA.CREATE(removed, DATA.REMOVE(added, 0))"
  ].join("\n"));
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));
  assert.deepEqual(valid.symbols.map(item => item.type), ["LIST", "LIST", "LIST"]);

  const badList = check("DATA.CREATE(items, 1)\nDATA.CREATE(result, DATA.ADD(items, 2))");
  assert.ok(badList.diagnostics.some(item => item.code === "QX3042"));
  const badIndex = check("DATA.CREATE(items, [1])\nDATA.CREATE(result, DATA.REMOVE(items, TRUE))");
  assert.ok(badIndex.diagnostics.some(item => item.code === "QX3043"));
  const wrongArity = check("DATA.CREATE(items, [])\nDATA.CREATE(result, DATA.ADD(items))");
  assert.ok(wrongArity.diagnostics.some(item => item.code === "QX3041"));
});

test("requires DATA.SET_GLOBAL to be inside a function", () => {
  const result = check("DATA.CREATE(value, 1)\nDATA.SET_GLOBAL(value, 2)");
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === "QX3021"));
});

test("validates PROCESS.ADD as a numeric increment of an existing NUM variable", () => {
  const valid = check("DATA.CREATE(count, 0)\nPROCESS.ADD(count, 1.5)");
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));
  assert.equal(valid.symbols[0].type, "NUM");

  const badTarget = check('DATA.CREATE(count, "0")\nPROCESS.ADD(count, 1)');
  assert.ok(badTarget.diagnostics.some(item => item.code === "QX3024"));
  const badAmount = check("DATA.CREATE(count, 0)\nPROCESS.ADD(count, TRUE)");
  assert.ok(badAmount.diagnostics.some(item => item.code === "QX3025"));
});

test("PROCESS.ADD does not bypass the explicit global-write rule inside functions", () => {
  const result = check([
    "DATA.CREATE(count, 0)",
    "FUNCTION increment()",
    "PROCESS.ADD(count, 1)",
    "END"
  ].join("\n"));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.code === "QX3020"));
});

test("accepts INTEGRATION.REQUEST as a TXT-valued expression", () => {
  const result = check('DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{\\\"id\\\":1}"))');
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.symbols.find(item => item.name === "response").type, "TXT");
});

test("rejects malformed INTEGRATION.REQUEST arguments and statement use", () => {
  const wrongArity = check('DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup"))');
  assert.ok(wrongArity.diagnostics.some(item => item.code === "QX3050"));
  const wrongType = check('DATA.CREATE(response, INTEGRATION.REQUEST("demo", 7, "{}"))');
  assert.ok(wrongType.diagnostics.some(item => item.code === "QX3051"));
  const statement = check('INTEGRATION.REQUEST("demo", "lookup", "{}")');
  assert.ok(statement.diagnostics.some(item => item.code === "QX3052"));
});


test("validates the UI.TREE TXT JSON statement contract", () => {
  const valid = check('UI.TREE("{}")');
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));

  const wrongType = check("UI.TREE(42)");
  assert.equal(wrongType.valid, false);
  assert.ok(wrongType.diagnostics.some(item =>
    item.code === "QX3060" && item.message === "UI.TREE expects a TXT JSON tree"
  ));
  const wrongArity = check('UI.TREE("{}", "{}")');
  assert.ok(wrongArity.diagnostics.some(item => item.code === "QX3046"));
});

test("validates DATA.COUNT statement arity and registered LIST parameter type", () => {
  const valid = check("DATA.CREATE(items, [1])\nDATA.COUNT(items)");
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));

  const wrongType = check("DATA.COUNT(1)");
  assert.ok(wrongType.diagnostics.some(item => item.code === "QX3014"));

  const wrongArity = check("DATA.COUNT()");
  assert.ok(wrongArity.diagnostics.some(item => item.code === "QX3013"));
});
