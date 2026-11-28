import { resolveCommand } from "./command-registry.js";

function opTree(input) {
  const valueRefs = []; let nodes = 0, valid = true;
  const exact = (object, keys) => object && Object.getPrototypeOf(object) === Object.prototype && Object.keys(object).sort().join(",") === keys.slice().sort().join(",");
  const visit = (node, depth) => {
    if (++nodes > 1000 || depth > 32 || !node || typeof node !== "object") { valid = false; return; }
    if (node.kind === "text") {
      if (!exact(node, ["kind", "valueRef"]) || typeof node.valueRef !== "string" || !/^v_[0-9]+$/.test(node.valueRef)) valid = false;
      else valueRefs.push(node.valueRef);
      return;
    }
    if (!exact(node, ["kind", "id", "type", "version", "props", "children"]) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(node.id ?? "") ||
        !["UI.CONTAINER", "UI.TEXT_BLOCK"].includes(node.type) ||
        node.version !== "1.0.0" || !exact(node.props, []) || !Array.isArray(node.children) || ids.has(node.id)) { valid = false; return; }
    ids.add(node.id);
    if (node.type === "UI.TEXT_BLOCK" && (node.children.length !== 1 || node.children.some(child => child?.kind !== "text"))) valid = false;
    if (node.type === "UI.CONTAINER" && node.children.some(child => child?.kind !== "component")) valid = false;
    for (const child of node.children) visit(child, depth + 1);
  };
  if (!exact(input, ["schema", "version", "children"]) || input.schema !== "QX.UI.TREE" || input.version !== "1.0" || !Array.isArray(input.children)) valid = false;
  else for (const child of input.children) { if (child?.kind !== "component") valid = false; visit(child, 1); }
  return { valid, valueRefs };
}
const VALUE_TYPES = new Set(["NUM", "TXT", "BOOL", "LIST", "NULL", "RECORD"]);
const validType = (type, version) => VALUE_TYPES.has(type) && (type !== "RECORD" || ["1.6", "1.7"].includes(version));
const locationOf = node => {
  const value = node?.location ?? { line: 1, column: 1, offset: 0 };
  return { line: value.line, column: value.column, offset: value.offset };
};
const fail = (code, message, node = null) => {
  const error = new Error(message);
  error.name = "QIRDiagnostic";
  error.code = code;
  error.location = locationOf(node);
  throw error;
};

function inferExpression(node, variables, functions) {
  if (!node) return "NULL";
  switch (node.type) {
    case "NumberLiteral": return "NUM";
    case "StringLiteral": return "TXT";
    case "BooleanLiteral": return "BOOL";
    case "NullLiteral": return "NULL";
    case "Identifier": {
      const found = variables.get(node.name);
      if (!found) fail("QIR_E_UNKNOWN_VARIABLE", "Unknown variable " + node.name, node);
      return found.type;
    }
    case "GroupExpression": return inferExpression(node.expression, variables, functions);
    case "ListLiteral": node.elements.forEach(item => inferExpression(item, variables, functions)); return "LIST";
    case "RecordLiteral": node.fields.forEach(field => inferExpression(field.value, variables, functions)); return "RECORD";
    case "UnaryExpression": return node.operator === "NOT" ? "BOOL" : "NUM";
    case "BinaryExpression":
      if (["AND", "OR", "==", "!=", ">", ">=", "<", "<="].includes(node.operator)) return "BOOL";
      if (node.operator === "+" && inferExpression(node.left, variables, functions) === "TXT") return "TXT";
      return "NUM";
    case "CallExpression": {
      const name = node.callee?.name;
      const fn = functions.get(name);
      if (!fn) fail("QIR_E_UNKNOWN_FUNCTION", "Unknown function " + name, node);
      return fn.returnType;
    }
    case "CommandCallExpression": {
      const cmd = resolveCommand(node.domain, node.command);
      if (cmd?.id === "DATA.COUNT") return "NUM";
      if (cmd?.id === "DATA.ADD" || cmd?.id === "DATA.REMOVE") return "LIST";
      if (cmd?.id === "INTEGRATION.REQUEST") return "TXT";
      fail("QIR_E_COMMAND_NOT_ALLOWED", "Command has no approved QIR expression contract", node);
    }
    case "GeometricCallExpression": {
      if (node.group === "DATA_STORAGE" && node.symbol === "FETCH" && node.args?.length === 1 && node.args[0]?.type === "Identifier") {
        const found = variables.get(node.args[0].name);
        if (!found) fail("QIR_E_UNKNOWN_VARIABLE", "Unknown variable " + node.args[0].name, node.args[0]);
        return found.type;
      }
      fail("QIR_E_UNSUPPORTED_GEOMETRIC_EXPRESSION", "Geometric expression has no approved QIR lowering", node);
    }
    default: fail("QIR_E_UNSUPPORTED_AST", "Unsupported expression " + node.type, node);
  }
}

