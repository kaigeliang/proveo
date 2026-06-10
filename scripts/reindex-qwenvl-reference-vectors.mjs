#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch {
  // Prisma and CLIP will report missing config if writes are attempted.
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`Usage: node scripts/reindex-qwenvl-reference-vectors.mjs [options]

Recomputes jina-clip-v2 vectors for Qwen-enhanced reference text and upserts
only rows that have qwenFactorIds.

Options:
  --training=<path>       Qwen-enhanced training JSONL, default tmp/kalodata-test/benchmark-training.qwenvl.jsonl.
  --references=<path>     Qwen-enhanced ReferenceVideo JSON, default tmp/kalodata-test/reference-videos.qwenvl.import.json.
  --limit=<n>             Optional max rows to process.
  --dry-run               Validate input and print summary without embedding or database writes.
  --help                  Show this help.`);
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const trainingPath = path.resolve(readArg('training', 'tmp/kalodata-test/benchmark-training.qwenvl.jsonl'));
const referencesPath = path.resolve(readArg('references', 'tmp/kalodata-test/reference-videos.qwenvl.import.json'));
const limitArg = readArg('limit', '');
const limit = limitArg ? Math.max(1, Number(limitArg)) : Infinity;
const dryRun = hasFlag('dry-run');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readReferences(filePath) {
  const parsed = readJson(filePath);
  const videos = Array.isArray(parsed) ? parsed : parsed.videos;
  if (!Array.isArray(videos)) throw new Error(`No videos array found in ${filePath}`);
  return new Map(videos.map((item) => [item.id, item]));
}

function jsonNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function metadataFor(row, reference) {
  const breakdown = reference?.breakdownReport || {};
  const labels = row.labels || breakdown.benchmarkLabel || {};
  const perf = breakdown.performanceLabel || row.features || {};
  const qwen = breakdown.qwenTruthSlice || row.qwenTruthSlice || {};
  const normalizedFactors = Array.isArray(qwen.normalizedFactors) ? qwen.normalizedFactors : [];
  const qwenFactorIds = Array.isArray(row.qwenFactorIds)
    ? row.qwenFactorIds
    : normalizedFactors.map((factor) => factor.factorId).filter(Boolean);

  return {
    title: breakdown.productTitle || '',
    description: breakdown.description || '',
    referenceText: row.referenceText || breakdown.referenceText || '',
    platform: breakdown.platform || 'tiktok_us',
    category: row.category || breakdown.category || '',
    datasets: row.datasets || breakdown.datasets || [],
    trafficType: breakdown.trafficType || '',
    durationSeconds: breakdown.durationSeconds || row.durationSeconds || null,
    creatorHandle: breakdown.creatorHandle || '',
    sourceUrl: reference?.sourceUrl || '',
    kalodataUrl: breakdown.kalodataUrl || '',
    labels,
    metrics: perf,
    benchmarkScore: labels.benchmarkScore ?? null,
    gmvPercentile: labels.gmvPercentile ?? null,
    salesPercentile: labels.salesPercentile ?? null,
    gmvPerMilleViewsPercentile: labels.gmvPerMilleViewsPercentile ?? null,
    organicWinner: labels.organicWinner === true,
    paidValidatedWinner: labels.paidValidatedWinner === true,
    lowFollowerWinner: labels.lowFollowerWinner === true,
    qwenTruth: {
      model: qwen.model || 'qwen3-vl-plus',
      factorIds: qwenFactorIds,
      factorCount: qwenFactorIds.length,
      qualityControl: qwen.qualityControl || row.qwenTruthSlice?.qualityControl || {},
    },
  };
}

function l2normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

const rows = readJsonl(trainingPath)
  .filter((row) => Array.isArray(row.qwenFactorIds) && row.qwenFactorIds.length > 0)
  .slice(0, Number.isFinite(limit) ? limit : undefined);
const references = readReferences(referencesPath);

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        trainingPath,
        referencesPath,
        qwenRows: rows.length,
        missingReferences: rows.filter((row) => !references.has(row.id)).length,
        firstIds: rows.slice(0, 8).map((row) => row.id),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const clipPath = path.join(root, 'apps/api/dist/apps/api/src/lib/clip.js');
if (!fs.existsSync(clipPath)) throw new Error('CLIP dist module not found. Run `npm run build --prefix apps/api`.');

process.chdir(path.join(root, 'apps/api'));
const { embedTextStrict, CLIP_MODEL_ID, EMBEDDING_DIMS } = require(clipPath);
if (typeof embedTextStrict !== 'function') throw new Error('apps/api dist is stale; embedTextStrict is unavailable.');
const db = require('@aigc-video-hub/db');

let upserted = 0;
try {
  for (const [index, row] of rows.entries()) {
    const reference = references.get(row.id);
    if (!reference) {
      console.error(`[qwen-vector] missing reference for ${row.id}; skipped`);
      continue;
    }

    const vector = l2normalize(await embedTextStrict(row.referenceText || ''));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (vector.length !== EMBEDDING_DIMS || norm < 0.95 || norm > 1.05) {
      throw new Error(`Invalid ${CLIP_MODEL_ID} vector for ${row.id}: dims=${vector.length}, norm=${norm}`);
    }

    await db.upsertEmbeddingVector({
      ownerType: 'reference',
      ownerId: row.id,
      embeddingModel: db.REFERENCE_TEXT_EMBEDDING_MODEL,
      dims: EMBEDDING_DIMS,
      vector,
      metadata: metadataFor(row, reference),
    });
    upserted += 1;
    if ((index + 1) % 25 === 0) console.error(`[qwen-vector] reindexed ${index + 1}/${rows.length}`);
  }

  console.log(
    JSON.stringify(
      {
        dryRun: false,
        qwenRows: rows.length,
        upserted,
        ownerType: 'reference',
        embeddingModel: db.REFERENCE_TEXT_EMBEDDING_MODEL,
        dims: EMBEDDING_DIMS,
      },
      null,
      2,
    ),
  );
} finally {
  await db.disconnectPrisma?.();
}
