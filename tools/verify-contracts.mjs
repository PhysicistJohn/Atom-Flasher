import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import ts from 'typescript';
import {
  canonicalText,
  exportedTypeSourceSignature,
  projectedSourceSignatures,
} from './contract-source-signatures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsRoot = resolve(root, 'contracts');
const PUBLISHED_V2_CATALOG_VERSION = 2;
const LEGACY_APPLICATION_V1_SHA256 = '837eda919735fbf092952c94107752ae4bd747ff5f5ff5b458ce6861346b3dbc';
const LOCAL_MANIFEST_SCHEMA_ID = 'https://physicistjohn.github.io/tinysa-flasher/contracts/schemas/tinysa-firmware-build-manifest-v1.schema.json';
const PUBLISHED_V2_ARTIFACT_SHA256 = Object.freeze({
  'contracts/contract-catalog-v2.json': 'f5b45ed023e0c45be2d89f9f1c368a8a060bf86c6cfdf09a260ede87994a041c',
  'contracts/flasher-application-v2.json': 'e43c12157adbba7315a9056ff306d409782aa1648eca3fe32f5f9ec421dae3ba',
  'contracts/schemas/contract-catalog-v2.schema.json': 'b999dac827b7cff18d1de2f849dc4ef9b4a4d5b7dec5770821547aa4fd665ff4',
  'contracts/schemas/flasher-application-v2.schema.json': 'ace01aebf9c0b5b76cf01041d3d778447d81566624bb1ce358b540f603a68c3f',
  'contracts/schemas/interface-contract-v2.schema.json': '39f11b3aece9a3960923dedf6cde2269a3e67658d1d4324649b89e23a3c0bca6',
  'contracts/schemas/tinysa-firmware-build-manifest-v1.schema.json': 'ae64bcc0db88a5e6fbecbcff6ee9d15b3a56777ced716a69ace80df3e537c77c',
  'contracts/schemas/firmware-release-v1.schema.json': 'fdbc8335146150171b49c4e5ec27760bd8c397852d33f95225af6bc62986ce51',
  'contracts/releases/oem-zs407-c979386-v1.json': '00e02b32d9a23477a7a26152901637bddc9bad156bd62688c5471374616277f5',
});

await verifyVerifierSelfTests();
await verifyPublishedV2Artifacts();
const legacyApplication = await verifyLegacyApplicationV1();
const publishedV2 = await verifyApplicationAndCatalog(PUBLISHED_V2_CATALOG_VERSION, { validateLiveSource: false });
assertDeepEqual(legacyApplication.release, publishedV2.application.release, 'legacy v1/application v2 OEM release projection');
await verifyInterfaceInventory(publishedV2);
await verifyActiveApplicationSource(publishedV2);
await verifyLocalManifestSchema();

console.log(JSON.stringify({
  status: 'PASS',
  frozenInterfaceCatalogVersion: publishedV2.catalog.contractVersion,
  contractId: publishedV2.application.contractId,
  contractVersion: publishedV2.application.contractVersion,
  applicationContractVersion: publishedV2.application.applicationContractVersion,
  deviceContractVersion: publishedV2.application.deviceContractVersion,
  applicationSha256: publishedV2.applicationSha256,
  releaseManifest: publishedV2.application.releaseManifest.path,
  releaseManifestSha256: publishedV2.application.releaseManifest.sha256,
  release: publishedV2.application.release.version,
  frozenInterfaceContracts: publishedV2.catalog.interfaces.length,
  publishedV2Artifacts: Object.keys(PUBLISHED_V2_ARTIFACT_SHA256).length,
  frozenInterfaceSha256: Object.fromEntries(publishedV2.interfaces.map((item) => [item.contract.contractId, item.sha256])),
  legacyApplicationV1Sha256: LEGACY_APPLICATION_V1_SHA256,
}));

async function verifyPublishedV2Artifacts() {
  for (const [relativePath, expectedHash] of Object.entries(PUBLISHED_V2_ARTIFACT_SHA256)) {
    const path = resolveRepositoryPath(relativePath, 'published v2 artifact');
    const bytes = await readFile(path);
    assertEqual(sha256(bytes), expectedHash, `published v2 artifact ${relativePath} SHA-256`);
    parseJson(bytes, path);
  }
}

