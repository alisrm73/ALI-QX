import { createHash } from "node:crypto";

export const UI_TREE_LIMITS = Object.freeze({
  maxSerializedBytes: 65536,
  maxNodes: 1000,
  maxDepth: 32,
  maxTextLength: 10000,
  maxTotalTextLength: 50000,
  maxProperties: 16,
  maxPropertyBytes: 4096
});

const REGISTRY_RELEASE = "ui-registry-1.0.0";
const TREE_SCHEMA = "QX.UI.TREE";
const LOCK_SCHEMA = "QX.UI.COMPONENT-LOCK";

function canonicalJSON(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
  }
  throw new TypeError("Value is not canonical JSON data");
}

function digest(schema) {
  return "sha256:" + createHash("sha256").update(canonicalJSON(schema), "utf8").digest("hex");
}

const definitions = [
  {
    type: "UI.CONTAINER",
    contractVersion: "1.0.0",
    renderer: "container",
    props: {},
    children: { text: true, components: ["UI.CONTAINER", "UI.TEXT_BLOCK", "UI.HEADING"] }
  },
  {
    type: "UI.TEXT_BLOCK",
    contractVersion: "1.0.0",
    renderer: "text-block",
    props: {},
    children: { text: true, components: [] }
  },
  {
    type: "UI.HEADING",
    contractVersion: "1.0.0",
    renderer: "heading",
    props: { level: { type: "number", required: true, integer: true, minimum: 1, maximum: 6 } },
    children: { text: true, components: [] }
  }
];

const registry = new Map(definitions.map(definition => {
  freezeDeep(definition.props);
  freezeDeep(definition.children);
  const schema = freezeDeep({
    type: definition.type,
    contractVersion: definition.contractVersion,
    props: definition.props,
    children: definition.children,
    renderer: definition.renderer
  });
  return [definition.type, freezeDeep({ ...definition, schema, schemaDigest: digest(schema) })];
}));

export class QXUIError extends Error {
  constructor(code, message, nodeId = null) {
    super(message);
    this.name = "QXUIError";
    this.code = code;
    this.nodeId = nodeId;
  }
}

const fail = (code, message, nodeId = null) => { throw new QXUIError(code, message, nodeId); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const allowedKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).every(key => keys.includes(key));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
function isSemver(value) {
  if (typeof value !== "string") return false;
  const match = semver.exec(value);
  if (!match) return false;
  return !(match[4] && match[4].split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")));
}

export function getUIComponentRegistry() {
  return Object.freeze([...registry.values()].map(item => Object.freeze({
    type: item.type,
    contractVersion: item.contractVersion,
    schemaDigest: item.schemaDigest,
    registryRelease: REGISTRY_RELEASE,
    renderer: item.renderer,
    props: item.props,
    children: item.children
  })));
}

export function createDefaultUILock() {
  return Object.freeze({
    schema: LOCK_SCHEMA,
    version: "1.0",
    components: Object.freeze(getUIComponentRegistry()
      .map(({ type, contractVersion, schemaDigest, registryRelease }) =>
        Object.freeze({ type, contractVersion, schemaDigest, registryRelease }))
      .sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.contractVersion < b.contractVersion ? -1 : a.contractVersion > b.contractVersion ? 1 : 0))
  });
}

function parseData(input, code, description, maxBytes) {
  let value = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > maxBytes) fail(code, description + " exceeds the byte limit");
    try { value = JSON.parse(input); }
    catch { fail(code, description + " must be valid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    fail(code, description + " must be a plain JSON object");
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { fail(code, description + " must contain only JSON data"); }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) fail(code, description + " exceeds the byte limit");
  return value;
}

