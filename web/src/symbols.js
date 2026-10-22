const TYPES = /^(ClassDeclaration|ClassDefinition|ClassSpecifier|StructSpecifier|EnumSpecifier|StructItem|EnumItem|TraitItem|InterfaceDeclaration|TypeSpec|TypeAliasDeclaration|RecordDeclaration)$/;
const FUNCTIONS = /^(FunctionDeclaration|FunctionDefinition|FunctionDecl|MethodDeclaration|MethodDecl|FunctionItem|ConstructorDeclaration)$/;
const FIELDS = /^(FieldDeclaration|FieldDecl|PropertyDeclaration|EnumConstant|EnumVariant)$/;
const VARIABLES = /^(VariableDeclaration|LexicalDeclaration|Declaration|VarDecl|ConstSpec|LetDeclaration|LocalVariableDeclaration|AssignStatement)$/;
const NAMES = /^(VariableDefinition|VariableName|PropertyDefinition|PropertyName|Identifier|FieldIdentifier|TypeIdentifier|Definition|DefName|FieldName|BoundIdentifier|TypeName)$/;
const BODIES = /^(ClassBody|FieldDeclarationList|StructBody|DeclarationList|CompoundStatement|Block|Body|ParameterList|ParamList|Parameters|FormalParameters|TypeParamList|TypeParameterList)$/;

// Syntax-based navigation works without a language server, including disconnected
// projects. References are identifier matches, never a claim of semantic binding.
export async function symbolsFor(text, check, language = '') {
  const { parserFor } = await import('./lezer.js');
  const parser = await parserFor(check || (language === 'csharp' ? 'java' : ''));
  return parser ? analyzeSymbols(parser, text) : { symbols: [], tokens: [] };
}

export function analyzeSymbols(parser, text) {
  const tree = parser.parse(text);
  const symbols = [];
  const tokens = [];
  const headerNames = (node) => {
    const out = [];
    const scan = (n) => {
      if (BODIES.test(n.name) || /^(TypeName|PrimitiveType|TypeIdentifier|TypeReference|TypeAnnotation|ReturnType|ArgList|ArgumentList|CallExpression|BinaryExpression|NewExpression)$/.test(n.name)) return;
      if (NAMES.test(n.name)) { out.push(n); return; }
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (/^(Equals|AssignOp|=|:=)$/.test(c.name)) break;
        scan(c);
        // Initializers can contain further identifiers, including nested calls.
        if (n.name === 'InitDeclarator' || n.name === 'VariableDeclarator') break;
      }
    };
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (BODIES.test(c.name)) continue;
      if (/^(Equals|AssignOp|=|:=)$/.test(c.name)) break;
      // A type declaration's name may itself be a type token.
      if (TYPES.test(node.name) && /^(TypeIdentifier|TypeName)$/.test(c.name)) out.push(c);
      else scan(c);
    }
    return out;
  };
  const walk = (node, owner = null) => {
    if (/Comment|String|Character|TemplateString|RegExp/.test(node.name)) return;
    if (NAMES.test(node.name) && !node.firstChild) tokens.push({ name: text.slice(node.from, node.to), from: node.from, to: node.to });
    let kind = TYPES.test(node.name) ? 'type' : FUNCTIONS.test(node.name) ? 'method' : FIELDS.test(node.name) ? 'field' : VARIABLES.test(node.name) ? 'variable' : '';
    if (node.name === 'ImplItem') kind = 'type';
    let nextOwner = owner;
    if (kind) {
      let names = headerNames(node);
      if (node.name === 'ImplItem') names = [...children(node)].filter((c) => c.name === 'TypeIdentifier').slice(-1);
      if (kind === 'type' || kind === 'method') names = names.slice(0, 1);
      for (const n of names) {
        const name = text.slice(n.from, n.to);
        if (!/^[$\p{L}_][$\p{L}\p{N}_]*$/u.test(name)) continue;
        const s = { name, kind: kind === 'variable' && owner?.kind === 'type' ? 'field' : kind, from: n.from, to: n.to, start: node.from, end: node.to, owner };
        if (!symbols.some((x) => x.from === s.from)) symbols.push(s);
        if (kind === 'type' || kind === 'method') nextOwner = s;
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c, nextOwner);
  };
  walk(tree.topNode);
  return { symbols: symbols.sort((a, b) => a.from - b.from), tokens };
}

function* children(node) { for (let c = node.firstChild; c; c = c.nextSibling) yield c; }

export function identifierAt(text, pos) {
  const isName = (c) => !!c && /[$\p{L}\p{N}_]/u.test(c);
  let from = pos;
  let to = pos;
  while (from > 0 && isName(text[from - 1])) from--;
  while (to < text.length && isName(text[to])) to++;
  const name = text.slice(from, to);
  return /^[$\p{L}_][$\p{L}\p{N}_]*$/u.test(name) ? { name, from, to } : null;
}

export function enclosingSymbol(symbols, pos, kind) {
  return symbols.filter((s) => (!kind || s.kind === kind) && s.start <= pos && pos <= s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
}
