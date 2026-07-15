import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportedTypeSourceSignature,
  parseContractSource,
  projectedSourceSignatures,
} from './contract-source-signatures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(process.argv[2] ?? '');
if (!contractPath.startsWith(`${root}${sep}`)) throw new Error('Pass one interface contract inside this repository');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const sourceCache = new Map();

async function sourceFile(sourceModule) {
  let cached = sourceCache.get(sourceModule);
  if (!cached) {
    const sourcePath = resolve(root, sourceModule);
    if (!sourcePath.startsWith(`${root}${sep}`)) throw new Error(`Source module escapes the repository: ${sourceModule}`);
    cached = parseContractSource(sourceModule, await readFile(sourcePath, 'utf8'));
    sourceCache.set(sourceModule, cached);
  }
  return cached;
}

for (const definition of Object.values(contract.typeDefinitions)) {
  if (!definition.typeExport || definition.sourceModule.startsWith('platform:')) continue;
  definition.sourceSignature = exportedTypeSourceSignature(
    await sourceFile(definition.sourceModule),
    definition.typeExport,
  );
}

for (const projection of contract.sourceProjections) {
  const actual = projectedSourceSignatures(await sourceFile(projection.sourceModule), projection);
  const byMember = new Map(actual.map((item) => [item.sourceMember, item.sourceSignature]));
  for (const member of projection.members) {
    const signature = byMember.get(member.sourceMember);
    if (!signature) throw new Error(`Projection omits or misnames ${projection.symbol}.${member.sourceMember}`);
    member.sourceSignature = signature;
  }
  if (actual.length !== projection.members.length) {
    throw new Error(`Projection ${projection.symbol} has ${projection.members.length} members, source has ${actual.length}`);
  }
}

process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
