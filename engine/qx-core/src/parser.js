import { tokenize } from "./lexer.js";

export class QXParseError extends Error {
  constructor(code, message, token) { super(message); this.name = "QXParseError"; this.code = code; this.location = { line: token.line, column: token.column, offset: token.offset }; this.token = token; }
}
const PREC = new Map([["OR",1],["AND",2],["EQ_EQ",3],["BANG_EQ",3],["GT",3],["GT_EQ",3],["LT",3],["LT_EQ",3],["PLUS",4],["MINUS",4],["STAR",5],["SLASH",5],["PERCENT",5]]);
const OP = new Map([["OR","OR"],["AND","AND"],["EQ_EQ","=="],["BANG_EQ","!="],["GT",">"],["GT_EQ",">="],["LT","<"],["LT_EQ","<="],["PLUS","+"],["MINUS","-"],["STAR","*"],["SLASH","/"],["PERCENT","%"]]);
const COMPARISONS = new Set(["==","!=",">",">=","<","<="]);

export class Parser {
  constructor(input) { this.tokens = typeof input === "string" ? tokenize(input) : input; this.i = 0; this.blockDepth = 0; this.functionDepth = 0; }
  peek(n = 0) { return this.tokens[Math.min(this.i + n, this.tokens.length - 1)]; }
  check(type) { return this.peek().type === type; }
  match(...types) { if (!types.includes(this.peek().type)) return false; this.i++; return true; }
  consume(type, message = "Expected " + type) { if (this.check(type)) return this.tokens[this.i++]; this.fail("QX2001", message); }
  fail(code, message) { throw new QXParseError(code, message, this.peek()); }
  newlines() { while (this.match("NEWLINE")) {} }
  loc(value) { return value.location ?? { line: value.line, column: value.column, offset: value.offset }; }
  boundary() { if (!this.check("NEWLINE") && !this.check("EOF") && !this.check("RBRACE")) this.fail("QX2003", "Each statement must occupy its own line"); }
  headerBreak(name) { if (!this.match("NEWLINE")) this.fail("QX2010", name + " header must end before its block starts"); }

