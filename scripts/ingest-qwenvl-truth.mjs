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
  // dotenv is optional for dry-run.
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
  console.log(`Usage: node scripts/ingest-qwenvl-truth.mjs [options]

Normalizes Qwen-VL VideoTruthSlice outputs, enriches ReferenceVideo records,
and fits an interpretable creative factor attribution table.

Options:
  --qwen-dir=<path>       Directory with Qwen per-video JSON, default tmp/kalodata-test/qwenvl-batch.
  --candidates=<path>     Candidate metadata JSON, default tmp/kalodata-test/qwenvl-candidates-local.json.
  --references=<path>     ReferenceVideo payload, default tmp/kalodata-test/reference-videos.import.json.
  --training=<path>       benchmark-training.jsonl, default tmp/kalodata-test/benchmark-training.jsonl.
  --out-dir=<path>        Output directory, default tmp/kalodata-test.
  --min-confidence=<n>    Minimum stable factor confidence, default 0.6.
  --write-db              Upsert enriched ReferenceVideo, FactorWeight, and EvolutionPoint rows.
  --help                  Show this help.

Outputs:
  qwenvl-truth-slices.jsonl
  qwenvl-factor-attribution-v1.json
  reference-videos.qwenvl.import.json
  benchmark-training.qwenvl.jsonl
  benchmark-train.qwenvl.jsonl
  benchmark-test.qwenvl.jsonl`);
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const qwenDir = path.resolve(readArg('qwen-dir', 'tmp/kalodata-test/qwenvl-batch'));
const candidatesPath = path.resolve(readArg('candidates', 'tmp/kalodata-test/qwenvl-candidates-local.json'));
const referencesPath = path.resolve(readArg('references', 'tmp/kalodata-test/reference-videos.import.json'));
const trainingPath = path.resolve(readArg('training', 'tmp/kalodata-test/benchmark-training.jsonl'));
const outDir = path.resolve(readArg('out-dir', 'tmp/kalodata-test'));
const minConfidence = Number(readArg('min-confidence', '0.6'));
const writeDb = hasFlag('write-db');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readJsonArrayPayload(filePath) {
  const parsed = readJson(filePath);
  return Array.isArray(parsed) ? parsed : parsed.videos || [];
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolValue(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['true', 'yes', '1', '有', '是'].includes(text)) return true;
  if (['false', 'no', '0', '无', '否'].includes(text)) return false;
  return null;
}

function parseMaybeJson(value) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/|]+/g, '_')
    .replace(/[^a-z0-9_\u4e00-\u9fa5-]/gi, '')
    .replace(/_+/g, '_')
    .slice(0, 64);
}

function bucketByNumber(value, buckets) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  for (const item of buckets) {
    if (n <= item.max) return item.id;
  }
  return buckets.at(-1)?.id || '';
}

function coarseRatio(value, numericValue) {
  if (Number.isFinite(Number(numericValue))) {
    const n = Number(numericValue);
    if (n >= 0.66) return 'high';
    if (n >= 0.34) return 'medium';
    return 'low';
  }
  const text = normalizeToken(value);
  if (text.includes('high') || text.includes('高')) return 'high';
  if (text.includes('medium') || text.includes('中')) return 'medium';
  if (text.includes('low') || text.includes('低')) return 'low';
  return text || 'unknown';
}

function coarseVisualStyle(value) {
  const text = normalizeToken(value);
  if (!text) return '';
  if (/outdoor|daylight|sun|户外|自然光/.test(text)) return 'outdoor_daylight';
  if (/macro|close|detail|特写|微距/.test(text)) return 'macro_detail';
  if (/lifestyle|home|living|居家|生活/.test(text)) return 'lifestyle_home';
  if (/action|motion|运动|动态/.test(text)) return 'action_motion';
  if (/studio|clean|white|极简|棚拍/.test(text)) return 'clean_studio';
  return text;
}

