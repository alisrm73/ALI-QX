import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDiagnostic,
  createProjectDiagnostics
} from "../src/project-diagnostics.js";

test("normalizes a parser error while preserving its source location", () => {
  const diagnostic = createProjectDiagnostic({
    error: Object.assign(new Error("Unexpected token"), {
      name: "QXParseError", code: "QX2005",
      location: { line: 3, column: 7, offset: 18 }
    }),
    phase: "parser", source: "QX parser", certainty: "confirmed"
  });
  assert.equal(diagnostic.code, "QX2005");
  assert.deepEqual(diagnostic.location, { line: 3, column: 7, offset: 18 });
  assert.equal(diagnostic.filePath, null);
  assert.match(diagnostic.id, /^qxdiag:[a-f0-9]{64}$/);
});

test("uses an explicit relative file path and preserves VM context", () => {
  const diagnostic = createProjectDiagnostic({
    error: Object.assign(new Error("Runtime failure"), {
      code: "QX_VM_DIVIDE_BY_ZERO", location: { line: 4, column: 2 },
      function: "main", block: "entry", instruction: "inst-4"
    }),
    phase: "vm", source: "QX VM", certainty: "confirmed",
    filePath: "src/main.qx", artifactId: "web-app"
  });
  assert.equal(diagnostic.filePath, "src/main.qx");
  assert.equal(diagnostic.context.function, "main");
  assert.equal(diagnostic.context.block, "entry");
  assert.equal(diagnostic.context.instruction, "inst-4");
});

test("normalizes backend diagnostic arrays without inventing file names", () => {
  const diagnostics = createProjectDiagnostics({
    error: Object.assign(new Error("Build failed"), {
      name: "QXWebBuildError", code: "QX_WEB_SEMANTIC_ERROR",
      diagnostics: [{ code: "QX3003", message: "Undeclared identifier", location: { line: 2, column: 5, offset: 9 } }]
    }),
    phase: "web_backend", source: "QX Web Backend", certainty: "confirmed"
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "QX3003");
  assert.equal(diagnostics[0].filePath, null);
  assert.equal(diagnostics[0].evidence[0].kind, "parent_error");
});

test("rejects unsupported phases, implicit certainty, unsafe paths, and malformed locations", () => {
  const error = new Error("bad");
  assert.throws(() => createProjectDiagnostic({ error, phase: "made_up", source: "test", certainty: "confirmed" }), { code: "QX_PROJECT_DIAGNOSTIC_INVALID" });
  assert.throws(() => createProjectDiagnostic({ error, phase: "parser", source: "test" }), { code: "QX_PROJECT_DIAGNOSTIC_INVALID" });
  assert.throws(() => createProjectDiagnostic({ error, phase: "parser", source: "test", certainty: "confirmed", filePath: "../outside.js" }), { code: "QX_PROJECT_DIAGNOSTIC_INVALID" });
  assert.throws(() => createProjectDiagnostic({ error: Object.assign(new Error("bad"), { location: { line: 0 } }), phase: "parser", source: "test", certainty: "confirmed" }), { code: "QX_PROJECT_DIAGNOSTIC_INVALID" });
});

test("diagnostic identifiers are stable for identical evidence", () => {
  const input = {
    error: Object.assign(new Error("Unexpected token"), { code: "QX2005", location: { line: 1, column: 1, offset: 0 } }),
    phase: "parser", source: "QX parser", certainty: "confirmed"
  };
  assert.equal(createProjectDiagnostic(input).id, createProjectDiagnostic(input).id);
});

test("rejects oversized nested diagnostic collections", () => {
  const error = Object.assign(new Error("Build failed"), {
    diagnostics: Array.from({ length: 101 }, () => ({ message: "issue" }))
  });
  assert.throws(() => createProjectDiagnostics({
    error, phase: "web_backend", source: "backend", certainty: "confirmed"
  }), { code: "QX_PROJECT_DIAGNOSTIC_INVALID" });
});
