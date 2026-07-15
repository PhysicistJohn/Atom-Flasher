import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import ts from 'typescript';
import {
  canonicalText,
  exportedContractDeclaration,
  exportedTypeSourceSignature,
  parseContractSource,
  projectedSourceSignatures,
} from './contract-source-signatures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsRoot = resolve(root, 'contracts');
const interfacesRoot = resolve(contractsRoot, 'interfaces');
const ACTIVE_INTERFACE_CATALOG = 'contracts/contract-catalog-v3.json';
const INTERFACE_SCHEMA_ID = 'https://physicistjohn.github.io/tinysa-flasher/contracts/interface-contract-v3.schema.json';

// These digests make the v3 publication append-only independently of the
// hashes embedded in its catalog. Populate only after the complete v3 set is
// reviewed; verification refuses an empty lock.
const PUBLISHED_V3_ARTIFACT_SHA256 = Object.freeze({
  'contracts/contract-catalog-v3.json': 'fb54af37f37d6a3101825cc98b9c42be2bcbdcb3cb8c83c45bb91741692204ed',
  'contracts/schemas/contract-catalog-v3.schema.json': 'd024eeb83cb6861fce80110ce5c53dfe87d6d19c6b17a7ba1f3f8263b624c5f0',
  'contracts/schemas/interface-contract-v3.schema.json': '35417d530ec60ac09ca3c97c6ff0d04915e95f6245515726bf5503d503fa786a',
  'contracts/interfaces/application-config-v3.json': 'fb94ef9718cc2e22a0c0d65931feb063bed7ae2016c206037fa3d110d8dde61c',
  'contracts/interfaces/application-facade-v3.json': '081970c74bf6f1a124c236ca40541d9458d34db9fd7e16b139d0adb60580ef68',
  'contracts/interfaces/device-cdc-v3.json': 'fc37df2616dd6564429c7ca0835ed835ff10f6e53c51c7bdc819d5bfaa2f6980',
  'contracts/interfaces/firmware-updater-v3.json': '6caf45d3531bd6958e82cbda11268adbbb881ee2c5755eac2fc2680d6d96e7da',
  'contracts/interfaces/ipc-adapter-v3.json': '44e87d07e9e5ccda53815f483027ae13e682a6913780294be9db7fd087854c55',
  'contracts/interfaces/legacy-migration-v3.json': '6010307920c58824b7da64a6a5b38cac837efbee1f1dd06f6604cd4d23afa44a',
  'contracts/interfaces/local-firmware-build-v3.json': '9e3e399d98e8722841258155639efe99e59eb14ba4016c62703663308c070f53',
  'contracts/interfaces/local-firmware-picker-v3.json': '648bdcae56106e9379f6b4f4f2558bc0eac432d8d39ce0c56d44b256f6cf42bf',
  'contracts/interfaces/renderer-ipc-v3.json': '98bf76c216491a770ec7de3d930fc0cf07cd52298fb5c4dee081fd5ff6149a08',
  'contracts/interfaces/runtime-ports-v3.json': 'dd4a09c410e07543b5ac4d147cf1c234393088c472dd78153c69ded6264af2b9',
  'contracts/interfaces/safety-evidence-v3.json': 'a07b23bb4420a12a69cc37845aacf3b2aa79653da23c1b02852b7af3d5986877',
});

const sourceCache = new Map();
export let activeInterfaceContractSet;

verifyVerifierSelfTests();

const catalogPath = resolveRepositoryPath(ACTIVE_INTERFACE_CATALOG, 'active interface catalog v3');
const catalogBytes = await readFile(catalogPath);
const catalog = parseJson(catalogBytes, catalogPath);
const catalogSchemaPath = resolveContractPath(catalog.$schema, contractsRoot, 'v3 catalog schema');
const catalogSchema = parseJson(await readFile(catalogSchemaPath), catalogSchemaPath);
assertEqual(catalogSchema.$schema, 'https://json-schema.org/draft/2020-12/schema', 'v3 catalog schema dialect');
assertEqual(catalogSchema.$id, 'https://physicistjohn.github.io/tinysa-flasher/contracts/contract-catalog-v3.schema.json', 'v3 catalog schema identity');
validateSchema(catalog, catalogSchema, '$catalogV3');

