#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import readXlsxFile from 'read-excel-file/node';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const DATASET_CONFIG = {
  organic: {
    key: 'organic_sales_videos',
    label: 'Organic sales winners',
    trafficType: 'organic',
    defaultUsage: 'analysis',
  },
  all: {
    key: 'all_videos',
    label: 'All top sales videos',
    trafficType: 'mixed',
    defaultUsage: 'analysis',
  },
  highRoas: {
    key: 'high_roas_ads',
    label: 'High ROAS paid winners',
    trafficType: 'paid_validated',
    defaultUsage: 'analysis',
  },
  lowFollower: {
    key: 'low_follower_videos',
    label: 'Low follower sales winners',
    trafficType: 'low_follower_winner',
    defaultUsage: 'analysis',
  },
};

const COLUMN = {
  dateRange: '日期范围',
  description: '视频描述',
  duration: '时长',
  creator: '达人handle（达人账号）',
  publishedAt: '发布日期',
  gmv: '成交金额(¥)',
  sales: '销量',
  productTitle: '商品标题',
  category: '商品类目',
  views: '观看次数',
  gmvPerMilleViews: '千次观看成交金额(¥)',
  costPerOrder: '单次成交广告成本(¥)',
  adViewRatio: '广告观看占比',
  adSpend: '广告消耗(¥)',
  adRoas: '广告ROAS',
  kalodataUrl: 'Kalodata详情页链接',
  tiktokUrl: 'TikTok链接',
};

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function printHelp() {
  console.log(`Usage:
  node scripts/ingest-kalodata-exports.mjs \\
    --organic=/path/organic_sales_videos.xlsx \\
    --all=/path/all_videos.xlsx \\
    --high-roas=/path/high_roas_ads.xlsx \\
    --low-follower=/path/low_follower_videos.xlsx \\
    --out-dir=tmp/kalodata-test \\
    --embedding=clip

Options:
  --embedding=clip             Build benchmark vectors with jina-clip-v2. Default: clip.
                              Requires apps/api dist and may download/cache model assets.
  --include-vectors            Include per-video embedding vectors in benchmark-training.jsonl.
  --test-ratio=<n>             Stable holdout ratio for benchmark-test.jsonl, default 0.2.
  --sample=<n>                 Also write first n records to reference-videos.sample.json, default 20.
  --help                       Show this help.

Outputs:
  summary.json
  reference-videos.import.json
  reference-videos.sample.json
  reference-videos.test.json
  benchmark-training.jsonl
  benchmark-train.jsonl
  benchmark-test.jsonl
  benchmark-model.json`);
}

function readText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).replace(/\s+/g, ' ').trim();
}

function readNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.replace(/[,\s¥]/g, '');
  if (normalized.endsWith('%')) {
    const percent = Number(normalized.slice(0, -1));
    return Number.isFinite(percent) ? percent / 100 : null;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Math.max(0, Math.round(value));
  const text = String(value).trim().toLowerCase();
  let match = text.match(/^(\d+)s$/);
  if (match) return Number(match[1]);
  match = text.match(/^(\d+)m\s*(\d+)s$/);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  match = text.match(/^(\d+)m$/);
  if (match) return Number(match[1]) * 60;
  const number = readNumber(text);
  return number === null ? null : Math.max(0, Math.round(number));
}

function extractVideoId(url) {
  const text = readText(url);
  return text.match(/\/video\/(\d+)/)?.[1] || text.match(/[?&]id=(\d+)/)?.[1] || '';
}

function safeId(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 96);
}

function l2normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function dot(a, b) {
  const len = Math.min(a?.length || 0, b?.length || 0);
  let total = 0;
  for (let i = 0; i < len; i += 1) total += a[i] * b[i];
  return total;
}

function percentileRank(sortedValues, value) {
  if (value === null || value === undefined || !sortedValues.length) return null;
  let count = 0;
  for (const item of sortedValues) {
    if (item <= value) count += 1;
    else break;
  }
  return count / sortedValues.length;
}