async function verifyLegacyApplicationV1() {
  const path = resolve(contractsRoot, 'flasher-application-v1.json');
  const bytes = await readFile(path);
  assertEqual(sha256(bytes), LEGACY_APPLICATION_V1_SHA256, 'legacy application v1 SHA-256');
  const value = parseJson(bytes, path);
  assertEqual(value.contractId, 'tinysa-flasher-application', 'legacy application v1 contract ID');
  assertEqual(value.contractVersion, 1, 'legacy application v1 document version');
  assertEqual(value.applicationContractVersion, 1, 'legacy application v1 behavior version');
  assertEqual(value.deviceContractVersion, 1, 'legacy application v1 device version');
  return value;
}

async function verifyVerifierSelfTests() {
  const fake = parseTypeScriptSource('self-test.ts', `
    // export const CommentOnly = 1;
    const text = "export interface StringOnly {}";
    export const RealValue = 1;
  `);
  if (findExportedDeclaration(fake, 'CommentOnly')) throw new Error('Verifier self-test accepted a commented fake export');
  if (findExportedDeclaration(fake, 'StringOnly')) throw new Error('Verifier self-test accepted a string-literal fake export');
  requireExportKind(fake, 'RealValue', ['variable'], 'verifier self-test');

  const projected = parseTypeScriptSource('signature-self-test.ts', `
    export interface ExamplePort {
      execute(input: string, count?: number): Promise<boolean>;
    }
  `);
  assertDeepEqual(projectedSourceSignatures(projected, {
    sourceModule: 'signature-self-test.ts',
    symbol: 'ExamplePort',
    symbolKind: 'interface',
  }), [{
    sourceMember: 'execute',
    sourceSignature: 'execute(input: string, count?: number): Promise<boolean>',
  }], 'verifier canonical source signature self-test');

  const wrongIpcWiring = parseTypeScriptSource('ipc-wiring-self-test.ts', `
    const snapshotIpcContract = {};
    const downloadIpcContract = {};
    export const IPC_CONTRACTS = Object.freeze({ snapshot: downloadIpcContract });
    export const IPC = Object.freeze({ snapshot: snapshotIpcContract.channel });
  `);
  assertThrows(
    () => assertIpcObjectBindings(wrongIpcWiring, ['snapshot']),
    'Verifier self-test accepted an incorrectly wired IPC registry',
  );
}