const applicationPath = resolveContractPath(catalog.applicationContract, contractsRoot, 'v3 catalog application contract');
const applicationBytes = await readFile(applicationPath);
assertEqual(sha256(applicationBytes), catalog.applicationContractSha256, 'v3 catalog application contract SHA-256');
const application = parseJson(applicationBytes, applicationPath);
assertEqual(application.contractId, 'tinysa-flasher-application', 'v3 catalog application contract ID');
assertEqual(application.contractVersion, 2, 'v3 catalog retained application contract version');

const interfaceSchemaPath = resolve(contractsRoot, 'schemas/interface-contract-v3.schema.json');
const interfaceSchema = parseJson(await readFile(interfaceSchemaPath), interfaceSchemaPath);
assertEqual(interfaceSchema.$schema, 'https://json-schema.org/draft/2020-12/schema', 'v3 interface schema dialect');
assertEqual(interfaceSchema.$id, INTERFACE_SCHEMA_ID, 'v3 interface schema identity');

const verified = [];
const catalogIds = new Set();
const catalogPaths = new Set();
for (const entry of catalog.interfaces) {
  if (catalogIds.has(entry.contractId)) throw new Error(`v3 catalog repeats contract ID ${entry.contractId}`);
  if (catalogPaths.has(entry.path)) throw new Error(`v3 catalog repeats interface path ${entry.path}`);
  catalogIds.add(entry.contractId);
  catalogPaths.add(entry.path);
  const path = resolveContractPath(entry.path, contractsRoot, `v3 interface ${entry.contractId}`);
  const bytes = await readFile(path);
  assertEqual(sha256(bytes), entry.sha256, `${entry.contractId} catalog SHA-256`);
  const contract = parseJson(bytes, path);
  validateSchema(contract, interfaceSchema, `$interfaces.${entry.contractId}`);
  assertEqual(contract.$id, `https://physicistjohn.github.io/tinysa-flasher/contracts/interfaces/${relative(interfacesRoot, path)}`, `${entry.contractId} $id`);
  assertEqual(contract.contractId, entry.contractId, `${entry.contractId} catalog identity`);
  assertEqual(contract.contractVersion, entry.contractVersion, `${entry.contractId} catalog version`);
  await verifyPreviousContract(contract, path);
  await verifyInterfaceContract(contract);
  verified.push({ contract, path, sha256: entry.sha256 });
}

activeInterfaceContractSet = Object.freeze({ interfaces: verified });
await verifyV3Inventory(catalogPaths);
await verifyNoNewerPublishedVersions(catalog, verified);
const coverage = await verifyExportedInterfaceCoverage(verified);
await verifyPublicationLocks();

console.log(JSON.stringify({
  status: 'PASS',
  activeInterfaceCatalogVersion: catalog.contractVersion,
  retainedApplicationContractVersion: application.contractVersion,
  interfaceEnvelopeVersion: catalog.interfaceEnvelopeVersion,
  interfaceContracts: verified.length,
  exportedInterfaces: coverage.exportedInterfaces,
  directBehavioralInterfaces: coverage.directBehavioralInterfaces,
  inheritedOnlyInterfaces: coverage.inheritedOnlyInterfaces,
  dataOnlyInterfaces: coverage.dataOnlyInterfaces,
  invocations: coverage.invocations,
  structuralCapabilities: coverage.structuralCapabilities,
  compositions: coverage.compositions,
  mappedTestFiles: coverage.mappedTestFiles,
  publishedV3Artifacts: Object.keys(PUBLISHED_V3_ARTIFACT_SHA256).length,
}));

function verifyVerifierSelfTests() {
  const sourceModule = 'v3-verifier-self-test.ts';
  const sourceFile = parseContractSource(sourceModule, `
    export interface ExamplePort {
      execute(value: string, timeout = 10): Promise<boolean>;
    }
  `);
  assertDeepEqual(invocationShapeForCallable(sourceFile, {
    sourceModule,
    symbol: 'ExamplePort',
    symbolKind: 'interface',
    sourceMember: 'execute',
  }), {
    argumentsSignature: 'readonly [value: string, timeout?: number]',
    returnSignature: 'Promise<boolean>',
  }, 'v3 verifier canonical invocation self-test');

  assertDeepEqual(invocationShapeForIpcRegistry({
    contractId: 'v3-verifier-self-test',
    typeDefinitions: {
      Input: { runtimeValidator: 'inputSchema' },
      Output: { runtimeValidator: 'outputSchema' },
    },
  }, "operation='execute', channel='flasher:self-test:execute', input=z.tuple([inputSchema]), output=outputSchema)"), {
    argumentsSignature: 'readonly [Input]',
    returnSignature: 'Promise<Output>',
    channel: 'flasher:self-test:execute',
  }, 'v3 verifier IPC invocation self-test');
}