function mockCtrFactorFor(factorId) {
  const [type, value = ''] = factorId.split(':');
  if (type === 'hook_type') {
    if (/question|pain|problem|comment|faq|疑问|痛点/.test(value)) return 'hook:question';
    if (/shock|surprise|curiosity|action|opening|高能|冲击|悬念/.test(value)) return 'hook:shock';
    if (/product|reveal|demo|展示/.test(value)) return 'hook:product_reveal';
    if (/life|scenario|home|户外|居家|生活/.test(value)) return 'hook:lifestyle';
    return 'hook:product_reveal';
  }
  if (factorId === 'product_first_visible_second:under_2s' || factorId === 'product_visible_ratio:high')
    return 'hook:product_reveal';
  if (factorId === 'has_hand_demo:true' || factorId === 'has_before_after:true' || factorId === 'has_unboxing:true')
    return 'proof:demonstration';
  if (factorId === 'cta_count:multi') return 'cta:urgency';
  if (factorId === 'cta_count:one') return 'cta:benefit';
  if (type === 'visual_style' && /lifestyle|home|outdoor/.test(value)) return 'hook:lifestyle';
  return '';
}

function normalizeQwenStableFactors(qwen) {
  if (Array.isArray(qwen.stable_factors)) return qwen.stable_factors;
  if (!qwen.stable_factors || typeof qwen.stable_factors !== 'object') return [];

  return Object.entries(qwen.stable_factors).map(([factorId, raw]) => {
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    const confidence = raw && typeof raw === 'object' ? raw.confidence : undefined;
    const evidenceSecond = raw && typeof raw === 'object' ? raw.evidence_second : null;
    const evidence = Number.isFinite(Number(evidenceSecond))
      ? [
          {
            start_second: Number(evidenceSecond),
            end_second: Number(evidenceSecond),
            reason: 'model_second',
          },
        ]
      : [];
    return {
      factor_id: factorId,
      value,
      numeric_value: Number.isFinite(Number(value)) ? Number(value) : null,
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0,
      tier: 'stable',
      scoring_eligible: true,
      evidence,
    };
  });
}

function normalizedFactorsFromQwen(qwen) {
  const stable = normalizeQwenStableFactors(qwen);
  const factors = [];
  for (const raw of stable) {
    const id = String(raw?.factor_id || '').trim();
    const confidence = number(raw?.confidence, 0);
    if (!id || confidence < minConfidence || raw?.scoring_eligible === false) continue;
    const value = parseMaybeJson(raw?.value);
    const numeric = Number.isFinite(Number(raw?.numeric_value)) ? Number(raw.numeric_value) : null;
    const evidence = Array.isArray(raw?.evidence) ? raw.evidence : [];

    const push = (factorId, scoringEligible = true) => {
      if (!factorId) return;
      factors.push({
        factorId,
        sourceFactorId: id,
        value,
        numericValue: numeric,
        confidence,
        scoringEligible,
        mockCtrFactorId: mockCtrFactorFor(factorId),
        evidence: evidence.slice(0, 3),
      });
    };

    if (id === 'hook_type') push(`hook_type:${normalizeToken(value) || 'unknown'}`);
    else if (id === 'product_first_visible_second')
      push(
        `product_first_visible_second:${bucketByNumber(numeric ?? value, [
          { max: 1, id: 'under_1s' },
          { max: 2, id: 'under_2s' },
          { max: 3, id: 'under_3s' },
          { max: 999, id: 'late' },
        ])}`,
      );
    else if (id === 'product_visible_ratio') push(`product_visible_ratio:${coarseRatio(value, numeric)}`);
    else if (id === 'scene_count')
      push(
        `scene_count:${bucketByNumber(numeric ?? value, [
          { max: 1, id: 'single_scene' },
          { max: 2, id: 'two_scenes' },
          { max: 4, id: 'three_plus' },
          { max: 999, id: 'five_plus' },
        ])}`,
      );
    else if (['has_hand_demo', 'has_human_face', 'has_before_after', 'has_unboxing'].includes(id)) {
      const bool = boolValue(numeric ?? value);
      if (bool === true) push(`${id}:true`);
    } else if (id === 'cta_count') {
      const count = number(numeric ?? value, 0);
      if (count <= 0) push('cta_count:none', false);
      else if (count === 1) push('cta_count:one');
      else push('cta_count:multi');
    } else if (id === 'ocr_texts') {
      const texts = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      if (texts.length) push('ocr_texts:has_visible_text', false);
    } else if (id === 'subtitle_quality') push(`subtitle_quality:${normalizeToken(value) || 'unknown'}`, false);
    else if (id === 'visual_style') push(`visual_style:${coarseVisualStyle(value) || 'unknown'}`);
    else if (id === 'risk_flags') {
      const flags = Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
      if (flags.some((flag) => normalizeToken(flag) !== 'none')) push('risk_flags:present', false);
    }
  }

  const deduped = new Map();
  for (const factor of factors) {
    const existing = deduped.get(factor.factorId);
    if (!existing || existing.confidence < factor.confidence) deduped.set(factor.factorId, factor);
  }
  return [...deduped.values()].sort((a, b) => a.factorId.localeCompare(b.factorId));
}

