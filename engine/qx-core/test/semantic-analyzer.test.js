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
  assert.equal(result.diagnostics[0].code, "QX3012");
});

test("returns source locations in semantic diagnostics", () => {
  const result = check("\nDATA.CREATE(value, NULL)");
  assert.deepEqual(result.diagnostics[0].location, { line: 2, column: 19, offset: 19 });
});
