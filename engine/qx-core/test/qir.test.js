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
  assert.throws(
    () => lowerToQIR(ast, semantic),
    error => error.name === "QIRValidationError" &&
      error.diagnostics.some(item => item.code === "QIR_E_GLOBAL_READ_BEFORE_CALL")
  );
});

test("covers remaining expression nodes, command lowerings, locals, and procedure calls", () => {
  const qir = compile([
    "DATA.CREATE(items, [1, \"item\", NULL])",
    "DATA.CREATE(value, (1 + 2))",
    "DATA.CREATE(negative, -3)",
    "DATA.CREATE(flag, NOT FALSE)",
    "DATA.CREATE(count, DATA.COUNT(items))",
    "DATA.SET(value, value + 1)",
    "PROCESS.CALCULATE(value, value + 2)",
    "PROCESS.COMPARE(flag, FALSE)",
    "FUNCTION identity(arg)",
    "DATA.CREATE(local, arg)",
    "RETURN local",
    "END",
    "FUNCTION touch()",
    "DATA.SET_GLOBAL(value, 9)",
    "END",
    "DATA.CREATE(copy, identity(value))",
    "touch()"
  ].join("\n"));
  const all = [qir.initializer, ...qir.functions].flatMap(fn => fn.blocks.flatMap(block => block.instructions));
  for (const opcode of ["CONST_NULL", "MAKE_LIST", "UNARY", "BINARY", "COMMAND_CALL", "CALL", "STORE_LOCAL", "STORE_GLOBAL"])
    assert.ok(all.some(item => item.opcode === opcode), "missing opcode " + opcode);
  assert.equal(serializeQIR(qir), serializeQIR(qir));
});

test("validator rejects broken control-flow targets and undefined value references", () => {
  const qir = compile([
    "DATA.CREATE(flag, TRUE)",
    "WHILE(flag)",
    "PROCESS.COMPARE(flag, FALSE)",
    "END"
  ].join("\n"));
  const badTarget = JSON.parse(JSON.stringify(qir));
  const jump = badTarget.initializer.blocks.flatMap(block => block.instructions).find(item => item.opcode === "JUMP");
  jump.operands.target = "bb_missing";
  assert.ok(validateQIR(badTarget).some(item => item.code === "QIR_E_JUMP_TARGET"));

  const badValue = JSON.parse(JSON.stringify(qir));
  const branch = badValue.initializer.blocks.flatMap(block => block.instructions).find(item => item.opcode === "BRANCH");
  branch.operands.condition = "v_999";
  assert.ok(validateQIR(badValue).some(item => item.code === "QIR_E_UNDEFINED_VALUE"));
});

test("validator enforces LOAD, RETURN, and CALL type contracts", () => {
  const loadQir = compile("DATA.CREATE(x, 1)\nDATA.CREATE(y, x + 1)");
  const badLoad = JSON.parse(JSON.stringify(loadQir));
  const load = badLoad.initializer.blocks.flatMap(block => block.instructions).find(item => item.opcode === "LOAD");
  load.type = "TXT";
  assert.ok(validateQIR(badLoad).some(item => item.code === "QIR_E_LOAD_TYPE"));

  const returnQir = compile([
    "FUNCTION identity(arg)",
    "RETURN arg",
    "END",
    "DATA.CREATE(result, identity(1))"
  ].join("\n"));
  const fn = returnQir.functions[0];
  const returnBlock = fn.blocks.find(block => block.instructions.at(-1).opcode === "RETURN");
  returnBlock.instructions.splice(-1, 0, {
    id: "inst_extra_return", opcode: "CONST_TXT", result: "v_extra_return",
    type: "TXT", operands: { value: "wrong" }, source: { line: 1, column: 1, offset: 0 }
  });
  returnBlock.instructions.at(-1).operands.value = "v_extra_return";
  assert.ok(validateQIR(returnQir).some(item => item.code === "QIR_E_RETURN_TYPE"));

  const callQir = JSON.parse(JSON.stringify(returnQir));
  const initBlock = callQir.initializer.blocks.find(block => block.instructions.some(item => item.opcode === "CALL"));
  const call = initBlock.instructions.find(item => item.opcode === "CALL");
  initBlock.instructions.splice(initBlock.instructions.indexOf(call), 0, {
    id: "inst_extra_call", opcode: "CONST_TXT", result: "v_extra_call",
    type: "TXT", operands: { value: "wrong" }, source: { line: 1, column: 1, offset: 0 }
  });
  call.operands.arguments = ["v_extra_call"];
  assert.ok(validateQIR(callQir).some(item => item.code === "QIR_E_CALL_TYPE"));
});


test("lowers immutable list operations into QIR 1.1 and round-trips", () => {
  const qir = compile([
    "DATA.CREATE(items, [1, [2], 3])",
    "DATA.CREATE(added, DATA.ADD(items, 4))",
    "DATA.CREATE(removed, DATA.REMOVE(added, 1))"
  ].join("\n"));
  assert.equal(qir.version, "1.1");
  const calls = [qir.initializer, ...qir.functions].flatMap(fn => fn.blocks.flatMap(block => block.instructions))
    .filter(inst => inst.opcode === "COMMAND_CALL");
  assert.deepEqual(calls.map(inst => inst.operands.command), ["DATA.ADD", "DATA.REMOVE"]);
  assert.ok(calls.every(inst => inst.type === "LIST" && inst.result));
  assert.deepEqual(validateQIR(parseQIR(serializeQIR(qir))), []);
});

