import test from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/index.js";
import { GEOMETRIC_SYMBOLS } from "../src/geometric-symbols.js";

test("registers exactly the 72 approved geometric symbols", () => {
  assert.equal(GEOMETRIC_SYMBOLS.length, 72);
  assert.equal(new Set(GEOMETRIC_SYMBOLS.map(item => item.glyph)).size, 72);
  assert.equal(new Set(GEOMETRIC_SYMBOLS.map(item => item.name)).size, 72);
});

test("tokenizes all approved glyphs as one native token each", () => {
  for (const symbol of GEOMETRIC_SYMBOLS) {
    const [token, eof] = tokenize(symbol.glyph);
    assert.equal(token.type, "GEOMETRIC_SYMBOL", symbol.name);
    assert.equal(token.value, symbol.name);
    assert.equal(token.glyph, symbol.glyph);
    assert.equal(token.group, symbol.group);
    assert.equal(token.raw, symbol.glyph);
    assert.equal(eof.type, "EOF");
  }
});

test("preserves the exact code-point sequences of composite glyphs", () => {
  for (const glyph of ["⛓️‍💥", "⬢⃝", "⬣⃝"]) {
    const [token] = tokenize(glyph);
    assert.equal(token.raw, glyph);
    assert.equal(token.glyph, glyph);
  }
});

test("does not split adjacent geometric symbols", () => {
  const tokens = tokenize("⬡⬢◈").filter(token => token.type !== "EOF");
  assert.deepEqual(tokens.map(token => token.value), ["ORIGIN", "FORM", "CORE"]);
});