function quantiles(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))];
  return { min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: q(1) };
}

function averageVector(vectors) {
  if (!vectors.length) return null;
  const dims = vectors[0].length;
  const out = Array.from({ length: dims }, () => 0);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) out[i] += vector[i] || 0;
  }
  return l2normalize(out.map((value) => value / vectors.length));
}

async function readDataset(file, datasetKey) {
  const workbookRows = await readXlsxFile(file, { sheet: 'LIST_VIDEO' });
  const rows = Array.isArray(workbookRows?.[0]?.data) ? workbookRows[0].data : workbookRows;
  if (!rows.length) throw new Error(`Empty sheet LIST_VIDEO in ${file}`);
  const headers = rows[0].map((cell) => readText(cell));
  const indexes = new Map(headers.map((header, index) => [header, index]));
  for (const required of Object.values(COLUMN)) {
    if (!indexes.has(required)) throw new Error(`Missing column ${required} in ${file}`);
  }
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell !== null && cell !== undefined && cell !== ''))
    .map((row) => {
      const get = (name) => row[indexes.get(name)];
      const tiktokUrl = readText(get(COLUMN.tiktokUrl));
      const kalodataUrl = readText(get(COLUMN.kalodataUrl));
      const videoId = extractVideoId(tiktokUrl) || extractVideoId(kalodataUrl);
      const adViewRatio = readNumber(get(COLUMN.adViewRatio));
      const adSpendCny = readNumber(get(COLUMN.adSpend));
      const trafficType =
        DATASET_CONFIG[datasetKey].trafficType === 'mixed'
          ? adViewRatio === 0 || adSpendCny === 0
            ? 'organic'
            : 'paid'
          : DATASET_CONFIG[datasetKey].trafficType;
      return {
        dataset: DATASET_CONFIG[datasetKey].key,
        videoId,
        dateRange: readText(get(COLUMN.dateRange)),
        description: readText(get(COLUMN.description)),
        durationSeconds: parseDurationSeconds(get(COLUMN.duration)),
        creatorHandle: readText(get(COLUMN.creator)),
        publishedAt: readText(get(COLUMN.publishedAt)),
        gmvCny: readNumber(get(COLUMN.gmv)),
        sales: readNumber(get(COLUMN.sales)),
        productTitle: readText(get(COLUMN.productTitle)),
        category: readText(get(COLUMN.category)),
        views: readNumber(get(COLUMN.views)),
        gmvPerMilleViewsCny: readNumber(get(COLUMN.gmvPerMilleViews)),
        costPerOrderCny: readNumber(get(COLUMN.costPerOrder)),
        adViewRatio,
        adSpendCny,
        adRoas: readNumber(get(COLUMN.adRoas)),
        kalodataUrl,
        tiktokUrl,
        trafficType,
      };
    });
}

function mergeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = row.videoId || row.tiktokUrl || row.kalodataUrl;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row, datasets: [row.dataset], trafficTypes: [row.trafficType] });
      continue;
    }
    if (!existing.datasets.includes(row.dataset)) existing.datasets.push(row.dataset);
    if (!existing.trafficTypes.includes(row.trafficType)) existing.trafficTypes.push(row.trafficType);
    if ((row.gmvCny || 0) > (existing.gmvCny || 0)) {
      const datasets = existing.datasets;
      const trafficTypes = existing.trafficTypes;
      byKey.set(key, { ...row, datasets, trafficTypes });
    }
  }
  return [...byKey.values()];
}

