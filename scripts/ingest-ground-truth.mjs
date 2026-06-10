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
  console.log(`Usage: node scripts/ingest-ground-truth.mjs [options]

Creates or validates ReferenceVideo import payloads for P2 ground-truth analysis.
Default mode is a deterministic fixture dry run with no database writes.

Options:
  --count=<n>             Number of fixture records to generate, default 30.
  --input=<path>          Reviewed JSON array or {"videos": [...]} payload.
  --dry-run              Validate and print the payload summary without writes.
  --persist              POST records to /api/reference-videos/import.
  --api=<url>             API base URL required with --persist.
  --json                 Include full video records in output.
  --help                 Show this help.

Validation:
  - No external provider key is required.
  - Without --input, sourceUrl values are fixture:// paths for offline tests only.
  - --persist is explicit and requires a running API; default/--dry-run never writes.`);
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

function loadFixtureModule() {
  const relativePath =
    process.env.P2_USE_TS_SOURCE === '1'
      ? 'apps/api/src/lib/tournament/fixtures.ts'
      : 'apps/api/dist/apps/api/src/lib/tournament/fixtures.js';
  const modulePath = path.join(root, relativePath);
  if (!fs.existsSync(modulePath)) {
    throw new Error(
      'P2 module is unavailable. Run `npm run build:api`, or use the documented P2_USE_TS_SOURCE validation command.',
    );
  }
  return require(modulePath);
}

function readInput(inputPath) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.videos;
}

function validateVideos(videos) {
  if (!Array.isArray(videos) || videos.length === 0) throw new Error('No reference videos were supplied.');
  for (const item of videos) {
    if (!item.id || !item.sourceUrl || !item.breakdownReport) {
      throw new Error(`Invalid reference video record: ${JSON.stringify(item)}`);
    }
  }
}

const count = Number(readArg('count', '30'));
const inputPath = readArg('input', '');
const apiBase = readArg('api', '').replace(/\/$/, '');
const dryRun = hasFlag('dry-run');
const persist = hasFlag('persist');
const outputJson = hasFlag('json');
if (dryRun && persist) {
  throw new Error('Choose either --dry-run or --persist; dry-run never writes.');
}
const { createGroundTruthFixtures } = loadFixtureModule();
const videos = inputPath ? readInput(inputPath) : createGroundTruthFixtures(count);
validateVideos(videos);

if (persist && !apiBase) {
  throw new Error('Use `--persist --api=http://127.0.0.1:5001` to write through the reference video API.');
}

let importResult = null;
if (persist) {
  const response = await fetch(`${apiBase}/api/reference-videos/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videos }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST /api/reference-videos/import -> ${response.status}: ${text}`);
  importResult = text ? JSON.parse(text) : null;
}

const result = {
  mode: inputPath ? 'reviewed_input' : 'deterministic_fixture',
  fixtureOnly: !inputPath,
  dryRun: !persist,
  count: videos.length,
  persisted: Boolean(persist),
  api: persist ? apiBase : undefined,
  sourceUrlsPresent: videos.every((item) => Boolean(item.sourceUrl)),
  ids: videos.map((item) => item.id),
  importResult,
  warning: inputPath
    ? undefined
    : 'fixture:// URLs support offline evaluation only; replace with reviewed public sources before production use.',
  videos: outputJson ? videos : undefined,
};

console.log(JSON.stringify(result, null, 2));