function validateLock(input) {
  const lock = parseData(input, "QX_UI_LOCK_INVALID", "UI lock", UI_TREE_LIMITS.maxSerializedBytes);
  if (!exactKeys(lock, ["schema", "version", "components"]) || lock.schema !== LOCK_SCHEMA || lock.version !== "1.0" || !Array.isArray(lock.components))
    fail("QX_UI_LOCK_INVALID", "Invalid UI component lock envelope");
  const seen = new Set();
  const entries = new Map();
  let previousType = null, previousVersion = null;
  for (const entry of lock.components) {
    if (!exactKeys(entry, ["type", "contractVersion", "schemaDigest", "registryRelease"]) ||
        typeof entry.type !== "string" || !isSemver(entry.contractVersion) ||
        !digestPattern.test(entry.schemaDigest) || typeof entry.registryRelease !== "string" || !entry.registryRelease)
      fail("QX_UI_LOCK_INVALID", "Invalid UI component lock entry");
    if (previousType !== null && (entry.type < previousType || (entry.type === previousType && entry.contractVersion < previousVersion)))
      fail("QX_UI_LOCK_ORDER", "UI lock entries must be sorted by type and contract version");
    previousType = entry.type; previousVersion = entry.contractVersion;
    const key = entry.type + "@" + entry.contractVersion;
    if (seen.has(key)) fail("QX_UI_LOCK_DUPLICATE", "Duplicate UI lock entry: " + key);
    seen.add(key);
    const registered = registry.get(entry.type);
    if (!registered) fail("QX_UI_UNKNOWN_COMPONENT", "Component is not present in the host registry: " + entry.type);
    if (entry.registryRelease !== REGISTRY_RELEASE || entry.contractVersion !== registered.contractVersion)
      fail("QX_UI_RELEASE_UNAVAILABLE", "The exact component release is not available: " + key);
    if (entry.schemaDigest !== registered.schemaDigest)
      fail("QX_UI_DIGEST_MISMATCH", "Component contract digest does not match the host registry: " + entry.type);
    entries.set(key, entry);
  }
  return entries;
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function validateUIComponentTree(input, lockInput, limits = {}) {
  const activeLimits = { ...UI_TREE_LIMITS, ...limits };
  for (const [name, value] of Object.entries(activeLimits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + " must be a positive safe integer");
  }
  const raw = parseData(input, "QX_UI_TREE_INVALID", "UI component tree", activeLimits.maxSerializedBytes);
  const lock = validateLock(lockInput);
  if (!exactKeys(raw, ["schema", "version", "children"]) || raw.schema !== TREE_SCHEMA || raw.version !== "1.0" || !Array.isArray(raw.children))
    fail("QX_UI_TREE_INVALID", "Invalid UI component tree envelope");

  const ids = new Set();
  let nodeCount = 0;
  let totalText = 0;

  function visit(node, depth, parentPolicy = null) {
    if (depth > activeLimits.maxDepth) fail("QX_UI_TREE_DEPTH", "UI component tree nesting limit exceeded");
    if (++nodeCount > activeLimits.maxNodes) fail("QX_UI_TREE_NODES", "UI component tree node limit exceeded");
    if (!node || typeof node !== "object" || Array.isArray(node)) fail("QX_UI_NODE_INVALID", "Invalid UI tree node");
    if (node.kind === "text") {
      if (!exactKeys(node, ["kind", "value"]) || typeof node.value !== "string")
        fail("QX_UI_TEXT_INVALID", "Text nodes must contain only a string value");
      if (parentPolicy && !parentPolicy.text) fail("QX_UI_CHILD_POLICY", "This component does not accept text children");
      if (node.value.length > activeLimits.maxTextLength) fail("QX_UI_TEXT_LIMIT", "UI text node exceeds the length limit");
      totalText += node.value.length;
      if (totalText > activeLimits.maxTotalTextLength) fail("QX_UI_TEXT_LIMIT", "Total UI text exceeds the length limit");
      return { kind: "text", value: node.value };
    }
    if (node.kind !== "component" || !exactKeys(node, ["kind", "id", "type", "version", "props", "children"]))
      fail("QX_UI_NODE_INVALID", "Invalid component node shape");
    if (typeof node.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(node.id))
      fail("QX_UI_ID_INVALID", "Component node ID is invalid");
    if (ids.has(node.id)) fail("QX_UI_ID_DUPLICATE", "Duplicate component node ID: " + node.id, node.id);
    ids.add(node.id);
    if (parentPolicy && !parentPolicy.components.includes(node.type))
      fail("QX_UI_CHILD_POLICY", "Parent component does not permit child type " + node.type, node.id);
    const definition = registry.get(node.type);
    if (!definition) fail("QX_UI_UNKNOWN_COMPONENT", "Unknown UI component type: " + node.type, node.id);
    if (node.version !== definition.contractVersion)
      fail("QX_UI_VERSION_MISMATCH", "Component node version does not match the registered contract", node.id);
    if (!lock.has(node.type + "@" + node.version))
      fail("QX_UI_LOCK_MISSING", "No exact lock entry exists for " + node.type + "@" + node.version, node.id);
    if (!allowedKeys(node.props, Object.keys(definition.props)) || Object.keys(node.props).length > activeLimits.maxProperties)
      fail("QX_UI_PROPS_INVALID", "Invalid or unknown component properties", node.id);
    for (const [name, rule] of Object.entries(definition.props)) {
      const value = node.props[name];
      if (rule.required && value === undefined) fail("QX_UI_PROP_REQUIRED", "Missing required property: " + name, node.id);
      if (value !== undefined && (typeof value !== rule.type || (rule.integer && !Number.isSafeInteger(value)) ||
          (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)))
        fail("QX_UI_PROP_INVALID", "Invalid component property: " + name, node.id);
    }
    if (Buffer.byteLength(JSON.stringify(node.props), "utf8") > activeLimits.maxPropertyBytes)
      fail("QX_UI_PROP_LIMIT", "Component properties exceed the byte limit", node.id);
    if (!Array.isArray(node.children)) fail("QX_UI_CHILDREN_INVALID", "Component children must be an array", node.id);
    const children = node.children.map(child => visit(child, depth + 1, definition.children));
    return { kind: "component", id: node.id, type: node.type, version: node.version, props: { ...node.props }, children };
  }

  const children = raw.children.map(node => visit(node, 1));
  return freezeDeep({ schema: TREE_SCHEMA, version: "1.0", children });
}
