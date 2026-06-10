#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function printHelp() {
  console.log(`Usage: node scripts/extract-factors.mjs [options]

Extracts baseline creative factor weights from reviewed GT input or deterministic fixtures.
Default mode is a dry run; it prints FactorWeight-ready records and does not write to DB.

Options:
  --input=<path>          Reviewed JSON array or {"videos": [...]} payload.
  --top=<n>               Number of factors to return, default 12.
  --dry-run              Explicit no-write mode; equivalent to the default.
  --help                 Show this help.

Validation:
  - No database or external provider key is required.
  - Without --input, 30 fixture:// GT records are used.
  - Persisting factors is intentionally delegated to the DB/API adapter.`);
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

function requireBuilt(relativePath) {
  const sourcePath = relativePath.replace('apps/api/dist/apps/api/src/', 'apps/api/src/').replace(/\.js$/, '.ts');
  const modulePath = path.join(root, process.env.P2_USE_TS_SOURCE === '1' ? sourcePath : relativePath);
  if (!fs.existsSync(modulePath)) {
    throw new Error(
      'P2 module is unavailable. Run `npm run build:api`, or use the documented P2_USE_TS_SOURCE validation command.',
    );
  }
  return require(modulePath);
}

function readVideos(inputPath) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.videos;
}

const inputPath = readArg('input', '');
const topK = Math.max(1, Number(readArg('top', '12')));
const dryRun = true;
const { createGroundTruthFixtures, FIXTURE_FACTOR_WEIGHTS } = requireBuilt(
  'apps/api/dist/apps/api/src/lib/tournament/fixtures.js',
);
const { DEFAULT_FACTOR_EFFECTS } = requireBuilt('apps/api/dist/apps/api/src/lib/scoring/mock-ctr.js');
const videos = inputPath ? readVideos(inputPath) : createGroundTruthFixtures(30);
const occurrences = new Map();

for (const video of videos) {
  const factors = Array.isArray(video.breakdownReport?.factors) ? video.breakdownReport.factors : [];
  for (const factorId of factors) occurrences.set(factorId, (occurrences.get(factorId) || 0) + 1);
}

const fixtureWeights = new Map(FIXTURE_FACTOR_WEIGHTS.map((factor) => [factor.factorId, factor.weight]));
const factors = [...occurrences.entries()]
  .map(([factorId, sampleSize]) => ({
    factorId,
    factorType: factorId.split(':')[0],
    factorValue: factorId.split(':').slice(1).join(':'),
    sampleSize,
    baselineWeight: fixtureWeights.get(factorId) ?? DEFAULT_FACTOR_EFFECTS[factorId] ?? 0,
    source: inputPath ? 'ground_truth_input' : 'deterministic_fixture',
  }))
  .sort((left, right) => right.sampleSize - left.sampleSize || right.baselineWeight - left.baselineWeight)
  .slice(0, topK);

if (factors.length < 10) {
  throw new Error(`Only ${factors.length} factors were extracted; at least 10 are required for the rubric baseline.`);
}

console.log(
  JSON.stringify(
    {
      mode: inputPath ? 'reviewed_input' : 'deterministic_fixture',
      dryRun,
      videoCount: videos.length,
      factorCount: factors.length,
      persistenceRequired: 'Main integration must upsert each item into FactorWeight through the DB/API adapter.',
      factors,
    },
    null,
    2,
  ),
);
