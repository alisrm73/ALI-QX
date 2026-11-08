import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_DOMAINS,
  COMMAND_REGISTRY,
  isCommandEnabled,
  resolveCommand
} from "../src/command-registry.js";

test("registers exactly the V1 command catalog", () => {
  assert.equal(COMMAND_REGISTRY.length, 17);
  assert.deepEqual(
    [...new Set(COMMAND_REGISTRY.map(command => command.domain))],
    ["DATA", "UI", "PROCESS", "INTEGRATION", "QX"]
  );
});

test("resolves English and Arabic domain-command aliases to one identity", () => {
  for (const command of COMMAND_REGISTRY) {
    const [english, arabic] = command.aliases;
    assert.equal(resolveCommand(english.domain, english.command), command);
    assert.equal(resolveCommand(arabic.domain, arabic.command), command);
    assert.equal(command.id, command.domain + "." + command.name);
  }
});

test("English domain and command names are ASCII case-insensitive", () => {
  assert.equal(resolveCommand("data", "create"), resolveCommand("DATA", "CREATE"));
  assert.equal(resolveCommand("Process", "add"), resolveCommand("PROCESS", "ADD"));
  assert.equal(resolveCommand("qx", "stop"), resolveCommand("QX", "STOP"));
});

test("does not accept unregistered names, aliases, or cross-domain commands", () => {
  assert.equal(resolveCommand("DATA", "UNKNOWN"), null);
  assert.equal(resolveCommand("UNKNOWN", "CREATE"), null);
  assert.equal(resolveCommand("DATA", "SHOW"), null);
  assert.equal(resolveCommand("UI", "CREATE"), null);
  assert.equal(resolveCommand("DATA", "إنشاء"), null);
});

test("records the approved V1 command contracts", () => {
  assert.deepEqual(resolveCommand("DATA", "COUNT").signature, {
    parameters: [{ name: "list", type: "LIST" }],
    result: { kind: "value", type: "NUM" }
  });
  assert.deepEqual(resolveCommand("PROCESS", "CALCULATE").signature, {
    parameters: [
      { name: "target", type: "Identifier", variableType: "NUM", mustBeDeclared: true },
      { name: "expression", type: "Expression", resultType: "NUM" }
    ],
    result: { kind: "stored", target: "target", type: "NUM" }
  });
  assert.deepEqual(resolveCommand("PROCESS", "COMPARE").signature, {
    parameters: [
      { name: "target", type: "Identifier", variableType: "BOOL", mustBeDeclared: true },
      { name: "expression", type: "Expression", resultType: "BOOL" }
    ],
    result: { kind: "stored", target: "target", type: "BOOL" }
  });
  assert.equal(COMMAND_REGISTRY.filter(command => command.signatureStatus === "specified").length, 6);
  assert.deepEqual(resolveCommand("PROCESS", "ADD").signature, {
    parameters: [
      { name: "target", type: "Identifier", variableType: "NUM", mustBeDeclared: true },
      { name: "amount", type: "Expression", resultType: "NUM" }
    ],
    result: { kind: "stored", target: "target", type: "NUM" }
  });
  assert.deepEqual(resolveCommand("DATA", "ADD").signature, {
    parameters: [{ name: "list", type: "LIST" }, { name: "value", types: ["NUM", "TXT", "BOOL", "LIST", "NULL"] }],
    result: { kind: "value", type: "LIST" }
  });
  assert.deepEqual(resolveCommand("DATA", "REMOVE").signature, {
    parameters: [{ name: "list", type: "LIST" }, { name: "index", type: "NUM", integer: true, minimum: 0 }],
    result: { kind: "value", type: "LIST" }
  });
  assert.deepEqual(resolveCommand("UI", "SHOW").signature, {
    parameters: [{ name: "value", types: ["NUM", "TXT", "BOOL", "LIST", "NULL"] }],
    result: { kind: "effect", component: "SHOW" }
  });
  assert.deepEqual(resolveCommand("UI", "TEXT").signature, {
    parameters: [{ name: "text", type: "TXT" }],
    result: { kind: "effect", component: "TEXT" }
  });
});

test("enables only commands with approved semantic contracts", () => {
  const enabled = new Set(["DATA.COUNT", "DATA.ADD", "DATA.REMOVE", "UI.SHOW", "UI.TEXT", "PROCESS.ADD", "PROCESS.CALCULATE", "PROCESS.COMPARE"]);
  for (const command of COMMAND_REGISTRY) {
    assert.equal(command.enabled, enabled.has(command.id));
    assert.equal(isCommandEnabled(command.domain, command.name), enabled.has(command.id));
    if (enabled.has(command.id)) {
      assert.equal(command.signatureStatus, "specified");
      assert.notEqual(command.signature, null);
    } else {
      assert.equal(command.signature, null);
      assert.equal(command.signatureStatus, "pending");
    }
  }
});

test("exposes only the four library domains plus the separate QX system domain", () => {
  assert.equal(COMMAND_DOMAINS.length, 5);
  assert.equal(COMMAND_DOMAINS.filter(domain => domain.kind !== "system").length, 4);
  assert.equal(COMMAND_DOMAINS.find(domain => domain.id === "QX").kind, "system");
});
