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

test("keeps every command disabled until its signature is specified", () => {
  for (const command of COMMAND_REGISTRY) {
    assert.equal(command.signature, null);
    assert.equal(command.signatureStatus, "pending");
    assert.equal(command.enabled, false);
    assert.equal(isCommandEnabled(command.domain, command.name), false);
  }
});

test("exposes only the four library domains plus the separate QX system domain", () => {
  assert.equal(COMMAND_DOMAINS.length, 5);
  assert.equal(COMMAND_DOMAINS.filter(domain => domain.kind !== "system").length, 4);
  assert.equal(COMMAND_DOMAINS.find(domain => domain.id === "QX").kind, "system");
});
