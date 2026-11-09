import { resolveCommand } from "./command-registry.js";

const TYPES = new Set(["TXT", "NUM", "BOOL", "LIST"]);
const VALUE_TYPES = [...TYPES];
const loc = node => node?.location ?? { line: 1, column: 1, offset: 0 };

class TypeCell {
  constructor(label = "") { this.parent = this; this.allowed = new Set(VALUE_TYPES); this.label = label; this.evidence = null; }
}
function root(cell) { if (cell.parent !== cell) cell.parent = root(cell.parent); return cell.parent; }
function unify(a, b, node) {
  const x = root(a), y = root(b); if (x === y) return;
  const common = new Set([...x.allowed].filter(type => y.allowed.has(type)));
  y.parent = x; x.allowed = common; x.evidence ??= y.evidence ?? node;
}
const concrete = type => { const c = new TypeCell(type); c.allowed = new Set([type]); return c; };
const typeOf = cell => { const r = root(cell); return r.allowed.size === 1 ? [...r.allowed][0] : "UNKNOWN"; };

class Scope {
  constructor(parent = null, kind = "module") { this.parent = parent; this.kind = kind; this.symbols = new Map(); }
  lookup(name) { for (let s = this; s; s = s.parent) if (s.symbols.has(name)) return { symbol: s.symbols.get(name), scope: s }; return null; }
}