async function verifyLocalManifestSchema() {
  const path = resolve(contractsRoot, 'schemas/tinysa-firmware-build-manifest-v1.schema.json');
  const schema = parseJson(await readFile(path), path);
  assertEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', 'local manifest schema dialect');
  assertEqual(schema.$id, LOCAL_MANIFEST_SCHEMA_ID, 'local manifest schema canonical $id');
  const validate = makeAjv().compile(schema);
  const base = {
    $schema: LOCAL_MANIFEST_SCHEMA_ID,
    manifestVersion: 1,
    artifact: {
      filename: 'tinySA4_dev-225-g1111111.bin',
      format: 'raw-stm32-binary',
      sizeBytes: 180_000,
      sha256: 'a'.repeat(64),
      loadAddress: '0x08000000',
      maximumWriteBytes: 245_760,
      initialStackPointer: '0x20001000',
      resetHandler: '0x08000101',
    },
    firmware: {
      product: 'tinySA Ultra / Ultra+',
      hardwareTarget: 'ZS407',
      mcu: 'STM32F303',
      version: 'tinySA4_dev-225-g1111111',
      reportedRevision: '1111111',
      sourceRepository: 'PhysicistJohn/TinySA_Firmware',
      sourceCommit: '1'.repeat(40),
      sourceTree: 'tracked-clean',
      chibiosCommit: '2'.repeat(40),
    },
    build: {
      sourceDateEpoch: 1_700_000_000,
      toolchain: 'arm-none-eabi-gcc 13.2.1',
      reproducibleCleanBuilds: true,
      hardwareQualification: 'unqualified',
      simulationQualification: 'passed',
    },
    flashPolicy: {
      physicalFlash: 'operator-confirmed-only',
      automatedFlash: false,
      requiresKnownGoodRollback: true,
    },
  };
  assertAjvAccepts(validate, base, 'valid unqualified local manifest');
  assertAjvAccepts(validate, {
    ...base,
    build: { ...base.build, hardwareQualification: 'qualified-on-zs407', qualificationEvidenceSha256: 'b'.repeat(64) },
  }, 'valid qualified local manifest');
  assertAjvRejects(validate, {
    ...base,
    build: { ...base.build, qualificationEvidenceSha256: 'b'.repeat(64) },
  }, 'unqualified manifest with qualification evidence');
  assertAjvRejects(validate, { ...base, artifact: { ...base.artifact, sizeBytes: 245_761 } }, 'oversize local artifact');
  assertAjvRejects(validate, { ...base, artifact: { ...base.artifact, filename: `${'a'.repeat(157)}.bin` } }, 'overlong local filename');
  assertAjvRejects(validate, { ...base, build: { ...base.build, hardwareQualification: 'qualified-on-zs407' } }, 'qualified manifest without evidence');

  const runtimeSourceModule = 'src/core/local-firmware-build.ts';
  const runtimeSource = parseTypeScriptSource(runtimeSourceModule, await readFile(resolve(root, runtimeSourceModule), 'utf8'));
  const schemaId = findExportedDeclaration(runtimeSource, 'MANIFEST_SCHEMA_ID');
  if (!schemaId || schemaId.kind !== 'variable') throw new Error('MANIFEST_SCHEMA_ID must be an exported const');
  const initializer = exportedVariables(schemaId.node)
    .find((item) => item.name === 'MANIFEST_SCHEMA_ID')?.initializer;
  const literal = unwrapExpression(initializer);
  if (!literal || !ts.isStringLiteral(literal)) throw new Error('MANIFEST_SCHEMA_ID must be a string literal');
  assertEqual(literal.text, LOCAL_MANIFEST_SCHEMA_ID, 'runtime local manifest schema identity');
}

function assertAjvAccepts(validate, value, label) {
  if (!validate(value)) throw new Error(`${label} was rejected: ${formatAjvErrors(validate.errors)}`);
}

function assertAjvRejects(validate, value, label) {
  if (validate(value)) throw new Error(`${label} was incorrectly accepted`);
}

async function verifyApplicationAndCatalog(catalogVersion, { validateLiveSource }) {
  const catalogPath = resolve(contractsRoot, `contract-catalog-v${catalogVersion}.json`);
  const catalog = parseJson(await readFile(catalogPath), catalogPath);
  const catalogSchemaPath = resolveContractPath(catalog.$schema, contractsRoot, `catalog v${catalogVersion} $schema`);
  const catalogSchema = parseJson(await readFile(catalogSchemaPath), catalogSchemaPath);
  assertEqual(catalog.contractVersion, catalogVersion, `catalog v${catalogVersion} document version`);
  assertEqual(catalogSchema.$schema, 'https://json-schema.org/draft/2020-12/schema', `catalog v${catalogVersion} schema dialect`);
  assertEqual(catalogSchema.$id, `https://physicistjohn.github.io/tinysa-flasher/contracts/contract-catalog-v${catalogVersion}.schema.json`, `catalog v${catalogVersion} schema $id`);
  validateSchema(catalog, catalogSchema, `$catalogV${catalogVersion}`);

  const applicationPath = resolveContractPath(catalog.applicationContract, contractsRoot, `catalog v${catalogVersion} application contract`);
  const applicationBytes = await readFile(applicationPath);
  const application = parseJson(applicationBytes, applicationPath);
  const applicationSchemaPath = resolveContractPath(application.$schema, dirname(applicationPath), 'active application $schema');
  const applicationSchema = parseJson(await readFile(applicationSchemaPath), applicationSchemaPath);
  const applicationSchemaVersionMatch = application.$schema.match(/flasher-application-v(\d+)\.schema\.json$/u);
  if (!applicationSchemaVersionMatch) throw new Error(`Active application references an unversioned schema: ${application.$schema}`);
  const applicationSchemaVersion = Number(applicationSchemaVersionMatch[1]);
  assertEqual(applicationSchema.$schema, 'https://json-schema.org/draft/2020-12/schema', `application v${application.contractVersion} schema dialect`);
  assertEqual(applicationSchema.$id, `https://physicistjohn.github.io/tinysa-flasher/contracts/flasher-application-v${applicationSchemaVersion}.schema.json`, `application v${application.contractVersion} schema $id`);
  validateSchema(application, applicationSchema, `$applicationV${application.contractVersion}`);

  const releaseReference = application.releaseManifest;
  const releasePath = resolveContractPath(releaseReference.path, contractsRoot, `application v${application.contractVersion} release manifest`);
  const releaseBytes = await readFile(releasePath);
  const release = parseJson(releaseBytes, releasePath);
  assertEqual(sha256(releaseBytes), releaseReference.sha256, `application v${application.contractVersion} release manifest SHA-256`);
  assertEqual(release.$id, releaseReference.$id, `application v${application.contractVersion} release manifest $id`);
  const releaseSchemaPath = resolveContractPath(release.$schema, dirname(releasePath), `application v${application.contractVersion} release $schema`);
  const releaseSchema = parseJson(await readFile(releaseSchemaPath), releaseSchemaPath);
  assertEqual(releaseSchema.$schema, 'https://json-schema.org/draft/2020-12/schema', 'release schema dialect');
  assertEqual(releaseSchema.$id, 'https://physicistjohn.github.io/tinysa-flasher/contracts/firmware-release-v1.schema.json', 'release schema $id');
  validateSchema(release, releaseSchema, `$applicationV${application.contractVersion}.releaseManifest`);
  const releaseProjection = Object.fromEntries(Object.keys(application.release).map((field) => [field, release[field]]));
  assertDeepEqual(application.release, releaseProjection, `application v${application.contractVersion} release projection`);

  const interfaces = await verifyCatalogInterfaces(catalog, { validateLiveSource });
  return {
    catalogVersion,
    application,
    applicationPath,
    applicationSha256: sha256(applicationBytes),
    catalog,
    catalogPath,
    interfaces,
  };
}

