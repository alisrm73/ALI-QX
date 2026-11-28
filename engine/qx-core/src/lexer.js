import { GEOMETRIC_SYMBOLS } from "./geometric-symbols.js";
import {
  UNICODE_VERSION, isXIDStart, isXIDContinue, isLetter, isLatin, isArabic,
  isDefaultIgnorable, normalizeNFC
} from "./unicode.js";

const KEYWORDS = new Map([
  ["IF", "IF"], ["إذا", "IF"], ["ELSE", "ELSE"], ["وإلا", "ELSE"],
  ["END", "END"], ["نهاية", "END"], ["WHILE", "WHILE"], ["طالما", "WHILE"],
  ["FUNCTION", "FUNCTION"], ["دالة", "FUNCTION"], ["RETURN", "RETURN"], ["أرجع", "RETURN"],
  ["TRUE", "TRUE"], ["صحيح", "TRUE"], ["FALSE", "FALSE"], ["خطأ", "FALSE"],
  ["NULL", "NULL"], ["فارغ", "NULL"], ["AND", "AND"], ["و", "AND"],
  ["OR", "OR"], ["أو", "OR"], ["NOT", "NOT"], ["ليس", "NOT"]
]);
const PUNCT = new Map(Object.entries({ "(": "LPAREN", ")": "RPAREN", "{": "LBRACE", "}": "RBRACE", "[": "LBRACKET", "]": "RBRACKET", ",": "COMMA", ":": "COLON", ".": "DOT", "+": "PLUS", "-": "MINUS", "*": "STAR", "/": "SLASH", "%": "PERCENT", ">": "GT", "<": "LT" }));
const GEOMETRIC_SYMBOLS_LONGEST_FIRST = [...GEOMETRIC_SYMBOLS].sort((a, b) => b.glyph.length - a.glyph.length);
const PAIRS = new Map([["==", "EQ_EQ"], ["!=", "BANG_EQ"], [">=", "GT_EQ"], ["<=", "LT_EQ"]]);

export class QXLexError extends Error {
  constructor(code, message, location) { super(message); this.name = "QXLexError"; this.code = code; this.location = location; }
}

