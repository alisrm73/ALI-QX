import test from "node:test";
import assert from "node:assert/strict";
import { analyze, lowerToQIR, parse, runQIR, runQIRAsync, createIntegrationBroker, QXVMError, createDefaultUILock } from "../src/index.js";

function compile(source) {
  const ast = parse(source);
  const semantic = analyze(ast);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.diagnostics));
  return lowerToQIR(ast, semantic);
}

test("executes arithmetic, globals, function parameters, and returns", () => {
  const module = compile([
    "FUNCTION add(a, b)",
    "RETURN a + b",
    "END",
    "DATA.CREATE(total, add(4, 5))",
    "PROCESS.CALCULATE(total, total * 2)"
  ].join("\n"));
  assert.equal(runQIR(module).globals.total, 18);
});

test("uses DATA.SET_GLOBAL after local PROCESS calculations to update module state", () => {
  const module = compile([
    "DATA.CREATE(total, 1)",
    "FUNCTION update(amount)",
    "DATA.CREATE(nextTotal, total + amount)",
    "PROCESS.ADD(nextTotal, 1)",
    "PROCESS.CALCULATE(nextTotal, nextTotal * 2)",
    "DATA.SET_GLOBAL(total, nextTotal)",
    "END",
    "update(3)"
  ].join("\n"));
  assert.equal(runQIR(module).globals.total, 10);
});

test("executes branches, loops, and short-circuit logic", () => {
  const module = compile([
    "DATA.CREATE(counter, 0)",
    "WHILE(counter < 3)",
    "PROCESS.CALCULATE(counter, counter + 1)",
    "END",
    "DATA.CREATE(flag, FALSE AND (1 / 0 > 0))",
    "DATA.CREATE(done, FALSE)",
    "IF(counter == 3)",
    "DATA.SET(done, TRUE)",
    "ELSE",
    "DATA.SET(done, FALSE)",
    "END"
  ].join("\n"));
  const result = runQIR(module).globals;
  assert.equal(result.counter, 3);
  assert.equal(result.flag, false);
  assert.equal(result.done, true);
});

test("executes list construction and DATA.COUNT", () => {
  const result = runQIR(compile('DATA.CREATE(items, ["A", 2, TRUE])\nDATA.CREATE(size, DATA.COUNT(items))')).globals;
  assert.deepEqual(result.items, ["A", 2, true]);
  assert.equal(result.size, 3);
});

test("enforces the instruction budget", () => {
  assert.throws(() => runQIR(compile("DATA.CREATE(value, 1)"), { limits: { maxInstructions: 1 } }),
    error => error instanceof QXVMError && error.code === "QX_VM_INSTRUCTION_LIMIT");
});

test("enforces recursive call depth", () => {
  const module = compile("FUNCTION again()\nagain()\nEND\nagain()");
  assert.throws(() => runQIR(module, { limits: { maxCallDepth: 4 } }),
    error => error instanceof QXVMError && error.code === "QX_VM_CALL_DEPTH_LIMIT");
});

test("reports division by zero", () => {
  assert.throws(() => runQIR(compile("DATA.CREATE(value, 4 / 0)")),
    error => error instanceof QXVMError && error.code === "QX_VM_DIVIDE_BY_ZERO");
});

test("does not invent LIST equality semantics", () => {
  const module = compile("DATA.CREATE(left, [1])\nDATA.CREATE(right, [1])\nDATA.CREATE(equal, left == right)");
  assert.throws(() => runQIR(module),
    error => error instanceof QXVMError && error.code === "QX_VM_LIST_EQUALITY_UNSPECIFIED");
});

test("orders TXT by Unicode code point", () => {
  assert.equal(runQIR(compile('DATA.CREATE(result, "𐀀" > "")')).globals.result, true);
});

test("rejects malformed QIR before executing it", () => {
  const module = compile("DATA.CREATE(value, 1)");
  module.initializer.blocks[0].instructions[0].opcode = "HOST_ACCESS";
  assert.throws(() => runQIR(module), error => error.name === "QIRValidationError");
});