function factorTypeValue(factorId) {
  const [type, ...rest] = factorId.split(':');
  return { factorType: type, factorValue: rest.join(':') || 'present' };
}

function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function confidenceLabel(sampleSize, avgConfidence) {
  if (sampleSize >= 20 && avgConfidence >= 0.82) return 'high';
  if (sampleSize >= 8 && avgConfidence >= 0.72) return 'medium';
  return 'low';
}

function coefficientFromLift(lift, sampleSize, confidence) {
  if (!Number.isFinite(lift)) return 0;
  const sampleConfidence = Math.min(1, sampleSize / 24);
  const modelConfidence = confidence === 'high' ? 1 : confidence === 'medium' ? 0.65 : 0.35;
  return Math.max(-0.18, Math.min(0.24, lift * 0.32 * sampleConfidence * modelConfidence));
}

function buildAttribution(slices) {
  const allIds = new Set(slices.flatMap((slice) => slice.normalizedFactors.map((factor) => factor.factorId)));
  const factors = [];
  for (const factorId of allIds) {
    const withRows = slices.filter((slice) => slice.normalizedFactors.some((factor) => factor.factorId === factorId));
    const withoutRows = slices.filter(
      (slice) => !slice.normalizedFactors.some((factor) => factor.factorId === factorId),
    );
    const withScores = withRows.map((slice) => number(slice.labels?.benchmarkScore, NaN));
    const withoutScores = withoutRows.map((slice) => number(slice.labels?.benchmarkScore, NaN));
    const lift = (mean(withScores) ?? 0) - (mean(withoutScores) ?? 0);
    const organicRows = slices.filter(
      (slice) => slice.labels?.organicWinner === true || slice.performance?.adViewRatio === 0,
    );
    const organicWith = organicRows.filter((slice) =>
      slice.normalizedFactors.some((factor) => factor.factorId === factorId),
    );
    const organicWithout = organicRows.filter(
      (slice) => !slice.normalizedFactors.some((factor) => factor.factorId === factorId),
    );
    const lowFollowerRows = slices.filter((slice) => slice.labels?.lowFollowerWinner === true);
    const lowFollowerWith = lowFollowerRows.filter((slice) =>
      slice.normalizedFactors.some((factor) => factor.factorId === factorId),
    );
    const lowFollowerWithout = lowFollowerRows.filter(
      (slice) => !slice.normalizedFactors.some((factor) => factor.factorId === factorId),
    );
    const avgConfidence =
      mean(
        withRows.flatMap((slice) =>
          slice.normalizedFactors
            .filter((factor) => factor.factorId === factorId)
            .map((factor) => number(factor.confidence, NaN)),
        ),
      ) ?? 0;
    const confidence = confidenceLabel(withRows.length, avgConfidence);
    const { factorType, factorValue } = factorTypeValue(factorId);
    const mockCtrFactorIds = [
      ...new Set(
        withRows
          .flatMap((slice) => slice.normalizedFactors)
          .filter((factor) => factor.factorId === factorId)
          .map((factor) => factor.mockCtrFactorId)
          .filter(Boolean),
      ),
    ];
    factors.push({
      factor_id: factorId,
      factor_type: factorType,
      factor_value: factorValue,
      lift: Number(lift.toFixed(4)),
      sample_size: withRows.length,
      baseline_size: withoutRows.length,
      confidence,
      avg_factor_confidence: Number(avgConfidence.toFixed(4)),
      organic_only_lift:
        organicWith.length && organicWithout.length
          ? Number(
              (
                (mean(organicWith.map((slice) => number(slice.labels?.benchmarkScore, NaN))) ?? 0) -
                (mean(organicWithout.map((slice) => number(slice.labels?.benchmarkScore, NaN))) ?? 0)
              ).toFixed(4),
            )
          : null,
      low_follower_lift:
        lowFollowerWith.length && lowFollowerWithout.length
          ? Number(
              (
                (mean(lowFollowerWith.map((slice) => number(slice.labels?.benchmarkScore, NaN))) ?? 0) -
                (mean(lowFollowerWithout.map((slice) => number(slice.labels?.benchmarkScore, NaN))) ?? 0)
              ).toFixed(4),
            )
          : null,
      gmv_per_mille_lift: Number(
        (
          (mean(withRows.map((slice) => number(slice.labels?.gmvPerMilleViewsPercentile, NaN))) ?? 0) -
          (mean(withoutRows.map((slice) => number(slice.labels?.gmvPerMilleViewsPercentile, NaN))) ?? 0)
        ).toFixed(4),
      ),
      mock_ctr_factor_ids: mockCtrFactorIds,
      coefficient: Number(coefficientFromLift(lift, withRows.length, confidence).toFixed(4)),
      evidence_video_ids: withRows
        .sort((a, b) => number(b.labels?.benchmarkScore, 0) - number(a.labels?.benchmarkScore, 0))
        .slice(0, 5)
        .map((slice) => slice.id),
    });
  }
  return factors.sort((a, b) => b.coefficient - a.coefficient || b.sample_size - a.sample_size);
}

