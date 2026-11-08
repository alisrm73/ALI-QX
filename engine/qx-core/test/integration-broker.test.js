import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationBroker, QXIntegrationError } from "../src/index.js";

const connector = (invoke = async () => '{"ok":true}') => ({
  demo: { id: "demo", version: "1.0.0", operations: { lookup: { permissions: ["demo:read"], invoke } } }
});
const grant = [{ connector: "demo", operation: "lookup", permissions: ["demo:read"] }];
const makeBroker = (invoke, options = {}) => createIntegrationBroker({
  connectors: connector(invoke), grants: options.grants ?? grant, limits: options.limits
});

test("dispatches a registered operation and returns bounded JSON", async () => {
  let observed;
  const broker = makeBroker(async request => { observed = request; return '{"value":42}'; });
  assert.equal(await broker.request("demo", "lookup", '{"query":"QX"}'), '{"value":42}');
  assert.equal(observed.connector, "demo");
  assert.equal(observed.connectorVersion, "1.0.0");
  assert.deepEqual(observed.payload, { query: "QX" });
  assert.equal(observed.signal instanceof AbortSignal, true);
  assert.equal(Object.isFrozen(observed), true);
});
test("denies by default when a grant is missing or incomplete", async () => {
  for (const grants of [[], [{ connector: "demo", operation: "lookup", permissions: [] }]]) {
    const broker = makeBroker(undefined, { grants });
    await assert.rejects(broker.request("demo", "lookup", "{}"),
      error => error instanceof QXIntegrationError && error.code === "QX_INTEGRATION_PERMISSION_DENIED");
  }
});
test("rejects unknown connectors and operations", async () => {
  const broker = makeBroker();
  await assert.rejects(broker.request("other", "lookup", "{}"), error => error.code === "QX_INTEGRATION_NOT_REGISTERED");
  await assert.rejects(broker.request("demo", "send", "{}"), error => error.code === "QX_INTEGRATION_NOT_REGISTERED");
});
test("rejects invalid identifiers and malformed JSON", async () => {
  const broker = makeBroker();
  await assert.rejects(broker.request("../demo", "lookup", "{}"), error => error.code === "QX_INTEGRATION_INVALID_TARGET");
  await assert.rejects(broker.request("demo", "lookup", "{"), error => error.code === "QX_INTEGRATION_INVALID_REQUEST");
  await assert.rejects(broker.request("demo", "lookup", "undefined"), error => error.code === "QX_INTEGRATION_INVALID_REQUEST");
});
test("enforces request and response byte limits", async () => {
  const requestBroker = makeBroker(undefined, { limits: { maxRequestBytes: 2 } });
  await assert.rejects(requestBroker.request("demo", "lookup", '{"x":1}'), error => error.code === "QX_INTEGRATION_INVALID_REQUEST");
  const responseBroker = makeBroker(async () => '{"long":"response"}', { limits: { maxResponseBytes: 5 } });
  await assert.rejects(responseBroker.request("demo", "lookup", "{}"), error => error.code === "QX_INTEGRATION_INVALID_RESPONSE");
});
test("rejects malformed adapter responses", async () => {
  const broker = makeBroker(async () => "<script>");
  await assert.rejects(broker.request("demo", "lookup", "{}"), error => error.code === "QX_INTEGRATION_INVALID_RESPONSE");
});
test("wraps adapter failures without exposing adapter error text", async () => {
  const broker = makeBroker(async () => { throw new Error("secret-token=do-not-leak"); });
  await assert.rejects(broker.request("demo", "lookup", "{}"),
    error => error.code === "QX_INTEGRATION_ADAPTER_FAILED" && !error.message.includes("do-not-leak"));
});
test("aborts an adapter when its operation exceeds the time limit", async () => {
  let aborted = false;
  const broker = makeBroker(({ signal }) => new Promise(resolve => {
    signal.addEventListener("abort", () => { aborted = true; resolve('{"late":true}'); }, { once: true });
  }), { limits: { timeoutMs: 10 } });
  await assert.rejects(broker.request("demo", "lookup", "{}"), error => error.code === "QX_INTEGRATION_TIMEOUT");
  assert.equal(aborted, true);
});
test("enforces the concurrent request limit", async () => {
  let release;
  const broker = makeBroker(() => new Promise(resolve => { release = resolve; }), {
    limits: { maxConcurrentRequests: 1, timeoutMs: 1000 }
  });
  const first = broker.request("demo", "lookup", "{}");
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(broker.request("demo", "lookup", "{}"), error => error.code === "QX_INTEGRATION_BUSY");
  release('{"ok":true}');
  assert.equal(await first, '{"ok":true}');
  assert.equal(broker.activeRequests, 0);
});
test("requires explicit permissions on every operation", () => {
  assert.throws(() => createIntegrationBroker({
    connectors: { demo: { id: "demo", version: "1", operations: { lookup: { permissions: [], invoke() {} } } } }
  }), /must declare unique permissions/);
});

test("keeps an uncooperative timed-out adapter counted until it settles", async () => {
  let finish;
  let calls = 0;
  const broker = makeBroker(() => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve('{"ok":true}');
  }, { limits: { maxConcurrentRequests: 1, timeoutMs: 10 } });
  await assert.rejects(broker.request("demo", "lookup", "{}"), error => error.code === "QX_INTEGRATION_TIMEOUT");
  await assert.rejects(broker.request("demo", "lookup", "{}"), error => error.code === "QX_INTEGRATION_BUSY");
  finish('{"late":true}');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.activeRequests, 0);
  assert.equal(await broker.request("demo", "lookup", "{}"), '{"ok":true}');
});
