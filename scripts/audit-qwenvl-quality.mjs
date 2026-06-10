#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=');
      return [key, rest.length > 0 ? rest.join('=') : 'true'];
    }),
);

const qwenDir = args.get('qwen-dir') || 'tmp/kalodata-test/qwenvl-url-batch';
const trainingPath = args.get('training') || 'tmp/kalodata-test/qwenvl-url-ingested-v2/benchmark-training.qwenvl.jsonl';
const outPath = args.get('out') || 'tmp/kalodata-test/qwenvl-url-ingested-v2/qwenvl-quality-report.json';

const expectedFactors = [
  'hook_type',
  'product_first_visible_second',
  'product_visible_ratio',
  'scene_count',
  'has_hand_demo',
  'has_human_face',
  'has_before_after',
  'has_unboxing',
  'cta_count',
  'ocr_texts',
  'subtitle_quality',
  'visual_style',
  'risk_flags',
];

const enumValues = {
  hook_type: new Set([
    'pain_point',
    'product_demo',
    'before_after',
    'unboxing',
    'social_proof',
    'offer',
    'lifestyle',
    'unknown',
  ]),
  subtitle_quality: new Set(['none', 'clear', 'partial', 'unclear']),
  visual_style: new Set(['home_demo', 'studio_demo', 'ugc_selfie', 'screen_recording', 'mixed', 'unknown']),
};

const riskFlags = new Set(['logo_text_error', 'unsafe_claim', 'unclear_product', 'none']);

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

function boolLabel(row, key) {
  return Boolean(row?.labels?.[key] ?? row?.breakdownReport?.benchmarkLabel?.[key]);
}

function scoreOf(row) {
  return Number(row?.labels?.benchmarkScore ?? row?.breakdownReport?.benchmarkLabel?.benchmarkScore ?? 0);
}

function issue(list, id, issueName, extra = {}) {
  list.push({ id, issue: issueName, ...extra });
}

const trainingRows = fs.existsSync(trainingPath) ? readJsonl(trainingPath) : [];
const trainingById = new Map(trainingRows.map((row) => [row.id, row]));
const qwenFiles = fs
  .readdirSync(qwenDir)
  .filter((name) => /^kalodata_.*\.json$/.test(name) && !name.endsWith('.meta.json'))
  .sort();

const hardIssues = [];
const warnings = [];
const factorPresence = Object.fromEntries(expectedFactors.map((factor) => [factor, 0]));
const hookDistribution = {};
const confidenceValues = [];
const unknownCounts = { hook_type: 0, visual_style: 0, subtitle_quality_none: 0 };

