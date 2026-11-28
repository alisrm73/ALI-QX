import { GEOMETRIC_SYMBOL_BY_GLYPH } from "./geometric-symbols.js";

const DEFINITION_NODE_TYPES = Object.freeze({
  ORIGIN: "OriginDeclaration",
  FORM: "FormDefinition",
  CORE: "CoreEntityDeclaration",
  SEED: "ComponentDeclaration",
  ROOT: "RootSelectionDeclaration",
  IDENTITY: "IdentityDeclaration"
});

function cloneAndAdapt(value) {
  if (Array.isArray(value)) return value.map(cloneAndAdapt);
  if (!value || typeof value !== "object") return value;

  const cloned = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneAndAdapt(child)])
  );

  if (value.type !== "GeometricStatement") return cloned;

  const registered = GEOMETRIC_SYMBOL_BY_GLYPH.get(value.glyph);
  const specializedType = DEFINITION_NODE_TYPES[value.symbol];

  if (
    !registered ||
    registered.name !== value.symbol ||
    registered.group !== "CREATION_DEFINITION" ||
    value.group !== "CREATION_DEFINITION" ||
    !specializedType
  ) {
    return cloned;
  }

  return {
    ...cloned,
    type: specializedType,
    parentType: "DefinitionDeclaration",
    syntaxType: "GeometricStatement"
  };
}

/**
 * Creates a non-mutating semantic-AST view of the parser AST.
 *
 * Only statement-form declarations in the approved first geometric group
 * receive their approved specialized AST type. Arguments, blocks, alternate
 * branches, source locations, and symbol identity are preserved verbatim.
 * GeometricCallExpression nodes and all other symbols remain syntactic nodes
 * because their semantic AST contracts are not yet specified.
 */
export function adaptGeometricAst(program) {
  if (!program || program.type !== "Program" || !Array.isArray(program.body)) {
    throw new TypeError("adaptGeometricAst expects a QX Program AST");
  }
  return cloneAndAdapt(program);
}