function aggregateMockCtrWeights(factors) {
  const byId = new Map();
  for (const factor of factors) {
    if (!factor.mock_ctr_factor_ids?.length || factor.sample_size < 5) continue;
    for (const id of factor.mock_ctr_factor_ids) {
      const row = byId.get(id) || { factor_id: id, sample_size: 0, weightedCoefficient: 0, evidence_factor_ids: [] };
      const weight =
        factor.sample_size * (factor.confidence === 'high' ? 1 : factor.confidence === 'medium' ? 0.65 : 0.35);
      row.sample_size += factor.sample_size;
      row.weightedCoefficient += factor.coefficient * weight;
      row.evidence_factor_ids.push(factor.factor_id);
      row._weight = (row._weight || 0) + weight;
      byId.set(id, row);
    }
  }
  return [...byId.values()]
    .map((row) => ({
      factor_id: row.factor_id,
      coefficient: Number((row.weightedCoefficient / Math.max(row._weight || 1, 1)).toFixed(4)),
      sample_size: row.sample_size,
      evidence_factor_ids: [...new Set(row.evidence_factor_ids)].slice(0, 8),
    }))
    .sort((a, b) => b.coefficient - a.coefficient);
}

const candidates = new Map(readJsonArrayPayload(candidatesPath).map((item) => [item.id, item]));
const references = readJsonArrayPayload(referencesPath);
const referenceById = new Map(references.map((item) => [item.id, item]));
const trainingRows = readJsonl(trainingPath);
const trainingById = new Map(trainingRows.map((item) => [item.id, item]));

const qwenFiles = fs
  .readdirSync(qwenDir)
  .filter((name) => /^(kalodata|fastmoss)_.*\.json$/.test(name) && !name.endsWith('.meta.json'))
  .sort();