test("QIR 1.0 continues to reject DATA.ADD and DATA.REMOVE command calls", () => {
  const qir = compile("DATA.CREATE(items, [1])");
  assert.equal(qir.version, "1.0");
  const bad = JSON.parse(JSON.stringify(qir));
  bad.initializer.blocks[0].instructions.splice(-1, 0, {
    id: "inst_bad", opcode: "COMMAND_CALL", result: "v_bad", type: "LIST",
    operands: { command: "DATA.ADD", arguments: ["v_missing", "v_missing"] },
    source: { line: 1, column: 1, offset: 0 }
  });
  assert.ok(validateQIR(bad).some(item => item.code === "QIR_E_COMMAND_SIGNATURE" || item.code === "QIR_E_COMMAND_NOT_ALLOWED"));
});

test("lowers PROCESS.ADD into a NUM load-add-store sequence in QIR 1.0", () => {
  const qir = compile("DATA.CREATE(count, 1)\nPROCESS.ADD(count, 2)");
  assert.equal(qir.version, "1.0");
  const instructions = qir.initializer.blocks.flatMap(block => block.instructions);
  const loadIndex = instructions.findIndex(inst => inst.opcode === "LOAD");
  const addIndex = instructions.findIndex(inst => inst.opcode === "BINARY" && inst.operands.operator === "+");
  const storeIndex = instructions.findIndex((inst, index) => index > addIndex && inst.opcode === "STORE_GLOBAL");
  assert.ok(loadIndex >= 0 && addIndex > loadIndex && storeIndex > addIndex);
});

test("lowers UI.SHOW and UI.TEXT into compatible QIR 1.2 effect calls", () => {
  const qir = compile([
    'UI.TEXT("Hello QX")',
    "DATA.CREATE(items, [1, 2])",
    "UI.SHOW(items)",
    "UI.SHOW(NULL)"
  ].join("\n"));
  assert.equal(qir.version, "1.2");
  const calls = qir.initializer.blocks.flatMap(block => block.instructions)
    .filter(inst => inst.opcode === "COMMAND_CALL");
  assert.deepEqual(calls.map(inst => inst.operands.command), ["UI.TEXT", "UI.SHOW", "UI.SHOW"]);
  assert.ok(calls.every(inst => !inst.result && !inst.type));
  assert.deepEqual(validateQIR(parseQIR(serializeQIR(qir))), []);
});

test("QIR 1.2 retains DATA list extension operations", () => {
  const qir = compile([
    "DATA.CREATE(items, [1])",
    "DATA.CREATE(added, DATA.ADD(items, 2))",
    'UI.TEXT("items updated")'
  ].join("\n"));
  assert.equal(qir.version, "1.2");
  assert.deepEqual(validateQIR(qir), []);
});

test("lowers UI.TREE into QIR 1.4 and rejects it in older QIR modules", () => {
  const qir = compile('UI.TREE("{\\"schema\\":\\"QX.UI.TREE\\",\\"version\\":\\"1.0\\",\\"children\\":[]} ")');
  assert.equal(qir.version, "1.4");
  const call = qir.initializer.blocks.flatMap(block => block.instructions)
    .find(inst => inst.opcode === "COMMAND_CALL" && inst.operands.command === "UI.TREE");
  assert.ok(call);
  assert.equal(call.type, undefined);
  const older = { ...qir, version: "1.3" };
  assert.ok(validateQIR(older).some(item => item.code === "QIR_E_COMMAND_SIGNATURE"));
  const combined = compile(source + '\nDATA.CREATE(items, [1])\nDATA.CREATE(rest, DATA.REMOVE(items, 0))\nUI.TEXT("ready")');
  assert.equal(combined.version, "1.4");
  assert.deepEqual(validateQIR(combined), []);
});

test("QIR 1.1 rejects UI output commands", () => {
  const qir = compile('UI.TEXT("hello")');
  const bad = JSON.parse(JSON.stringify(qir));
  bad.version = "1.1";
  assert.ok(validateQIR(bad).some(item => item.code === "QIR_E_COMMAND_SIGNATURE" || item.code === "QIR_E_COMMAND_NOT_ALLOWED"));
});

test("lowers INTEGRATION.REQUEST into QIR 1.3 and round-trips", () => {
  const qir = compile('DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{\\\"id\\\":1}"))');
  assert.equal(qir.version, "1.3");
  const call = qir.initializer.blocks.flatMap(block => block.instructions)
    .find(inst => inst.opcode === "COMMAND_CALL" && inst.operands.command === "INTEGRATION.REQUEST");
  assert.ok(call);
  assert.equal(call.type, "TXT");
  assert.ok(call.result);
  assert.equal(call.operands.arguments.length, 3);
  assert.deepEqual(validateQIR(parseQIR(serializeQIR(qir))), []);
});

test("QIR 1.3 retains DATA and UI extensions while requiring the integration signature", () => {
  const qir = compile([
    "DATA.CREATE(items, [1])",
    "DATA.CREATE(added, DATA.ADD(items, 2))",
    'UI.TEXT("ready")',
    'DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{}"))'
  ].join("\n"));
  assert.equal(qir.version, "1.3");
  assert.deepEqual(validateQIR(qir), []);
  const invalid = JSON.parse(JSON.stringify(qir));
  const call = invalid.initializer.blocks.flatMap(block => block.instructions)
    .find(inst => inst.opcode === "COMMAND_CALL" && inst.operands.command === "INTEGRATION.REQUEST");
  call.type = "NUM";
  assert.ok(validateQIR(invalid).some(item => item.code === "QIR_E_COMMAND_SIGNATURE"));
});
