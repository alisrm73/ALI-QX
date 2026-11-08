import { resolveCommand } from "./command-registry.js";

const TYPES = new Set(["TXT", "NUM", "BOOL", "LIST"]);
const loc = node => node?.location ?? { line: 1, column: 1, offset: 0 };

function diagnostic(code, message, node) {
  return { code, message, location: loc(node) };
}

class Scope {
  constructor(parent = null, kind = "module") {
    this.parent = parent;
    this.kind = kind;
    this.symbols = new Map();
  }
  lookup(name) {
    for (let scope = this; scope; scope = scope.parent) {
      if (scope.symbols.has(name)) return { symbol: scope.symbols.get(name), scope };
    }
    return null;
  }
}

export function analyze(program) {
  const diagnostics = [];
  const moduleScope = new Scope();
  const functionScopes = new Map();

  const report = (code, message, node) => diagnostics.push(diagnostic(code, message, node));
  const declare = (scope, name, type, node, kind = "variable") => {
    if (scope.symbols.has(name)) {
      report("QX3001", "Duplicate declaration in the same scope: " + name, node);
      return null;
    }
    if (scope.kind === "function" && scope.parent?.symbols.has(name)) {
      report("QX3002", "A local name cannot shadow a module variable: " + name, node);
      return null;
    }
    const symbol = { name, type, kind, location: loc(node) };
    scope.symbols.set(name, symbol);
    return symbol;
  };

  function expression(node, scope) {
    if (!node) return "NULL";
    switch (node.type) {
      case "NumberLiteral": return "NUM";
      case "StringLiteral": return "TXT";
      case "BooleanLiteral": return "BOOL";
      case "NullLiteral": return "NULL";
      case "Identifier": {
        const found = scope.lookup(node.name);
        if (!found) {
          report("QX3003", "Undeclared identifier: " + node.name, node);
          return "ERROR";
        }
        return found.symbol.type;
      }
      case "GroupExpression":
        return expression(node.expression, scope);
      case "ListLiteral":
        for (const element of node.elements) expression(element, scope);
        return "LIST";
      case "UnaryExpression": {
        const type = expression(node.argument, scope);
        if (type === "ERROR") return type;
        if (node.operator === "NOT") {
          if (type !== "BOOL") report("QX3004", "NOT requires BOOL, received " + type, node);
          return type === "BOOL" ? "BOOL" : "ERROR";
        }
        if (type !== "NUM") report("QX3005", "Unary " + node.operator + " requires NUM, received " + type, node);
        return type === "NUM" ? "NUM" : "ERROR";
      }
      case "BinaryExpression": {
        const left = expression(node.left, scope);
        const right = expression(node.right, scope);
        if (left === "ERROR" || right === "ERROR") return "ERROR";
        const op = node.operator;
        if (op === "+" && left === right && (left === "NUM" || left === "TXT")) return left;
        if (["-", "*", "/", "%"].includes(op)) {
          if (left !== "NUM" || right !== "NUM") {
            report("QX3006", op + " requires two NUM operands", node);
            return "ERROR";
          }
          if (op === "%" && (!Number.isInteger(node.left.value) || !Number.isInteger(node.right.value))) {
            // Integer-ness of non-literal expressions is a runtime property.
          }
          return "NUM";
        }
        if (op === "+" ) {
          report("QX3007", "+ requires two NUM operands or two TXT operands", node);
          return "ERROR";
        }
        if (["AND", "OR"].includes(op)) {
          if (left !== "BOOL" || right !== "BOOL") {
            report("QX3008", op + " requires two BOOL operands", node);
            return "ERROR";
          }
          return "BOOL";
        }
        if (["==", "!="].includes(op)) {
          if (left !== right || !TYPES.has(left)) {
            report("QX3009", op + " requires operands of the same compatible type", node);
            return "ERROR";
          }
          return "BOOL";
        }
        if ([">", ">=", "<", "<="].includes(op)) {
          if (left !== right || !["NUM", "TXT"].includes(left)) {
            report("QX3010", op + " requires two NUM operands or two TXT operands", node);
            return "ERROR";
          }
          return "BOOL";
        }
        return "ERROR";
      }
      case "CommandCallExpression": {
        const command = resolveCommand(node.domain, node.command);
        if (!command) {
          report("QX3011", "Unknown command: " + node.domain + "." + node.command, node);
          return "ERROR";
        }
        if (command.id !== "DATA.COUNT") {
          report("QX3012", "This command has no approved value-returning expression contract", node);
          return "ERROR";
        }
        if (node.args.length !== 1) {
          report("QX3013", "DATA.COUNT expects exactly one argument", node);
          node.args.forEach(arg => expression(arg, scope));
          return "ERROR";
        }
        const argType = expression(node.args[0], scope);
        if (argType !== "LIST" && argType !== "ERROR") {
          report("QX3014", "DATA.COUNT expects LIST, received " + argType, node.args[0]);
          return "ERROR";
        }
        return argType === "LIST" ? "NUM" : "ERROR";
      }
      case "CallExpression":
        report("QX3015", "Function-call typing is not part of this semantic slice", node);
        return "ERROR";
      default:
        report("QX3016", "Unsupported expression node: " + node.type, node);
        return "ERROR";
    }
  }

  function command(node, scope) {
    const command = resolveCommand(node.domain, node.command);
    if (!command) {
      report("QX3011", "Unknown command: " + node.domain + "." + node.command, node);
      node.args.forEach(arg => expression(arg, scope));
      return;
    }
    if (command.id === "DATA.CREATE") {
      if (node.args.length !== 2 || node.args[0]?.type !== "Identifier") {
        report("QX3017", "DATA.CREATE expects an identifier and an initial value", node);
        node.args.forEach(arg => expression(arg, scope));
        return;
      }
      const type = expression(node.args[1], scope);
      if (!TYPES.has(type)) {
        report("QX3018", "DATA.CREATE cannot infer a variable type from " + type, node.args[1]);
        return;
      }
      declare(scope, node.args[0].name, type, node.args[0]);
      return;
    }
    if (command.id === "DATA.SET" || command.id === "DATA.SET_GLOBAL") {
      if (node.args.length !== 2 || node.args[0]?.type !== "Identifier") {
        report("QX3019", command.id + " expects an identifier and a value", node);
        node.args.forEach(arg => expression(arg, scope));
        return;
      }
      const name = node.args[0].name;
      const found = scope.lookup(name);
      if (!found) {
        report("QX3003", "Undeclared identifier: " + name, node.args[0]);
        expression(node.args[1], scope);
        return;
      }
      if (command.id === "DATA.SET" && scope.kind === "function" && found.scope.kind !== "function") {
        report("QX3020", "Use DATA.SET_GLOBAL to update a module variable inside a function", node);
        expression(node.args[1], scope);
        return;
      }
      if (command.id === "DATA.SET_GLOBAL" && found.scope.kind !== "module") {
        report("QX3021", "DATA.SET_GLOBAL requires an existing module variable", node.args[0]);
        expression(node.args[1], scope);
        return;
      }
      const valueType = expression(node.args[1], scope);
      if (valueType !== found.symbol.type && valueType !== "ERROR") {
        report("QX3022", "Cannot assign " + valueType + " to " + found.symbol.type + " variable " + name, node.args[1]);
      }
      return;
    }
    if (command.id === "PROCESS.CALCULATE" || command.id === "PROCESS.COMPARE") {
      const expected = command.id === "PROCESS.CALCULATE" ? "NUM" : "BOOL";
      if (node.args.length !== 2 || node.args[0]?.type !== "Identifier") {
        report("QX3023", command.id + " expects a target identifier and an expression", node);
        node.args.forEach(arg => expression(arg, scope));
        return;
      }
      const found = scope.lookup(node.args[0].name);
      if (!found) report("QX3003", "Undeclared target: " + node.args[0].name, node.args[0]);
      else if (found.symbol.type !== expected) report("QX3024", command.id + " target must be " + expected, node.args[0]);
      const actual = expression(node.args[1], scope);
      if (actual !== expected && actual !== "ERROR") report("QX3025", command.id + " expression must produce " + expected, node.args[1]);
      return;
    }
    // Other command signatures are intentionally unresolved in V1.
    node.args.forEach(arg => expression(arg, scope));
  }

  function statements(body, scope) {
    for (const node of body) {
      switch (node.type) {
        case "CommandStatement":
          command(node, scope);
          break;
        case "IfStatement": {
          const test = expression(node.test, scope);
          if (test !== "BOOL" && test !== "ERROR") report("QX3026", "IF condition must be BOOL", node.test);
          statements(node.consequent, scope);
          if (node.alternate) statements(node.alternate, scope);
          break;
        }
        case "WhileStatement": {
          const test = expression(node.test, scope);
          if (test !== "BOOL" && test !== "ERROR") report("QX3027", "WHILE condition must be BOOL", node.test);
          statements(node.body, scope);
          break;
        }
        case "FunctionDeclaration": {
          if (functionScopes.has(node.name)) {
            report("QX3001", "Duplicate function declaration: " + node.name, node);
            break;
          }
          const fnScope = new Scope(moduleScope, "function");
          functionScopes.set(node.name, { node, scope: fnScope });
          for (const param of node.params) declare(fnScope, param.name, "UNKNOWN", param, "parameter");
          report("QX3030", "Function-body analysis is deferred until parameter and return-type inference is implemented", node);
          break;
        }
        case "ReturnStatement":
          expression(node.argument, scope);
          break;
        case "ExpressionStatement":
          expression(node.expression, scope);
          break;
        default:
          report("QX3028", "Unsupported statement node: " + node.type, node);
      }
    }
  }

  statements(program.body, moduleScope);
  return {
    type: "SemanticAnalysis",
    valid: diagnostics.length === 0,
    diagnostics,
    symbols: [...moduleScope.symbols.values()].map(({ name, type, kind, location }) => ({ name, type, kind, location }))
  };
}