const slices = [];
const parseFailures = [];
for (const file of qwenFiles) {
  const id = file.replace(/\.json$/, '');
  try {
    const qwen = readJson(path.join(qwenDir, file));
    const qwenMetaPath = path.join(qwenDir, `${id}.meta.json`);
    const qwenMeta = fs.existsSync(qwenMetaPath) ? readJson(qwenMetaPath) : {};
    const candidate = candidates.get(id) || {};
    const training = trainingById.get(id) || {};
    const labels = candidate.labels || training.labels || {};
    const performance = candidate.performance || {};
    const normalizedFactors = normalizedFactorsFromQwen(qwen);
    slices.push({
      id,
      videoId: candidate.videoId || training.videoId || qwen.video_id || id.replace(/^(kalodata|fastmoss)_/, ''),
      bucket: candidate.bucket || '',
      category: candidate.category || training.category || '',
      productTitle: candidate.productTitle || '',
      sourceUrl: candidate.sourceUrl || referenceById.get(id)?.sourceUrl || '',
      labels,
      performance,
      qwen,
      qwenMeta,
      normalizedFactors,
      retrievalText: [
        candidate.referenceText || training.referenceText,
        `Qwen stable factors: ${normalizedFactors.map((factor) => factor.factorId).join(' ')}`,
        Array.isArray(qwen.observations) ? qwen.observations.join(' ') : '',
        Array.isArray(qwen.shot_summary) ? qwen.shot_summary.join(' ') : '',
      ]
        .filter(Boolean)
        .join(' | '),
    });
  } catch (error) {
    parseFailures.push({ id, file, error: error instanceof Error ? error.message : String(error) });
  }
}

const attributionFactors = buildAttribution(slices);
const mockCtrWeights = aggregateMockCtrWeights(attributionFactors);
const qwenModels = [...new Set(slices.map((slice) => slice.qwenMeta?.model).filter(Boolean))];
const attribution = {
  model_version: 'attribution-v1-from-qwenvl-real-winners',
  generated_at: new Date().toISOString(),
  fit_window: 'Kalodata TikTok Shop exports + Qwen-VL observed creative factors',
  qwen_model: qwenModels.length === 1 ? qwenModels[0] : qwenModels.join(',') || 'unknown',
  video_count: slices.length,
  parse_failures: parseFailures,
  policy: {
    scoring_core: 'Only stable observable factors with scoring_eligible=true and confidence above threshold are used.',
    inferred_fields: 'selling_points/audience/why_it_sold remain retrieval/explanation only.',
    coefficient:
      'Interpretable lift scaled into mock CTR coefficient range; no neural model is trained on the small sample.',
  },
  factors: attributionFactors,
  mock_ctr_factor_weights: mockCtrWeights,
};

const enrichedReferences = references.map((reference) => {
  const slice = slices.find((item) => item.id === reference.id);
  if (!slice) return reference;
  const breakdown = reference.breakdownReport || {};
  return {
    ...reference,
    breakdownReport: {
      ...breakdown,
      qwenTruthSlice: {
        schemaVersion: slice.qwen.schema_version || 'VideoTruthSlice.v1',
        model: slice.qwenMeta?.model || attribution.qwen_model,
        ingestedAt: attribution.generated_at,
        videoId: slice.videoId,
        bucket: slice.bucket,
        stableFactors: slice.qwen.stable_factors || [],
        normalizedFactors: slice.normalizedFactors,
        observations: slice.qwen.observations || [],
        shotStructure: slice.qwen.shot_structure || slice.qwen.shot_summary || [],
        inferredFactors: slice.qwen.inferred_factors || [],
        qualityControl: slice.qwen.quality_control || {},
      },
      creativeFeature: {
        ...(breakdown.creativeFeature || {}),
        qwenObservedFactorIds: slice.normalizedFactors.map((factor) => factor.factorId),
        shotStructure:
          slice.qwen.shot_structure || slice.qwen.shot_summary || breakdown.creativeFeature?.shotStructure || [],
      },
      factors: slice.normalizedFactors.filter((factor) => factor.scoringEligible).map((factor) => factor.factorId),
      referenceText: [
        breakdown.referenceText,
        `Qwen factors: ${slice.normalizedFactors.map((f) => f.factorId).join(' ')}`,
      ]
        .filter(Boolean)
        .join(' | '),
    },
  };
});