function benchmarkText(row) {
  return [
    row.description,
    row.productTitle,
    row.category,
    row.datasets?.join(' '),
    row.trafficTypes?.join(' '),
    `duration:${row.durationSeconds ?? ''}`,
  ]
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function embedRows(rows, mode) {
  if (mode !== 'clip') throw new Error(`Unsupported embedding mode: ${mode}`);
  const clipPath = path.join(repoRoot, 'apps/api/dist/apps/api/src/lib/clip.js');
  try {
    await fs.access(clipPath);
  } catch {
    throw new Error('CLIP dist module not found. Run `npm run build --prefix apps/api` before --embedding=clip.');
  }
  process.chdir(path.join(repoRoot, 'apps/api'));
  const { embedTextStrict, CLIP_MODEL_ID, EMBEDDING_DIMS } = require(clipPath);
  if (typeof embedTextStrict !== 'function') {
    throw new Error('apps/api dist is stale. Run `npm run build --prefix apps/api` to expose embedTextStrict.');
  }
  const vectors = new Map();
  for (const [index, row] of rows.entries()) {
    const vector = await embedTextStrict(row.referenceText);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (vector.length !== EMBEDDING_DIMS || norm < 0.95 || norm > 1.05) {
      throw new Error(`Invalid ${CLIP_MODEL_ID} vector for ${row.id}: dims=${vector.length}, norm=${norm}`);
    }
    vectors.set(row.id, l2normalize(vector));
    if ((index + 1) % 50 === 0) console.error(`[kalodata] embedded ${index + 1}/${rows.length}`);
  }
  return { vectors, model: CLIP_MODEL_ID, dims: EMBEDDING_DIMS };
}

function addLabels(rows, vectors) {
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }
  const sortedByCategory = new Map();
  for (const [category, categoryRows] of byCategory) {
    sortedByCategory.set(category, {
      gmvCny: categoryRows
        .map((row) => row.gmvCny)
        .filter((value) => value !== null)
        .sort((a, b) => a - b),
      sales: categoryRows
        .map((row) => row.sales)
        .filter((value) => value !== null)
        .sort((a, b) => a - b),
      views: categoryRows
        .map((row) => row.views)
        .filter((value) => value !== null)
        .sort((a, b) => a - b),
      gmvPerMilleViewsCny: categoryRows
        .map((row) => row.gmvPerMilleViewsCny)
        .filter((value) => value !== null)
        .sort((a, b) => a - b),
      adRoas: categoryRows
        .map((row) => row.adRoas)
        .filter((value) => value !== null)
        .sort((a, b) => a - b),
    });
  }

  const cohortVectors = {};
  for (const cohort of ['organic_sales_videos', 'high_roas_ads', 'low_follower_videos']) {
    cohortVectors[cohort] = averageVector(
      rows
        .filter((row) => row.datasets.includes(cohort))
        .map((row) => vectors.get(row.id))
        .filter(Boolean),
    );
  }

  for (const row of rows) {
    const sorted = sortedByCategory.get(row.category);
    const labels = {
      categorySize: byCategory.get(row.category)?.length || 0,
      gmvPercentile: percentileRank(sorted.gmvCny, row.gmvCny),
      salesPercentile: percentileRank(sorted.sales, row.sales),
      viewsPercentile: percentileRank(sorted.views, row.views),
      gmvPerMilleViewsPercentile: percentileRank(sorted.gmvPerMilleViewsCny, row.gmvPerMilleViewsCny),
      adRoasPercentile: percentileRank(sorted.adRoas, row.adRoas),
    };
    const vector = vectors.get(row.id);
    const similarities = {
      organicWinnerSimilarity:
        vector && cohortVectors.organic_sales_videos ? dot(vector, cohortVectors.organic_sales_videos) : null,
      paidRoasWinnerSimilarity: vector && cohortVectors.high_roas_ads ? dot(vector, cohortVectors.high_roas_ads) : null,
      lowFollowerWinnerSimilarity:
        vector && cohortVectors.low_follower_videos ? dot(vector, cohortVectors.low_follower_videos) : null,
    };
    const conversionLabel = Math.max(labels.gmvPerMilleViewsPercentile ?? 0, labels.salesPercentile ?? 0);
    const paidLabel = Math.max(labels.adRoasPercentile ?? 0, labels.gmvPerMilleViewsPercentile ?? 0);
    const organicBoost = row.datasets.includes('organic_sales_videos') ? 0.08 : 0;
    const lowFollowerBoost = row.datasets.includes('low_follower_videos') ? 0.05 : 0;
    row.labels = {
      ...labels,
      organicWinner: row.datasets.includes('organic_sales_videos'),
      paidValidatedWinner: row.datasets.includes('high_roas_ads'),
      lowFollowerWinner: row.datasets.includes('low_follower_videos'),
      benchmarkScore: Math.min(
        1,
        0.5 * conversionLabel + 0.25 * paidLabel + 0.17 * (labels.gmvPercentile ?? 0) + organicBoost + lowFollowerBoost,
      ),
    };
    row.similarities = similarities;
  }
  return cohortVectors;
}