test("implements integer remainder and rejects fractional operands", () => {
  const integerModule = compile("DATA.CREATE(value, 5 + 2)");
  const integerBinary = integerModule.initializer.blocks.flatMap(block => block.instructions).find(item => item.opcode === "BINARY");
  integerBinary.operands.operator = "%";
  assert.equal(runQIR(integerModule).globals.value, 1);

  const fractionalModule = compile("DATA.CREATE(value, 5.5 + 2)");
  const fractionalBinary = fractionalModule.initializer.blocks.flatMap(block => block.instructions).find(item => item.opcode === "BINARY");
  fractionalBinary.operands.operator = "%";
  assert.throws(() => runQIR(fractionalModule),
    error => error instanceof QXVMError && error.code === "QX_VM_REMAINDER_INTEGER");
});

test("normalizes text to Unicode NFC before equality and ordering", () => {
  const equal = compile('DATA.CREATE(result, "é" == "é")');
  assert.equal(runQIR(equal).globals.result, true);
  const ordered = compile('DATA.CREATE(result, "é" == "é")');
  const binary = ordered.initializer.blocks.flatMap(block => block.instructions).find(item => item.opcode === "BINARY");
  binary.operands.operator = ">";
  assert.equal(runQIR(ordered).globals.result, false);
});

test("executes function-local declarations and DATA.SET", () => {
  const module = compile([
    "FUNCTION increment(value)",
    "DATA.CREATE(localValue, value + 1)",
    "DATA.SET(localValue, localValue + 1)",
    "RETURN localValue",
    "END",
    "DATA.CREATE(result, increment(2))"
  ].join("\n"));
  assert.equal(runQIR(module).globals.result, 4);
});

test("executes PROCESS.COMPARE into an existing BOOL target", () => {
  const module = compile([
    "DATA.CREATE(isGreater, FALSE)",
    "PROCESS.COMPARE(isGreater, 9 > 4)"
  ].join("\n"));
  assert.equal(runQIR(module).globals.isGreater, true);
});

test("enforces list and string allocation limits", () => {
  const listModule = compile("DATA.CREATE(items, [1, 2])");
  assert.throws(() => runQIR(listModule, { limits: { maxListLength: 1 } }),
    error => error instanceof QXVMError && error.code === "QX_VM_LIST_LIMIT");

  const textModule = compile('DATA.CREATE(value, "abc")');
  assert.throws(() => runQIR(textModule, { limits: { maxStringLength: 2 } }),
    error => error instanceof QXVMError && error.code === "QX_VM_STRING_LIMIT");
});


test("executes DATA.ADD and DATA.REMOVE without mutating source lists", () => {
  const result = runQIR(compile([
    "DATA.CREATE(items, [1, [2, 3], 4])",
    "DATA.CREATE(added, DATA.ADD(items, 5))",
    "DATA.CREATE(removed, DATA.REMOVE(added, 1))"
  ].join("\n"))).globals;
  assert.deepEqual(result.items, [1, [2, 3], 4]);
  assert.deepEqual(result.added, [1, [2, 3], 4, 5]);
  assert.deepEqual(result.removed, [1, 4, 5]);
  assert.notEqual(result.items, result.added);
  assert.notEqual(result.items[1], result.added[1]);
});

test("DATA.ADD and DATA.REMOVE enforce list limits and valid zero-based indices", () => {
  const add = compile("DATA.CREATE(items, [1])\nDATA.CREATE(updated, DATA.ADD(items, 2))");
  assert.throws(() => runQIR(add, { limits: { maxListLength: 1 } }),
    error => error instanceof QXVMError && error.code === "QX_VM_LIST_LIMIT");

  for (const index of [-1, 1.5, 2]) {
    const remove = compile("DATA.CREATE(items, [1, 2])\nDATA.CREATE(updated, DATA.REMOVE(items, " + index + "))");
    assert.throws(() => runQIR(remove),
      error => error instanceof QXVMError && error.code === "QX_VM_LIST_INDEX");
  }
});

test("executes PROCESS.ADD in module and local function scopes", () => {
  const module = compile([
    "DATA.CREATE(count, 1)",
    "PROCESS.ADD(count, 2)",
    "FUNCTION increment(value)",
    "PROCESS.ADD(value, 3)",
    "RETURN value",
    "END",
    "DATA.CREATE(result, increment(4))"
  ].join("\n"));
  const globals = runQIR(module).globals;
  assert.equal(globals.count, 3);
  assert.equal(globals.result, 7);
});

