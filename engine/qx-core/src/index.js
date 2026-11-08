export { Lexer, QXLexError, tokenize } from "./lexer.js";
export { Parser, QXParseError, parse } from "./parser.js";
export { COMMAND_DOMAINS, COMMAND_REGISTRY, isCommandEnabled, resolveCommand } from "./command-registry.js";
export { analyze } from "./semantic-analyzer.js";
export { lowerToQIR, validateQIR, serializeQIR, parseQIR } from "./qir.js";
export { runQIR, QXVMError } from "./vm.js";

export { buildWebProject, generateWebAssets, QXWebBuildError } from "./web-backend.js";
export { createIntegrationBroker, QXIntegrationError } from "./integration-broker.js";