async function verifyCatalogInterfaces(catalog, { validateLiveSource }) {
  const declaredPaths = new Set();
  const declaredIds = new Set();
  const verified = [];
  for (const entry of catalog.interfaces) {
    if (declaredPaths.has(entry.path)) throw new Error(`Catalog v${catalog.contractVersion} has duplicate interface path: ${entry.path}`);
    if (declaredIds.has(entry.contractId)) throw new Error(`Catalog v${catalog.contractVersion} has duplicate interface ID: ${entry.contractId}`);
    declaredPaths.add(entry.path);
    declaredIds.add(entry.contractId);
    const interfacePath = resolveContractPath(entry.path, contractsRoot, `interface ${entry.contractId} v${entry.contractVersion}`);
    const interfaceBytes = await readFile(interfacePath);
    const contract = parseJson(interfaceBytes, interfacePath);
    assertEqual(sha256(interfaceBytes), entry.sha256, `${entry.contractId} v${entry.contractVersion} SHA-256`);
    assertEqual(contract.contractId, entry.contractId, `${entry.contractId} catalog identity`);
    assertEqual(contract.contractVersion, entry.contractVersion, `${entry.contractId} catalog version`);
    const schemaPath = resolveContractPath(contract.$schema, dirname(interfacePath), `${entry.contractId} $schema`);
    const schema = parseJson(await readFile(schemaPath), schemaPath);
    const schemaVersionMatch = contract.$schema.match(/interface-contract-v(\d+)\.schema\.json$/u);
    if (!schemaVersionMatch) throw new Error(`${entry.contractId} references an unversioned interface schema: ${contract.$schema}`);
    const schemaVersion = Number(schemaVersionMatch[1]);
    assertEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${entry.contractId} schema dialect`);
    assertEqual(schema.$id, `https://physicistjohn.github.io/tinysa-flasher/contracts/interface-contract-v${schemaVersion}.schema.json`, `${entry.contractId} schema $id`);
    validateSchema(contract, schema, `$interfaces.${entry.contractId}`);
    validateInterfaceStructure(contract);
    if (validateLiveSource) await validateLiveInterface(contract, schemaVersion);
    verified.push({ path: entry.path, sha256: entry.sha256, contract });
  }
  return verified;
}

