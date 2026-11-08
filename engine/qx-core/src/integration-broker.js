const DEFAULT_LIMITS = Object.freeze({
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  timeoutMs: 10_000,
  maxConcurrentRequests: 8
});
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const PERMISSION = /^[a-z][a-z0-9:._-]{0,127}$/;
const encoder = new TextEncoder();

export class QXIntegrationError extends Error {
  constructor(code, message) { super(message); this.name = "QXIntegrationError"; this.code = code; }
}
function validateLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + " must be a positive safe integer");
  return Object.freeze(limits);
}
function parseJson(value, maxBytes, code, label) {
  if (typeof value !== "string") throw new QXIntegrationError(code, label + " must be JSON text");
  if (encoder.encode(value).byteLength > maxBytes) throw new QXIntegrationError(code, label + " exceeds the configured size limit");
  try { return JSON.parse(value); }
  catch { throw new QXIntegrationError(code, label + " must contain valid JSON"); }
}
function normalizeConnectors(connectors) {
  if (!connectors || typeof connectors !== "object" || Array.isArray(connectors))
    throw new TypeError("connectors must be an object keyed by connector id");
  const result = new Map();
  for (const [id, connector] of Object.entries(connectors)) {
    if (!IDENTIFIER.test(id) || !connector || typeof connector !== "object" ||
        connector.id !== id || typeof connector.version !== "string" || !connector.version.trim())
      throw new TypeError("Invalid connector descriptor: " + id);
    if (!connector.operations || typeof connector.operations !== "object" || Array.isArray(connector.operations))
      throw new TypeError("Connector operations must be an object: " + id);
    const operations = new Map();
    for (const [operationId, operation] of Object.entries(connector.operations)) {
      if (!IDENTIFIER.test(operationId) || !operation || typeof operation.invoke !== "function")
        throw new TypeError("Invalid operation descriptor: " + id + "." + operationId);
      const required = operation.permissions;
      if (!Array.isArray(required) || required.length === 0 ||
          required.some(item => typeof item !== "string" || !PERMISSION.test(item)) ||
          new Set(required).size !== required.length)
        throw new TypeError("Every connector operation must declare unique permissions: " + id + "." + operationId);
      operations.set(operationId, Object.freeze({ permissions: Object.freeze([...required]), invoke: operation.invoke }));
    }
    result.set(id, Object.freeze({ id, version: connector.version, operations }));
  }
  return result;
}
function normalizeGrants(grants) {
  if (!Array.isArray(grants)) throw new TypeError("grants must be an array");
  const result = new Map();
  for (const grant of grants) {
    if (!grant || typeof grant.connector !== "string" || !IDENTIFIER.test(grant.connector) ||
        typeof grant.operation !== "string" || !IDENTIFIER.test(grant.operation) ||
        !Array.isArray(grant.permissions) ||
        grant.permissions.some(item => typeof item !== "string" || !PERMISSION.test(item)))
      throw new TypeError("Invalid integration permission grant");
    const key = grant.connector + "." + grant.operation;
    if (result.has(key)) throw new TypeError("Duplicate integration permission grant: " + key);
    result.set(key, new Set(grant.permissions));
  }
  return result;
}

/** Host-owned broker. QX never receives connector objects, URLs, credentials, or host capabilities. */
export function createIntegrationBroker({ connectors, grants = [], limits: overrides = {} } = {}) {
  const registry = normalizeConnectors(connectors);
  const permissions = normalizeGrants(grants);
  const limits = validateLimits(overrides);
  let activeRequests = 0;

  async function request(connectorId, operationId, payloadJson) {
    if (typeof connectorId !== "string" || !IDENTIFIER.test(connectorId) ||
        typeof operationId !== "string" || !IDENTIFIER.test(operationId))
      throw new QXIntegrationError("QX_INTEGRATION_INVALID_TARGET", "Invalid connector or operation identifier");
    const connector = registry.get(connectorId);
    const operation = connector?.operations.get(operationId);
    if (!connector || !operation)
      throw new QXIntegrationError("QX_INTEGRATION_NOT_REGISTERED", "Connector operation is not registered");
    const grant = permissions.get(connectorId + "." + operationId);
    if (!grant || operation.permissions.some(permission => !grant.has(permission)))
      throw new QXIntegrationError("QX_INTEGRATION_PERMISSION_DENIED", "Required connector permission was not granted");
    const payload = parseJson(payloadJson, limits.maxRequestBytes, "QX_INTEGRATION_INVALID_REQUEST", "Integration request");
    if (activeRequests >= limits.maxConcurrentRequests)
      throw new QXIntegrationError("QX_INTEGRATION_BUSY", "Integration request capacity is exhausted");

    activeRequests++;
    const controller = new AbortController();
    let timeout;
    try {
      const invocation = Promise.resolve().then(() => operation.invoke(Object.freeze({
        connector: connectorId, connectorVersion: connector.version, operation: operationId,
        payload, signal: controller.signal
      })));
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new QXIntegrationError("QX_INTEGRATION_TIMEOUT", "Connector operation exceeded its time limit"));
        }, limits.timeoutMs);
      });
      const response = await Promise.race([invocation, deadline]);
      if (typeof response !== "string" || encoder.encode(response).byteLength > limits.maxResponseBytes)
        throw new QXIntegrationError("QX_INTEGRATION_INVALID_RESPONSE", "Connector response must be bounded JSON text");
      try { JSON.parse(response); }
      catch { throw new QXIntegrationError("QX_INTEGRATION_INVALID_RESPONSE", "Connector response must contain valid JSON"); }
      return response;
    } catch (error) {
      if (error instanceof QXIntegrationError) throw error;
      throw new QXIntegrationError("QX_INTEGRATION_ADAPTER_FAILED", "Connector operation failed");
    } finally {
      if (timeout) clearTimeout(timeout);
      activeRequests--;
    }
  }
  return Object.freeze({ request, get activeRequests() { return activeRequests; } });
}
