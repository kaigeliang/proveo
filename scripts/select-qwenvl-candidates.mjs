#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`Usage: node scripts/select-qwenvl-candidates.mjs [options]

Selects high-value Kalodata reference videos for Qwen-VL video understanding.

Options:
  --input=<path>          ReferenceVideo payload, default tmp/kalodata-test/reference-videos.import.json.
  --out=<path>            Output JSON path, default tmp/kalodata-test/qwenvl-candidates.json.
  --csv=<path>            Output CSV path, default tmp/kalodata-test/qwenvl-candidates.csv.
  --organic=<n>           Organic winner count, default 35.
  --paid=<n>              High-ROAS ad count, default 35.
  --low-follower=<n>      Low-follower winner count, default 35.
  --negative=<n>          Contrast negative count, default 15.
  --category-cap=<n>      Max videos per category per bucket, default 5.
  --help                  Show this help.`);
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const inputPath = path.resolve(readArg('input', 'tmp/kalodata-test/reference-videos.import.json'));
const outPath = path.resolve(readArg('out', 'tmp/kalodata-test/qwenvl-candidates.json'));
const csvPath = path.resolve(readArg('csv', 'tmp/kalodata-test/qwenvl-candidates.csv'));
const bucketTargets = {
  organic_winner: Number(readArg('organic', '35')),
  paid_roas_winner: Number(readArg('paid', '35')),
  low_follower_winner: Number(readArg('low-follower', '35')),
  negative_contrast: Number(readArg('negative', '15')),
};
const categoryCap = Number(readArg('category-cap', '5'));

function readReferences(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const videos = Array.isArray(parsed) ? parsed : parsed.videos;
  if (!Array.isArray(videos) || !videos.length) throw new Error(`No videos found in ${filePath}`);
  return videos;
}

function number(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function report(video) {
  return video.breakdownReport || {};
}

function labels(video) {
  return report(video).benchmarkLabel || {};
}

function perf(video) {
  return report(video).performanceLabel || {};
}

function datasets(video) {
  return Array.isArray(report(video).datasets) ? report(video).datasets : [];
}

function category(video) {
  return String(report(video).category || 'unknown');
}

function baseScore(video) {
  const l = labels(video);
  const p = perf(video);
  return (
    number(l.benchmarkScore) * 0.44 +
    number(l.gmvPercentile) * 0.18 +
    number(l.salesPercentile) * 0.14 +
    number(l.gmvPerMilleViewsPercentile) * 0.14 +
    Math.min(1, Math.log1p(number(p.gmvCny)) / Math.log1p(2_000_000)) * 0.1
  );
}

function paidScore(video) {
  const l = labels(video);
  const p = perf(video);
  return (
    number(l.adRoasPercentile) * 0.36 +
    Math.min(1, number(p.adRoas) / 10) * 0.28 +
    number(l.benchmarkScore) * 0.22 +
    Math.min(1, Math.log1p(number(p.adSpendCny)) / Math.log1p(100_000)) * 0.14
  );
}

function negativeScore(video) {
  const l = labels(video);
  const highAttentionLowEfficiency =
    number(l.viewsPercentile) * 0.45 + (1 - number(l.gmvPerMilleViewsPercentile)) * 0.35;
  return highAttentionLowEfficiency + (1 - number(l.benchmarkScore)) * 0.2;
}

function candidate(video, bucket, rank, score) {
  const r = report(video);
  const l = labels(video);
  const p = perf(video);
  return {
    id: video.id,
    bucket,
    rank,
    score: Number(score.toFixed(4)),
    sourceUrl: video.sourceUrl,
    kalodataUrl: r.kalodataUrl || undefined,
    tiktokUrl: r.tiktokUrl || video.sourceUrl,
    platform: r.platform || 'tiktok_us',
    datasets: datasets(video),
    category: r.category || '',
    productTitle: r.productTitle || '',
    creatorHandle: r.creatorHandle || '',
    publishedAt: r.publishedAt || '',
    durationSeconds: r.durationSeconds ?? null,
    description: r.description || '',
    referenceText: r.referenceText || '',
    labels: {
      benchmarkScore: l.benchmarkScore ?? null,
      gmvPercentile: l.gmvPercentile ?? null,
      salesPercentile: l.salesPercentile ?? null,
      viewsPercentile: l.viewsPercentile ?? null,
      gmvPerMilleViewsPercentile: l.gmvPerMilleViewsPercentile ?? null,
      adRoasPercentile: l.adRoasPercentile ?? null,
      organicWinner: l.organicWinner === true,
      paidValidatedWinner: l.paidValidatedWinner === true,
      lowFollowerWinner: l.lowFollowerWinner === true,
    },
    performance: {
      gmvCny: p.gmvCny ?? null,
      sales: p.sales ?? null,
      views: p.views ?? null,
      gmvPerMilleViewsCny: p.gmvPerMilleViewsCny ?? null,
      adViewRatio: p.adViewRatio ?? null,
      adSpendCny: p.adSpendCny ?? null,
      adRoas: p.adRoas ?? null,
    },
  };
}

function selectBucket({ videos, used, bucket, target, predicate, scoreFn }) {
  const selected = [];
  const perCategory = new Map();
  const ranked = videos
    .filter((video) => !used.has(video.id) && predicate(video))
    .map((video) => ({ video, score: scoreFn(video) }))
    .sort((left, right) => right.score - left.score);

  for (const item of ranked) {
    const cat = category(item.video);
    const count = perCategory.get(cat) || 0;
    if (count >= categoryCap) continue;
    selected.push(candidate(item.video, bucket, selected.length + 1, item.score));
    used.add(item.video.id);
    perCategory.set(cat, count + 1);
    if (selected.length >= target) break;
  }

  if (selected.length < target) {
    for (const item of ranked) {
      if (used.has(item.video.id)) continue;
      selected.push(candidate(item.video, bucket, selected.length + 1, item.score));
      used.add(item.video.id);
      if (selected.length >= target) break;
    }
  }
  return selected;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const videos = readReferences(inputPath);
const used = new Set();
const selected = [
  ...selectBucket({
    videos,
    used,
    bucket: 'organic_winner',
    target: bucketTargets.organic_winner,
    predicate: (video) =>
      labels(video).organicWinner === true || datasets(video).includes('organic_sales_videos'),
    scoreFn: baseScore,
  }),
  ...selectBucket({
    videos,
    used,
    bucket: 'paid_roas_winner',
    target: bucketTargets.paid_roas_winner,
    predicate: (video) =>
      labels(video).paidValidatedWinner === true || datasets(video).includes('high_roas_ads'),
    scoreFn: paidScore,
  }),
  ...selectBucket({
    videos,
    used,
    bucket: 'low_follower_winner',
    target: bucketTargets.low_follower_winner,
    predicate: (video) =>
      labels(video).lowFollowerWinner === true || datasets(video).includes('low_follower_videos'),
    scoreFn: baseScore,
  }),
  ...selectBucket({
    videos,
    used,
    bucket: 'negative_contrast',
    target: bucketTargets.negative_contrast,
    predicate: (video) =>
      number(labels(video).benchmarkScore) <= 0.35 ||
      (number(labels(video).viewsPercentile) >= 0.7 &&
        number(labels(video).gmvPerMilleViewsPercentile) <= 0.35),
    scoreFn: negativeScore,
  }),
];

const summary = {
  generatedAt: new Date().toISOString(),
  source: inputPath,
  totalInput: videos.length,
  totalSelected: selected.length,
  buckets: Object.fromEntries(
    Object.keys(bucketTargets).map((bucket) => [
      bucket,
      selected.filter((item) => item.bucket === bucket).length,
    ]),
  ),
  categories: Object.fromEntries(
    [...new Set(selected.map((item) => item.category))]
      .sort()
      .map((cat) => [cat, selected.filter((item) => item.category === cat).length]),
  ),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify({ summary, videos: selected }, null, 2)}\n`);

const headers = [
  'bucket',
  'rank',
  'score',
  'id',
  'category',
  'productTitle',
  'durationSeconds',
  'benchmarkScore',
  'gmvCny',
  'sales',
  'views',
  'adRoas',
  'sourceUrl',
  'kalodataUrl',
];
const csv = [
  headers.join(','),
  ...selected.map((item) =>
    [
      item.bucket,
      item.rank,
      item.score,
      item.id,
      item.category,
      item.productTitle,
      item.durationSeconds,
      item.labels.benchmarkScore,
      item.performance.gmvCny,
      item.performance.sales,
      item.performance.views,
      item.performance.adRoas,
      item.sourceUrl,
      item.kalodataUrl,
    ]
      .map(csvEscape)
      .join(','),
  ),
].join('\n');
fs.writeFileSync(csvPath, `${csv}\n`);

console.log(JSON.stringify({ summary, outPath, csvPath }, null, 2));
