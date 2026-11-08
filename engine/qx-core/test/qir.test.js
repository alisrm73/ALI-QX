import test from "node:test";
import assert from "node:assert/strict";
import { analyze, lowerToQIR, parse, parseQIR, serializeQIR, validateQIR } from "../src/index.js";

function compile(source) {
  const ast = parse(source);
  const semantic = analyze(ast);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.diagnostics));
  return lowerToQIR(ast, semantic);
}

test("lowers module declarations and arithmetic into valid QIR", () => {
  const qir = compile("DATA.CREATE(total, 4 + 5)");
  assert.equal(qir.format, "QIR");
  assert.equal(qir.initializer.id, "fn_0");
  assert.ok(qir.initializer.blocks.flatMap(block => block.instructions).some(item => item.opcode === "BINARY"));
  assert.deepEqual(validateQIR(qir), []);
});

test("lowers functions, parameters, forward calls, and returns", () => {
  const qir = compile([
    "DATA.CREATE(base, 2)",
    "FUNCTION add(a, b)",
    "RETURN a + b",
    "END",
    "DATA.CREATE(total, add(base, 3))"
  ].join("\n"));
  assert.equal(qir.functions.length, 1);
  assert.equal(qir.functions[0].id, "fn_1");
  assert.equal(qir.functions[0].return_type, "NUM");
  assert.ok(qir.initializer.blocks.flatMap(block => block.instructions).some(item => item.opcode === "CALL"));
});

test("lowers AND/OR using branches and a temporary instead of eager BINARY", () => {
  const qir = compile("DATA.CREATE(flag, TRUE AND FALSE)");
  const instructions = qir.initializer.blocks.flatMap(block => block.instructions);
  assert.ok(instructions.some(item => item.opcode === "BRANCH"));
  assert.ok(instructions.some(item => item.opcode === "STORE_LOCAL"));
  assert.ok(!instructions.some(item => item.opcode === "BINARY" && ["AND", "OR"].includes(item.operands.operator)));
});

test("lowers IF and WHILE with explicit CFG terminators", () => {
  const ifQir = compile([
    "FUNCTION choose(flag)",
    "IF(flag)",
    "RETURN 1",
    "ELSE",
    "RETURN 2",
    "END",
    "END"
  ].join("\n"));
  assert.ok(ifQir.functions[0].blocks.some(block => block.instructions.at(-1).opcode === "BRANCH"));
  const loopQir = compile([
    "DATA.CREATE(flag, TRUE)",
    "WHILE(flag)",
    "PROCESS.COMPARE(flag, FALSE)",
    "END"
  ].join("\n"));
  assert.ok(loopQir.initializer.blocks.some(block => block.instructions.at(-1).opcode === "BRANCH"));
});

test("round-trips canonical QIR JSON and rejects invalid headers", () => {
  const qir = compile("DATA.CREATE(name, \"QX\")");
  const encoded = serializeQIR(qir);
  assert.deepEqual(parseQIR(encoded), qir);
  assert.throws(() => parseQIR("{"), /Invalid QIR JSON/);
  assert.ok(validateQIR({ format: "QIR", version: "9", unicode_version: "18.0.0" }).length > 0);
});

test("refuses lowering when semantic analysis has errors", () => {
  const ast = parse("DATA.CREATE(value, missing)");
  const semantic = analyze(ast);
  assert.equal(semantic.valid, false);
  assert.throws(() => lowerToQIR(ast, semantic), error => error.code === "QIR_E_SEMANTIC_ERRORS");
});

test("validator checks stored value types and definite assignment", () => {
  const qir = compile("DATA.CREATE(x, 1)\nDATA.CREATE(y, x + 1)");
  const badType = JSON.parse(JSON.stringify(qir));
  const constant = badType.initializer.blocks[0].instructions.find(item => item.opcode === "CONST_NUM");
  constant.type = "TXT";
  assert.ok(validateQIR(badType).some(item => item.code === "QIR_E_STORE_TYPE"));

  const uninitialized = JSON.parse(JSON.stringify(qir));
  const instructions = uninitialized.initializer.blocks[0].instructions;
  const loadIndex = instructions.findIndex(item => item.opcode === "LOAD");
  const firstStoreIndex = instructions.findIndex(item => item.opcode === "STORE_GLOBAL");
  const [load] = instructions.splice(loadIndex, 1);
  instructions.splice(firstStoreIndex, 0, load);
  const uninitializedDiagnostics = validateQIR(uninitialized);
  assert.ok(uninitializedDiagnostics.some(item => item.code === "QIR_E_UNINITIALIZED_LOAD"), JSON.stringify(uninitializedDiagnostics));
});

test("validator rejects calls before globals read by the callee are initialized", () => {
  const ast = parse([
    "FUNCTION readGlobal()",
    "RETURN value",
    "END",
    "DATA.CREATE(result, readGlobal())",
    "DATA.CREATE(value, 7)"
  ].join("\n"));
  const semantic = analyze(ast);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.diagnostics));
  const qir = lowerToQIR(ast, semantic);
  const diagnostics = validateQIR(qir);
  assert.ok(diagnostics.some(item => item.code === "QIR_E_GLOBAL_READ_BEFORE_CALL"), JSON.stringify({ diagnostics, qir }));
});
