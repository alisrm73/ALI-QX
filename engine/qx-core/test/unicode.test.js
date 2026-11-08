import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, Lexer, QXLexError } from "../src/index.js";
import {
  UNICODE_VERSION, isXIDStart, isXIDContinue, isLetter, isLatin, isArabic,
  isDefaultIgnorable, normalizeNFC
} from "../src/unicode.js";

test("pins lexer and Unicode tables to Unicode 18.0.0", () => {
  assert.equal(UNICODE_VERSION, "18.0.0");
  assert.equal(new Lexer("").unicodeVersion, "18.0.0");
});

test("uses Unicode 18 XID and script data for newly assigned letters", () => {
  const garayLetter = 0x10ED9;
  assert.equal(isXIDStart(garayLetter), true);
  assert.equal(isXIDContinue(garayLetter), true);
  assert.equal(isLetter(garayLetter), true);
  assert.equal(isArabic(garayLetter), true);
  assert.equal(tokenize(String.fromCodePoint(garayLetter))[0].type, "IDENTIFIER");
  const latinLetter = 0x1DF1F;
  assert.equal(isXIDStart(latinLetter), true);
  assert.equal(isLatin(latinLetter), true);
  assert.equal(tokenize(String.fromCodePoint(latinLetter))[0].type, "IDENTIFIER");
});

test("keeps QX V1 identifiers limited to Arabic and Latin letters", () => {
  assert.equal(isLetter(0x03B1), true);
  assert.throws(() => tokenize("αname"), error => error instanceof QXLexError && error.code === "QX1008");
  assert.throws(() => tokenize("℘name"), error => error instanceof QXLexError && error.code === "QX1008");
});

test("uses pinned Default_Ignorable_Code_Point data", () => {
  assert.equal(isDefaultIgnorable(0x200E), true);
  assert.throws(() => tokenize("name\u200E"), error => error instanceof QXLexError && error.code === "QX1007");
});

test("normalizes canonical compositions, reordering, and Hangul with Unicode 18 data", () => {
  assert.equal(normalizeNFC("cafe\u0301"), "café");
  assert.equal(normalizeNFC("A\u030A\u0301"), "Ǻ");
  assert.equal(normalizeNFC("\u1100\u1161\u11A8"), "각");
  assert.equal(normalizeNFC("\u1E0A\u0323"), "Ḍ\u0307");
  assert.equal(normalizeNFC("a\u05B1\u05B0\u094D\u05C8b"), "a\u094D\u05B0\u05C8\u05B1b");
});