class FunctionBuilder {
  constructor(owner, descriptor) {
    this.owner = owner;
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.variables = new Map();
    this.blocks = [];
    this.blockCounter = 0;
    this.instructionCounter = 0;
    this.valueCounter = 0;
    this.variableCounter = 0;
    this.current = this.newBlock();
    this.entry = this.current.id;
    this.tempCounter = 0;
    for (const param of descriptor.parameters) {
      const variable = this.addVariable(param.name, param.type, "local", true);
      this.emit("DECLARE", { variable: variable.id, name: param.name, storage: "local", declared_type: param.type, parameter: true, ...(owner.usesImmutable ? { mutable: true } : {}) }, null, null, param.node);
    }
  }
  newBlock() {
    const block = { id: "bb_" + this.blockCounter++, instructions: [] };
    this.blocks.push(block);
    return block;
  }
  emit(opcode, operands = {}, type = null, result = null, node = null) {
    const instruction = {
      id: "inst_" + this.instructionCounter++,
      opcode,
      ...(result ? { result, type } : {}),
      operands,
      source: locationOf(node)
    };
    this.current.instructions.push(instruction);
    return result;
  }
  value() { return "v_" + this.valueCounter++; }
  terminate(opcode, operands, node) {
    if (!this.current) fail("QIR_E_NO_CURRENT_BLOCK", "No active basic block", node);
    if (this.current.instructions.length && ["BRANCH", "JUMP", "RETURN"].includes(this.current.instructions.at(-1).opcode))
      fail("QIR_E_DOUBLE_TERMINATOR", "Basic block already terminated", node);
    this.emit(opcode, operands, null, null, node);
    this.current = null;
  }
  switchTo(block) { this.current = block; }
  addVariable(name, type, storage = "local", parameter = false, mutable = true) {
    const id = storage === "global" ? this.owner.globalsByName.get(name)?.id : "var_" + this.id + "_" + this.variableCounter++;
    if (!id) fail("QIR_E_UNKNOWN_VARIABLE", "Missing global declaration " + name);
    const value = { id, name, type, storage, parameter, mutable };
    this.variables.set(name, value);
    return value;
  }
  ensureActive(node) {
    if (!this.current) {
      this.current = this.newBlock();
      this.terminate("JUMP", { target: this.current.id }, node);
    }
  }
  lowerExpression(node) {
    switch (node.type) {
      case "NumberLiteral": {
        const result = this.value(); this.emit("CONST_NUM", { value: node.value }, "NUM", result, node); return { value: result, type: "NUM" };
      }
      case "StringLiteral": {
        const result = this.value(); this.emit("CONST_TXT", { value: node.value }, "TXT", result, node); return { value: result, type: "TXT" };
      }
      case "BooleanLiteral": {
        const result = this.value(); this.emit("CONST_BOOL", { value: node.value }, "BOOL", result, node); return { value: result, type: "BOOL" };
      }
      case "NullLiteral": {
        const result = this.value(); this.emit("CONST_NULL", {}, "NULL", result, node); return { value: result, type: "NULL" };
      }
      case "Identifier": {
        const variable = this.variables.get(node.name) ?? this.owner.globalVariable(node.name, this);
        if (!variable) fail("QIR_E_UNKNOWN_VARIABLE", "Unknown variable " + node.name, node);
        const result = this.value(); this.emit("LOAD", { variable: variable.id }, variable.type, result, node); return { value: result, type: variable.type };
      }
      case "GroupExpression": return this.lowerExpression(node.expression);
      case "ListLiteral": {
        const elements = node.elements.map(item => this.lowerExpression(item).value);
        const result = this.value(); this.emit("MAKE_LIST", { elements }, "LIST", result, node); return { value: result, type: "LIST" };
      }
      case "RecordLiteral": {
        const fields = node.fields.map(field => ({ name: field.name, value: this.lowerExpression(field.value).value }));
        const result = this.value(); this.emit("MAKE_RECORD", { fields }, "RECORD", result, node); return { value: result, type: "RECORD" };
      }
      case "UnaryExpression": {
        const arg = this.lowerExpression(node.argument);
        const result = this.value(); this.emit("UNARY", { operator: node.operator, value: arg.value }, node.operator === "NOT" ? "BOOL" : "NUM", result, node);
        return { value: result, type: node.operator === "NOT" ? "BOOL" : "NUM" };
      }
      case "BinaryExpression": return ["AND", "OR"].includes(node.operator) ? this.lowerShortCircuit(node) : this.lowerBinary(node);
      case "CallExpression": {
        const fn = this.owner.functionsByName.get(node.callee.name);
        if (!fn) fail("QIR_E_UNKNOWN_FUNCTION", "Unknown function " + node.callee.name, node);
        const args = node.args.map(arg => this.lowerExpression(arg).value);
        if (fn.returnType === "NULL") {
          this.emit("CALL", { function: fn.id, arguments: args }, null, null, node);
          return { value: null, type: "NULL" };
        }
        const result = this.value(); this.emit("CALL", { function: fn.id, arguments: args }, fn.returnType, result, node);
        return { value: result, type: fn.returnType };
      }
      case "GeometricCallExpression": {
        if (node.group !== "DATA_STORAGE" || node.symbol !== "FETCH" || node.args?.length !== 1 || node.args[0]?.type !== "Identifier")
          fail("QIR_E_UNSUPPORTED_GEOMETRIC_EXPRESSION", "Geometric expression has no approved QIR lowering", node);
        const variable = this.variables.get(node.args[0].name) ?? this.owner.globalVariable(node.args[0].name, this);
        if (!variable) fail("QIR_E_UNKNOWN_VARIABLE", "Unknown variable " + node.args[0].name, node.args[0]);
        const result = this.value();
        this.emit("LOAD", { variable: variable.id }, variable.type, result, node);
        return { value: result, type: variable.type };
      }
      case "CommandCallExpression": {
        const cmd = resolveCommand(node.domain, node.command);
        if (!cmd || !["DATA.COUNT", "DATA.ADD", "DATA.REMOVE", "INTEGRATION.REQUEST"].includes(cmd.id)) fail("QIR_E_COMMAND_NOT_ALLOWED", "Command has no approved QIR expression contract", node);
        const signature = cmd.signature;
        if (!signature || node.args.length !== signature.parameters.length) {
          fail("QIR_E_BAD_COMMAND_ARGUMENTS", cmd.id + " does not match its registered parameter count", node);
        }
        const args = node.args.map(arg => this.lowerExpression(arg));
        for (let index = 0; index < signature.parameters.length; index++) {
          const parameter = signature.parameters[index];
          const acceptedTypes = parameter.types ?? (parameter.type ? [parameter.type] : null);
          if (acceptedTypes && !acceptedTypes.includes(args[index].type)) {
            fail("QIR_E_COMMAND_ARGUMENT", cmd.id + " argument " + (index + 1) + " does not match its registered type", node.args[index]);
          }
        }
        const resultType = signature.result.type;
        const result = this.value();
        this.emit("COMMAND_CALL", { command: cmd.id, arguments: args.map(arg => arg.value) }, resultType, result, node);
        return { value: result, type: resultType };
      }
      default: fail("QIR_E_UNSUPPORTED_AST", "Unsupported expression " + node.type, node);
    }
  }
  lowerBinary(node) {
    const left = this.lowerExpression(node.left), right = this.lowerExpression(node.right);
    const result = this.value();
    const type = ["==", "!=", ">", ">=", "<", "<="].includes(node.operator) ? "BOOL" :
      node.operator === "+" && left.type === "TXT" ? "TXT" : "NUM";
    this.emit("BINARY", { operator: node.operator, left: left.value, right: right.value }, type, result, node);
    return { value: result, type };
  }
  lowerShortCircuit(node) {
    const left = this.lowerExpression(node.left);
    const tempName = "$qir_sc_" + this.tempCounter++;
    const temp = this.addVariable(tempName, "BOOL");
    this.emit("DECLARE", { variable: temp.id, name: tempName, storage: "local", declared_type: "BOOL", generated: true, ...(this.owner.usesImmutable ? { mutable: true } : {}) }, null, null, node);
    const evalRight = this.newBlock(), shortcut = this.newBlock(), merge = this.newBlock();
    if (node.operator === "AND") this.terminate("BRANCH", { condition: left.value, true_target: evalRight.id, false_target: shortcut.id }, node);
    else this.terminate("BRANCH", { condition: left.value, true_target: shortcut.id, false_target: evalRight.id }, node);
    this.switchTo(shortcut);
    const constant = this.value();
    this.emit("CONST_BOOL", { value: node.operator === "OR" }, "BOOL", constant, node);
    this.emit("STORE_LOCAL", { variable: temp.id, value: constant }, null, null, node);
    this.terminate("JUMP", { target: merge.id }, node);
    this.switchTo(evalRight);
    const right = this.lowerExpression(node.right);
    this.emit("STORE_LOCAL", { variable: temp.id, value: right.value }, null, null, node);
    this.terminate("JUMP", { target: merge.id }, node);
    this.switchTo(merge);
    const result = this.value(); this.emit("LOAD", { variable: temp.id }, "BOOL", result, node);
    return { value: result, type: "BOOL" };
  }
  store(variable, value, node) {
    if (variable.storage === "global") this.emit("STORE_GLOBAL", { variable: variable.id, value }, null, null, node);
    else this.emit("STORE_LOCAL", { variable: variable.id, value }, null, null, node);
  }
  lowerCommand(node) {
    const command = resolveCommand(node.domain, node.command);
    if (!command) fail("QIR_E_UNKNOWN_COMMAND", "Unknown command", node);
    const args = node.args;
    switch (command.id) {
      case "DATA.CREATE": {
        const signature = command.signature;
        if (!signature || args.length !== signature.parameters.length || args[0]?.type !== signature.parameters[0].type)
          fail("QIR_E_BAD_COMMAND_ARGUMENTS", "DATA.CREATE does not match its registered signature", node);
        const value = this.lowerExpression(args[1]);
        const parameter = signature.parameters[1];
        const acceptedTypes = parameter.types ?? (parameter.type ? [parameter.type] : null);
        if (parameter.notNull && value.type === "NULL") fail("QIR_E_NULL_VARIABLE", "Cannot infer variable type from NULL", args[1]);
        if (acceptedTypes && !acceptedTypes.includes(value.type))
          fail("QIR_E_COMMAND_ARGUMENT", "DATA.CREATE initial value does not match its registered type", args[1]);
        const storage = this.descriptor.kind === "module_initializer" ? "global" : "local";
        const variable = this.addVariable(args[0].name, value.type, storage);
        this.emit("DECLARE", { variable: variable.id, name: variable.name, storage, declared_type: value.type, ...(this.owner.usesImmutable ? { mutable: true } : {}) }, null, null, node);
        this.store(variable, value.value, node); return;
      }
      case "DATA.SET":
      case "DATA.SET_GLOBAL": {
        const signature = command.signature;
        if (!signature || args.length !== signature.parameters.length || args[0]?.type !== signature.parameters[0].type)
          fail("QIR_E_BAD_COMMAND_ARGUMENTS", command.id + " does not match its registered signature", node);
        const variable = this.variables.get(args[0].name) ?? this.owner.globalVariable(args[0].name, this);
        if (!variable) fail("QIR_E_UNKNOWN_VARIABLE", "Unknown target " + args[0].name, args[0]);
        if (variable.mutable === false) fail("QIR_E_IMMUTABLE_WRITE", "Cannot modify immutable VALUE binding", args[0]);
        if (signature.result.scope === "function" &&
            (this.descriptor.kind !== "function" || variable.storage !== signature.result.targetStorage))
          fail("QIR_E_GLOBAL_REQUIRED", "DATA.SET_GLOBAL requires a module global and must be used inside a function", args[0]);
        if (command.id === "DATA.SET" && variable.storage === "global" && this.descriptor.kind !== "module_initializer")
          fail("QIR_E_GLOBAL_WRITE", "Use DATA.SET_GLOBAL inside functions", node);
        const value = this.lowerExpression(args[1]);
        const valueParameter = signature.parameters[1];
        const acceptedTypes = valueParameter.types ?? (valueParameter.sameTypeAsTarget ? null : valueParameter.type ? [valueParameter.type] : null);
        const expectedType = valueParameter.sameTypeAsTarget ? variable.type : valueParameter.resultType;
        if ((acceptedTypes && !acceptedTypes.includes(value.type)) || (expectedType && value.type !== expectedType))
          fail("QIR_E_TYPE_MISMATCH", "Stored value type mismatch", node);
        this.store(variable, value.value, node);
        return;
      }
      case "PROCESS.ADD":
      case "PROCESS.CALCULATE":
      case "PROCESS.COMPARE": {
        if (args.length !== 2 || args[0].type !== "Identifier") fail("QIR_E_BAD_COMMAND_ARGUMENTS", command.id + " expects target and value", node);
        const variable = this.variables.get(args[0].name) ?? this.owner.globalVariable(args[0].name, this);
        if (!variable) fail("QIR_E_UNKNOWN_VARIABLE", "Unknown target " + args[0].name, args[0]);
        if (variable.mutable === false) fail("QIR_E_IMMUTABLE_WRITE", "Cannot modify immutable VALUE binding", args[0]);
        const expected = command.signature.parameters[1].resultType;
        const expectedTarget = command.signature.parameters[0].variableType;
        if (variable.type !== expectedTarget) fail("QIR_E_TYPE_MISMATCH", "Stored target type mismatch", args[0]);
        if (variable.storage === "global" && this.descriptor.kind !== "module_initializer")
          fail("QIR_E_GLOBAL_WRITE", "Use DATA.SET_GLOBAL inside functions", node);
        const value = this.lowerExpression(args[1]);
        if (value.type !== expected) fail("QIR_E_TYPE_MISMATCH", "Stored value type mismatch", node);
        if (command.id === "PROCESS.ADD") {
          const current = this.value(); this.emit("LOAD", { variable: variable.id }, "NUM", current, args[0]);
          const sum = this.value(); this.emit("BINARY", { operator: "+", left: current, right: value.value }, "NUM", sum, node);
          this.store(variable, sum, node);
        } else this.store(variable, value.value, node);
        return;
      }
      case "DATA.COUNT": {
        const signature = command.signature;
        if (args.length !== signature.parameters.length) fail("QIR_E_BAD_COMMAND_ARGUMENTS", "DATA.COUNT expects one argument", node);
        const value = this.lowerExpression(args[0]);
        const parameter = signature.parameters[0];
        const acceptedTypes = parameter.types ?? (parameter.type ? [parameter.type] : null);
        if (acceptedTypes && !acceptedTypes.includes(value.type)) fail("QIR_E_COMMAND_ARGUMENT", "DATA.COUNT argument does not match its registered type", args[0]);
        this.emit("COMMAND_CALL", { command: "DATA.COUNT", arguments: [value.value] }, null, null, node); return;
      }
      case "UI.SHOW":
      case "UI.TEXT":
      case "UI.TREE": {
        if (args.length !== command.signature.parameters.length) fail("QIR_E_BAD_COMMAND_ARGUMENTS", command.id + " expects one argument", node);
        const values = args.map((arg, index) => {
          const value = this.lowerExpression(arg);
          const parameter = command.signature.parameters[index];
          const expectedTypes = parameter.types ?? (parameter.type ? [parameter.type] : null);
          if (expectedTypes && !expectedTypes.includes(value.type)) {
            fail("QIR_E_COMMAND_ARGUMENT", command.id + " argument " + (index + 1) + " does not match its registered type", arg);
          }
          return value.value;
        });
        this.emit("COMMAND_CALL", { command: command.id, arguments: values }, null, null, node);
        return;
      }
      default: fail("QIR_E_COMMAND_NOT_ALLOWED", "Command has no approved QIR lowering: " + command.id, node);
    }
  }
  lowerStaticUI(node) {
    const buildChildren = (items) => items.map(item => {
      if (item.symbol === "PANEL") {
        return { kind: "component", id: item.args[0].name, type: "UI.CONTAINER", version: "1.0.0", props: {}, children: buildChildren(item.body ?? []) };
      }
      if (item.symbol === "BLOCK") {
        const content = this.lowerExpression(item.args[1]);
        if (content.type !== "TXT") fail("QIR_E_UI_TEXT_TYPE", "BLOCK content must produce TXT", item.args[1]);
        return { kind: "component", id: item.args[0].name, type: "UI.TEXT_BLOCK", version: "1.0.0", props: {}, children: [{ kind: "text", valueRef: content.value }] };
      }
      fail("QIR_E_UNSUPPORTED_AST", "Unsupported child in static UI tree", item);
    });
    const tree = { schema: "QX.UI.TREE", version: "1.0", children: buildChildren(node.body ?? []) };
    const value = this.value();
    this.emit("MAKE_UI_TREE", { tree }, "TXT", value, node);
    this.emit("COMMAND_CALL", { command: "UI.TREE", arguments: [value] }, null, null, node);
  }
  lowerStatement(node) {
    if (!this.current) return;
    switch (node.type) {
      case "CommandStatement": return this.lowerCommand(node);
      case "GeometricStatement": {
        if (node.group === "INTERFACE_DESIGN" && node.symbol === "SCREEN") {
          this.lowerStaticUI(node);
          return;
        }
        if (node.group !== "DATA_STORAGE") fail("QIR_E_UNSUPPORTED_AST", "Unsupported geometric statement " + node.symbol, node);
        const args = node.args ?? [];
        if (["DATA", "VALUE", "RECORD"].includes(node.symbol) && args.length === 2 && args[0]?.type === "Identifier") {
          const value = this.lowerExpression(args[1]);
          if (!VALUE_TYPES.has(value.type) || value.type === "NULL")
            fail("QIR_E_NULL_VARIABLE", "Cannot infer geometric DATA type", args[1]);
          const storage = this.descriptor.kind === "module_initializer" ? "global" : "local";
          const mutable = !["VALUE", "RECORD"].includes(node.symbol);
          const variable = this.addVariable(args[0].name, value.type, storage, false, mutable);
          this.emit("DECLARE", { variable: variable.id, name: variable.name, storage, declared_type: value.type, ...(this.owner.usesImmutable ? { mutable } : {}) }, null, null, node);
          this.store(variable, value.value, node);
          return;
        }
        if (node.symbol === "STORE" && args.length === 2 && args[0]?.type === "Identifier") {
          const variable = this.variables.get(args[0].name) ?? this.owner.globalVariable(args[0].name, this);
          if (!variable) fail("QIR_E_UNKNOWN_VARIABLE", "Unknown target " + args[0].name, args[0]);
          if (variable.mutable === false) fail("QIR_E_IMMUTABLE_WRITE", "Cannot modify immutable VALUE binding", args[0]);
          if (variable.storage === "global" && this.descriptor.kind !== "module_initializer")
            fail("QIR_E_GLOBAL_WRITE", "Geometric STORE cannot update a module binding inside a function", node);
          const value = this.lowerExpression(args[1]);
          if (value.type !== variable.type) fail("QIR_E_TYPE_MISMATCH", "Geometric STORE value type mismatch", args[1]);
          this.store(variable, value.value, node);
          return;
        }
        if (node.symbol === "COLLECTION" && args.length === 1 && args[0]?.type === "Identifier") {
          const storage = this.descriptor.kind === "module_initializer" ? "global" : "local";
          const variable = this.addVariable(args[0].name, "LIST", storage);
          const empty = this.value();
          this.emit("MAKE_LIST", { elements: [] }, "LIST", empty, node);
          this.emit("DECLARE", { variable: variable.id, name: variable.name, storage, declared_type: "LIST", ...(this.owner.usesImmutable ? { mutable: true } : {}) }, null, null, node);
          this.store(variable, empty, node);
          return;
        }
        fail("QIR_E_UNSUPPORTED_AST", "Geometric symbol has no approved QIR statement lowering: " + node.symbol, node);
      }
      case "ExpressionStatement": {
        if (node.expression.type === "CallExpression" && this.owner.functionsByName.get(node.expression.callee.name)?.returnType === "NULL") {
          const fn = this.owner.functionsByName.get(node.expression.callee.name);
          const args = node.expression.args.map(arg => this.lowerExpression(arg).value);
          this.emit("CALL", { function: fn.id, arguments: args }, null, null, node); return;
        }
        this.lowerExpression(node.expression); return;
      }
      case "ReturnStatement": {
        const value = this.lowerExpression(node.argument);
        this.terminate("RETURN", { value: value.value }, node); return;
      }
      case "IfStatement": {
        const condition = this.lowerExpression(node.test);
        const yes = this.newBlock(), no = this.newBlock(), merge = this.newBlock();
        this.terminate("BRANCH", { condition: condition.value, true_target: yes.id, false_target: no.id }, node);
        this.switchTo(yes); node.consequent.forEach(statement => this.lowerStatement(statement));
        const yesFalls = !!this.current;
        if (yesFalls) this.terminate("JUMP", { target: merge.id }, node);
        this.switchTo(no); (node.alternate ?? []).forEach(statement => this.lowerStatement(statement));
        const noFalls = !!this.current;
        if (noFalls) this.terminate("JUMP", { target: merge.id }, node);
        if (yesFalls || noFalls) this.switchTo(merge);
        else { this.blocks.splice(this.blocks.indexOf(merge), 1); this.current = null; }
        return;
      }
      case "WhileStatement": {
        const conditionBlock = this.newBlock(), bodyBlock = this.newBlock(), exitBlock = this.newBlock();
        this.terminate("JUMP", { target: conditionBlock.id }, node);
        this.switchTo(conditionBlock);
        const condition = this.lowerExpression(node.test);
        this.terminate("BRANCH", { condition: condition.value, true_target: bodyBlock.id, false_target: exitBlock.id }, node);
        this.switchTo(bodyBlock); node.body.forEach(statement => this.lowerStatement(statement));
        if (this.current) this.terminate("JUMP", { target: conditionBlock.id }, node);
        this.switchTo(exitBlock); return;
      }
      default: fail("QIR_E_UNSUPPORTED_AST", "Unsupported statement " + node.type, node);
    }
  }
  finish(body) {
    for (const statement of body) this.lowerStatement(statement);
    if (this.current) {
      if (this.descriptor.returnType !== "NULL") fail("QIR_E_MISSING_RETURN", "Value-returning function falls through");
      this.terminate("RETURN", {}, this.descriptor.node);
    }
    return {
      id: this.id, kind: this.descriptor.kind, name: this.descriptor.name,
      parameters: this.descriptor.parameters.map((param, index) => ({ id: "arg_" + index, name: param.name, type: param.type })),
      return_type: this.descriptor.returnType, entry_block: this.entry, blocks: this.blocks
    };
  }
}