function toReferenceVideo(row) {
  const trafficType = row.datasets.includes('high_roas_ads')
    ? 'paid_validated'
    : row.datasets.includes('organic_sales_videos') && (row.adViewRatio || 0) === 0
      ? 'organic'
      : row.trafficTypes.includes('paid')
        ? 'paid'
        : row.trafficTypes[0] || 'mixed';
  return {
    id: row.id,
    sourceUrl: row.tiktokUrl || row.kalodataUrl,
    sourceDeclaration: 'Kalodata Data Export 2026-05-28; source video URL retained; analysis-only benchmark reference.',
    licenseType: 'kalodata_data_export_reference',
    usageScope: 'analysis',
    breakdownReport: {
      source: 'kalodata',
      platform: 'tiktok_us',
      datasets: row.datasets,
      videoId: row.videoId,
      kalodataUrl: row.kalodataUrl,
      tiktokUrl: row.tiktokUrl,
      description: row.description,
      durationSeconds: row.durationSeconds,
      creatorHandle: row.creatorHandle,
      publishedAt: row.publishedAt,
      productTitle: row.productTitle,
      category: row.category,
      trafficType,
      performanceLabel: {
        window: row.dateRange || '2026-04-27~2026-05-26',
        gmvCny: row.gmvCny,
        sales: row.sales,
        views: row.views,
        gmvPerMilleViewsCny: row.gmvPerMilleViewsCny,
        adViewRatio: row.adViewRatio,
        adSpendCny: row.adSpendCny,
        adRoas: row.adRoas,
        costPerOrderCny: row.costPerOrderCny,
      },
      benchmarkLabel: row.labels,
      benchmarkSimilarity: row.similarities,
      creativeFeature: {
        scriptText: row.description,
        hookText: row.description.slice(0, 160),
        sellingPoints: [],
        shotStructure: [],
        ctaText: '',
      },
      referenceText: row.referenceText,
    },
  };
}

