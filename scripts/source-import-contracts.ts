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

/** Keep forbidden direct Application/Effect calls detectable after owner renames. */
export function importedInstanceMethodCallCount(source: string, exportedName: string, method: string): number {
  const { file, checker, calls } = importedCalls(source, exportedName);
  const owners = new Set<ts.Symbol>();
  for (const call of calls) {
    const parent = call.parent;
    const name = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name
      : ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(parent.left) ? parent.left : undefined;
    const symbol = name && checker.getSymbolAtLocation(name);
    if (symbol) owners.add(symbol);
  }
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === method) {
      const receiver = node.expression.expression;
      const symbol = ts.isIdentifier(receiver) && checker.getSymbolAtLocation(receiver);
      if (symbol && owners.has(symbol) || ts.isCallExpression(receiver) && calls.includes(receiver)) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}