export class Lexer {
  constructor(source) {
    if (typeof source !== "string") throw new TypeError("QX source must be a string");
    this.source = source; this.i = 0; this.line = 1; this.column = 1; this.tokens = [];
    this.unicodeVersion = UNICODE_VERSION;
  }
  peek() { return this.i < this.source.length ? String.fromCodePoint(this.source.codePointAt(this.i)) : null; }
  peekNext() {
    const ch = this.peek();
    return ch === null ? null : (this.i + ch.length < this.source.length ? String.fromCodePoint(this.source.codePointAt(this.i + ch.length)) : null);
  }
  take() {
    const ch = this.peek(); if (ch === null) return null;
    this.i += ch.length;
    if (ch === "\r") { if (this.peek() === "\n") this.i++; this.line++; this.column = 1; }
    else if (ch === "\n") { this.line++; this.column = 1; }
    else this.column++;
    return ch;
  }
  loc() { return { line: this.line, column: this.column, offset: this.i }; }
  add(type, value, start, raw = value, extra = {}) { this.tokens.push({ type, value, raw, line: start.line, column: start.column, offset: start.offset, endLine: this.line, endColumn: this.column, endOffset: this.i, ...extra }); }
  geometricSymbol() {
    const symbol = GEOMETRIC_SYMBOLS_LONGEST_FIRST.find(item => this.source.startsWith(item.glyph, this.i));
    if (!symbol) return false;
    const start = this.loc();
    for (const _ of symbol.glyph) this.take();
    this.add("GEOMETRIC_SYMBOL", symbol.name, start, symbol.glyph, { glyph: symbol.glyph, group: symbol.group });
    return true;
  }
  error(code, message, at = this.loc()) { throw new QXLexError(code, message, at); }
  comment() { while (this.peek() !== null && this.peek() !== "\n" && this.peek() !== "\r") this.take(); }
  string() {
    const start = this.loc(); this.take(); let value = "";
    while (this.peek() !== null) {
      const ch = this.take();
      if (ch === '"') { this.add("STRING", value, start, this.source.slice(start.offset, this.i)); return; }
      if (ch === "\n" || ch === "\r") this.error("QX1004", "Unterminated string literal", start);
      if (ch === "\\") {
        const e = this.take(); const map = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" };
        if (e === null || !Object.hasOwn(map, e)) this.error("QX1005", "Unsupported escape sequence: \\" + (e ?? ""), start);
        value += map[e];
      } else value += ch;
    }
    this.error("QX1004", "Unterminated string literal", start);
  }
  number() {
    const start = this.loc(); while (/[0-9]/.test(this.peek() ?? "")) this.take();
    if (this.peek() === "." && /[0-9]/.test(this.peekNext() ?? "")) { this.take(); while (/[0-9]/.test(this.peek() ?? "")) this.take(); }
    const raw = this.source.slice(start.offset, this.i); this.add("NUMBER", Number(raw), start, raw);
  }
  identifier() {
    const start = this.loc(), first = this.peek(); this.take();
    while (this.peek() !== null && isXIDContinue(this.peek().codePointAt(0))) this.take();
    const raw = this.source.slice(start.offset, this.i); let script = null;
    const firstCodePoint = first.codePointAt(0);
    if (!isLetter(firstCodePoint) || (!isLatin(firstCodePoint) && !isArabic(firstCodePoint))) this.error("QX1008", "Identifiers must start with an Arabic or Latin letter", start);
    for (const ch of raw) {
      const cp = ch.codePointAt(0);
      if (isDefaultIgnorable(cp)) this.error("QX1007", "Invisible characters are not allowed in identifiers", start);
      if (isLetter(cp)) {
        const next = isLatin(cp) ? "Latin" : isArabic(cp) ? "Arabic" : null;
        if (!next) this.error("QX1008", "Only Arabic and Latin letters are supported in V1 identifiers", start);
        if (script && script !== next) this.error("QX1009", "An identifier cannot mix Arabic and Latin letters", start);
        script = next;
      }
    }
    const normalized = normalizeNFC(raw);
    const asciiFolded = normalized.replace(/[a-z]/g, ch => ch.toUpperCase());
    const keyword = KEYWORDS.get(normalized) ?? KEYWORDS.get(asciiFolded);
    this.add(keyword ?? "IDENTIFIER", keyword ?? normalized, start, raw);
  }
  tokenize() {
    while (this.peek() !== null) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\f") { this.take(); continue; }
      if (ch === "\n" || ch === "\r") { const start = this.loc(); this.take(); this.add("NEWLINE", "\n", start, "\n"); continue; }
      if (ch === "/" && this.peekNext() === "/") { this.take(); this.take(); this.comment(); continue; }
      if (ch === '"') { this.string(); continue; }
      // Match approved multi-code-point glyphs before rejecting default-ignorable
      // code points (variation selectors, combining marks, and ZWJ sequences).
      if (this.geometricSymbol()) continue;
      if (isDefaultIgnorable(ch.codePointAt(0))) this.error("QX1007", "Invisible or default-ignorable characters are not allowed in source identifiers", this.loc());
      if (/[0-9]/.test(ch)) { this.number(); continue; }
      if (isXIDStart(ch.codePointAt(0))) { this.identifier(); continue; }
      const start = this.loc(), pair = ch + (this.peekNext() ?? "");
      if (PAIRS.has(pair)) { this.take(); this.take(); this.add(PAIRS.get(pair), pair, start, pair); continue; }
      if (PUNCT.has(ch)) { this.take(); this.add(PUNCT.get(ch), ch, start, ch); continue; }
      this.error("QX1001", "Unexpected character: " + JSON.stringify(ch), start);
    }
    const end = this.loc(); this.tokens.push({ type: "EOF", value: null, raw: "", ...end, endLine: end.line, endColumn: end.column, endOffset: end.offset });
    return this.tokens;
  }
}
export const tokenize = source => new Lexer(source).tokenize();
