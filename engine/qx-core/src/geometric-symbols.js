// Canonical geometric vocabulary for QX.
// Glyphs and meanings are defined by the root QX Geometric Language Specification.
export const GEOMETRIC_SYMBOLS = Object.freeze([
  ["⬡", "ORIGIN", "CREATION_DEFINITION"],
  ["⬢", "FORM", "CREATION_DEFINITION"],
  ["◈", "CORE", "CREATION_DEFINITION"],
  ["⬣", "SEED", "CREATION_DEFINITION"],
  ["⬠", "ROOT", "CREATION_DEFINITION"],
  ["⟐", "IDENTITY", "CREATION_DEFINITION"],

  ["◉", "DATA", "DATA_STORAGE"],
  ["◍", "STORE", "DATA_STORAGE"],
  ["◌", "FETCH", "DATA_STORAGE"],
  ["⊙", "VALUE", "DATA_STORAGE"],
  ["⊚", "RECORD", "DATA_STORAGE"],
  ["⊛", "COLLECTION", "DATA_STORAGE"],

  ["△", "SCREEN", "INTERFACE_DESIGN"],
  ["▱", "PANEL", "INTERFACE_DESIGN"],
  ["▰", "BLOCK", "INTERFACE_DESIGN"],
  ["◫", "WINDOW", "INTERFACE_DESIGN"],
  ["⌑", "BUTTON", "INTERFACE_DESIGN"],
  ["▤", "LAYOUT", "INTERFACE_DESIGN"],

  ["⟁", "EXECUTE", "EXECUTION_PROCESSING"],
  ["⧫", "PROCESS", "EXECUTION_PROCESSING"],
  ["⧬", "COMPUTE", "EXECUTION_PROCESSING"],
  ["⧭", "TRANSFORM", "EXECUTION_PROCESSING"],
  ["⧮", "ACTION", "EXECUTION_PROCESSING"],
  ["⧯", "FINISH", "EXECUTION_PROCESSING"],

  ["⟡", "IF", "CONDITIONS_DECISIONS"],
  ["⟢", "ELSE", "CONDITIONS_DECISIONS"],
  ["⟣", "ELSE_IF", "CONDITIONS_DECISIONS"],
  ["⟤", "EQUAL", "CONDITIONS_DECISIONS"],
  ["⟥", "GREATER", "CONDITIONS_DECISIONS"],
  ["⟦", "LESS", "CONDITIONS_DECISIONS"],

  ["⟳", "LOOP", "LOOPS_FLOW"],
  ["⟲", "REPEAT", "LOOPS_FLOW"],
  ["⤴", "BREAK", "LOOPS_FLOW"],
  ["⤵", "CONTINUE", "LOOPS_FLOW"],
  ["⤷", "RETURN", "LOOPS_FLOW"],
  ["⤶", "EXIT", "LOOPS_FLOW"],

  ["⛓", "CONNECT", "LINKING_COMMUNICATION"],
  ["⧉", "LINK", "LINKING_COMMUNICATION"],
  ["⧊", "BIND", "LINKING_COMMUNICATION"],
  ["⧋", "IMPORT", "LINKING_COMMUNICATION"],
  ["⧌", "EXPORT", "LINKING_COMMUNICATION"],
  ["⧍", "API", "LINKING_COMMUNICATION"],

  ["⛨", "SECURITY", "SECURITY_PERMISSIONS"],
  ["⛉", "AUTH", "SECURITY_PERMISSIONS"],
  ["⛊", "PERMISSION", "SECURITY_PERMISSIONS"],
  ["⛋", "ACCESS", "SECURITY_PERMISSIONS"],
  ["⛌", "ENCRYPT", "SECURITY_PERMISSIONS"],
  ["⛍", "VALIDATE", "SECURITY_PERMISSIONS"],

  ["⊞", "INPUT", "INPUT_OUTPUT"],
  ["⊟", "OUTPUT", "INPUT_OUTPUT"],
  ["⊠", "READ", "INPUT_OUTPUT"],
  ["⊡", "WRITE", "INPUT_OUTPUT"],
  ["⊢", "DISPLAY", "INPUT_OUTPUT"],
  ["⊣", "RECEIVE", "INPUT_OUTPUT"],

  ["⌘", "CALL", "CALLS_COMPONENTS"],
  ["⌬", "MODULE", "CALLS_COMPONENTS"],
  ["⌭", "COMPONENT", "CALLS_COMPONENTS"],
  ["⌮", "FUNCTION", "CALLS_COMPONENTS"],
  ["⌯", "EVENT", "CALLS_COMPONENTS"],
  ["⌰", "TRIGGER", "CALLS_COMPONENTS"],

  ["⚠", "WARNING", "ERRORS_DIAGNOSTICS"],
  ["⛔", "ERROR", "ERRORS_DIAGNOSTICS"],
  ["⛑", "RECOVER", "ERRORS_DIAGNOSTICS"],
  ["⛒", "DEBUG", "ERRORS_DIAGNOSTICS"],
  ["⛓️‍💥", "EXCEPTION", "ERRORS_DIAGNOSTICS"],
  ["⛕", "LOG", "ERRORS_DIAGNOSTICS"],

  ["⬟", "BUILD", "BUILD_RUNTIME"],
  ["⬢⃝", "COMPILE", "BUILD_RUNTIME"],
  ["⬣⃝", "PACKAGE", "BUILD_RUNTIME"],
  ["⬤", "RUN", "BUILD_RUNTIME"],
  ["⬥", "DEPLOY", "BUILD_RUNTIME"],
  ["⬦", "VERSION", "BUILD_RUNTIME"]
].map(([glyph, name, group]) => Object.freeze({ glyph, name, group })));

export const GEOMETRIC_SYMBOL_BY_GLYPH = new Map(
  [...GEOMETRIC_SYMBOLS]
    .sort((a, b) => b.glyph.length - a.glyph.length)
    .map(symbol => [symbol.glyph, symbol])
);