async function verifyPreviousContract(contract, contractPath) {
  const previousPath = resolveContractPath(contract.previousContract.path, dirname(contractPath), `${contract.contractId} previous contract`);
  const bytes = await readFile(previousPath);
  assertEqual(sha256(bytes), contract.previousContract.sha256, `${contract.contractId} previous contract SHA-256`);
  const previous = parseJson(bytes, previousPath);
  assertEqual(previous.contractId, contract.contractId, `${contract.contractId} previous contract identity`);
  assertEqual(previous.contractVersion, contract.previousContract.contractVersion, `${contract.contractId} previous contract version`);
  if (previous.contractVersion >= contract.contractVersion) {
    throw new Error(`${contract.contractId} v3 must advance its previous semantic version`);
  }
}

async function verifyInterfaceContract(contract) {
  const declaredSources = new Set(contract.sourceOfTruth);
  for (const sourceModule of declaredSources) await requireReadableSource(contract.contractId, sourceModule);

  for (const [name, definition] of Object.entries(contract.typeDefinitions)) {
    await verifyTypeDefinition(contract.contractId, name, definition);
    if (!definition.sourceModule.startsWith('platform:') && !declaredSources.has(definition.sourceModule)) {
      throw new Error(`${contract.contractId} sourceOfTruth omits type source ${definition.sourceModule}`);
    }
  }

  const invocationKeys = new Set();
  const invocationGroups = new Map();
  const capabilitySignatures = new Map();
  for (const invocation of contract.invocations) {
    if (!declaredSources.has(invocation.sourceModule)) {
      throw new Error(`${contract.contractId} sourceOfTruth omits invocation source ${invocation.sourceModule}`);
    }
    const key = invocationKey(invocation.sourceModule, invocation.symbol, invocation.sourceMember);
    if (invocationKeys.has(key)) throw new Error(`${contract.contractId} repeats source invocation ${key}`);
    invocationKeys.add(key);
    const groupKey = `${invocation.sourceModule}#${invocation.symbol}#${invocation.symbolKind}`;
    const group = invocationGroups.get(groupKey) ?? [];
    group.push(invocation);
    invocationGroups.set(groupKey, group);

    const signature = `${invocation.argumentsSignature} -> ${invocation.returnSignature}`;
    const prior = capabilitySignatures.get(invocation.capabilityId);
    if (prior !== undefined && prior !== signature) {
      throw new Error(`${contract.contractId} capability ${invocation.capabilityId} aliases incompatible source signatures: ${prior} versus ${signature}`);
    }
    capabilitySignatures.set(invocation.capabilityId, signature);
    await verifyInvocation(contract, invocation);
  }

  for (const [groupKey, invocations] of invocationGroups) {
    const first = invocations[0];
    const sourceFile = await loadSource(first.sourceModule);
    const actual = projectedSourceSignatures(sourceFile, first);
    const declared = invocations.map(({ sourceMember, sourceSignature }) => ({ sourceMember, sourceSignature }));
    assertDeepEqual(declared, actual, `${contract.contractId} exhaustive source invocation group ${groupKey}`);
  }

  const structuralIds = new Set();
  for (const capability of contract.structuralCapabilities) {
    if (structuralIds.has(capability.capabilityId)) throw new Error(`${contract.contractId} repeats structural capability ${capability.capabilityId}`);
    if (capabilitySignatures.has(capability.capabilityId)) throw new Error(`${contract.contractId} uses ${capability.capabilityId} as both invocation and structural capability`);
    structuralIds.add(capability.capabilityId);
    for (const ref of [capability.semanticInputRef, capability.semanticOutputRef]) {
      if (!Object.hasOwn(contract.typeDefinitions, ref)) throw new Error(`${contract.contractId} structural capability ${capability.capabilityId} has unresolved semantic ref ${ref}`);
    }
    await verifyTestPaths(contract.contractId, capability.capabilityId, capability.tests);
  }

  const compositionKeys = new Set();
  const compositionIds = new Set();
  for (const composition of contract.compositions) {
    if (!declaredSources.has(composition.sourceModule)) {
      throw new Error(`${contract.contractId} sourceOfTruth omits composition source ${composition.sourceModule}`);
    }
    const key = `${composition.sourceModule}#${composition.symbol}`;
    if (compositionKeys.has(key)) throw new Error(`${contract.contractId} repeats composition ${key}`);
    if (compositionIds.has(composition.compositionId)) throw new Error(`${contract.contractId} repeats composition ID ${composition.compositionId}`);
    compositionKeys.add(key);
    compositionIds.add(composition.compositionId);
    await verifyComposition(contract, composition);
  }
}