function summarize(rows, originalRows, embeddingInfo) {
  const missing = {};
  for (const field of [
    'description',
    'durationSeconds',
    'creatorHandle',
    'publishedAt',
    'gmvCny',
    'sales',
    'productTitle',
    'category',
    'views',
    'gmvPerMilleViewsCny',
    'adViewRatio',
    'adSpendCny',
    'adRoas',
    'kalodataUrl',
    'tiktokUrl',
  ]) {
    missing[field] = originalRows.filter(
      (row) => row[field] === null || row[field] === undefined || row[field] === '',
    ).length;
  }
  const byDataset = {};
  for (const row of rows) {
    for (const dataset of row.datasets) {
      const bucket = (byDataset[dataset] ||= { uniqueVideos: 0, gmvCny: 0, sales: 0, views: 0, organic: 0, paid: 0 });
      bucket.uniqueVideos += 1;
      bucket.gmvCny += row.gmvCny || 0;
      bucket.sales += row.sales || 0;
      bucket.views += row.views || 0;
      if (row.trafficTypes.includes('paid')) bucket.paid += 1;
      else bucket.organic += 1;
    }
  }
  for (const bucket of Object.values(byDataset)) {
    bucket.gmvCny = Math.round(bucket.gmvCny);
    bucket.sales = Math.round(bucket.sales);
    bucket.views = Math.round(bucket.views);
    bucket.avgGmvCny = Math.round(bucket.gmvCny / bucket.uniqueVideos);
    bucket.avgViews = Math.round(bucket.views / bucket.uniqueVideos);
  }
  const categories = new Map();
  for (const row of rows) categories.set(row.category, (categories.get(row.category) || 0) + 1);
  return {
    generatedAt: new Date().toISOString(),
    inputRows: originalRows.length,
    uniqueVideos: rows.length,
    duplicateRows: originalRows.length - rows.length,
    embedding: embeddingInfo,
    missing,
    quantiles: {
      durationSeconds: quantiles(originalRows.map((row) => row.durationSeconds)),
      gmvCny: quantiles(originalRows.map((row) => row.gmvCny)),
      sales: quantiles(originalRows.map((row) => row.sales)),
      views: quantiles(originalRows.map((row) => row.views)),
      gmvPerMilleViewsCny: quantiles(originalRows.map((row) => row.gmvPerMilleViewsCny)),
      adViewRatio: quantiles(originalRows.map((row) => row.adViewRatio)),
      adSpendCny: quantiles(originalRows.map((row) => row.adSpendCny)),
      adRoas: quantiles(originalRows.map((row) => row.adRoas)),
    },
    datasets: byDataset,
    topCategories: [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}

function assignSplits(rows, testRatio) {
  const clampedRatio = Math.max(0, Math.min(0.5, testRatio));
  const buckets = new Map();
  for (const row of rows) {
    const bucketKey = [...row.datasets].sort().join('+');
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(row);
  }

  let train = 0;
  let test = 0;
  for (const bucketRows of buckets.values()) {
    bucketRows.sort((a, b) => a.id.localeCompare(b.id));
    const testCount =
      bucketRows.length >= 5 && clampedRatio > 0
        ? Math.max(1, Math.min(bucketRows.length - 1, Math.round(bucketRows.length * clampedRatio)))
        : 0;
    const testIndexes = new Set(
      Array.from({ length: testCount }, (_, index) => Math.floor(((index + 0.5) * bucketRows.length) / testCount)),
    );
    for (const [index, row] of bucketRows.entries()) {
      row.split = testIndexes.has(index) ? 'test' : 'train';
      if (row.split === 'test') test += 1;
      else train += 1;
    }
  }
  return {
    train,
    test,
    testRatio: clampedRatio,
    strategy: 'dataset-stratified-id-order-even-sampling',
    bucketCount: buckets.size,
  };
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const files = {
  organic: readArg('organic'),
  all: readArg('all'),
  highRoas: readArg('high-roas'),
  lowFollower: readArg('low-follower'),
};
for (const [key, file] of Object.entries(files)) {
  if (!file)
    throw new Error(
      `Missing --${key === 'highRoas' ? 'high-roas' : key === 'lowFollower' ? 'low-follower' : key}=<xlsx>`,
    );
}

const outDir = path.resolve(readArg('out-dir', 'tmp/kalodata-test'));
const embeddingMode = readArg('embedding', 'clip');
const sampleCount = Number(readArg('sample', '20'));
const includeVectors = hasFlag('include-vectors');
const requestedTestRatio = Number(readArg('test-ratio', '0.2'));

const originalRows = [];
for (const [key, file] of Object.entries(files)) {
  const rows = await readDataset(path.resolve(file), key);
  originalRows.push(...rows);
  console.error(`[kalodata] ${DATASET_CONFIG[key].key}: ${rows.length} rows`);
}

const merged = mergeRows(originalRows).map((row) => ({
  ...row,
  id: `kalodata_${safeId(row.videoId || row.tiktokUrl || row.kalodataUrl)}`,
}));
for (const row of merged) row.referenceText = benchmarkText(row);

const embedding = await embedRows(merged, embeddingMode);
const cohortVectors = addLabels(merged, embedding.vectors);
const split = assignSplits(merged, requestedTestRatio);
const embeddingInfo = {
  mode: embeddingMode,
  model: embedding.model,
  dims: embedding.dims,
  rowsEmbedded: embedding.vectors.size,
};
const summary = summarize(merged, originalRows, embeddingInfo);
summary.split = split;
const references = merged.map(toReferenceVideo);
const referencesById = new Map(references.map((reference) => [reference.id, reference]));

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
await fs.writeFile(
  path.join(outDir, 'reference-videos.import.json'),
  `${JSON.stringify({ videos: references }, null, 2)}\n`,
);
await fs.writeFile(
  path.join(outDir, 'reference-videos.sample.json'),
  `${JSON.stringify({ videos: references.slice(0, sampleCount) }, null, 2)}\n`,
);
await fs.writeFile(
  path.join(outDir, 'reference-videos.test.json'),
  `${JSON.stringify(
    { videos: merged.filter((row) => row.split === 'test').map((row) => referencesById.get(row.id)) },
    null,
    2,
  )}\n`,
);

function trainingRecord(row) {
  return {
    id: row.id,
    videoId: row.videoId,
    split: row.split,
    referenceText: row.referenceText,
    datasets: row.datasets,
    category: row.category,
    durationSeconds: row.durationSeconds,
    trafficTypes: row.trafficTypes,
    features: {
      adViewRatio: row.adViewRatio,
      adSpendCny: row.adSpendCny,
      adRoas: row.adRoas,
      gmvPerMilleViewsCny: row.gmvPerMilleViewsCny,
    },
    labels: row.labels,
    similarities: row.similarities,
    embedding: includeVectors ? embedding.vectors.get(row.id) : undefined,
  };
}

const trainingLines = merged.map((row) => JSON.stringify(trainingRecord(row)));
const trainLines = merged.filter((row) => row.split === 'train').map((row) => JSON.stringify(trainingRecord(row)));
const testLines = merged.filter((row) => row.split === 'test').map((row) => JSON.stringify(trainingRecord(row)));
await fs.writeFile(path.join(outDir, 'benchmark-training.jsonl'), `${trainingLines.join('\n')}\n`);
await fs.writeFile(path.join(outDir, 'benchmark-train.jsonl'), `${trainLines.join('\n')}\n`);
await fs.writeFile(path.join(outDir, 'benchmark-test.jsonl'), `${testLines.join('\n')}\n`);
await fs.writeFile(
  path.join(outDir, 'benchmark-model.json'),
  `${JSON.stringify(
    {
      generatedAt: summary.generatedAt,
      embedding: embeddingInfo,
      split,
      cohorts: Object.fromEntries(
        Object.entries(cohortVectors).map(([key, vector]) => [
          key,
          vector ? vector.map((value) => Number(value.toFixed(8))) : null,
        ]),
      ),
      scoring: {
        version: 'kalodata-benchmark-v0',
        target:
          'Use category-normalized GMV per mille views, sales, GMV, ROAS, and cohort similarity as a first-pass Auditor benchmark score.',
      },
    },
    null,
    2,
  )}\n`,
);

console.log(
  JSON.stringify(
    {
      outDir,
      inputRows: summary.inputRows,
      uniqueVideos: summary.uniqueVideos,
      embedding: embeddingInfo,
      split,
      outputs: [
        'summary.json',
        'reference-videos.import.json',
        'reference-videos.sample.json',
        'reference-videos.test.json',
        'benchmark-training.jsonl',
        'benchmark-train.jsonl',
        'benchmark-test.jsonl',
        'benchmark-model.json',
      ],
    },
    null,
    2,
  ),
);