function validateInterfaceStructure(contract) {
  const capabilityIds = new Set();
  const channels = new Set();
  const referencedTypes = new Set();
  for (const capability of contract.capabilities) {
    if (capabilityIds.has(capability.capabilityId)) throw new Error(`${contract.contractId} has duplicate capability ID: ${capability.capabilityId}`);
    capabilityIds.add(capability.capabilityId);
    referencedTypes.add(capability.input.typeRef);
    referencedTypes.add(capability.output.typeRef);
    if (contract.kind === 'ipc') {
      if (typeof capability.channel !== 'string' || capability.channel.length === 0) throw new Error(`${contract.contractId} IPC capability ${capability.capabilityId} has no channel`);
      if (channels.has(capability.channel)) throw new Error(`${contract.contractId} has duplicate IPC channel: ${capability.channel}`);
      channels.add(capability.channel);
    } else if (capability.channel !== undefined) {
      throw new Error(`${contract.contractId} non-IPC capability ${capability.capabilityId} declares an IPC channel`);
    }
  }
  const definitionNames = new Set(Object.keys(contract.typeDefinitions));
  for (const typeRef of referencedTypes) {
    if (!definitionNames.has(typeRef)) throw new Error(`${contract.contractId} has unresolved typeRef: ${typeRef}`);
  }
  for (const definitionName of definitionNames) {
    if (!referencedTypes.has(definitionName)) throw new Error(`${contract.contractId} has unused type definition: ${definitionName}`);
  }
}

async function validateLiveInterface(contract, schemaVersion) {
  for (const [name, definition] of Object.entries(contract.typeDefinitions)) await validateTypeDefinition(contract.contractId, name, definition);
  for (const sourcePath of contract.sourceOfTruth) await requireReadableSource(contract.contractId, sourcePath);
  const requiredSources = new Set([
    ...Object.values(contract.typeDefinitions)
      .map((definition) => definition.sourceModule)
      .filter((sourceModule) => !sourceModule.startsWith('platform:')),
    ...(contract.sourceProjections ?? []).map((projection) => projection.sourceModule),
  ]);
  const declaredSources = new Set(contract.sourceOfTruth);
  for (const sourceModule of requiredSources) {
    if (!declaredSources.has(sourceModule)) throw new Error(`${contract.contractId} sourceOfTruth omits referenced module ${sourceModule}`);
  }
  if (schemaVersion >= 2) await verifySourceProjections(contract);
  if (contract.contractId === 'tinysa-flasher-renderer-ipc') await verifyIpcSourceProjection(contract);
}

async function validateTypeDefinition(contractId, name, definition) {
  if (!isObject(definition)) throw new Error(`${contractId} type definition ${name} must be an object`);
  const locators = ['runtimeValidator', 'runtimeContract', 'valueExport', 'typeExport', 'platformType']
    .filter((field) => typeof definition[field] === 'string');
  if (locators.length === 0) throw new Error(`${contractId} type definition ${name} has no source locator`);
  if (definition.sourceModule.startsWith('platform:')) {
    if (locators.length !== 1 || !definition.platformType) throw new Error(`${contractId} platform type ${name} must declare only platformType`);
    return;
  }
  const sourcePath = resolveRepositoryPath(definition.sourceModule, `${contractId} type definition ${name}`);
  let source;
  try { source = await readFile(sourcePath, 'utf8'); }
  catch { throw new Error(`${contractId} type definition ${name} source is missing: ${definition.sourceModule}`); }
  const sourceFile = parseTypeScriptSource(definition.sourceModule, source);
  if (definition.runtimeValidator) requireExportKind(sourceFile, definition.runtimeValidator, ['variable', 'function'], `${contractId} runtime validator ${name}`);
  if (definition.runtimeContract) requireExportKind(sourceFile, definition.runtimeContract, ['variable'], `${contractId} runtime contract ${name}`);
  if (definition.valueExport) requireExportKind(sourceFile, definition.valueExport, ['variable', 'function', 'class'], `${contractId} value export ${name}`);
  if (definition.typeExport) {
    requireExportKind(sourceFile, definition.typeExport, ['type', 'interface', 'class'], `${contractId} type export ${name}`);
    if (definition.sourceSignature !== undefined) {
      assertEqual(
        definition.sourceSignature,
        exportedTypeSourceSignature(sourceFile, definition.typeExport),
        `${contractId} type definition ${name} canonical source signature`,
      );
    }
  }
}