async function verifyTypeDefinition(contractId, name, definition) {
  const locators = ['runtimeValidator', 'runtimeContract', 'valueExport', 'typeExport', 'platformType']
    .filter((field) => typeof definition[field] === 'string');
  if (locators.length === 0) throw new Error(`${contractId} type definition ${name} has no locator`);
  if (definition.sourceModule.startsWith('platform:')) {
    if (locators.length !== 1 || !definition.platformType) throw new Error(`${contractId} platform type ${name} must declare only platformType`);
    return;
  }
  const sourceFile = await loadSource(definition.sourceModule);
  for (const locator of ['runtimeValidator', 'runtimeContract', 'valueExport']) {
    if (definition[locator] && !exportedContractDeclaration(sourceFile, definition[locator])) {
      throw new Error(`${contractId} ${name} ${locator} ${definition[locator]} is not exported by ${definition.sourceModule}`);
    }
  }
  if (definition.typeExport) {
    const declaration = exportedContractDeclaration(sourceFile, definition.typeExport);
    if (!declaration || !['type', 'interface', 'class'].includes(declaration.kind)) {
      throw new Error(`${contractId} ${name} type export ${definition.typeExport} is missing`);
    }
    assertEqual(
      definition.sourceSignature,
      exportedTypeSourceSignature(sourceFile, definition.typeExport),
      `${contractId} ${name} canonical type signature`,
    );
  }
}

async function verifyInvocation(contract, invocation) {
  const sourceFile = await loadSource(invocation.sourceModule);
  const actualProjection = projectedSourceSignatures(sourceFile, invocation)
    .find((item) => item.sourceMember === invocation.sourceMember);
  if (!actualProjection) {
    throw new Error(`${contract.contractId} cannot find ${invocation.symbol}.${invocation.sourceMember}`);
  }
  assertEqual(invocation.sourceSignature, actualProjection.sourceSignature, `${contract.contractId} ${invocation.capabilityId} source signature`);

  let actualInvocation;
  if (invocation.symbolKind === 'ipc-registry') {
    actualInvocation = invocationShapeForIpcRegistry(contract, actualProjection.sourceSignature);
    if (!invocation.channel) throw new Error(`${contract.contractId} IPC invocation ${invocation.capabilityId} has no channel`);
    assertEqual(invocation.channel, actualInvocation.channel, `${contract.contractId} ${invocation.capabilityId} channel`);
  } else {
    if (invocation.channel !== undefined) throw new Error(`${contract.contractId} non-IPC invocation ${invocation.capabilityId} declares a channel`);
    actualInvocation = invocationShapeForCallable(sourceFile, invocation);
  }
  assertEqual(invocation.argumentsSignature, actualInvocation.argumentsSignature, `${contract.contractId} ${invocation.capabilityId} canonical arguments`);
  assertEqual(invocation.returnSignature, actualInvocation.returnSignature, `${contract.contractId} ${invocation.capabilityId} canonical return`);
  await verifyTestPaths(contract.contractId, invocation.capabilityId, invocation.tests);
}

