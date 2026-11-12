import ts from 'typescript';

/** Count calls bound to a named import, independent of spelling and formatting. */
function importedCalls(source: string, exportedName: string) {
  const fileName = 'source-contract.ts';
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === fileName ? file : undefined;
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const imports = new Set<ts.Symbol>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      if ((specifier.propertyName ?? specifier.name).text !== exportedName) continue;
      const symbol = checker.getSymbolAtLocation(specifier.name);
      if (symbol) imports.add(symbol);
    }
  }
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol && imports.has(symbol)) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { file, checker, calls };
}

export function importedCallCount(source: string, exportedName: string): number {
  return importedCalls(source, exportedName).calls.length;
}

type TransparentExpression = ts.ParenthesizedExpression | ts.AsExpression | ts.TypeAssertion
  | ts.NonNullExpression | ts.SatisfiesExpression;

function isTransparentExpression(node: ts.Node): node is TransparentExpression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (isTransparentExpression(expression)) expression = expression.expression;
  return expression;
}

/** Inspect local owner bindings and direct factory method calls; fail closed for
 * other binding forms so new syntax cannot silently bypass an ownership guard. */
export function importedInstanceMethodCallCount(source: string, exportedName: string, method: string): number {
  const { file, checker, calls } = importedCalls(source, exportedName);
  const owners = new Set<ts.Symbol>();
  for (const call of calls) {
    let value: ts.Expression = call;
    while (isTransparentExpression(value.parent)) value = value.parent;
    const parent = value.parent;
    const target = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name
      : ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ? unwrapExpression(parent.left) : undefined;
    const name = target && ts.isIdentifier(target) ? target : undefined;
    const symbol = name && checker.getSymbolAtLocation(name);
    if (symbol) {
      owners.add(symbol);
    } else if (!(ts.isPropertyAccessExpression(parent) && ts.isCallExpression(parent.parent)
      && parent.parent.expression === parent)) {
      throw new Error(`Unsupported owner binding for ${exportedName}: ${parent.getText(file)}`);
    }
  }
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === method) {
      const receiver = unwrapExpression(node.expression.expression);
      const symbol = ts.isIdentifier(receiver) && checker.getSymbolAtLocation(receiver);
      if (symbol && owners.has(symbol) || ts.isCallExpression(receiver) && calls.includes(receiver)) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}
