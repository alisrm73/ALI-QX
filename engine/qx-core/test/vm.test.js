import test from "node:test";
import assert from "node:assert/strict";
import { analyze, lowerToQIR, parse, runQIR, QXVMError } from "../src/index.js";

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