function invocationShapeForCallable(sourceFile, invocation) {
  const declaration = exportedContractDeclaration(sourceFile, invocation.symbol);
  if (!declaration || declaration.kind !== invocation.symbolKind) {
    throw new Error(`Cannot find ${invocation.symbolKind} ${invocation.symbol} in ${invocation.sourceModule}`);
  }
  let node = declaration.node;
  if (declaration.kind === 'class' || declaration.kind === 'interface') {
    node = declaration.node.members.find((member) => memberName(member.name) === invocation.sourceMember);
  }
  if (!node || (!ts.isFunctionDeclaration(node)
    && !ts.isMethodDeclaration(node)
    && !ts.isMethodSignature(node)
    && !ts.isGetAccessorDeclaration(node))) {
    throw new Error(`Cannot derive invocation shape for ${invocation.symbol}.${invocation.sourceMember}`);
  }
  const parameters = ts.isGetAccessorDeclaration(node) ? [] : node.parameters;
  const argumentsSignature = `readonly [${parameters.map((parameter) => invocationParameter(parameter, sourceFile)).join(', ')}]`;
  const returnSignature = node.type ? canonicalText(node.type, sourceFile) : 'inferred';
  return { argumentsSignature, returnSignature };
}

function invocationParameter(parameter, sourceFile) {
  const rest = parameter.dotDotDotToken ? '...' : '';
  const name = canonicalText(parameter.name, sourceFile);
  const optional = parameter.questionToken || parameter.initializer ? '?' : '';
  const type = parameter.type ? canonicalText(parameter.type, sourceFile) : inferredInitializerType(parameter.initializer);
  return `${rest}${name}${optional}: ${type}`;
}

function inferredInitializerType(initializer) {
  if (!initializer) return 'inferred';
  const value = unwrapExpression(initializer);
  if (ts.isNumericLiteral(value) || value?.kind === ts.SyntaxKind.PrefixUnaryExpression) return 'number';
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return 'string';
  if (value?.kind === ts.SyntaxKind.TrueKeyword || value?.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  return 'inferred';
}

function invocationShapeForIpcRegistry(contract, sourceSignature) {
  const match = sourceSignature.match(/operation=('[^']+'), channel=('[^']+'), input=(.+), output=(.+)\)$/u);
  if (!match) throw new Error(`${contract.contractId} has an unrecognized IPC registry signature: ${sourceSignature}`);
  const inputExpression = match[3];
  const outputExpression = match[4];
  const channel = JSON.parse(match[2].replaceAll("'", '"'));
  let argumentsSignature;
  if (inputExpression === 'noArgumentsSchema') {
    argumentsSignature = 'readonly []';
  } else {
    const expression = parseExpression(inputExpression);
    if (!ts.isCallExpression(expression)
      || !ts.isPropertyAccessExpression(expression.expression)
      || expression.expression.expression.getText() !== 'z'
      || expression.expression.name.text !== 'tuple'
      || !ts.isArrayLiteralExpression(expression.arguments[0])) {
      throw new Error(`${contract.contractId} IPC input is not a static z.tuple: ${inputExpression}`);
    }
    const types = expression.arguments[0].elements.map((element) => {
      if (!ts.isIdentifier(element)) throw new Error(`${contract.contractId} IPC tuple validator is not an identifier: ${element.getText()}`);
      return typeNameForRuntimeValidator(contract, element.text);
    });
    argumentsSignature = `readonly [${types.join(', ')}]`;
  }
  const outputType = typeNameForRuntimeValidator(contract, outputExpression);
  return { argumentsSignature, returnSignature: `Promise<${outputType}>`, channel };
}

function typeNameForRuntimeValidator(contract, validator) {
  const matches = Object.entries(contract.typeDefinitions)
    .filter(([, definition]) => definition.runtimeValidator === validator)
    .map(([name]) => name);
  if (matches.length !== 1) {
    throw new Error(`${contract.contractId} must map runtime validator ${validator} to exactly one v3 type definition; found ${matches.length}`);
  }
  return matches[0];
}