test("executes UI.TREE with an exact project lock and rejects missing or invalid locks", () => {
  const source = 'UI.TREE("{\\"schema\\":\\"QX.UI.TREE\\",\\"version\\":\\"1.0\\",\\"children\\":[{\\"kind\\":\\"component\\",\\"id\\":\\"title\\",\\"type\\":\\"UI.HEADING\\",\\"version\\":\\"1.0.0\\",\\"props\\":{\\"level\\":1},\\"children\\":[{\\"kind\\":\\"text\\",\\"value\\":\\"Hello\\"}]}]}")';
  const qir = compile(source + '\nDATA.CREATE(items, [1])\nDATA.CREATE(rest, DATA.REMOVE(items, 0))\nUI.TEXT("ready")');
  assert.equal(qir.version, "1.4");
  assert.throws(() => runQIR(qir), { code: "QX_VM_UI_LOCK_REQUIRED" });
  const result = runQIR(qir, { uiLock: createDefaultUILock() });
  assert.deepEqual(result.outputs.map(item => item.component), ["TREE", "TEXT"]);
  assert.equal(result.outputs[0].tree.children[0].type, "UI.HEADING");
  assert.equal(result.outputs[1].value, "ready");
  assert.deepEqual(result.globals.rest, []);
  const badLock = { ...createDefaultUILock(), components: [] };
  assert.throws(() => runQIR(qir, { uiLock: badLock }), { code: "QX_UI_LOCK_MISSING" });
});

test("executes UI.TEXT and UI.SHOW as ordered output effects", () => {
  const result = runQIR(compile([
    'UI.TEXT("Hello from QX")',
    "DATA.CREATE(items, [1, [2, 3], TRUE])",
    "UI.SHOW(items)",
    "UI.SHOW(NULL)"
  ].join("\n")));
  assert.deepEqual(result.outputs.map(item => item.component), ["TEXT", "SHOW", "SHOW"]);
  assert.equal(result.outputs[0].value, "Hello from QX");
  assert.deepEqual(result.outputs[1].value, [1, [2, 3], true]);
  assert.equal(result.outputs[2].value, null);
  assert.equal(result.globals.items.length, 3);
});

test("collects UI output from called functions in execution order", () => {
  const result = runQIR(compile([
    "FUNCTION greet(name)",
    'UI.TEXT("Hello")',
    "UI.SHOW(name)",
    "END",
    'greet("QX")',
    'UI.TEXT("Done")'
  ].join("\n")));
  assert.deepEqual(result.outputs.map(item => item.component), ["TEXT", "SHOW", "TEXT"]);
  assert.deepEqual(result.outputs.map(item => item.value), ["Hello", "QX", "Done"]);
});

function demoIntegrationBroker(invoke = async ({ payload }) => JSON.stringify({ received: payload })) {
  return createIntegrationBroker({
    connectors: {
      demo: {
        id: "demo",
        version: "1.0.0",
        operations: { lookup: { permissions: ["demo:read"], invoke } }
      }
    },
    grants: [{ connector: "demo", operation: "lookup", permissions: ["demo:read"] }]
  });
}

test("executes INTEGRATION.REQUEST asynchronously through a trusted broker, including nested functions", async () => {
  const module = compile([
    "FUNCTION lookup(payload)",
    'RETURN INTEGRATION.REQUEST("demo", "lookup", payload)',
    "END",
    'DATA.CREATE(response, lookup("{\\\"id\\\":7}"))'
  ].join("\n"));
  assert.equal(module.version, "1.3");
  const result = await runQIRAsync(module, { integrationBroker: demoIntegrationBroker() });
  assert.equal(result.globals.response, '{"received":{"id":7}}');
});

test("requires asynchronous VM execution and a broker before running integration modules", async () => {
  const module = compile('DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{}"))');
  let calls = 0;
  const integrationBroker = demoIntegrationBroker(async () => { calls++; return '{"ok":true}'; });
  assert.throws(() => runQIR(module, { integrationBroker }),
    error => error instanceof QXVMError && error.code === "QX_VM_ASYNC_REQUIRED");
  assert.equal(calls, 0);
  await assert.rejects(runQIRAsync(module),
    error => error instanceof QXVMError && error.code === "QX_VM_INTEGRATION_UNAVAILABLE");
});

