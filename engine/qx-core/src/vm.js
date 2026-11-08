import { validateQIR } from "./qir.js";
import { normalizeNFC } from "./unicode.js";

const UNINITIALIZED = Symbol("QX_UNINITIALIZED");
const DEFAULT_LIMITS = Object.freeze({
  maxInstructions: 100_000,
  maxCallDepth: 128,
  maxListLength: 10_000,
  maxStringLength: 1_000_000
});

export class QXVMError extends Error {
  constructor(code, message, instruction = null, context = {}) {
    super(message);
    this.name = "QXVMError";
    this.code = code;
    this.location = instruction?.source ?? null;
    this.function = context.function ?? null;
    this.block = context.block ?? null;
    this.instruction = instruction?.id ?? null;
  }
}

function checkedLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(name + " must be a positive safe integer");
  }
  return limits;
}

function compareCodePoints(left, right) {
  const a = Array.from(normalizeNFC(left), char => char.codePointAt(0));
  const b = Array.from(normalizeNFC(right), char => char.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function cloneValue(value) {
  return Array.isArray(value) ? value.map(cloneValue) : value;
}

function createQIRExecution(module, options = {}) {
  const diagnostics = validateQIR(module);
  if (diagnostics.length) {
    const error = new Error(diagnostics[0].message);
    error.name = "QIRValidationError";
    error.diagnostics = diagnostics;
    throw error;
  }

  const limits = checkedLimits(options.limits);
  const functions = new Map([module.initializer, ...module.functions].map(fn => [fn.id, fn]));
  const globalsById = new Map(module.globals.map(item => [item.id, item]));
  const globals = new Map(module.globals.map(item => [item.id, UNINITIALIZED]));
  const state = { instructions: 0 };
  const outputs = [];
  const integrationBroker = options.integrationBroker;
  const usesIntegration = [module.initializer, ...module.functions].some(fn =>
    fn.blocks.some(block => block.instructions.some(inst => inst.opcode === "COMMAND_CALL" && inst.operands?.command === "INTEGRATION.REQUEST")));

  const runtimeError = (code, message, instruction, context) =>
    new QXVMError(code, message, instruction, context);

  function readValue(frame, id, instruction) {
    if (!frame.values.has(id))
      throw runtimeError("QX_VM_UNDEFINED_VALUE", "Runtime value is not available: " + id, instruction, frame.context);
    return frame.values.get(id);
  }

  function readVariable(frame, id, instruction) {
    const value = globalsById.has(id) ? globals.get(id) : frame.variables.get(id);
    if (value === undefined || value === UNINITIALIZED)
      throw runtimeError("QX_VM_UNINITIALIZED_VARIABLE", "Variable is not initialized: " + id, instruction, frame.context);
    return value;
  }

  function writeVariable(frame, id, value, instruction, global) {
    if (global) {
      if (!globalsById.has(id))
        throw runtimeError("QX_VM_UNKNOWN_GLOBAL", "Unknown global variable: " + id, instruction, frame.context);
      globals.set(id, value);
    } else {
      if (!frame.variables.has(id))
        throw runtimeError("QX_VM_UNKNOWN_LOCAL", "Unknown local variable: " + id, instruction, frame.context);
      frame.variables.set(id, value);
    }
  }

  function ensureNumber(value, instruction, frame) {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw runtimeError("QX_VM_INVALID_NUMBER", "Numeric operation requires a finite NUM value", instruction, frame.context);
    return value;
  }

  function ensureString(value, instruction, frame) {
    if (typeof value !== "string")
      throw runtimeError("QX_VM_INVALID_TEXT", "Text operation requires TXT", instruction, frame.context);
    if (value.length > limits.maxStringLength)
      throw runtimeError("QX_VM_STRING_LIMIT", "String length limit exceeded", instruction, frame.context);
    return value;
  }

  function executeBinary(operator, left, right, instruction, frame) {
    switch (operator) {
      case "+":
        if (typeof left === "string" && typeof right === "string") {
          const result = left + right;
          return ensureString(result, instruction, frame);
        }
        return ensureNumber(ensureNumber(left, instruction, frame) + ensureNumber(right, instruction, frame), instruction, frame);
      case "-": return ensureNumber(ensureNumber(left, instruction, frame) - ensureNumber(right, instruction, frame), instruction, frame);
      case "*": return ensureNumber(ensureNumber(left, instruction, frame) * ensureNumber(right, instruction, frame), instruction, frame);
      case "/": {
        const divisor = ensureNumber(right, instruction, frame);
        if (divisor === 0) throw runtimeError("QX_VM_DIVIDE_BY_ZERO", "Division by zero", instruction, frame.context);
        return ensureNumber(ensureNumber(left, instruction, frame) / divisor, instruction, frame);
      }
      case "%": {
        const dividend = ensureNumber(left, instruction, frame);
        const divisor = ensureNumber(right, instruction, frame);
        if (!Number.isInteger(dividend) || !Number.isInteger(divisor))
          throw runtimeError("QX_VM_REMAINDER_INTEGER", "Remainder requires integer NUM operands", instruction, frame.context);
        if (divisor === 0) throw runtimeError("QX_VM_DIVIDE_BY_ZERO", "Remainder by zero", instruction, frame.context);
        return dividend % divisor;
      }
      case "==":
      case "!=": {
        if (Array.isArray(left) || Array.isArray(right))
          throw runtimeError("QX_VM_LIST_EQUALITY_UNSPECIFIED", "LIST equality is not defined by QIR V1 runtime semantics", instruction, frame.context);
        const equal = typeof left === "string" && typeof right === "string"
          ? normalizeNFC(left) === normalizeNFC(right)
          : left === right;
        return operator === "==" ? equal : !equal;
      }
      case ">":
      case ">=":
      case "<":
      case "<=": {
        let comparison;
        if (typeof left === "number" && typeof right === "number") {
          ensureNumber(left, instruction, frame); ensureNumber(right, instruction, frame);
          comparison = left < right ? -1 : left > right ? 1 : 0;
        } else if (typeof left === "string" && typeof right === "string") {
          ensureString(left, instruction, frame); ensureString(right, instruction, frame);
          comparison = compareCodePoints(left, right);
        } else {
          throw runtimeError("QX_VM_INVALID_COMPARISON", "Ordered comparison requires two NUM values or two TXT values", instruction, frame.context);
        }
        if (operator === ">") return comparison > 0;
        if (operator === ">=") return comparison >= 0;
        if (operator === "<") return comparison < 0;
        return comparison <= 0;
      }
      case "AND": return left === true && right === true;
      case "OR": return left === true || right === true;
      default: throw runtimeError("QX_VM_UNKNOWN_OPERATOR", "Unsupported binary operator: " + operator, instruction, frame.context);
    }
  }

  function* executeFunction(fn, args, depth) {
    if (depth > limits.maxCallDepth)
      throw new QXVMError("QX_VM_CALL_DEPTH_LIMIT", "Maximum function call depth exceeded", null, { function: fn.id });

    const blocks = new Map(fn.blocks.map(block => [block.id, block]));
    const variables = new Map();
    const values = new Map();
    const context = { function: fn.id, block: null };
    const parameterDeclarations = fn.blocks.flatMap(block => block.instructions)
      .filter(instruction => instruction.opcode === "DECLARE" && instruction.operands.parameter === true);

    if (parameterDeclarations.length !== fn.parameters.length || args.length !== fn.parameters.length)
      throw new QXVMError("QX_VM_PARAMETER_MISMATCH", "Function parameter layout does not match its arguments", null, context);

    parameterDeclarations.forEach((instruction, index) => variables.set(instruction.operands.variable, args[index]));
    const frame = { variables, values, context };

    let blockId = fn.entry_block;
    while (true) {
      const block = blocks.get(blockId);
      if (!block) throw new QXVMError("QX_VM_INVALID_BLOCK", "Execution reached an unknown basic block: " + blockId, null, context);
      context.block = block.id;
      let transferred = false;

      for (const instruction of block.instructions) {
        state.instructions++;
        if (state.instructions > limits.maxInstructions)
          throw runtimeError("QX_VM_INSTRUCTION_LIMIT", "Maximum instruction count exceeded", instruction, context);

        const op = instruction.operands ?? {};
        switch (instruction.opcode) {
          case "CONST_NUM": values.set(instruction.result, ensureNumber(op.value, instruction, frame)); break;
          case "CONST_TXT": values.set(instruction.result, ensureString(op.value, instruction, frame)); break;
          case "CONST_BOOL": values.set(instruction.result, op.value); break;
          case "CONST_NULL": values.set(instruction.result, null); break;
          case "DECLARE":
            if (op.storage === "global") {
              if (!globalsById.has(op.variable))
                throw runtimeError("QX_VM_UNKNOWN_GLOBAL", "Unknown global declaration: " + op.variable, instruction, context);
              globals.set(op.variable, UNINITIALIZED);
            } else if (op.parameter !== true) {
              variables.set(op.variable, UNINITIALIZED);
            }
            break;
          case "LOAD": values.set(instruction.result, readVariable(frame, op.variable, instruction)); break;
          case "STORE_LOCAL": writeVariable(frame, op.variable, readValue(frame, op.value, instruction), instruction, false); break;
          case "STORE_GLOBAL": writeVariable(frame, op.variable, readValue(frame, op.value, instruction), instruction, true); break;
          case "UNARY": {
            const value = readValue(frame, op.value, instruction);
            let result;
            if (op.operator === "NOT") result = !value;
            else if (op.operator === "+") result = ensureNumber(value, instruction, frame);
            else if (op.operator === "-") result = -ensureNumber(value, instruction, frame);
            else throw runtimeError("QX_VM_UNKNOWN_OPERATOR", "Unsupported unary operator: " + op.operator, instruction, context);
            values.set(instruction.result, result);
            break;
          }
          case "BINARY":
            values.set(instruction.result, executeBinary(op.operator, readValue(frame, op.left, instruction), readValue(frame, op.right, instruction), instruction, frame));
            break;
          case "MAKE_LIST": {
            if (op.elements.length > limits.maxListLength)
              throw runtimeError("QX_VM_LIST_LIMIT", "Maximum list length exceeded", instruction, context);
            values.set(instruction.result, op.elements.map(id => cloneValue(readValue(frame, id, instruction))));
            break;
          }
          case "CALL": {
            const target = functions.get(op.function);
            if (!target) throw runtimeError("QX_VM_UNKNOWN_FUNCTION", "Unknown function: " + op.function, instruction, context);
            const callArgs = op.arguments.map(id => cloneValue(readValue(frame, id, instruction)));
            const result = yield* executeFunction(target, callArgs, depth + 1);
            if (instruction.result) values.set(instruction.result, result);
            break;
          }
          case "COMMAND_CALL": {
            const args = op.arguments ?? [];
            if (op.command === "DATA.COUNT" && args.length === 1) {
              const list = readValue(frame, args[0], instruction);
              if (!Array.isArray(list)) throw runtimeError("QX_VM_COMMAND_ARGUMENT", "DATA.COUNT requires LIST", instruction, context);
              if (instruction.result) values.set(instruction.result, list.length);
              break;
            }
            if (op.command === "DATA.ADD" && args.length === 2) {
              const list = readValue(frame, args[0], instruction), value = readValue(frame, args[1], instruction);
              if (!Array.isArray(list)) throw runtimeError("QX_VM_COMMAND_ARGUMENT", "DATA.ADD requires LIST as its first argument", instruction, context);
              if (list.length >= limits.maxListLength) throw runtimeError("QX_VM_LIST_LIMIT", "Maximum list length exceeded", instruction, context);
              values.set(instruction.result, [...list.map(cloneValue), cloneValue(value)]);
              break;
            }
            if (op.command === "DATA.REMOVE" && args.length === 2) {
              const list = readValue(frame, args[0], instruction), index = readValue(frame, args[1], instruction);
              if (!Array.isArray(list)) throw runtimeError("QX_VM_COMMAND_ARGUMENT", "DATA.REMOVE requires LIST as its first argument", instruction, context);
              if (!Number.isSafeInteger(index) || index < 0 || index >= list.length)
                throw runtimeError("QX_VM_LIST_INDEX", "DATA.REMOVE index must be a valid zero-based integer within the list", instruction, context);
              values.set(instruction.result, list.filter((_, itemIndex) => itemIndex !== index).map(cloneValue));
              break;
            }
            if (op.command === "INTEGRATION.REQUEST" && args.length === 3 && module.version === "1.3") {
              if (typeof integrationBroker?.request !== "function")
                throw runtimeError("QX_VM_INTEGRATION_UNAVAILABLE", "No trusted integration broker was supplied", instruction, context);
              const connector = ensureString(readValue(frame, args[0], instruction), instruction, frame);
              const operation = ensureString(readValue(frame, args[1], instruction), instruction, frame);
              const payloadJson = ensureString(readValue(frame, args[2], instruction), instruction, frame);
              let response;
              try {
                response = yield Promise.resolve(integrationBroker.request(connector, operation, payloadJson));
              } catch (error) {
                if (error?.code === "QX_INTEGRATION_INVALID_RESPONSE")
                  throw runtimeError("QX_VM_INTEGRATION_RESPONSE", "Integration broker returned an invalid response", instruction, context);
                throw runtimeError("QX_VM_INTEGRATION_FAILED", "Integration request failed", instruction, context);
              }
              if (typeof response !== "string")
                throw runtimeError("QX_VM_INTEGRATION_RESPONSE", "Integration broker returned an invalid response", instruction, context);
              ensureString(response, instruction, frame);
              try { JSON.parse(response); }
              catch { throw runtimeError("QX_VM_INTEGRATION_RESPONSE", "Integration broker returned invalid JSON", instruction, context); }
              values.set(instruction.result, response);
              break;
            }
            if (op.command === "UI.SHOW" && args.length === 1 && ["1.2", "1.3"].includes(module.version)) {
              outputs.push(Object.freeze({ component: "SHOW", value: cloneValue(readValue(frame, args[0], instruction)), source: instruction.source }));
              break;
            }
            if (op.command === "UI.TEXT" && args.length === 1 && ["1.2", "1.3"].includes(module.version)) {
              const value = readValue(frame, args[0], instruction);
              if (typeof value !== "string") throw runtimeError("QX_VM_INVALID_TEXT", "UI.TEXT requires TXT", instruction, context);
              ensureString(value, instruction, frame);
              outputs.push(Object.freeze({ component: "TEXT", value, source: instruction.source }));
              break;
            }
            throw runtimeError("QX_VM_COMMAND_NOT_ALLOWED", "Command is not available in this QIR version", instruction, context);
          }
          case "BRANCH": {
            const condition = readValue(frame, op.condition, instruction);
            if (typeof condition !== "boolean")
              throw runtimeError("QX_VM_BRANCH_TYPE", "BRANCH condition must be BOOL", instruction, context);
            blockId = condition ? op.true_target : op.false_target;
            transferred = true;
            break;
          }
          case "JUMP": blockId = op.target; transferred = true; break;
          case "RETURN":
            return Object.hasOwn(op, "value") ? cloneValue(readValue(frame, op.value, instruction)) : null;
          default:
            throw runtimeError("QX_VM_UNKNOWN_OPCODE", "Unsupported QIR opcode: " + instruction.opcode, instruction, context);
        }
        if (transferred) break;
      }
      if (!transferred)
        throw new QXVMError("QX_VM_MISSING_TERMINATOR", "Basic block ended without a control-flow transfer", null, context);
    }
  }

  function resultSnapshot() {
    const resultGlobals = {};
    for (const global of module.globals) {
      const value = globals.get(global.id);
      if (value !== UNINITIALIZED) resultGlobals[global.name] = cloneValue(value);
    }
    return Object.freeze({
      globals: Object.freeze(resultGlobals),
      outputs: Object.freeze(outputs.map(item => Object.freeze({ ...item }))),
      instructionCount: state.instructions
    });
  }

  function runSync() {
    if (usesIntegration)
      throw new QXVMError("QX_VM_ASYNC_REQUIRED", "QIR module uses INTEGRATION.REQUEST; call runQIRAsync", null, { function: module.initializer.id });
    const generator = executeFunction(module.initializer, [], 1);
    let step = generator.next();
    while (!step.done) {
      if (step.value && typeof step.value.then === "function")
        throw new QXVMError("QX_VM_ASYNC_REQUIRED", "QIR module requires asynchronous execution", null, { function: module.initializer.id });
      step = generator.next(step.value);
    }
    return resultSnapshot();
  }

  async function runAsync() {
    if (usesIntegration && typeof integrationBroker?.request !== "function")
      throw new QXVMError("QX_VM_INTEGRATION_UNAVAILABLE", "No trusted integration broker was supplied", null, { function: module.initializer.id });
    const generator = executeFunction(module.initializer, [], 1);
    let step = generator.next();
    while (!step.done) {
      try { step = generator.next(await step.value); }
      catch (error) { step = generator.throw(error); }
    }
    return resultSnapshot();
  }

  return Object.freeze({ runSync, runAsync });
}

export function runQIR(module, options = {}) {
  return createQIRExecution(module, options).runSync();
}

export async function runQIRAsync(module, options = {}) {
  return createQIRExecution(module, options).runAsync();
}