function parseExpression(source) {
  const sourceFile = ts.createSourceFile('contract-expression.ts', `const value = ${source};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = sourceFile.statements[0];
  if (!ts.isVariableStatement(statement)) throw new Error(`Cannot parse expression ${source}`);
  return unwrapExpression(statement.declarationList.declarations[0].initializer);
}

async function verifyComposition(contract, composition) {
  const sourceFile = await loadSource(composition.sourceModule);
  const declaration = exportedContractDeclaration(sourceFile, composition.symbol);
  if (!declaration || declaration.kind !== 'interface') {
    throw new Error(`${contract.contractId} composition ${composition.symbol} is not an exported interface`);
  }
  const directCallables = projectedSourceSignatures(sourceFile, {
    sourceModule: composition.sourceModule,
    symbol: composition.symbol,
    symbolKind: 'interface',
  });
  if (directCallables.length !== 0) {
    throw new Error(`${contract.contractId} composition ${composition.symbol} has direct invocable members and is not inherited-only`);
  }
  const extended = declaration.node.heritageClauses
    ?.filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((clause) => clause.types.map((type) => canonicalText(type, sourceFile))) ?? [];
  if (extended.length === 0) throw new Error(`${contract.contractId} composition ${composition.symbol} extends no interfaces`);
  assertDeepEqual(composition.extends, extended, `${contract.contractId} ${composition.symbol} extends composition`);
  await verifyTestPaths(contract.contractId, composition.compositionId, composition.tests);
}

async function verifyTestPaths(contractId, capabilityId, paths) {
  for (const testPath of paths) {
    const resolved = resolveRepositoryPath(testPath, `${contractId} ${capabilityId} test`);
    if (!resolved.startsWith(`${resolve(root, 'tests')}${sep}`)) {
      throw new Error(`${contractId} ${capabilityId} test escapes tests/: ${testPath}`);
    }
    try { await readFile(resolved); }
    catch { throw new Error(`${contractId} ${capabilityId} test is missing: ${testPath}`); }
  }
}

async function verifyV3Inventory(catalogPaths) {
  const files = (await readdir(interfacesRoot))
    .filter((name) => /-v3\.json$/u.test(name))
    .map((name) => `./interfaces/${name}`)
    .sort();
  assertDeepEqual([...catalogPaths].sort(), files, 'v3 interface file inventory');
}

async function verifyNoNewerPublishedVersions(catalog, verifiedContracts) {
  const newerCatalogs = (await readdir(contractsRoot))
    .map((name) => name.match(/^contract-catalog-v(\d+)\.json$/u))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((version) => version > catalog.contractVersion);
  if (newerCatalogs.length > 0) {
    throw new Error(`Active catalog v${catalog.contractVersion} is older than published catalog v${Math.max(...newerCatalogs)}`);
  }

  const activeVersions = new Map(verifiedContracts.map(({ contract }) => [contract.contractId, contract.contractVersion]));
  for (const name of await readdir(interfacesRoot)) {
    if (!name.endsWith('.json')) continue;
    const path = resolve(interfacesRoot, name);
    const contract = parseJson(await readFile(path), path);
    const activeVersion = activeVersions.get(contract.contractId);
    if (activeVersion === undefined) throw new Error(`Active v3 catalog omits interface ${contract.contractId}`);
    if (contract.contractVersion > activeVersion) {
      throw new Error(`Active v3 catalog selects ${contract.contractId} v${activeVersion} while v${contract.contractVersion} exists`);
    }
  }
}

async function verifyExportedInterfaceCoverage(verifiedContracts) {
  const typeCoverage = new Set();
  const invocationCoverage = new Set();
  const compositionCoverage = new Set();
  const testFiles = new Set();
  let invocations = 0;
  let structuralCapabilities = 0;
  let compositions = 0;
  for (const { contract } of verifiedContracts) {
    for (const definition of Object.values(contract.typeDefinitions)) {
      if (definition.typeExport && !definition.sourceModule.startsWith('platform:')) {
        typeCoverage.add(`${definition.sourceModule}#${definition.typeExport}`);
      }
    }
    for (const invocation of contract.invocations) {
      invocationCoverage.add(invocationKey(invocation.sourceModule, invocation.symbol, invocation.sourceMember));
      invocation.tests.forEach((path) => testFiles.add(path));
      invocations += 1;
    }
    for (const capability of contract.structuralCapabilities) {
      capability.tests.forEach((path) => testFiles.add(path));
      structuralCapabilities += 1;
    }
    for (const composition of contract.compositions) {
      compositionCoverage.add(`${composition.sourceModule}#${composition.symbol}`);
      composition.tests.forEach((path) => testFiles.add(path));
      compositions += 1;
    }
  }

  let exportedInterfaces = 0;
  let directBehavioralInterfaces = 0;
  let inheritedOnlyInterfaces = 0;
  let dataOnlyInterfaces = 0;
  for (const path of await collectTypeScriptFiles(resolve(root, 'src'))) {
    const sourceModule = relative(root, path).split(sep).join('/');
    const sourceFile = await loadSource(sourceModule);
    for (const statement of sourceFile.statements) {
      if (!ts.isInterfaceDeclaration(statement) || !hasExportModifier(statement)) continue;
      exportedInterfaces += 1;
      const interfaceKey = `${sourceModule}#${statement.name.text}`;
      if (!typeCoverage.has(interfaceKey)) throw new Error(`Exported interface has no active v3 type definition: ${interfaceKey}`);
      const members = projectedSourceSignatures(sourceFile, {
        sourceModule,
        symbol: statement.name.text,
        symbolKind: 'interface',
      });
      const extendsInterfaces = statement.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? false;
      if (members.length > 0) {
        directBehavioralInterfaces += 1;
        for (const member of members) {
          const key = invocationKey(sourceModule, statement.name.text, member.sourceMember);
          if (!invocationCoverage.has(key)) throw new Error(`Exported interface member has no active v3 invocation: ${key}`);
        }
      } else if (extendsInterfaces) {
        inheritedOnlyInterfaces += 1;
        if (!compositionCoverage.has(interfaceKey)) throw new Error(`Inherited-only interface has no AST-checked v3 composition: ${interfaceKey}`);
      } else {
        dataOnlyInterfaces += 1;
      }
    }
  }
  return {
    exportedInterfaces,
    directBehavioralInterfaces,
    inheritedOnlyInterfaces,
    dataOnlyInterfaces,
    invocations,
    structuralCapabilities,
    compositions,
    mappedTestFiles: testFiles.size,
  };
}