test("sanitizes integration adapter failures at the VM boundary", async () => {
  const module = compile('DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{}"))');
  const integrationBroker = demoIntegrationBroker(async () => { throw new Error("private-adapter-secret"); });
  await assert.rejects(runQIRAsync(module, { integrationBroker }), error =>
    error instanceof QXVMError && error.code === "QX_VM_INTEGRATION_FAILED" &&
    !error.message.includes("private-adapter-secret"));
});

test("rejects non-JSON integration broker responses", async () => {
  const module = compile('DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{}"))');
  const integrationBroker = demoIntegrationBroker(async () => "<html>not json</html>");
  await assert.rejects(runQIRAsync(module, { integrationBroker }),
    error => error instanceof QXVMError && error.code === "QX_VM_INTEGRATION_RESPONSE");
});


test("executes Group 2 DATA, STORE, FETCH, and COLLECTION bindings", () => {
  const result = runQIR(compile([
    "◉(total, 1)",
    "◍(total, ◌(total) + 4)",
    "⊛(items)",
    "◍(items, [1, \"two\", TRUE])",
    "◉(count, DATA.COUNT(◌(items)))",
    "◉(copy, ◌(total))"
  ].join("\n"))).globals;
  assert.equal(result.total, 5);
  assert.deepEqual(result.items, [1, "two", true]);
  assert.equal(result.count, 3);
  assert.equal(result.copy, 5);
});

test("executes Group 2 local bindings and FETCH inside functions", () => {
  const result = runQIR(compile([
    "FUNCTION calculate(seed)",
    "◉(localValue, seed)",
    "◍(localValue, ◌(localValue) * 2)",
    "RETURN ◌(localValue)",
    "END",
    "◉(result, calculate(6))"
  ].join("\n"))).globals;
  assert.equal(result.result, 12);
});

test("executes VALUE declarations while preserving immutable metadata", () => {
  const module = compile("⊙(fixed, 7)");
  assert.equal(module.version, "1.5");
  assert.equal(module.globals[0].mutable, false);
  assert.equal(runQIR(module).globals.fixed, 7);
});

test("executes local VALUE bindings in QIR 1.5 functions", () => {
  const module = compile([
    "FUNCTION readFixed()",
    "⊙(localFixed, 11)",
    "RETURN localFixed",
    "END",
    "DATA.CREATE(result, readFixed())"
  ].join("\n"));
  assert.equal(runQIR(module).globals.result, 11);
});

test("rejects QIR 1.5 immutable global initialization without DECLARE", () => {
  const module = compile("⊙(fixed, 7)");
  const instructions = module.initializer.blocks[0].instructions;
  const declarationIndex = instructions.findIndex(item => item.opcode === "DECLARE" && item.operands.mutable === false);
  instructions.splice(declarationIndex, 1);
  assert.throws(() => runQIR(module), error =>
    error.name === "QIRValidationError" &&
    error.diagnostics.some(item => item.code === "QIR_E_IMMUTABLE_DECLARE"));
});

test("executes inherited QIR 1.1 and 1.2 commands in a QIR 1.5 module", () => {
  const module = compile([
    "⊙(fixed, 7)",
    "DATA.CREATE(items, [1])",
    "DATA.CREATE(added, DATA.ADD(items, 2))",
    'UI.TEXT("ready")'
  ].join("\n"));
  assert.equal(module.version, "1.5");
  const result = runQIR(module);
  assert.equal(result.globals.fixed, 7);
  assert.deepEqual(result.globals.added, [1, 2]);
  assert.deepEqual(result.outputs.map(item => [item.component, item.value]), [["TEXT", "ready"]]);
});

test("VM entrypoint rejects duplicate immutable DECLARE before execution", () => {
  const module = compile("⊙(fixed, 7)");
  const [declaration, constant, store, ret] = module.initializer.blocks[0].instructions;
  module.initializer.blocks[0].instructions = [
    declaration,
    { ...declaration, id: "inst_redeclare_immutable" },
    constant,
    store,
    ret
  ];
  assert.throws(() => runQIR(module), error =>
    error.name === "QIRValidationError" &&
    error.diagnostics.some(item => item.code === "QIR_E_IMMUTABLE_DECLARE"));
});