class ModuleLowerer {
  constructor(program, analysis) {
    if (!program || program.type !== "Program" || !Array.isArray(program.body)) fail("QIR_E_BAD_AST", "Expected Program AST");
    if (!analysis || analysis.valid !== true) fail("QIR_E_SEMANTIC_ERRORS", "QIR lowering requires successful semantic analysis");
    this.program = program;
    this.analysis = analysis;
    this.globals = [];
    this.globalsByName = new Map();
    this.functionsByName = new Map();
    this.functionDescriptors = [];
    const containsSymbol = (node, symbols) => Array.isArray(node) ? node.some(item => containsSymbol(item, symbols)) : !!node && typeof node === "object" && (node.type === "GeometricStatement" && symbols.includes(node.symbol) || Object.values(node).some(value => containsSymbol(value, symbols)));
    const containsRecordLiteral = node => Array.isArray(node) ? node.some(containsRecordLiteral) : !!node && typeof node === "object" && (node.type === "RecordLiteral" || Object.values(node).some(containsRecordLiteral));
    this.usesRecord = containsSymbol(program, ["RECORD"]) || containsRecordLiteral(program);
    this.usesStaticUI = containsSymbol(program, ["SCREEN"]);
    this.usesImmutable = this.usesRecord || containsSymbol(program, ["VALUE"]);
    this.collectFunctions();
    this.collectGlobals();
  }
  collectFunctions() {
    const signatures = new Map(this.analysis.functions.map(fn => [fn.name, fn]));
    let index = 1;
    for (const node of this.program.body.filter(item => item.type === "FunctionDeclaration")) {
      const signature = signatures.get(node.name);
      if (!signature) fail("QIR_E_FUNCTION_SIGNATURE", "Missing semantic signature for " + node.name, node);
      const descriptor = {
        id: "fn_" + index++, kind: "function", name: node.name, node,
        returnType: signature.returnType,
        parameters: node.params.map((param, i) => ({ node: param, name: param.name, type: signature.parameters[i]?.type }))
      };
      if (descriptor.parameters.some(param => !VALUE_TYPES.has(param.type)) || !VALUE_TYPES.has(descriptor.returnType))
        fail("QIR_E_FUNCTION_SIGNATURE", "Unresolved function signature", node);
      this.functionsByName.set(node.name, descriptor);
      this.functionDescriptors.push(descriptor);
    }
  }
  collectGlobals() {
    const variables = new Map();
    const functions = new Map([...this.functionsByName].map(([name, fn]) => [name, fn]));
    for (const node of this.program.body) {
      let name = null, type = null;
      if (node.type === "CommandStatement") {
        const command = resolveCommand(node.domain, node.command);
        if (command?.id === "DATA.CREATE" && node.args[0]?.type === "Identifier" && node.args.length === 2) {
          name = node.args[0].name;
          type = inferExpression(node.args[1], variables, functions);
        }
      } else if (node.type === "GeometricStatement" && node.group === "DATA_STORAGE") {
        const args = node.args ?? [];
        if (["DATA", "VALUE", "RECORD"].includes(node.symbol) && args.length === 2 && args[0]?.type === "Identifier") {
          name = args[0].name;
          type = inferExpression(args[1], variables, functions);
        } else if (node.symbol === "COLLECTION" && args.length === 1 && args[0]?.type === "Identifier") {
          name = args[0].name;
          type = "LIST";
        }
      }
      if (name === null) continue;
      if (!VALUE_TYPES.has(type) || type === "NULL") fail("QIR_E_NULL_VARIABLE", "Cannot infer global type", node);
      const id = "var_" + this.globals.length;
      const immutable = this.program.body.some(node => node.type === "GeometricStatement" && ["VALUE", "RECORD"].includes(node.symbol) && node.args?.[0]?.name === name);
      const item = { id, name, type, storage: "global", ...(this.usesImmutable ? { mutable: !immutable } : {}) };
      this.globals.push(item); this.globalsByName.set(item.name, item); variables.set(item.name, item);
    }
  }
  globalVariable(name, builder) {
    const global = this.globalsByName.get(name);
    if (!global) return null;
    const local = builder.variables.get(name);
    if (local) return local;
    return builder.addVariable(name, global.type, "global", false, global.mutable !== false);
  }
  lower() {
    const initializerDescriptor = { id: "fn_0", kind: "module_initializer", name: null, parameters: [], returnType: "NULL", node: this.program };
    const initializerBuilder = new FunctionBuilder(this, initializerDescriptor);
    const topLevel = this.program.body.filter(node => node.type !== "FunctionDeclaration");
    const initializer = initializerBuilder.finish(topLevel);
    const functions = this.functionDescriptors.map(descriptor => {
      const builder = new FunctionBuilder(this, descriptor);
      return builder.finish(descriptor.node.body);
    });
    const instructions = [initializer, ...functions].flatMap(fn => fn.blocks.flatMap(block => block.instructions));
    const usesUI = instructions.some(inst => ["UI.SHOW", "UI.TEXT"].includes(inst.operands?.command));
    const usesUITree = instructions.some(inst => inst.operands?.command === "UI.TREE");
    const usesListOperations = instructions.some(inst => ["DATA.ADD", "DATA.REMOVE"].includes(inst.operands?.command));
    const usesIntegration = instructions.some(inst => inst.operands?.command === "INTEGRATION.REQUEST");
    return {
      format: "QIR", version: this.usesStaticUI ? "1.7" : this.usesRecord ? "1.6" : this.usesImmutable ? "1.5" : usesUITree ? "1.4" : usesIntegration ? "1.3" : usesUI ? "1.2" : usesListOperations ? "1.1" : "1.0", module_id: "module_0", unicode_version: "18.0.0",
      globals: this.globals, initializer, functions
    };
  }
}

