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
  // dotenv is optional for dry-run; Prisma will report missing DATABASE_URL on writes.
}

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`Usage: node scripts/index-reference-vectors.mjs [options]

Imports Kalodata reference videos and 1024-dim jina-clip-v2 vectors into Postgres.

Options:
  --references=<path>     ReferenceVideo payload, default tmp/kalodata-test/reference-videos.import.json.
  --training=<path>       benchmark-training.jsonl with embedding vectors, default tmp/kalodata-test/benchmark-training.jsonl.
  --limit=<n>             Optional max records to process.
  --dry-run               Validate payload and print summary without database writes.
  --skip-references       Only upsert EmbeddingVector rows; do not upsert ReferenceVideo rows.
  --help                  Show this help.

Notes:
  - ownerType is "reference"; embeddingModel is "jinaai/jina-clip-v2".
  - These records are analysis-only references and must not be used as creative source material.`);
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const referencesPath = path.resolve(readArg('references', 'tmp/kalodata-test/reference-videos.import.json'));
const trainingPath = path.resolve(readArg('training', 'tmp/kalodata-test/benchmark-training.jsonl'));
const limitArg = readArg('limit', '');
const limit = limitArg ? Math.max(1, Number(limitArg)) : Infinity;
const dryRun = hasFlag('dry-run');
const skipReferences = hasFlag('skip-references');

function readReferences(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const videos = Array.isArray(parsed) ? parsed : parsed.videos;
  if (!Array.isArray(videos) || !videos.length) throw new Error(`No videos found in ${filePath}`);
  return videos;
}

function readTraining(filePath) {
  const records = new Map();
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record?.id) records.set(record.id, record);
  }
  return records;
}

function metadataFor(reference, record) {
  const breakdown = reference.breakdownReport || {};
  const labels = record?.labels || breakdown.benchmarkLabel || {};
  const perf = breakdown.performanceLabel || record?.features || {};
  return {
    title: breakdown.productTitle || '',
    description: breakdown.description || '',
    referenceText: breakdown.referenceText || record?.referenceText || '',
    platform: breakdown.platform || 'tiktok_us',
    category: breakdown.category || record?.category || '',
    datasets: breakdown.datasets || record?.datasets || [],
    trafficType: breakdown.trafficType || '',
    durationSeconds: breakdown.durationSeconds || record?.durationSeconds || null,
    creatorHandle: breakdown.creatorHandle || '',
    sourceUrl: reference.sourceUrl,
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
  };
}

const references = readReferences(referencesPath).slice(0, Number.isFinite(limit) ? limit : undefined);
const training = readTraining(trainingPath);
const missingEmbedding = references.filter((reference) => !Array.isArray(training.get(reference.id)?.embedding));

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        references: references.length,
        trainingRecords: training.size,
        missingEmbedding: missingEmbedding.length,
        firstMissingIds: missingEmbedding.slice(0, 5).map((item) => item.id),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const db = require('@aigc-video-hub/db');

let upsertedReferences = 0;
let upsertedVectors = 0;
let skipped = 0;

try {
  for (const reference of references) {
    const record = training.get(reference.id);
    const embedding = record?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== 1024) {
      skipped += 1;
      continue;
    }

    if (!skipReferences) {
      await db.upsertReferenceVideo({
        id: reference.id,
        sourceUrl: reference.sourceUrl,
        localVideoUrl: reference.localVideoUrl,
        sourceDeclaration: reference.sourceDeclaration,
        licenseType: reference.licenseType,
        usageScope: reference.usageScope,
        breakdownReport: reference.breakdownReport,
      });
      upsertedReferences += 1;
    }

    await db.upsertEmbeddingVector({
      ownerType: 'reference',
      ownerId: reference.id,
      embeddingModel: db.REFERENCE_TEXT_EMBEDDING_MODEL,
      dims: 1024,
      vector: embedding,
      metadata: metadataFor(reference, record),
    });
    upsertedVectors += 1;

    if (upsertedVectors % 100 === 0) {
      console.error(`[reference-index] indexed ${upsertedVectors}/${references.length}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun: false,
        references: references.length,
        upsertedReferences,
        upsertedVectors,
        skipped,
        ownerType: 'reference',
        embeddingModel: db.REFERENCE_TEXT_EMBEDDING_MODEL,
        dims: 1024,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const compactMessage = message
    .split('\n')
    .filter((line) => line.trim() && !line.includes('node_modules/@prisma/client/runtime'))
    .slice(-8)
    .join('\n');
  console.error(`[reference-index] failed: ${compactMessage || message}`);
  process.exitCode = 1;
} finally {
  await db.disconnectPrisma?.();
}