export function analyze(program) {
  const diagnostics = [], moduleScope = new Scope(), functions = new Map();
  const reported = new Set();
  const report = (code, message, node) => {
    const l = loc(node), key = `${code}:${l.offset}:${message}`;
    if (!reported.has(key)) { reported.add(key); diagnostics.push({ code, message, location: l }); }
  };
  const constrain = (cell, types, node, code, message) => {
    const r = root(cell);
    if (r.allowed.size === 1 && r.allowed.has("ERROR")) return true;
    const common = [...r.allowed].filter(type => types.includes(type));
    if (!common.length) { report(code, message, node); return false; }
    r.allowed = new Set(common); r.evidence ??= node; return true;
  };
  const join = (a, b, node, code = "QX3031", message = "Conflicting type constraints") => {
    const x = root(a), y = root(b);
    if (x === y) return true;
    if ((x.allowed.size === 1 && x.allowed.has("ERROR")) ||
        (y.allowed.size === 1 && y.allowed.has("ERROR"))) return true;
    if (![...x.allowed].some(type => y.allowed.has(type))) { report(code, message, node); return false; }
    unify(x, y, node); return true;
  };

  // Register every function before analyzing bodies, enabling forward and recursive calls.
  for (const node of program.body) if (node.type === "FunctionDeclaration") {
    if (functions.has(node.name)) report("QX3001", "Duplicate function declaration: " + node.name, node);
    else functions.set(node.name, { node, params: node.params.map(p => ({ node: p, cell: new TypeCell(`${node.name}.${p.name}`) })), result: new TypeCell(`${node.name}.return`), returnNodes: [], valueUses: [] });
  }

  function declare(scope, name, cell, node, kind = "variable") {
    if (scope.symbols.has(name)) { report("QX3001", "Duplicate declaration in the same scope: " + name, node); return null; }
    if (scope.kind === "function" && scope.parent?.symbols.has(name)) { report("QX3002", "A local name cannot shadow a module variable: " + name, node); return null; }
    const symbol = { name, cell, kind, location: loc(node) }; scope.symbols.set(name, symbol); return symbol;
  }

  function expression(node, scope, requireValue = true, expected = null) {
    if (!node) return concrete("NULL");
    let out;
    switch (node.type) {
      case "NumberLiteral": out = concrete("NUM"); break;
      case "StringLiteral": out = concrete("TXT"); break;
      case "BooleanLiteral": out = concrete("BOOL"); break;
      case "NullLiteral": out = concrete("NULL"); break;
      case "Identifier": {
        const found = scope.lookup(node.name);
        if (!found) { report("QX3003", "Undeclared identifier: " + node.name, node); out = concrete("ERROR"); }
        else out = found.symbol.cell;
        break;
      }
      case "GroupExpression": out = expression(node.expression, scope, requireValue); break;
      case "ListLiteral": node.elements.forEach(e => expression(e, scope)); out = concrete("LIST"); break;
      case "UnaryExpression": {
        const arg = expression(node.argument, scope);
        if (node.operator === "NOT") { constrain(arg, ["BOOL"], node, "QX3004", "NOT requires BOOL"); out = concrete("BOOL"); }
        else { constrain(arg, ["NUM"], node, "QX3005", "Unary " + node.operator + " requires NUM"); out = concrete("NUM"); }
        break;
      }
      case "BinaryExpression": {
        const left = expression(node.left, scope), right = expression(node.right, scope), op = node.operator;
        if (["-", "*", "/", "%"].includes(op)) {
          constrain(left, ["NUM"], node.left, "QX3006", op + " requires two NUM operands");
          constrain(right, ["NUM"], node.right, "QX3006", op + " requires two NUM operands"); out = concrete("NUM");
        } else if (op === "+") {
          join(left, right, node, "QX3007", "+ requires two NUM operands or two TXT operands"); constrain(left, ["NUM", "TXT"], node, "QX3007", "+ requires two NUM operands or two TXT operands"); out = left;
        } else if (["AND", "OR"].includes(op)) {
          constrain(left, ["BOOL"], node.left, "QX3008", op + " requires two BOOL operands");
          constrain(right, ["BOOL"], node.right, "QX3008", op + " requires two BOOL operands"); out = concrete("BOOL");
        } else if (["==", "!="].includes(op)) {
          join(left, right, node, "QX3009", op + " requires operands of the same compatible type"); constrain(left, VALUE_TYPES, node, "QX3009", op + " requires operands of the same compatible type"); out = concrete("BOOL");
        } else if ([">", ">=", "<", "<="].includes(op)) {
          join(left, right, node, "QX3010", op + " requires two NUM operands or two TXT operands"); constrain(left, ["NUM", "TXT"], node, "QX3010", op + " requires two NUM operands or two TXT operands"); out = concrete("BOOL");
        } else out = concrete("ERROR");
        break;
      }
      case "CommandCallExpression": {
        const cmd = resolveCommand(node.domain, node.command);
        if (!cmd) { report("QX3011", "Unknown command: " + node.domain + "." + node.command, node); node.args.forEach(a => expression(a, scope)); out = concrete("ERROR"); break; }
        if (cmd.id === "DATA.COUNT") {
          if (node.args.length !== 1) { report("QX3013", "DATA.COUNT expects exactly one argument", node); node.args.forEach(a => expression(a, scope)); out = concrete("ERROR"); break; }
          const arg = expression(node.args[0], scope); constrain(arg, ["LIST"], node.args[0], "QX3014", "DATA.COUNT expects LIST"); out = concrete("NUM"); break;
        }
        if (cmd.id === "DATA.ADD" || cmd.id === "DATA.REMOVE") {
          if (node.args.length !== 2) { report("QX3041", cmd.id + " expects exactly two arguments", node); node.args.forEach(a => expression(a, scope)); out = concrete("ERROR"); break; }
          const list = expression(node.args[0], scope); constrain(list, ["LIST"], node.args[0], "QX3042", cmd.id + " first argument must be LIST");
          const value = expression(node.args[1], scope);
          if (cmd.id === "DATA.REMOVE") constrain(value, ["NUM"], node.args[1], "QX3043", "DATA.REMOVE index must be NUM");
          out = concrete("LIST"); break;
        }
        if (cmd.id === "UI.SHOW" || cmd.id === "UI.TEXT" || cmd.id === "UI.TREE") {
          report("QX3045", cmd.id + " is a UI statement and cannot be used as an expression", node);
          node.args.forEach(a => expression(a, scope)); out = concrete("ERROR"); break;
        }
        if (cmd.id === "INTEGRATION.REQUEST") {
          if (node.args.length !== 3) {
            report("QX3050", "INTEGRATION.REQUEST expects connector, operation, and JSON payload text", node);
            node.args.forEach(a => expression(a, scope)); out = concrete("ERROR"); break;
          }
          node.args.forEach((arg, index) =>
            constrain(expression(arg, scope), ["TXT"], arg, "QX3051", "INTEGRATION.REQUEST argument " + (index + 1) + " must be TXT"));
          out = concrete("TXT"); break;
        }
        report("QX3012", "This command has no approved value-returning expression contract", node); node.args.forEach(a => expression(a, scope)); out = concrete("ERROR"); break;
      }
      case "CallExpression": {
        const fn = node.callee?.type === "Identifier" ? functions.get(node.callee.name) : null;
        if (!fn) { report("QX3033", "Unknown function: " + (node.callee?.name ?? "<expression>"), node.callee ?? node); node.args.forEach(a => expression(a, scope)); out = concrete("ERROR"); break; }
        if (requireValue) fn.valueUses.push(node);
        if (node.args.length !== fn.params.length) report("QX3034", `${fn.node.name} expects ${fn.params.length} arguments, received ${node.args.length}`, node);
        node.args.forEach((arg, i) => {
          const actual = expression(arg, scope);
          if (fn.params[i]) join(fn.params[i].cell, actual, arg, "QX3037", `Argument ${i + 1} of ${fn.node.name} has an incompatible type`);
        });
        out = fn.result; break;
      }
      default: report("QX3016", "Unsupported expression node: " + node.type, node); out = concrete("ERROR");
    }
    if (expected) join(out, expected, node);
    return out;
  }

  function command(node, scope) {
    const cmd = resolveCommand(node.domain, node.command);
    if (!cmd) { report("QX3011", "Unknown command: " + node.domain + "." + node.command, node); node.args.forEach(a => expression(a, scope)); return; }
    if (cmd.id === "DATA.CREATE") {
      if (node.args.length !== 2 || node.args[0]?.type !== "Identifier") { report("QX3017", "DATA.CREATE expects an identifier and an initial value", node); node.args.forEach(a => expression(a, scope)); return; }
      const value = expression(node.args[1], scope), name = node.args[0].name;
      if (typeOf(value) === "NULL") { report("QX3018", "DATA.CREATE cannot infer a variable type from NULL", node.args[1]); return; }
      declare(scope, name, value, node.args[0]); return;
    }
    if (["DATA.SET", "DATA.SET_GLOBAL"].includes(cmd.id)) {
      if (node.args.length !== 2 || node.args[0]?.type !== "Identifier") { report("QX3019", cmd.id + " expects an identifier and a value", node); node.args.forEach(a => expression(a, scope)); return; }
      const found = scope.lookup(node.args[0].name);
      if (!found) { report("QX3003", "Undeclared identifier: " + node.args[0].name, node.args[0]); expression(node.args[1], scope); return; }
      if (cmd.id === "DATA.SET" && scope.kind === "function" && found.scope.kind !== "function") report("QX3020", "Use DATA.SET_GLOBAL to update a module variable inside a function", node);
      if (cmd.id === "DATA.SET_GLOBAL" && scope.kind !== "function") report("QX3021", "DATA.SET_GLOBAL is only valid inside a function", node);
      if (cmd.id === "DATA.SET_GLOBAL" && found.scope.kind !== "module") report("QX3021", "DATA.SET_GLOBAL requires an existing module variable", node.args[0]);
      join(found.symbol.cell, expression(node.args[1], scope), node.args[1], "QX3022", "Assigned value has a different type from variable " + node.args[0].name); return;
    }
    if (["PROCESS.ADD", "PROCESS.CALCULATE", "PROCESS.COMPARE"].includes(cmd.id)) {
      const required = cmd.id === "PROCESS.COMPARE" ? "BOOL" : "NUM";
      if (node.args.length !== 2 || node.args[0]?.type !== "Identifier") { report("QX3023", cmd.id + " expects a target identifier and an expression", node); node.args.forEach(a => expression(a, scope)); return; }
      const found = scope.lookup(node.args[0].name);
      if (!found) report("QX3003", "Undeclared target: " + node.args[0].name, node.args[0]);
      else {
        constrain(found.symbol.cell, [required], node.args[0], "QX3024", cmd.id + " target must be " + required);
        if (cmd.id === "PROCESS.ADD" && scope.kind === "function" && found.scope.kind !== "function")
          report("QX3020", "Use DATA.SET_GLOBAL inside a function to update a module variable", node);
      }
      constrain(expression(node.args[1], scope), [required], node.args[1], "QX3025", cmd.id + " expression must produce " + required); return;
    }
    if (cmd.id === "DATA.ADD" || cmd.id === "DATA.REMOVE") {
      report("QX3044", cmd.id + " is an expression and cannot be used as a command statement", node);
      node.args.forEach(a => expression(a, scope));
      return;
    }
    if (cmd.id === "DATA.COUNT") {
      if (node.args.length !== 1) {
        report("QX3013", "DATA.COUNT expects exactly one argument", node);
        node.args.forEach(a => expression(a, scope));
        return;
      }
      constrain(expression(node.args[0], scope), ["LIST"], node.args[0], "QX3014", "DATA.COUNT expects LIST");
      return;
    }
    if (cmd.id === "UI.SHOW" || cmd.id === "UI.TEXT") {
      if (node.args.length !== 1) {
        report("QX3046", cmd.id + " expects exactly one argument", node);
        node.args.forEach(a => expression(a, scope));
        return;
      }
      const value = expression(node.args[0], scope);
      if (cmd.id === "UI.TEXT") constrain(value, ["TXT"], node.args[0], "QX3047", "UI.TEXT expects TXT");
      if (cmd.id === "UI.TREE") constrain(value, ["TXT"], node.args[0], "QX3060", "UI.TREE expects a TXT JSON tree");
      return;
    }
    if (cmd.id === "INTEGRATION.REQUEST") {
      report("QX3052", "INTEGRATION.REQUEST is a value-returning expression and cannot be used as a command statement", node);
      node.args.forEach(a => expression(a, scope));
      return;
    }
    if (!["DATA.CREATE", "DATA.SET", "DATA.SET_GLOBAL"].includes(cmd.id) && !cmd.enabled) {
      report("QX3040", "Command has no approved semantic contract: " + cmd.id, node);
      node.args.forEach(a => expression(a, scope));
      return;
    }
    node.args.forEach(a => expression(a, scope));
  }

  function block(body, scope, fn = null) {
    let guaranteedReturn = false;
    for (const node of body) {
      switch (node.type) {
        case "CommandStatement": command(node, scope); break;
        case "IfStatement": {
          constrain(expression(node.test, scope), ["BOOL"], node.test, "QX3026", "IF condition must be BOOL");
          const a = block(node.consequent, scope, fn), b = node.alternate ? block(node.alternate, scope, fn) : false;
          if (a && b) guaranteedReturn = true;
          break;
        }
        case "WhileStatement":
          constrain(expression(node.test, scope), ["BOOL"], node.test, "QX3027", "WHILE condition must be BOOL");
          block(node.body, scope, fn); break;
        case "ReturnStatement": {
          const value = expression(node.argument, scope);
          if (!fn) report("QX3035", "RETURN is only valid inside a function", node);
          else { fn.returnNodes.push(node); join(fn.result, value, node.argument, "QX3038", `Return type conflicts with another return path in ${fn.node.name}`); }
          guaranteedReturn = true; break;
        }
        case "ExpressionStatement":
          // A bare function call may be a procedure statement; calls nested in
          // any value expression still require a return value.
          expression(node.expression, scope, node.expression?.type !== "CallExpression");
          break;
        default: report("QX3028", "Unsupported statement node: " + node.type, node);
      }
    }
    return guaranteedReturn;
  }

  // Module declarations are analyzed first to establish globals and function contracts.
  for (const node of program.body) if (node.type !== "FunctionDeclaration") block([node], moduleScope);
  for (const fn of functions.values()) {
    const scope = new Scope(moduleScope, "function"); fn.params.forEach(p => declare(scope, p.node.name, p.cell, p.node, "parameter"));
    const returnsAllPaths = block(fn.node.body, scope, fn);
    if (!fn.returnNodes.length) {
      root(fn.result).allowed = new Set(["NULL"]);
    } else if (!returnsAllPaths) {
      report("QX3032", `Function ${fn.node.name} has a return path that can fall through without a value`, fn.node);
    }
  }

  // Validate value use after every procedure/function result has been resolved;
  // this also handles forward calls and procedures returned through other functions.
  for (const fn of functions.values()) {
    if (!fn.returnNodes.length && fn.valueUses.length)
      report("QX3039", `Procedure ${fn.node.name} is used where a returned value is required`, fn.valueUses[0]);
    if (fn.returnNodes.length && typeOf(fn.result) === "NULL")
      report("QX3038", `Function ${fn.node.name} cannot return NULL as an inferable value`, fn.node);
  }

  // Resolve all constraints after the complete call graph and all function bodies have contributed evidence.
  const allCells = new Set();
  const collect = scope => { for (const symbol of scope.symbols.values()) allCells.add(root(symbol.cell)); };
  collect(moduleScope);
  for (const fn of functions.values()) {
    for (const p of fn.params) allCells.add(root(p.cell));
    allCells.add(root(fn.result));
  }
  for (const cell of allCells) if (root(cell).allowed.size > 1) {
    const r = root(cell);
    // Only report unresolved public function contracts and module symbols; locals are implementation details.
    if (r.label && (r.label.includes(".") || [...moduleScope.symbols.values()].some(s => root(s.cell) === r)))
      report("QX3036", `Cannot infer a unique type for ${r.label || "value"}`, r.evidence);
  }
  for (const symbol of moduleScope.symbols.values()) {
    const inferred = typeOf(symbol.cell);
    if (inferred === "NULL") report("QX3018", `DATA.CREATE cannot infer a variable type from NULL: ${symbol.name}`, { location: symbol.location });
    else if (inferred === "UNKNOWN") report("QX3036", `Cannot infer a unique type for module variable ${symbol.name}`, { location: symbol.location });
  }

  return {
    type: "SemanticAnalysis", valid: diagnostics.length === 0, diagnostics,
    symbols: [...moduleScope.symbols.values()].map(({ name, cell, kind, location }) => ({ name, type: typeOf(cell), kind, location })),
    functions: [...functions.values()].map(fn => ({ name: fn.node.name, parameters: fn.params.map(p => ({ name: p.node.name, type: typeOf(p.cell) })), returnType: typeOf(fn.result), kind: typeOf(fn.result) === "NULL" ? "procedure" : "function" }))
  };
}
