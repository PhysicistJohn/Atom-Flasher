import ts from 'typescript';

export function parseContractSource(sourceModule, source) {
  const scriptKind = sourceModule.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(sourceModule, source, ts.ScriptTarget.Latest, true, scriptKind);
}

export function exportedContractDeclaration(sourceFile, symbol) {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      const declaration = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === symbol);
      if (declaration) return { kind: 'variable', node: statement, variable: declaration };
      continue;
    }
    if (!hasExportModifier(statement) || statement.name?.text !== symbol) continue;
    if (ts.isFunctionDeclaration(statement)) return { kind: 'function', node: statement };
    if (ts.isClassDeclaration(statement)) return { kind: 'class', node: statement };
    if (ts.isInterfaceDeclaration(statement)) return { kind: 'interface', node: statement };
    if (ts.isTypeAliasDeclaration(statement)) return { kind: 'type', node: statement };
  }
  return undefined;
}

export function projectedSourceSignatures(sourceFile, projection) {
  const declaration = exportedContractDeclaration(sourceFile, projection.symbol);
  if (!declaration || !projectionKindMatches(declaration.kind, projection.symbolKind)) {
    throw new Error(`Cannot find exported ${projection.symbolKind} ${projection.symbol} in ${projection.sourceModule}`);
  }
  if (declaration.kind === 'variable') return registrySignatures(declaration.variable, sourceFile);
  if (declaration.kind === 'function') {
    return [{ sourceMember: projection.symbol, sourceSignature: callableSignature(declaration.node, sourceFile) }];
  }
  return declaration.node.members
    .filter(isPublicCallableMember)
    .map((member) => ({
      sourceMember: staticName(member.name),
      sourceSignature: callableSignature(member, sourceFile),
    }));
}

export function exportedTypeSourceSignature(sourceFile, symbol) {
  const declaration = exportedContractDeclaration(sourceFile, symbol);
  if (!declaration || !['interface', 'type', 'class'].includes(declaration.kind)) {
    throw new Error(`Cannot find exported type, interface, or class ${symbol} in ${sourceFile.fileName}`);
  }
  if (declaration.kind !== 'class') return canonicalText(declaration.node, sourceFile);
  const members = declaration.node.members
    .filter(isPublicCallableMember)
    .map((member) => callableSignature(member, sourceFile));
  return `class ${symbol} { ${members.join('; ')} }`;
}

export function callableSignature(node, sourceFile) {
  const name = staticName(node.name);
  if (ts.isGetAccessorDeclaration(node)) {
    return `get ${name}(): ${node.type ? canonicalText(node.type, sourceFile) : 'inferred'}`;
  }
  const optional = node.questionToken ? '?' : '';
  const typeParameters = node.typeParameters?.length
    ? `<${node.typeParameters.map((parameter) => canonicalText(parameter, sourceFile)).join(', ')}>`
    : '';
  const parameters = node.parameters
    .map((parameter) => parameterSignature(parameter, sourceFile))
    .join(', ');
  const output = node.type ? canonicalText(node.type, sourceFile) : 'inferred';
  return `${name}${optional}${typeParameters}(${parameters}): ${output}`;
}

export function canonicalText(node, sourceFile) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    node.getText(sourceFile),
  );
  const parts = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      parts.push(' ');
    } else {
      parts.push(scanner.getTokenText());
    }
  }
  return parts.join('').replace(/\s+/gu, ' ').trim();
}

function registrySignatures(variable, sourceFile) {
  const initializer = unwrapExpression(variable.initializer);
  const objectLiteral = ts.isCallExpression(initializer) ? unwrapExpression(initializer.arguments[0]) : initializer;
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    throw new Error('Projected registry must initialize an object literal directly or through Object.freeze');
  }
  return objectLiteral.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      throw new Error('Projected registry may contain only static property assignments');
    }
    const sourceMember = staticName(property.name);
    const value = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : canonicalText(property.initializer, sourceFile);
    const definition = exportedContractDeclaration(sourceFile, value);
    const definitionInitializer = definition?.kind === 'variable'
      ? unwrapExpression(definition.variable.initializer)
      : undefined;
    if (definitionInitializer
      && ts.isCallExpression(definitionInitializer)
      && ts.isIdentifier(definitionInitializer.expression)
      && definitionInitializer.expression.text === 'defineIpcContract'
      && definitionInitializer.arguments.length === 4) {
      const [operation, channel, input, output] = definitionInitializer.arguments;
      return {
        sourceMember,
        sourceSignature: `${sourceMember}: ${value}(operation=${canonicalText(operation, sourceFile)}, channel=${canonicalText(channel, sourceFile)}, input=${canonicalText(input, sourceFile)}, output=${canonicalText(output, sourceFile)})`,
      };
    }
    return { sourceMember, sourceSignature: `${sourceMember}: ${value}` };
  });
}

function parameterSignature(parameter, sourceFile) {
  const rest = parameter.dotDotDotToken ? '...' : '';
  const name = canonicalText(parameter.name, sourceFile);
  const optional = parameter.questionToken ? '?' : '';
  const type = parameter.type
    ? canonicalText(parameter.type, sourceFile)
    : inferInitializerType(parameter.initializer);
  const initializer = parameter.initializer ? ` = ${canonicalText(parameter.initializer, sourceFile)}` : '';
  return `${rest}${name}${optional}: ${type}${initializer}`;
}

function inferInitializerType(initializer) {
  if (!initializer) return 'inferred';
  const value = unwrapExpression(initializer);
  if (ts.isNumericLiteral(value) || value?.kind === ts.SyntaxKind.PrefixUnaryExpression) return 'number';
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return 'string';
  if (value?.kind === ts.SyntaxKind.TrueKeyword || value?.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  return 'inferred';
}

function isPublicCallableMember(member) {
  const callable = ts.isMethodSignature(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member);
  if (!callable || !member.name || ts.isPrivateIdentifier(member.name)) return false;
  return !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
    || modifier.kind === ts.SyntaxKind.ProtectedKeyword
    || modifier.kind === ts.SyntaxKind.StaticKeyword);
}

function staticName(name) {
  if (!name || ts.isComputedPropertyName(name) || ts.isPrivateIdentifier(name)) {
    throw new Error('Contract source member must have a public static name');
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  throw new Error('Contract source member must have a public static name');
}

function projectionKindMatches(declarationKind, projectionKind) {
  if (projectionKind === 'ipc-registry') return declarationKind === 'variable';
  return declarationKind === projectionKind;
}

function hasExportModifier(statement) {
  return Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function unwrapExpression(expression) {
  let current = expression;
  while (current && (ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current))) current = current.expression;
  return current;
}