async function verifySourceProjections(contract) {
  const capabilityIds = new Set(contract.capabilities.map((item) => item.capabilityId));
  const projectedSymbols = new Set();
  for (const projection of contract.sourceProjections) {
    const key = `${projection.sourceModule}#${projection.symbol}`;
    if (projectedSymbols.has(key)) throw new Error(`${contract.contractId} projects ${key} more than once`);
    projectedSymbols.add(key);
    const sourcePath = resolveRepositoryPath(projection.sourceModule, `${contract.contractId} source projection`);
    const source = await readFile(sourcePath, 'utf8');
    const sourceFile = parseTypeScriptSource(projection.sourceModule, source);
    const declaration = sourceFile.statements.find((statement) => declarationMatches(statement, projection));
    if (!declaration) throw new Error(`${contract.contractId} source projection cannot find exported ${projection.symbolKind} ${projection.symbol} in ${projection.sourceModule}`);
    const actualMembers = projectedSourceSignatures(sourceFile, projection);
    const declaredMembers = projection.members.map(({ sourceMember, sourceSignature }) => ({ sourceMember, sourceSignature }));
    assertDeepEqual(declaredMembers, actualMembers, `${contract.contractId} ${projection.symbol} canonical source member signatures`);
    for (const member of projection.members) {
      if (!capabilityIds.has(member.capabilityId)) throw new Error(`${contract.contractId} projection ${projection.symbol}.${member.sourceMember} references unknown capability ${member.capabilityId}`);
    }
  }
}

function declarationMatches(statement, projection) {
  const declaration = exportedDeclaration(statement, projection.symbol);
  if (!declaration) return false;
  if (projection.symbolKind === 'interface') return declaration.kind === 'interface';
  if (projection.symbolKind === 'class') return declaration.kind === 'class';
  if (projection.symbolKind === 'function') return declaration.kind === 'function';
  return projection.symbolKind === 'ipc-registry' && declaration.kind === 'variable';
}

async function verifyIpcSourceProjection(contract) {
  const sourcePath = resolveRepositoryPath('src/main/ipc-contract.ts', 'renderer IPC source registry');
  const source = await readFile(sourcePath, 'utf8');
  const sourceFile = parseTypeScriptSource('src/main/ipc-contract.ts', source);
  const protocolDeclaration = findExportedDeclaration(sourceFile, 'IPC_PROTOCOL_VERSION');
  if (!protocolDeclaration || protocolDeclaration.kind !== 'variable') throw new Error('IPC_PROTOCOL_VERSION must be an exported const');
  const protocolInitializer = unwrapExpression(protocolDeclaration.node.declarationList.declarations[0]?.initializer);
  if (!protocolInitializer || !ts.isNumericLiteral(protocolInitializer)) throw new Error('IPC_PROTOCOL_VERSION must be a numeric literal');
  assertEqual(Number(protocolInitializer.text), contract.contractVersion, 'renderer IPC protocol version projection');
  const definitions = [];
  for (const statement of sourceFile.statements) {
    const exported = exportedVariables(statement);
    for (const { name, initializer } of exported) {
      if (!name.endsWith('IpcContract')) continue;
      const call = unwrapExpression(initializer);
      if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'defineIpcContract') continue;
      const operation = unwrapExpression(call.arguments[0]);
      const channel = unwrapExpression(call.arguments[1]);
      if (!operation || !channel || !ts.isStringLiteral(operation) || !ts.isStringLiteral(channel)) {
        throw new Error(`${name} must declare literal operation and channel arguments`);
      }
      assertEqual(name, `${operation.text}IpcContract`, `renderer IPC ${operation.text} contract export`);
      definitions.push({ operation: operation.text, capabilityId: kebabCase(operation.text), channel: channel.text });
    }
  }
  if (definitions.length === 0) throw new Error('Could not project defineIpcContract declarations from src/main/ipc-contract.ts');
  const declared = contract.capabilities.map(({ capabilityId, channel }) => ({ capabilityId, channel }));
  assertDeepEqual(declared, definitions.map(({ capabilityId, channel }) => ({ capabilityId, channel })), 'renderer IPC capability/channel projection');
  assertIpcObjectBindings(sourceFile, definitions.map(({ operation }) => operation));
}

