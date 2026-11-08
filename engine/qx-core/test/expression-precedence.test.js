import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/index.js";

const expressionOf = source => parse(`DATA.CREATE(result, ${source})`).body[0].args[1];

test("multiplication and division bind more tightly than addition and subtraction", () => {
  const expression = expressionOf("2 + 3 * 4 - 8 / 2");

  assert.equal(expression.type, "BinaryExpression");
  assert.equal(expression.operator, "-");
  assert.equal(expression.left.operator, "+");
  assert.equal(expression.left.left.value, 2);
  assert.equal(expression.left.right.operator, "*");
  assert.equal(expression.left.right.left.value, 3);
  assert.equal(expression.left.right.right.value, 4);
  assert.equal(expression.right.operator, "/");
  assert.equal(expression.right.left.value, 8);
  assert.equal(expression.right.right.value, 2);
});

test("arithmetic operators of equal precedence associate from left to right", () => {
  const subtraction = expressionOf("20 - 5 - 3");
  assert.equal(subtraction.operator, "-");
  assert.equal(subtraction.left.operator, "-");
  assert.equal(subtraction.left.left.value, 20);
  assert.equal(subtraction.left.right.value, 5);
  assert.equal(subtraction.right.value, 3);

  const division = expressionOf("24 / 4 / 2");
  assert.equal(division.operator, "/");
  assert.equal(division.left.operator, "/");
  assert.equal(division.left.left.value, 24);
  assert.equal(division.left.right.value, 4);
  assert.equal(division.right.value, 2);
});

test("unary operators bind more tightly than binary arithmetic and groups override precedence", () => {
  const unary = expressionOf("-2 * +3");
  assert.equal(unary.operator, "*");
  assert.equal(unary.left.type, "UnaryExpression");
  assert.equal(unary.left.operator, "-");
  assert.equal(unary.left.argument.value, 2);
  assert.equal(unary.right.type, "UnaryExpression");
  assert.equal(unary.right.operator, "+");
  assert.equal(unary.right.argument.value, 3);

  const grouped = expressionOf("2 * (3 + 4)");
  assert.equal(grouped.operator, "*");
  assert.equal(grouped.left.value, 2);
  assert.equal(grouped.right.type, "GroupExpression");
  assert.equal(grouped.right.expression.operator, "+");
});

test("NOT binds more tightly than AND, which binds more tightly than OR", () => {
  const expression = expressionOf("active OR ready AND NOT blocked");

  assert.equal(expression.operator, "OR");
  assert.equal(expression.left.name, "active");
  assert.equal(expression.right.operator, "AND");
  assert.equal(expression.right.left.name, "ready");
  assert.equal(expression.right.right.type, "UnaryExpression");
  assert.equal(expression.right.right.operator, "NOT");
  assert.equal(expression.right.right.argument.name, "blocked");
});

test("comparisons bind more tightly than AND, which binds more tightly than OR", () => {
  const expression = expressionOf("a < b AND c == d OR e != f");

  assert.equal(expression.operator, "OR");
  assert.equal(expression.left.operator, "AND");
  assert.equal(expression.left.left.operator, "<");
  assert.equal(expression.left.right.operator, "==");
  assert.equal(expression.right.operator, "!=");
});