const enrichedTrainingRows = trainingRows.map((row) => {
  const slice = slices.find((item) => item.id === row.id);
  if (!slice) return row;
  return {
    ...row,
    qwenTruthSlice: {
      model: slice.qwenMeta?.model || attribution.qwen_model,
      normalizedFactors: slice.normalizedFactors,
      qualityControl: slice.qwen.quality_control || {},
    },
    qwenFactorIds: slice.normalizedFactors.filter((factor) => factor.scoringEligible).map((factor) => factor.factorId),
    referenceText: [row.referenceText, `Qwen factors: ${slice.normalizedFactors.map((f) => f.factorId).join(' ')}`]
      .filter(Boolean)
      .join(' | '),
  };
});

fs.mkdirSync(outDir, { recursive: true });
writeJsonl(path.join(outDir, 'qwenvl-truth-slices.jsonl'), slices);
writeJson(path.join(outDir, 'qwenvl-factor-attribution-v1.json'), attribution);
writeJson(path.join(outDir, 'reference-videos.qwenvl.import.json'), { videos: enrichedReferences });
writeJsonl(path.join(outDir, 'benchmark-training.qwenvl.jsonl'), enrichedTrainingRows);
writeJsonl(
  path.join(outDir, 'benchmark-train.qwenvl.jsonl'),
  enrichedTrainingRows.filter((row) => row.split === 'train'),
);
writeJsonl(
  path.join(outDir, 'benchmark-test.qwenvl.jsonl'),
  enrichedTrainingRows.filter((row) => row.split === 'test'),
);

let dbWrites = { references: 0, factorWeights: 0, evolutionPoints: 0 };
if (writeDb) {
  const db = require('@aigc-video-hub/db');
  for (const reference of enrichedReferences.filter((item) => slices.some((slice) => slice.id === item.id))) {
    await db.upsertReferenceVideo({
      id: reference.id,
      sourceUrl: reference.sourceUrl,
      localVideoUrl: reference.localVideoUrl,
      localObjectKey: reference.localObjectKey,
      sourceDeclaration: reference.sourceDeclaration,
      licenseType: reference.licenseType,
      usageScope: reference.usageScope,
      breakdownReport: reference.breakdownReport,
    });
    dbWrites.references += 1;
  }

  const factorRows = attributionFactors
    .filter((factor) => factor.sample_size >= 5 && factor.coefficient !== 0)
    .map((factor) => ({
      factorId: factor.factor_id,
      weight: factor.coefficient,
      sampleSize: factor.sample_size,
      ...factorTypeValue(factor.factor_id),
    }));
  const seenFactorIds = new Set();
  for (const row of factorRows) {
    if (seenFactorIds.has(row.factorId)) continue;
    seenFactorIds.add(row.factorId);
    await db.upsertFactorWeight(row.factorId, row.weight, row.sampleSize);
    dbWrites.factorWeights += 1;
    await db.createEvolutionPoint({
      factorId: row.factorId,
      factorType: row.factorType,
      factorValue: row.factorValue,
      weight: row.weight,
      sampleSize: row.sampleSize,
    });
    dbWrites.evolutionPoints += 1;
  }
  await db.disconnectPrisma?.();
}

console.log(
  JSON.stringify(
    {
      qwenDir,
      videosRead: qwenFiles.length,
      truthSlices: slices.length,
      parseFailures: parseFailures.length,
      factorCount: attributionFactors.length,
      mockCtrFactorWeights: mockCtrWeights.length,
      outputs: {
        truthSlices: path.join(outDir, 'qwenvl-truth-slices.jsonl'),
        attribution: path.join(outDir, 'qwenvl-factor-attribution-v1.json'),
        references: path.join(outDir, 'reference-videos.qwenvl.import.json'),
        training: path.join(outDir, 'benchmark-training.qwenvl.jsonl'),
      },
      writeDb,
      dbWrites,
    },
    null,
    2,
  ),
);