  parse() {
    const body = []; this.newlines();
    while (!this.check("EOF")) {
      if (this.check("END") || this.check("ELSE") || this.check("RBRACE")) this.fail("QX2002", "Unexpected block terminator outside a matching block");
      body.push(this.statement()); this.boundary(); this.newlines();
    }
    return { type: "Program", body, location: { line: 1, column: 1, offset: 0 } };
  }
  statement() {
    switch (this.peek().type) {
      case "IF": return this.ifStatement();
      case "WHILE": return this.whileStatement();
      case "FUNCTION": return this.functionDeclaration();
      case "RETURN": return this.returnStatement();
      case "GEOMETRIC_SYMBOL": return this.geometricStatement();
      case "IDENTIFIER":
        if (this.peek(1).type === "DOT") return this.commandStatement();
        if (this.peek(1).type === "LPAREN") { const expression = this.expression(); return { type: "ExpressionStatement", expression, location: this.loc(expression) }; }
        this.fail("QX2004", "Expected a domain command or function call");
      default: this.fail("QX2005", "Unexpected token at the start of a statement: " + this.peek().type);
    }
  }
  geometricStatement() {
    const symbol = this.consume("GEOMETRIC_SYMBOL");
    const args = this.args();
    const body = this.match("LBRACE") ? this.geometricBlock() : null;
    let alternate = null;
    if (symbol.value === "IF" || symbol.value === "ELSE_IF") {
      const checkpoint = this.i;
      this.newlines();
      if (this.check("GEOMETRIC_SYMBOL") && (this.peek().value === "ELSE_IF" || this.peek().value === "ELSE")) {
        alternate = this.geometricStatement();
      } else {
        this.i = checkpoint;
      }
    }
    return {
      type: "GeometricStatement",
      symbol: symbol.value,
      glyph: symbol.glyph,
      group: symbol.group,
      args,
      body,
      alternate,
      location: this.loc(symbol)
    };
  }
  geometricBlock() {
    const body = [];
    this.newlines();
    while (!this.check("RBRACE") && !this.check("EOF")) {
      body.push(this.statement());
      this.boundary();
      this.newlines();
    }
    this.consume("RBRACE", "Expected '}' to close geometric block");
    return body;
  }
  commandStatement() {
    const domain = this.consume("IDENTIFIER", "Expected command domain");
    this.consume("DOT", "Expected '.' between domain and command");
    const command = this.consume("IDENTIFIER", "Expected command name");
    const args = this.args();
    return { type: "CommandStatement", domain: domain.value, command: command.value, args, location: this.loc(domain) };
  }
  args() {
    this.consume("LPAREN", "Expected '('"); const args = []; this.newlines();
    if (!this.check("RPAREN")) {
      do { this.newlines(); args.push(this.expression()); this.newlines(); } while (this.match("COMMA"));
    }
    this.consume("RPAREN", "Expected ')' after arguments"); return args;
  }
  ifStatement() {
    const start = this.consume("IF"); this.consume("LPAREN", "Expected '(' after IF"); const test = this.expression();
    this.consume("RPAREN", "Expected ')' after IF condition"); this.headerBreak("IF"); this.newlines();
    const consequent = this.block(["ELSE","END"]); let alternate = null;
    if (this.match("ELSE")) { this.headerBreak("ELSE"); this.newlines(); alternate = this.block(["END"]); }
    this.consume("END", "Expected END to close IF");
    return { type: "IfStatement", test, consequent, alternate, location: this.loc(start) };
  }
  whileStatement() {
    const start = this.consume("WHILE"); this.consume("LPAREN", "Expected '(' after WHILE"); const test = this.expression();
    this.consume("RPAREN", "Expected ')' after WHILE condition"); this.headerBreak("WHILE"); this.newlines();
    const body = this.block(["END"]); this.consume("END", "Expected END to close WHILE");
    return { type: "WhileStatement", test, body, location: this.loc(start) };
  }
  functionDeclaration() {
    if (this.blockDepth > 0) this.fail("QX2011", "FUNCTION declarations must be at top level in QX V1");
    const start = this.consume("FUNCTION"); const name = this.consume("IDENTIFIER", "Expected function name");
    const params = this.parameters(); this.headerBreak("FUNCTION"); this.newlines();
    this.functionDepth++;
    const body = this.block(["END"]); this.consume("END", "Expected END to close FUNCTION");
    this.functionDepth--;
    return { type: "FunctionDeclaration", name: name.value, params, body, location: this.loc(start) };
  }
  parameters() {
    this.consume("LPAREN", "Expected '(' after function name"); const params = []; this.newlines();
    if (!this.check("RPAREN")) {
      do { this.newlines(); const param = this.consume("IDENTIFIER", "Expected parameter name"); params.push({ type: "Identifier", name: param.value, location: this.loc(param) }); this.newlines(); } while (this.match("COMMA"));
    }
    this.consume("RPAREN", "Expected ')' after parameters"); return params;
  }
  returnStatement() {
    if (this.functionDepth === 0) this.fail("QX2012", "RETURN is only valid inside a FUNCTION");
    const start = this.consume("RETURN");
    if (this.check("NEWLINE") || this.check("END") || this.check("EOF")) this.fail("QX2006", "RETURN requires a value in QX V1");
    const argument = this.expression(); return { type: "ReturnStatement", argument, location: this.loc(start) };
  }
  block(stops) {
    const body = []; this.blockDepth++; this.newlines();
    while (!this.check("EOF") && !stops.includes(this.peek().type)) {
      if (this.check("END") || this.check("ELSE")) break;
      body.push(this.statement()); this.boundary(); this.newlines();
    }
    if (this.check("EOF")) this.fail("QX2007", "Unexpected end of file; missing END");
    this.blockDepth--;
    return body;
  }
  expression(min = 0) {
    let left = this.prefix();
    while (true) {
      const precedence = PREC.get(this.peek().type);
      if (precedence === undefined || precedence < min) break;
      const token = this.tokens[this.i++], operator = OP.get(token.type);
      if (COMPARISONS.has(operator) && left.type === "BinaryExpression" && COMPARISONS.has(left.operator)) this.fail("QX2008", "Chained comparisons are not supported; combine with AND");
      const right = this.expression(precedence + 1);
      left = { type: "BinaryExpression", operator, left, right, location: this.loc(left) };
    }
    return left;
  }
  prefix() {
    const token = this.peek();
    if (this.match("GEOMETRIC_SYMBOL")) {
      return {
        type: "GeometricCallExpression",
        symbol: token.value,
        glyph: token.glyph,
        group: token.group,
        args: this.args(),
        location: this.loc(token)
      };
    }
    if (this.match("NUMBER")) return { type: "NumberLiteral", value: token.value, location: this.loc(token) };
    if (this.match("STRING")) return { type: "StringLiteral", value: token.value, location: this.loc(token) };
    if (this.match("TRUE")) return { type: "BooleanLiteral", value: true, location: this.loc(token) };
    if (this.match("FALSE")) return { type: "BooleanLiteral", value: false, location: this.loc(token) };
    if (this.match("NULL")) return { type: "NullLiteral", value: null, location: this.loc(token) };
    if (this.match("NOT","PLUS","MINUS")) {
      const operator = token.type === "NOT" ? "NOT" : token.type === "PLUS" ? "+" : "-";
      return { type: "UnaryExpression", operator, argument: this.expression(6), location: this.loc(token) };
    }
    if (this.match("IDENTIFIER")) {
      if (this.match("DOT")) {
        const command = this.consume("IDENTIFIER", "Expected command name after domain separator");
        if (!this.check("LPAREN")) this.fail("QX2013", "A qualified command expression must include arguments");
        return { type: "CommandCallExpression", domain: token.value, command: command.value, args: this.args(), location: this.loc(token) };
      }
      const callee = { type: "Identifier", name: token.value, location: this.loc(token) };
      return this.check("LPAREN") ? { type: "CallExpression", callee, args: this.args(), location: this.loc(token) } : callee;
    }
    if (this.match("LPAREN")) {
      this.newlines(); const expression = this.expression(); this.newlines();
      this.consume("RPAREN", "Expected ')' after expression");
      return { type: "GroupExpression", expression, location: this.loc(token) };
    }
    if (this.match("LBRACKET")) {
      const elements = []; this.newlines();
      if (!this.check("RBRACKET")) {
        do { this.newlines(); elements.push(this.expression()); this.newlines(); } while (this.match("COMMA"));
      }
      this.consume("RBRACKET", "Expected ']' after list elements");
      return { type: "ListLiteral", elements, location: this.loc(token) };
    }
    this.fail("QX2009", "Expected expression, found " + token.type);
  }
}
export const parse = source => new Parser(source).parse();