function assertIpcObjectBindings(sourceFile, operations) {
  const registry = exportedObjectBindings(sourceFile, 'IPC_CONTRACTS');
  const channels = exportedObjectBindings(sourceFile, 'IPC');
  const expectedRegistry = operations.map((operation) => ({
    key: operation,
    value: `${operation}IpcContract`,
  }));
  const expectedChannels = operations.map((operation) => ({
    key: operation,
    value: `${operation}IpcContract.channel`,
  }));
  assertDeepEqual(registry, expectedRegistry, 'IPC_CONTRACTS operation-to-contract wiring');
  assertDeepEqual(channels, expectedChannels, 'IPC channel operation-to-contract wiring');
}

function exportedObjectBindings(sourceFile, symbol) {
  const declaration = findExportedDeclaration(sourceFile, symbol);
  if (!declaration || declaration.kind !== 'variable') throw new Error(`${symbol} must be an exported const object`);
  const variable = exportedVariables(declaration.node).find((item) => item.name === symbol);
  const initializer = unwrapExpression(variable?.initializer);
  const objectLiteral = ts.isCallExpression(initializer) ? unwrapExpression(initializer.arguments[0]) : initializer;
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    throw new Error(`${symbol} must initialize an object literal directly or through Object.freeze`);
  }
  return objectLiteral.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      throw new Error(`${symbol} may contain only static property assignments`);
    }
    if (!property.name || ts.isComputedPropertyName(property.name) || ts.isPrivateIdentifier(property.name)) {
      throw new Error(`${symbol} property names must be static`);
    }
    const key = property.name.text;
    const value = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : canonicalText(property.initializer, sourceFile);
    return { key, value };
  });
}

async function verifyInterfaceInventory(frozenV2) {
  const published = new Set();
  const catalogNames = (await readdir(contractsRoot))
    .filter((name) => /^contract-catalog-v\d+\.json$/u.test(name))
    .sort();
  if (catalogNames.length === 0) throw new Error('No versioned contract catalog is published');
  for (const catalogName of catalogNames) {
    const catalogPath = resolve(contractsRoot, catalogName);
    const catalog = parseJson(await readFile(catalogPath), catalogPath);
    if (!Array.isArray(catalog.interfaces)) throw new Error(`${catalogName} has no interface inventory`);
    for (const entry of catalog.interfaces) {
      published.add(entry.path);
      const interfacePath = resolveContractPath(entry.path, contractsRoot, `${catalogName} interface ${entry.contractId}`);
      const bytes = await readFile(interfacePath);
      const contract = parseJson(bytes, interfacePath);
      assertEqual(sha256(bytes), entry.sha256, `${catalogName} ${entry.contractId} SHA-256`);
      assertEqual(contract.contractId, entry.contractId, `${catalogName} ${entry.contractId} identity`);
      assertEqual(contract.contractVersion, entry.contractVersion, `${catalogName} ${entry.contractId} version`);
    }
  }
  const files = (await readdir(resolve(contractsRoot, 'interfaces')))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `./interfaces/${name}`)
    .sort();
  assertDeepEqual([...published].sort(), files, 'published interface inventory');
  for (const item of frozenV2.interfaces) {
    if (!published.has(item.path)) throw new Error(`Frozen v2 interface is absent from published catalog inventory: ${item.path}`);
  }
}