export function lowerToQIR(program, semanticAnalysis) {
  const module = new ModuleLowerer(program, semanticAnalysis).lower();
  const diagnostics = validateQIR(module);
  if (diagnostics.length) {
    const error = new Error(diagnostics[0].message);
    error.name = "QIRValidationError";
    error.diagnostics = diagnostics;
    throw error;
  }
  return module;
}

export function validateQIR(module) {
  const diagnostics = [];
  const report = (code, message, location = null, extra = {}) =>
    diagnostics.push({ code, severity: "ERROR", message, location, ...extra });
  if (!module || module.format !== "QIR" || !["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) || module.unicode_version !== "18.0.0") {
    report("QIR_E_SCHEMA", "Invalid QIR module header"); return diagnostics;
  }
  const functions = [module.initializer, ...(module.functions ?? [])];
  const functionIds = new Set(), globalIds = new Set(), globalNames = new Set();
  for (const global of module.globals ?? []) {
    if (!global?.id || globalIds.has(global.id) || globalNames.has(global.name) || !validType(global.type, module.version) || global.storage !== "global" || ["1.5", "1.6", "1.7"].includes(module.version) && typeof global.mutable !== "boolean" || !["1.5", "1.6", "1.7"].includes(module.version) && Object.hasOwn(global, "mutable"))
      report("QIR_E_GLOBAL_SCHEMA", "Invalid or duplicate global declaration");
    globalIds.add(global.id); globalNames.add(global.name);
  }
  const functionById = new Map(functions.map(fn => [fn.id, fn]));
  const flowByFunction = new Map();
  const valueTypesByFunction = new Map();
  const immutableDeclarationLocations = new Map();
  for (const fn of functions) {
    if (!fn || functionIds.has(fn.id) || !Array.isArray(fn.blocks) || !fn.blocks.length) {
      report("QIR_E_FUNCTION_SCHEMA", "Invalid function or duplicate function id"); continue;
    }
    functionIds.add(fn.id);
    if (!validType(fn.return_type, module.version) || !Array.isArray(fn.parameters) ||
        fn.parameters.some(parameter => !parameter || !validType(parameter.type, module.version)))
      report("QIR_E_FUNCTION_SCHEMA", "Function parameter or return type is invalid for this QIR version", null, { function: fn.id });
    const blocks = new Map(fn.blocks.map(block => [block.id, block]));
    if (!blocks.has(fn.entry_block)) report("QIR_E_ENTRY_BLOCK", "Entry block does not exist", null, { function: fn.id });
    const valueTypes = new Map(), valueLocations = new Map(), instructionIds = new Set(), variableTypes = new Map();
    valueTypesByFunction.set(fn.id, valueTypes);
    const definedVariables = new Set();
    const declaredVariables = new Set();
    for (const global of module.globals ?? []) { variableTypes.set(global.id, global.type); definedVariables.add(global.id); }
    const predecessors = new Map(fn.blocks.map(block => [block.id, new Set()]));
    for (const block of fn.blocks) {
      if (!Array.isArray(block.instructions) || !block.instructions.length) {
        report("QIR_E_EMPTY_BLOCK", "Basic block must end with a terminator", null, { function: fn.id, block: block.id }); continue;
      }
      for (let i = 0; i < block.instructions.length; i++) {
        const inst = block.instructions[i];
        if (!inst.id || instructionIds.has(inst.id)) report("QIR_E_INSTRUCTION_ID", "Duplicate or missing instruction id", inst.source, { function: fn.id, block: block.id });
        instructionIds.add(inst.id);
        const terminal = ["BRANCH", "JUMP", "RETURN"].includes(inst.opcode);
        if (terminal && i !== block.instructions.length - 1) report("QIR_E_TERMINATOR_POSITION", "Terminator must be last", inst.source, { function: fn.id, block: block.id });
        if (i === block.instructions.length - 1 && !terminal) report("QIR_E_MISSING_TERMINATOR", "Block must end with BRANCH, JUMP, or RETURN", inst.source, { function: fn.id, block: block.id });
        if (inst.result) {
          if (valueTypes.has(inst.result) || !validType(inst.type, module.version)) report("QIR_E_VALUE_TYPE", "Duplicate value or invalid result type", inst.source, { function: fn.id, block: block.id });
          valueTypes.set(inst.result, inst.type);
          valueLocations.set(inst.result, { block: block.id, index: i });
        }
        if (inst.opcode === "CONST_NUM" && (typeof inst.operands.value !== "number" || !Number.isFinite(inst.operands.value) || inst.type !== "NUM"))
          report("QIR_E_CONSTANT_TYPE", "CONST_NUM requires a finite number and NUM result", inst.source);
        if (inst.opcode === "CONST_TXT" && (typeof inst.operands.value !== "string" || inst.type !== "TXT"))
          report("QIR_E_CONSTANT_TYPE", "CONST_TXT requires a string and TXT result", inst.source);
        if (inst.opcode === "CONST_BOOL" && (typeof inst.operands.value !== "boolean" || inst.type !== "BOOL"))
          report("QIR_E_CONSTANT_TYPE", "CONST_BOOL requires a boolean and BOOL result", inst.source);
        if (inst.opcode === "CONST_NULL" && (inst.type !== "NULL" || Object.keys(inst.operands).length !== 0))
          report("QIR_E_CONSTANT_TYPE", "CONST_NULL has no operands and produces NULL", inst.source);
        if (inst.opcode === "MAKE_UI_TREE") {
          const tree = opTree(inst.operands?.tree);
          if (module.version !== "1.7" || inst.type !== "TXT" || !tree.valid) report("QIR_E_UI_TREE_SCHEMA", "MAKE_UI_TREE requires QIR 1.7, a TXT result, and a valid bounded tree descriptor", inst.source);
          else for (const id of tree.valueRefs) if (valueTypes.get(id) !== "TXT") report("QIR_E_UI_TREE_TEXT", "UI tree text references must resolve to TXT values", inst.source);
        }
        if (inst.opcode === "MAKE_RECORD") {
          const fields = inst.operands?.fields;
          const names = new Set();
          if (!["1.6", "1.7"].includes(module.version) || inst.type !== "RECORD" || !Array.isArray(fields) || fields.length > 10000) {
            report("QIR_E_RECORD_SCHEMA", "MAKE_RECORD requires QIR 1.6 or later, a RECORD result, and a bounded fields array", inst.source);
          } else {
            for (const field of fields) {
              if (!field || Object.keys(field).sort().join(",") !== "name,value" || typeof field.name !== "string" || !field.name.length || field.name.normalize("NFC") !== field.name || typeof field.value !== "string" || names.has(field.name.normalize("NFC"))) {
                report("QIR_E_RECORD_FIELD", "MAKE_RECORD fields require unique NFC-normalized names and value references", inst.source);
                continue;
              }
              names.add(field.name.normalize("NFC"));
            }
          }
        }

        if (inst.opcode === "DECLARE") {
          const { variable, declared_type: type, storage } = inst.operands ?? {};
          if (!variable || !validType(type, module.version) || !["local", "global"].includes(storage) || ["1.5", "1.6", "1.7"].includes(module.version) && typeof inst.operands?.mutable !== "boolean" || !["1.5", "1.6", "1.7"].includes(module.version) && Object.hasOwn(inst.operands ?? {}, "mutable")) report("QIR_E_DECLARE", "Invalid DECLARE", inst.source);
          else if (declaredVariables.has(variable)) report("QIR_E_DUPLICATE_DECLARE", "Variable is declared more than once in a function", inst.source);
          else {
            declaredVariables.add(variable);
            variableTypes.set(variable, type); definedVariables.add(variable);
            if (storage === "global" && ["1.5", "1.6", "1.7"].includes(module.version)) {
              const descriptor = (module.globals ?? []).find(item => item.id === variable);
              if (!descriptor || descriptor.mutable !== inst.operands.mutable)
                report("QIR_E_IMMUTABLE_SCHEMA", "Global DECLARE mutability differs from its module descriptor", inst.source);
            }
            if (["1.5", "1.6", "1.7"].includes(module.version) && inst.operands.mutable === false) {
              if (immutableDeclarationLocations.has(variable)) {
                report("QIR_E_IMMUTABLE_DECLARE", "Immutable binding must have exactly one DECLARE instruction", inst.source, { function: fn.id, variable });
              } else {
                immutableDeclarationLocations.set(variable, { functionId: fn.id, blockId: block.id, index: i, storage });
              }
            }
          }
        }
        if (inst.opcode === "BRANCH") {
          const { true_target, false_target } = inst.operands ?? {};
          if (blocks.has(true_target)) predecessors.get(true_target).add(block.id); else report("QIR_E_BRANCH_TARGET", "Invalid true branch target", inst.source);
          if (blocks.has(false_target)) predecessors.get(false_target).add(block.id); else report("QIR_E_BRANCH_TARGET", "Invalid false branch target", inst.source);
        }
        if (inst.opcode === "JUMP") {
          const target = inst.operands?.target;
          if (blocks.has(target)) predecessors.get(target).add(block.id); else report("QIR_E_JUMP_TARGET", "Invalid jump target", inst.source);
        }
        if (inst.opcode === "RETURN") {
          const hasValue = Object.hasOwn(inst.operands ?? {}, "value");
          if (fn.return_type === "NULL" && hasValue) report("QIR_E_RETURN_TYPE", "Procedure cannot return a value", inst.source);
          if (fn.return_type !== "NULL" && !hasValue) report("QIR_E_RETURN_TYPE", "Function must return a value", inst.source);
          if (hasValue && valueTypes.has(inst.operands.value) && valueTypes.get(inst.operands.value) !== fn.return_type) report("QIR_E_RETURN_TYPE", "RETURN value type differs from function return type", inst.source);
        }
        if (!["CONST_NUM","CONST_TXT","CONST_BOOL","CONST_NULL","DECLARE","LOAD","STORE_LOCAL","STORE_GLOBAL","UNARY","BINARY","MAKE_LIST","MAKE_RECORD","MAKE_UI_TREE","CALL","COMMAND_CALL","BRANCH","JUMP","RETURN"].includes(inst.opcode))
          report("QIR_E_UNKNOWN_OPCODE", "Unknown opcode " + inst.opcode, inst.source);
      }
    }
    const reachable = new Set([fn.entry_block]), queue = [fn.entry_block];
    while (queue.length) {
      const id = queue.shift(), block = blocks.get(id); if (!block) continue;
      const term = block.instructions.at(-1);
      const targets = term?.opcode === "JUMP" ? [term.operands.target] :
        term?.opcode === "BRANCH" ? [term.operands.true_target, term.operands.false_target] : [];
      for (const target of targets) if (blocks.has(target) && !reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
    const predecessorsOf = id => [...(predecessors.get(id) ?? [])].filter(p => reachable.has(p));
    const dominators = new Map();
    for (const id of reachable) dominators.set(id, id === fn.entry_block ? new Set([id]) : new Set(reachable));
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of reachable) {
        if (id === fn.entry_block) continue;
        const preds = predecessorsOf(id);
        let next = preds.length ? new Set(dominators.get(preds[0])) : new Set();
        for (const pred of preds.slice(1)) next = new Set([...next].filter(value => dominators.get(pred).has(value)));
        next.add(id);
        const old = dominators.get(id);
        if (old.size !== next.size || [...old].some(value => !next.has(value))) { dominators.set(id, next); changed = true; }
      }
    }
    // Forward must-analysis: a variable is initialized at a block only if every
    // reachable predecessor initializes it before control reaches that block.
    const trackedVariables = new Set();
    for (const block of fn.blocks) for (const inst of block.instructions) {
      if (inst.opcode === "DECLARE" && inst.operands?.storage === "local") trackedVariables.add(inst.operands.variable);
    }
    if (fn.id === "fn_0") for (const global of globalIds) trackedVariables.add(global);
    const universe = new Set(trackedVariables);
    const inStates = new Map(), outStates = new Map();
    for (const id of reachable) {
      inStates.set(id, id === fn.entry_block ? new Set() : new Set(universe));
      outStates.set(id, new Set(universe));
    }
    const transferBlock = (blockId, input) => {
      const state = new Set(input);
      for (const inst of blocks.get(blockId)?.instructions ?? []) {
        const op = inst.operands ?? {};
        if (inst.opcode === "DECLARE" && trackedVariables.has(op.variable)) {
          if (op.parameter === true) state.add(op.variable);
          else state.delete(op.variable);
        } else if ((inst.opcode === "STORE_LOCAL" || inst.opcode === "STORE_GLOBAL") && trackedVariables.has(op.variable)) {
          state.add(op.variable);
        }
      }
      return state;
    };
    const sameSet = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
    let flowChanged = true, flowRounds = 0;
    while (flowChanged && flowRounds++ < Math.max(4, reachable.size * 4)) {
      flowChanged = false;
      for (const id of reachable) {
        let nextIn;
        if (id === fn.entry_block) nextIn = new Set();
        else {
          const preds = predecessorsOf(id);
          nextIn = preds.length ? new Set(outStates.get(preds[0])) : new Set();
          for (const pred of preds.slice(1)) nextIn = new Set([...nextIn].filter(value => outStates.get(pred).has(value)));
        }
        const nextOut = transferBlock(id, nextIn);
        if (!sameSet(inStates.get(id), nextIn) || !sameSet(outStates.get(id), nextOut)) {
          inStates.set(id, nextIn); outStates.set(id, nextOut); flowChanged = true;
        }
      }
    }
    flowByFunction.set(fn.id, { trackedVariables, inStates });
    const flow = flowByFunction.get(fn.id);
    // Immutable bindings use a may-have-been-initialized analysis: if any
    // incoming path has already written the binding, another STORE is invalid.
    const immutableVariables = new Set((module.globals ?? []).filter(item => item.mutable === false).map(item => item.id));
    for (const block of fn.blocks) for (const inst of block.instructions ?? [])
      if (inst.opcode === "DECLARE" && inst.operands?.mutable === false) immutableVariables.add(inst.operands.variable);
    const maybeIn = new Map(), maybeOut = new Map();
    const initiallyWritten = fn.kind === "module_initializer" ? new Set() :
      new Set((module.globals ?? []).filter(item => item.mutable === false).map(item => item.id));
    for (const id of reachable) { maybeIn.set(id, new Set(initiallyWritten)); maybeOut.set(id, new Set(initiallyWritten)); }
    let maybeChanged = true, maybeRounds = 0;
    while (maybeChanged && maybeRounds++ < Math.max(4, reachable.size * 4)) {
      maybeChanged = false;
      for (const id of reachable) {
        const preds = predecessorsOf(id);
        const nextIn = new Set(initiallyWritten);
        for (const pred of preds) for (const variable of maybeOut.get(pred) ?? []) nextIn.add(variable);
        const nextOut = new Set(nextIn);
        for (const inst of blocks.get(id)?.instructions ?? []) {
          const op = inst.operands ?? {};
          if ((inst.opcode === "STORE_LOCAL" || inst.opcode === "STORE_GLOBAL") && immutableVariables.has(op.variable)) nextOut.add(op.variable);
        }
        const same = (a,b) => a.size === b.size && [...a].every(x => b.has(x));
        if (!same(maybeIn.get(id), nextIn) || !same(maybeOut.get(id), nextOut)) {
          maybeIn.set(id, nextIn); maybeOut.set(id, nextOut); maybeChanged = true;
        }
      }
    }

    for (const block of fn.blocks) {
      const initializedVariables = new Set(flow.inStates.get(block.id) ?? []);
      const possiblyInitializedImmutable = new Set(maybeIn.get(block.id) ?? initiallyWritten);
      const seen = new Set();
      let instructionIndex = 0;
      for (const inst of block.instructions) {
        const currentInstructionIndex = instructionIndex++;
        const refs = [];
        const op = inst.operands ?? {};
        if (inst.opcode === "LOAD") refs.push(op.variable);
        if (inst.opcode === "STORE_LOCAL" || inst.opcode === "STORE_GLOBAL") refs.push(op.variable);
        if (inst.opcode === "UNARY") refs.push(op.value);
        if (inst.opcode === "BINARY") refs.push(op.left, op.right);
        if (inst.opcode === "MAKE_LIST") refs.push(...(op.elements ?? []));
        if (inst.opcode === "MAKE_RECORD") refs.push(...(op.fields ?? []).map(field => field?.value));
        if (inst.opcode === "MAKE_UI_TREE") refs.push(...opTree(op.tree).valueRefs);
        if (inst.opcode === "CALL" || inst.opcode === "COMMAND_CALL") refs.push(...(op.arguments ?? []));
        if (inst.opcode === "BRANCH") refs.push(op.condition);
        if (inst.opcode === "STORE_LOCAL" || inst.opcode === "STORE_GLOBAL") refs.push(op.value);
        if (inst.opcode === "RETURN" && Object.hasOwn(op, "value")) refs.push(op.value);
        for (const ref of refs) if (typeof ref === "string" && ref.startsWith("v_") && !valueTypes.has(ref))
          report("QIR_E_UNDEFINED_VALUE", "Use of undefined value " + ref, inst.source, { function: fn.id, block: block.id });
        if (inst.opcode === "DECLARE" && op.parameter === true) initializedVariables.add(op.variable);
        if (inst.opcode === "LOAD") {
          if (!definedVariables.has(op.variable)) report("QIR_E_UNDECLARED_VARIABLE", "LOAD before DECLARE", inst.source);
          if (variableTypes.has(op.variable) && inst.type !== variableTypes.get(op.variable)) report("QIR_E_LOAD_TYPE", "LOAD result type differs from variable type", inst.source);
          else if (flow?.trackedVariables.has(op.variable) && !initializedVariables.has(op.variable))
            report("QIR_E_UNINITIALIZED_LOAD", "Variable may be read before initialization on every incoming path", inst.source);
        }
        if (["STORE_LOCAL","STORE_GLOBAL"].includes(inst.opcode) && !definedVariables.has(op.variable))
          report("QIR_E_UNDECLARED_VARIABLE", "STORE before DECLARE", inst.source);
        if (["STORE_LOCAL","STORE_GLOBAL"].includes(inst.opcode) && immutableVariables.has(op.variable)) {
          const declaration = immutableDeclarationLocations.get(op.variable);
          if (!declaration) {
            report("QIR_E_IMMUTABLE_DECLARE", "Immutable binding must be declared before initialization", inst.source, { function: fn.id, block: block.id, variable: op.variable });
          } else if (declaration.functionId !== fn.id ||
              (declaration.blockId === block.id
                ? declaration.index >= currentInstructionIndex
                : !dominators.get(block.id)?.has(declaration.blockId))) {
            report("QIR_E_IMMUTABLE_DECLARE_ORDER", "Immutable binding must be declared on every path before its initialization", inst.source, { function: fn.id, block: block.id, variable: op.variable });
          }
          if (possiblyInitializedImmutable.has(op.variable))
            report("QIR_E_IMMUTABLE_WRITE", "Immutable variable cannot be assigned more than once", inst.source, { function: fn.id, block: block.id, variable: op.variable });
          possiblyInitializedImmutable.add(op.variable);
        }
        if (inst.opcode === "DECLARE" && flow?.trackedVariables.has(op.variable)) {
          if (op.parameter === true) initializedVariables.add(op.variable);
          else initializedVariables.delete(op.variable);
        }
        if (["STORE_LOCAL","STORE_GLOBAL"].includes(inst.opcode) && flow?.trackedVariables.has(op.variable))
          initializedVariables.add(op.variable);
        if (inst.opcode === "BRANCH" && valueTypes.get(op.condition) !== "BOOL") report("QIR_E_BRANCH_TYPE", "BRANCH condition must be BOOL", inst.source);
        if (inst.opcode === "LOAD" && !variableTypes.has(op.variable)) report("QIR_E_UNDECLARED_VARIABLE", "LOAD references an unknown variable", inst.source);
        if (inst.opcode === "STORE_LOCAL" && globalIds.has(op.variable)) report("QIR_E_STORAGE_KIND", "STORE_LOCAL cannot write a global", inst.source);
        if (inst.opcode === "STORE_GLOBAL" && !globalIds.has(op.variable)) report("QIR_E_STORAGE_KIND", "STORE_GLOBAL requires a module global", inst.source);
        if (inst.opcode === "STORE_LOCAL" || inst.opcode === "STORE_GLOBAL") {
          if (!valueTypes.has(op.value) || variableTypes.get(op.variable) !== valueTypes.get(op.value)) report("QIR_E_STORE_TYPE", "Stored value type does not match variable type", inst.source);
        }
        if (inst.opcode === "UNARY") {
          const expected = op.operator === "NOT" ? "BOOL" : "NUM";
          if (valueTypes.get(op.value) !== expected || inst.type !== expected) report("QIR_E_UNARY_TYPE", "Invalid unary operand or result type", inst.source);
        }
        if (inst.opcode === "BINARY") {
          const left = valueTypes.get(op.left), right = valueTypes.get(op.right);
          const comparisons = ["==", "!=", ">", ">=", "<", "<="];
          const valid = op.operator === "+" ? left === right && ["NUM", "TXT"].includes(left) :
            ["AND", "OR"].includes(op.operator) ? left === "BOOL" && right === "BOOL" :
            ["==", "!="].includes(op.operator) ? left === right && ["NUM", "TXT", "BOOL", "LIST"].includes(left) :
            comparisons.includes(op.operator) ? left === right && ["NUM", "TXT"].includes(left) :
            ["-", "*", "/", "%"].includes(op.operator) ? left === "NUM" && right === "NUM" : false;
          const expected = comparisons.includes(op.operator) || ["AND", "OR"].includes(op.operator) ? "BOOL" : op.operator === "+" && left === "TXT" ? "TXT" : "NUM";
          if (!valid || inst.type !== expected) report("QIR_E_BINARY_TYPE", "Invalid binary operand or result types", inst.source);
        }
        if (inst.opcode === "COMMAND_CALL") {
          const args = op.arguments ?? [];
          const [domain, name] = (op.command ?? "").split(".");
          const command = resolveCommand(domain, name);
          const signature = command?.signature;
          const parameterTypes = signature?.parameters.map(parameter =>
            parameter.types ?? (parameter.type ? [parameter.type] : null)
          ) ?? [];
          const argumentsMatch = Boolean(signature) &&
            args.length === signature.parameters.length &&
            parameterTypes.every((types, index) =>
              types !== null && types.includes(valueTypes.get(args[index]))
            );
          const resultMatches = signature?.result?.kind === "value"
            ? (op.command === "DATA.COUNT" && !inst.result && !inst.type) || (Boolean(inst.result) && inst.type === signature.result.type)
            : Boolean(signature) && !inst.result && !inst.type;
          if (op.command === "DATA.COUNT") {
            if (!argumentsMatch || !resultMatches) report("QIR_E_COMMAND_SIGNATURE", "DATA.COUNT requires its registered signature", inst.source);
          } else if (op.command === "DATA.ADD") {
            if (!["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) || !argumentsMatch || !resultMatches) report("QIR_E_COMMAND_SIGNATURE", "DATA.ADD requires its registered signature in QIR 1.1 or later", inst.source);
          } else if (op.command === "DATA.REMOVE") {
            if (!["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) || !argumentsMatch || !resultMatches) report("QIR_E_COMMAND_SIGNATURE", "DATA.REMOVE requires its registered signature in QIR 1.1 or later", inst.source);
          } else if (op.command === "UI.SHOW") {
            if (!["1.2", "1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) || !argumentsMatch || !resultMatches) report("QIR_E_COMMAND_SIGNATURE", "UI.SHOW requires its registered signature in QIR 1.2 or later", inst.source);
          } else if (op.command === "UI.TEXT") {
            if (!["1.2", "1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) || !argumentsMatch || !resultMatches) report("QIR_E_COMMAND_SIGNATURE", "UI.TEXT requires its registered signature in QIR 1.2 or later", inst.source);
          } else if (op.command === "UI.TREE") {
            if (!["1.4", "1.5", "1.6", "1.7"].includes(module.version) || !argumentsMatch || !resultMatches)
              report("QIR_E_COMMAND_SIGNATURE", "UI.TREE requires its registered signature in QIR 1.4", inst.source);
          } else if (op.command === "INTEGRATION.REQUEST") {
            if (!["1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) || !argumentsMatch || !resultMatches)
              report("QIR_E_COMMAND_SIGNATURE", "INTEGRATION.REQUEST requires its registered signature in QIR 1.3 or later", inst.source);
          } else {
            report("QIR_E_COMMAND_NOT_ALLOWED", "Command is not allowed in QIR", inst.source);
          }
        }
        if (inst.result) seen.add(inst.result);
      }
    }
    for (const block of fn.blocks) {
      if (!reachable.has(block.id)) continue;
      for (let instIndex = 0; instIndex < block.instructions.length; instIndex++) {
        const inst = block.instructions[instIndex];
        const op = inst.operands ?? {};
        const refs = [];
        if (inst.opcode === "UNARY") refs.push(op.value);
        if (inst.opcode === "BINARY") refs.push(op.left, op.right);
        if (inst.opcode === "MAKE_LIST") refs.push(...(op.elements ?? []));
        if (inst.opcode === "MAKE_RECORD") {
          refs.push(...(op.fields ?? []).map(field => field?.value));
          for (const field of op.fields ?? []) {
            if (valueTypes.get(field?.value) === "NULL")
              report("QIR_E_RECORD_FIELD", "RECORD fields cannot contain NULL values", inst.source);
          }
        }
        if (inst.opcode === "CALL" || inst.opcode === "COMMAND_CALL") refs.push(...(op.arguments ?? []));
        if (inst.opcode === "BRANCH") refs.push(op.condition);
        for (const ref of refs) {
          if (!valueTypes.has(ref)) continue;
          const definition = valueLocations.get(ref);
          if (definition?.block === block.id && definition.index >= instIndex)
            report("QIR_E_USE_BEFORE_DEFINITION", "Value is used before its definition in the same block", inst.source, { function: fn.id, block: block.id });
          else if (definition && definition.block !== block.id && !dominators.get(block.id)?.has(definition.block))
            report("QIR_E_DOMINANCE", "Value definition does not dominate use", inst.source, { function: fn.id, block: block.id });
        }
      }
    }
  }
  if (["1.5", "1.6", "1.7"].includes(module.version)) {
    for (const global of module.globals ?? []) {
      if (global.mutable !== false) continue;
      const declaration = immutableDeclarationLocations.get(global.id);
      if (!declaration || declaration.functionId !== module.initializer.id || declaration.storage !== "global") {
        report("QIR_E_IMMUTABLE_DECLARE", "Every immutable global must be declared exactly once by the module initializer", null, { variable: global.id });
      }
    }
  }
  // Compute transitive global-read requirements across function calls.
  const requiredGlobals = new Map();
  for (const fn of functions) {
    const reads = new Set();
    for (const block of fn.blocks ?? []) for (const inst of block.instructions ?? [])
      if (inst.opcode === "LOAD" && globalIds.has(inst.operands?.variable)) reads.add(inst.operands.variable);
    requiredGlobals.set(fn.id, reads);
  }
  let readsChanged = true, readsRounds = 0;
  while (readsChanged && readsRounds++ < functions.length * 4 + 4) {
    readsChanged = false;
    for (const fn of functions) {
      const reads = requiredGlobals.get(fn.id);
      for (const block of fn.blocks ?? []) for (const inst of block.instructions ?? []) {
        if (inst.opcode !== "CALL") continue;
        for (const global of requiredGlobals.get(inst.operands?.function) ?? [])
          if (!reads.has(global)) { reads.add(global); readsChanged = true; }
      }
    }
  }
  const initFlow = flowByFunction.get(module.initializer.id);
  for (const block of module.initializer.blocks ?? []) {
    let state = new Set(initFlow?.inStates.get(block.id) ?? []);
    for (const inst of block.instructions ?? []) {
      const op = inst.operands ?? {};
      if (inst.opcode === "CALL") for (const global of requiredGlobals.get(op.function) ?? [])
        if (!state.has(global)) report("QIR_E_GLOBAL_READ_BEFORE_CALL", "Function may read a global before it is initialized", inst.source, { global });
      if (inst.opcode === "DECLARE" && globalIds.has(op.variable)) state.delete(op.variable);
      else if (inst.opcode === "STORE_GLOBAL" && globalIds.has(op.variable)) state.add(op.variable);
    }
  }

  for (const fn of functions) {
    for (const block of fn.blocks ?? []) for (const inst of block.instructions ?? []) {
      if (inst.opcode === "CALL") {
        const target = functionById.get(inst.operands?.function);
        const args = inst.operands?.arguments ?? [];
        if (!target) report("QIR_E_CALL_TARGET", "CALL references an unknown function", inst.source);
        else {
          if (args.length !== target.parameters.length) report("QIR_E_CALL_ARITY", "CALL argument count mismatch", inst.source);
          else args.forEach((arg, index) => {
            const actual = valueTypesByFunction.get(fn.id)?.get(arg);
            if (actual && actual !== target.parameters[index].type) report("QIR_E_CALL_TYPE", "CALL argument type mismatch at position " + (index + 1), inst.source);
          });
          if (inst.result && (target.return_type === "NULL" || inst.type !== target.return_type))
            report("QIR_E_CALL_RESULT", "CALL result is incompatible with target function return type", inst.source);
          if (!inst.result && target.return_type !== "NULL")
            report("QIR_E_CALL_RESULT", "Value-returning CALL must capture its result", inst.source);
        }
      }
      if (inst.opcode === "COMMAND_CALL" && !["DATA.COUNT", ...(["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) ? ["DATA.ADD", "DATA.REMOVE"] : []), ...(["1.2", "1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) ? ["UI.SHOW", "UI.TEXT"] : []), ...(["1.3", "1.4", "1.5", "1.6", "1.7"].includes(module.version) ? ["INTEGRATION.REQUEST"] : []), ...(["1.4", "1.5", "1.6", "1.7"].includes(module.version) ? ["UI.TREE"] : [])].includes(inst.operands?.command))
        report("QIR_E_COMMAND_NOT_ALLOWED", "Command is not allowed by this QIR version", inst.source);
    }
  }
  return diagnostics;
}

export function serializeQIR(module) {
  const diagnostics = validateQIR(module);
  if (diagnostics.length) {
    const error = new Error(diagnostics[0].message);
    error.name = "QIRValidationError";
    error.diagnostics = diagnostics;
    throw error;
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(module));
}

export function parseQIR(serialized) {
  let module;
  try { module = JSON.parse(serialized); }
  catch (error) { fail("QIR_E_INVALID_JSON", "Invalid QIR JSON: " + error.message); }
  const diagnostics = validateQIR(module);
  if (diagnostics.length) {
    const error = new Error(diagnostics[0].message);
    error.name = "QIRValidationError";
    error.diagnostics = diagnostics;
    throw error;
  }
  return module;
}