async function verifyPublicationLocks() {
  const entries = Object.entries(PUBLISHED_V3_ARTIFACT_SHA256);
  if (entries.length === 0) throw new Error('v3 publication digest lock is empty');
  for (const [relativePath, expected] of entries) {
    const path = resolveRepositoryPath(relativePath, 'published v3 artifact');
    assertEqual(sha256(await readFile(path)), expected, `published v3 artifact ${relativePath}`);
  }
}

async function requireReadableSource(contractId, sourceModule) {
  try {
    if (/\.tsx?$/u.test(sourceModule)) await loadSource(sourceModule);
    else await readFile(resolveRepositoryPath(sourceModule, `${contractId} source of truth`));
  }
  catch { throw new Error(`${contractId} source of truth is missing or unreadable: ${sourceModule}`); }
}

async function loadSource(sourceModule) {
  let cached = sourceCache.get(sourceModule);
  if (cached) return cached;
  const path = resolveRepositoryPath(sourceModule, 'contract source');
  cached = parseContractSource(sourceModule, await readFile(path, 'utf8'));
  sourceCache.set(sourceModule, cached);
  return cached;
}

async function collectTypeScriptFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectTypeScriptFiles(path));
    else if (/\.tsx?$/u.test(entry.name)) output.push(path);
  }
  return output.sort();
}

function invocationKey(sourceModule, symbol, sourceMember) {
  return `${sourceModule}#${symbol}.${sourceMember}`;
}

function memberName(name) {
  if (!name || ts.isComputedPropertyName(name) || ts.isPrivateIdentifier(name)) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
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

function validateSchema(value, schema, path) {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`Contract schema violation: ${ajv.errorsText(validate.errors, { dataVar: path, separator: '; ' })}`);
  }
}

function resolveRepositoryPath(relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error(`${label} must be a nonempty repository-relative path`);
  const path = resolve(root, relativePath);
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error(`${label} escapes the repository: ${relativePath}`);
  return path;
}

function resolveContractPath(relativePath, base, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error(`${label} must be a nonempty relative path`);
  const path = resolve(base, relativePath);
  if (path !== contractsRoot && !path.startsWith(`${contractsRoot}${sep}`)) throw new Error(`${label} escapes contracts/: ${relativePath}`);
  return path;
}

function parseJson(bytes, path) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