async function verifyActiveApplicationSource(active) {
  const runtimeSource = await readFile(resolve(root, 'src/core/contracts.ts'), 'utf8');
  if (!runtimeSource.includes(`contracts/${active.application.releaseManifest.path}`)) throw new Error('Runtime contracts must import the canonical firmware release manifest');
  const runtimeSourceFile = parseTypeScriptSource('src/core/contracts.ts', runtimeSource);
  for (const symbol of ['oemFirmwareTargetSchema', 'localCustomFirmwareTargetSchema', 'firmwareTargetSchema']) {
    requireExportKind(runtimeSourceFile, symbol, ['variable'], 'active dynamic target source');
  }
  const applicationSource = await readFile(resolve(root, 'src/application/application-contract.ts'), 'utf8');
  if (!/applicationSnapshotSchema\s*=\s*z\.object\(\{[\s\S]*?schemaVersion:\s*z\.literal\(2\)/u.test(applicationSource)) {
    throw new Error('Active application contract does not source-project schemaVersion 2 snapshots');
  }
  const evidenceSource = await readFile(resolve(root, 'src/core/persistence/evidence-registry.ts'), 'utf8');
  if (!/FIRMWARE_EVIDENCE_SCHEMA_REGISTRY[\s\S]*?1:[\s\S]*?2:/u.test(evidenceSource)) {
    throw new Error('Active evidence registry must retain v1 and append v2');
  }
}

async function requireReadableSource(contractId, sourcePath) {
  const path = resolveRepositoryPath(sourcePath, `${contractId} source of truth`);
  try { await readFile(path); }
  catch { throw new Error(`${contractId} source of truth is missing or unreadable: ${sourcePath}`); }
}

function resolveRepositoryPath(relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error(`${label} must be a nonempty repository-relative path`);
  const resolved = resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`${label} escapes the repository: ${relativePath}`);
  return resolved;
}

function parseTypeScriptSource(sourceModule, source) {
  const scriptKind = sourceModule.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(sourceModule, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function hasExportModifier(statement) {
  return Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function exportedVariables(statement) {
  if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name)
    ? [{ name: declaration.name.text, initializer: declaration.initializer }]
    : []);
}

function exportedDeclaration(statement, symbol) {
  if (ts.isVariableStatement(statement)) {
    const variable = exportedVariables(statement).find((item) => item.name === symbol);
    return variable ? { kind: 'variable', node: statement } : undefined;
  }
  if (!hasExportModifier(statement) || statement.name?.text !== symbol) return undefined;
  if (ts.isFunctionDeclaration(statement)) return { kind: 'function', node: statement };
  if (ts.isClassDeclaration(statement)) return { kind: 'class', node: statement };
  if (ts.isInterfaceDeclaration(statement)) return { kind: 'interface', node: statement };
  if (ts.isTypeAliasDeclaration(statement)) return { kind: 'type', node: statement };
  return undefined;
}

function findExportedDeclaration(sourceFile, symbol) {
  for (const statement of sourceFile.statements) {
    const found = exportedDeclaration(statement, symbol);
    if (found) return found;
  }
  return undefined;
}

function requireExportKind(sourceFile, symbol, allowedKinds, label) {
  const declaration = findExportedDeclaration(sourceFile, symbol);
  if (!declaration || !allowedKinds.includes(declaration.kind)) {
    throw new Error(`${label} ${symbol} must be an exported ${allowedKinds.join(' or ')}`);
  }
  return declaration;
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

function kebabCase(value) { return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(); }

function parseJson(bytes, path) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

function resolveContractPath(relativePath, base, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error(`${label} must be a nonempty relative path`);
  const resolved = resolve(base, relativePath);
  if (resolved !== contractsRoot && !resolved.startsWith(`${contractsRoot}${sep}`)) throw new Error(`${label} escapes the contracts directory`);
  return resolved;
}

function validateSchema(value, schema, path, rootSchema = schema) {
  if (rootSchema !== schema) throw new Error('Nested custom schema validation is unsupported; compile the root schema instead');
  const ajv = makeAjv();
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    const details = ajv.errorsText(validate.errors, { dataVar: path, separator: '; ' });
    throw new Error(`Contract schema violation: ${details}`);
  }
}

function makeAjv() {
  // `required` fields in conditional branches are declared by their parent
  // object schemas; disabling only strictRequired preserves strict validation
  // without rejecting that standard draft-2020-12 composition pattern.
  const instance = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(instance);
  return instance;
}

function formatAjvErrors(errors) {
  return errors?.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ') ?? 'unknown schema error';
}

function assertThrows(operation, label) {
  try { operation(); }
  catch { return; }
  throw new Error(label);
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function assertEqual(actual, expected, label) { if (!Object.is(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`); }
function assertDeepEqual(actual, expected, label) { if (!deepEqual(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`); }
function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