for (const file of qwenFiles) {
  const id = file.replace(/\.json$/, '');
  const qwen = readJson(path.join(qwenDir, file));
  const row = trainingById.get(id);
  const durationSeconds = Number(
    row?.durationSeconds || row?.breakdownReport?.durationSeconds || qwen.duration_seconds || 0,
  );
  const factors = qwen.stable_factors;

  if (qwen.schema_version !== 'VideoTruthSlice.v2')
    issue(hardIssues, id, 'schema_version', { value: qwen.schema_version });
  if (!factors || typeof factors !== 'object' || Array.isArray(factors)) {
    issue(hardIssues, id, 'stable_factors_not_object');
    continue;
  }

  for (const factorId of expectedFactors) {
    const factor = factors[factorId];
    if (!factor) {
      issue(hardIssues, id, 'missing_factor', { factorId });
      continue;
    }
    factorPresence[factorId] += 1;

    const confidence = Number(factor.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      issue(hardIssues, id, 'confidence_range', { factorId, value: factor.confidence });
    } else {
      confidenceValues.push(confidence);
    }

    const value = factor.value;
    if (enumValues[factorId] && !enumValues[factorId].has(value)) {
      issue(hardIssues, id, 'bad_enum', { factorId, value });
    }
    if (
      factorId === 'product_visible_ratio' &&
      value !== null &&
      (typeof value !== 'number' || value < 0 || value > 1)
    ) {
      issue(hardIssues, id, 'bad_product_visible_ratio', { value });
    }
    if (
      factorId === 'product_first_visible_second' &&
      value !== null &&
      (typeof value !== 'number' || value < 0 || (durationSeconds && value > durationSeconds + 2))
    ) {
      issue(hardIssues, id, 'bad_product_first_visible_second', { value, durationSeconds });
    }
    if (factorId === 'scene_count' && value !== null && (typeof value !== 'number' || value < 0 || value > 30)) {
      issue(hardIssues, id, 'bad_scene_count', { value });
    }
    if (
      ['has_hand_demo', 'has_human_face', 'has_before_after', 'has_unboxing'].includes(factorId) &&
      typeof value !== 'boolean'
    ) {
      issue(hardIssues, id, 'bad_boolean', { factorId, value });
    }
    if (factorId === 'cta_count' && (typeof value !== 'number' || value < 0 || value > 20)) {
      issue(hardIssues, id, 'bad_cta_count', { value });
    }
    if (factorId === 'ocr_texts') {
      if (!Array.isArray(value)) {
        issue(hardIssues, id, 'bad_ocr_texts_type', { value });
      } else {
        if (value.length > 5) issue(warnings, id, 'ocr_texts_more_than_5', { count: value.length });
        if (value.some((text) => typeof text !== 'string')) issue(hardIssues, id, 'bad_ocr_text_value', { value });
        if (value.some((text) => typeof text === 'string' && text.length > 40)) {
          issue(warnings, id, 'ocr_texts_longer_than_prompt_limit', {
            maxLength: Math.max(...value.map((text) => String(text).length)),
          });
        }
      }
    }
    if (
      factorId === 'risk_flags' &&
      (!Array.isArray(value) || !value.length || value.some((flag) => !riskFlags.has(flag)))
    ) {
      issue(hardIssues, id, 'bad_risk_flags', { value });
    }
  }

  const hook = factors.hook_type?.value || 'missing';
  hookDistribution[hook] = (hookDistribution[hook] || 0) + 1;
  unknownCounts.hook_type += factors.hook_type?.value === 'unknown' ? 1 : 0;
  unknownCounts.visual_style += factors.visual_style?.value === 'unknown' ? 1 : 0;
  unknownCounts.subtitle_quality_none += factors.subtitle_quality?.value === 'none' ? 1 : 0;
}

function sampleRows(cohort, rows) {
  const filtered = rows.filter((row) => {
    if (!fs.existsSync(path.join(qwenDir, `${row.id}.json`))) return false;
    if (cohort === 'nonWinner')
      return (
        !boolLabel(row, 'organicWinner') &&
        !boolLabel(row, 'paidValidatedWinner') &&
        !boolLabel(row, 'lowFollowerWinner')
      );
    if (cohort === 'lowScore') return scoreOf(row) < 0.5;
    return boolLabel(row, cohort);
  });
  filtered.sort((a, b) => scoreOf(b) - scoreOf(a));
  return filtered.slice(0, 5).map((row) => {
    const qwen = readJson(path.join(qwenDir, `${row.id}.json`));
    const factors = qwen.stable_factors || {};
    return {
      cohort,
      id: row.id,
      category: row.category,
      score: scoreOf(row),
      hook: factors.hook_type?.value,
      firstVisible: factors.product_first_visible_second?.value,
      visibleRatio: factors.product_visible_ratio?.value,
      sceneCount: factors.scene_count?.value,
      hand: factors.has_hand_demo?.value,
      face: factors.has_human_face?.value,
      subtitle: factors.subtitle_quality?.value,
      shots: qwen.shot_summary || [],
    };
  });
}

const avgConfidence =
  confidenceValues.length > 0 ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : 0;
const sample = ['organicWinner', 'paidValidatedWinner', 'lowFollowerWinner', 'nonWinner', 'lowScore'].flatMap(
  (cohort) => sampleRows(cohort, trainingRows),
);

const report = {
  generatedAt: new Date().toISOString(),
  qwenDir,
  trainingPath,
  files: qwenFiles.length,
  pass: hardIssues.length === 0,
  hardIssueCount: hardIssues.length,
  warningCount: warnings.length,
  hardIssues: hardIssues.slice(0, 50),
  warnings: warnings.slice(0, 50),
  factorPresence,
  avgConfidence: Number(avgConfidence.toFixed(3)),
  unknownRates: {
    hook_type: Number((unknownCounts.hook_type / Math.max(qwenFiles.length, 1)).toFixed(3)),
    visual_style: Number((unknownCounts.visual_style / Math.max(qwenFiles.length, 1)).toFixed(3)),
    subtitle_quality_none: Number((unknownCounts.subtitle_quality_none / Math.max(qwenFiles.length, 1)).toFixed(3)),
  },
  hookDistribution,
  sample,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (!report.pass) process.exitCode = 1;
