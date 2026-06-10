#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch {
  // Env can also be supplied by the caller.
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

if (hasFlag('help')) {
  console.log(`Usage: node scripts/ingest-subtitle-style-slices.mjs [options]

Builds analysis-only SubtitleStyleSlice.v1 records from existing ReferenceVideo.breakdownReport.qwenTruthSlice.
These records must never become production Slice/materialRef media.

Options:
  --out-dir=<path>                  Output directory, default tmp/subtitle-style-slices.
  --min-subtitle-confidence=<n>     Minimum subtitle_quality confidence, default 0.7.
  --min-benchmark-score=<n>         Minimum benchmark score unless winner, default 0.55.
  --risk-policy=safe|all            safe skips unsafe Qwen risk flags, default safe.
  --limit=<n>                       Max rows to write, 0 means no limit, default 0.
  --write-db                        Write subtitleStyleSlice back to ReferenceVideo.
  --help                            Show this help.`);
  process.exit(0);
}

const outDir = path.resolve(readArg('out-dir', 'tmp/subtitle-style-slices'));
const minSubtitleConfidence = Number(readArg('min-subtitle-confidence', '0.7'));
const minBenchmarkScore = Number(readArg('min-benchmark-score', '0.55'));
const riskPolicy = readArg('risk-policy', 'safe');
const limit = Math.max(0, Number(readArg('limit', '0')));
const writeDb = hasFlag('write-db');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function stableFactor(qwen, key) {
  return qwen?.stableFactors?.[key] || qwen?.stable_factors?.[key] || {};
}

function factorValue(qwen, key, fallback = undefined) {
  const factor = stableFactor(qwen, key);
  return factor && typeof factor === 'object' && 'value' in factor ? factor.value : fallback;
}

function factorConfidence(qwen, key) {
  const factor = stableFactor(qwen, key);
  const value = Number(factor?.confidence);
  return Number.isFinite(value) ? value : 0;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textValue(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isWinner(label = {}) {
  return Boolean(label.organicWinner || label.paidValidatedWinner || label.lowFollowerWinner);
}

function winnerTypes(label = {}) {
  return [
    label.organicWinner ? 'organic_winner' : '',
    label.paidValidatedWinner ? 'paid_validated_winner' : '',
    label.lowFollowerWinner ? 'low_follower_winner' : '',
  ].filter(Boolean);
}

function isSafeRisk(riskFlags) {
  const flags = arrayValue(riskFlags).map((item) => String(item).trim().toLowerCase());
  return flags.length === 0 || flags.every((flag) => flag === 'none');
}

function languageOf(texts) {
  const joined = texts.join(' ');
  if (/[\u4e00-\u9fff]/.test(joined)) return 'zh';
  if (/[áéíóúñ¿¡]/i.test(joined)) return 'es_or_latin';
  if (/[a-z]/i.test(joined)) return 'en';
  return 'unknown';
}

function uppercaseRatio(texts) {
  const letters = texts.join('').replace(/[^a-z]/gi, '');
  if (!letters) return 0;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return Number((upper / letters.length).toFixed(4));
}

function subtitleDensity(texts, durationSeconds) {
  const chars = texts.join('').replace(/\s+/g, '').length;
  const perSecond = durationSeconds > 0 ? chars / durationSeconds : chars / 15;
  if (texts.length >= 4 || perSecond >= 2.2) return 'dense';
  if (texts.length >= 2 || perSecond >= 0.9) return 'balanced';
  return 'sparse';
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function textFunctions(texts, qwen) {
  const joined = texts.join(' | ');
  const functions = new Set();
  const hookType = textValue(factorValue(qwen, 'hook_type'));
  const ctaCount = numberValue(factorValue(qwen, 'cta_count'), 0);

  if (texts.length) functions.add('visible_subtitle');
  if (hookType && hookType !== 'unknown') functions.add(`hook_${hookType}`);
  if (hasAny(joined, [/\b(step|how to|tips?|101|testing|test)\b/i, /教程|步骤|测评|测试/]))
    functions.add('instruction_or_demo');
  if (hasAny(joined, [/\b(now|before|after|results?|worked out|changed)\b/i, /前后|效果|结果/]))
    functions.add('proof_or_result');
  if (hasAny(joined, [/\b(shop|buy|link|discount|sale|coupon|code)\b/i, /下单|购买|优惠|链接/]) || ctaCount > 0) {
    functions.add('cta_or_offer');
  }
  if (hasAny(joined, [/\b(pov|girl to girl|mom|school|college|beach)\b/i, /场景|日常|通勤|旅行/])) {
    functions.add('contextual_hook');
  }
  if (hasAny(joined, [/\b(serum|spray|bag|controller|sticker|powder|cream|kit|set)\b/i, /套装|喷雾|精华|包|贴纸/])) {
    functions.add('product_label_or_feature');
  }
  return [...functions];
}

function headlinePattern(texts) {
  const first = textValue(texts[0]).toLowerCase();
  if (!first) return 'none';
  if (/\?$|what|why|how|怎么|为什么/.test(first)) return 'question_hook';
  if (/^pov\b|girl to girl|我以为|i thought/.test(first)) return 'pov_story_hook';
  if (/\b(testing|test|review|测评|测试)\b/.test(first)) return 'test_or_review_hook';
  if (/\b(step|101|how to|教程|步骤)\b/.test(first)) return 'instruction_hook';
  if (/\b(before|after|results?|worked out|效果|结果)\b/.test(first)) return 'result_hook';
  if (first.length <= 18 && first === first.toUpperCase()) return 'big_keyword_hook';
  return 'statement_hook';
}

function safePlacementHints(qwen) {
  const hints = [];
  const avoid = [];
  const hasFace = factorValue(qwen, 'has_human_face') === true;
  const hasHandDemo = factorValue(qwen, 'has_hand_demo') === true;
  const productRatio = numberValue(factorValue(qwen, 'product_visible_ratio'), 0);
  const visualStyle = textValue(factorValue(qwen, 'visual_style'), 'unknown');

  if (hasFace) avoid.push('face_area');
  if (hasHandDemo) avoid.push('hand_demo_area');
  if (productRatio >= 0.65) avoid.push('large_product_area');
  if (visualStyle === 'screen_recording') avoid.push('platform_ui_and_existing_text');

  hints.push('ask_qwenvl_to_locate_existing_ocr_before_overlay');
  hints.push('prefer_position_with_low_product_face_hand_overlap');
  if (productRatio >= 0.65) hints.push('consider_top_or_middle_lower_only_if_product_is_not_there');
  if (hasFace || hasHandDemo) hints.push('avoid_covering_face_expression_or_hand_action');
  return { observedPositionStatus: 'not_available_in_existing_qwen_truth', avoidRegions: avoid, inferredRules: hints };
}

function retrievalText(input) {
  return [
    `category:${input.category}`,
    `traffic:${input.trafficType}`,
    `subtitle_density:${input.style.density}`,
    `headline:${input.style.headlinePattern}`,
    `functions:${input.style.textFunctions.join(',')}`,
    `visual:${input.visualStyle}`,
    `hook:${input.hookType}`,
    `ocr:${input.ocrTexts.join(' | ')}`,
    `shot:${input.shotStructure.join(' | ')}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function valueScore(input) {
  const ocrRichness = Math.min(1, input.ocrTexts.length / 5);
  const confidence = Math.min(1, input.subtitleConfidence);
  const benchmark = Math.min(1, input.benchmarkScore);
  const winnerBoost = input.winner ? 1 : 0;
  return Number((confidence * 0.35 + benchmark * 0.35 + winnerBoost * 0.15 + ocrRichness * 0.15).toFixed(4));
}

function buildSlice(reference) {
  const breakdown = reference.breakdownReport || {};
  const qwen = breakdown.qwenTruthSlice || {};
  const label = breakdown.benchmarkLabel || {};
  const subtitleQuality = textValue(factorValue(qwen, 'subtitle_quality'));
  const subtitleConfidence = factorConfidence(qwen, 'subtitle_quality');
  const ocrTexts = arrayValue(factorValue(qwen, 'ocr_texts'))
    .map((item) => String(item).trim())
    .filter(Boolean);
  const riskFlags = arrayValue(factorValue(qwen, 'risk_flags'));
  const benchmarkScore = numberValue(label.benchmarkScore, 0);
  const winner = isWinner(label);
  const durationSeconds = numberValue(breakdown.durationSeconds || qwen.duration_seconds, 0);
  const visualStyle = textValue(factorValue(qwen, 'visual_style'), 'unknown');
  const hookType = textValue(factorValue(qwen, 'hook_type'), 'unknown');
  const shotStructure = arrayValue(qwen.shotStructure || qwen.shot_structure || qwen.shot_summary)
    .map((item) => String(item).trim())
    .filter(Boolean);

  if (subtitleQuality !== 'clear') return { skip: 'subtitle_not_clear' };
  if (subtitleConfidence < minSubtitleConfidence) return { skip: 'subtitle_confidence_low' };
  if (!ocrTexts.length) return { skip: 'missing_ocr_texts' };
  if (!winner && benchmarkScore < minBenchmarkScore) return { skip: 'benchmark_below_threshold' };
  if (riskPolicy === 'safe' && !isSafeRisk(riskFlags)) return { skip: 'risk_flags_not_safe' };

  const style = {
    presence: 'clear',
    density: subtitleDensity(ocrTexts, durationSeconds),
    language: languageOf(ocrTexts),
    headlinePattern: headlinePattern(ocrTexts),
    textFunctions: textFunctions(ocrTexts, qwen),
    maxObservedTextLength: Math.max(...ocrTexts.map((text) => text.length)),
    sampleTextCount: ocrTexts.length,
    uppercaseRatio: uppercaseRatio(ocrTexts),
  };
  const base = {
    category: textValue(breakdown.category, 'unknown'),
    trafficType: textValue(breakdown.trafficType, 'unknown'),
    style,
    visualStyle,
    hookType,
    ocrTexts,
    shotStructure,
    subtitleConfidence,
    benchmarkScore,
    winner,
  };

  return {
    schemaVersion: 'SubtitleStyleSlice.v1',
    id: `subtitle_style_${shortHash(reference.id)}`,
    referenceId: reference.id,
    sourceUrl: reference.sourceUrl,
    source: 'derived_from_existing_qwenvl_truth',
    generatedAt: new Date().toISOString(),
    qwenModel: textValue(qwen.model, 'unknown'),
    valueScore: valueScore(base),
    limitations: [
      'Existing QwenTruthSlice contains subtitle_quality and OCR texts, not exact subtitle timing or coordinates.',
      'Placement fields below are inferred safety hints for RAG, not observed ground-truth positions.',
    ],
    reference: {
      category: base.category,
      productTitle: textValue(breakdown.productTitle),
      trafficType: base.trafficType,
      winnerTypes: winnerTypes(label),
      benchmarkScore,
      durationSeconds,
    },
    evidence: {
      subtitleQuality,
      subtitleConfidence,
      ocrTexts,
      shotStructure,
      riskFlags,
      qualityControl: qwen.qualityControl || qwen.quality_control || {},
    },
    visualContext: {
      visualStyle,
      hookType,
      hasHumanFace: factorValue(qwen, 'has_human_face') === true,
      hasHandDemo: factorValue(qwen, 'has_hand_demo') === true,
      hasBeforeAfter: factorValue(qwen, 'has_before_after') === true,
      productVisibleRatio: numberValue(factorValue(qwen, 'product_visible_ratio'), 0),
      productFirstVisibleSecond: numberValue(factorValue(qwen, 'product_first_visible_second'), 0),
      sceneCount: numberValue(factorValue(qwen, 'scene_count'), 0),
    },
    style,
    placementLearning: safePlacementHints(qwen),
    composerUse: {
      useAsRagExample: true,
      avoidCopyingReferenceText: true,
      preferredUse:
        'Use this slice as a style and decision example. Current-video Qwen-VL must still decide final show/position from raw video.',
    },
    retrievalText: retrievalText(base),
  };
}

const db = require('@aigc-video-hub/db');
const references = await db.listReferenceVideos();
const skipCounts = {};
const slices = [];

for (const reference of references) {
  const built = buildSlice(reference);
  if (built.skip) {
    skipCounts[built.skip] = (skipCounts[built.skip] || 0) + 1;
    continue;
  }
  slices.push({ reference, slice: built });
}

slices.sort(
  (a, b) =>
    b.slice.valueScore - a.slice.valueScore || b.slice.reference.benchmarkScore - a.slice.reference.benchmarkScore,
);
const selected = limit > 0 ? slices.slice(0, limit) : slices;

let dbWrites = 0;
if (writeDb) {
  for (const { reference, slice } of selected) {
    const breakdown = reference.breakdownReport || {};
    await db.upsertReferenceVideo({
      id: reference.id,
      sourceUrl: reference.sourceUrl,
      localVideoUrl: reference.localVideoUrl || undefined,
      localObjectKey: reference.localObjectKey || undefined,
      sourceDeclaration: reference.sourceDeclaration,
      licenseType: reference.licenseType || undefined,
      usageScope: reference.usageScope || undefined,
      breakdownReport: {
        ...breakdown,
        subtitleStyleSlice: slice,
        creativeFeature: {
          ...(breakdown.creativeFeature || {}),
          subtitleStyleSliceId: slice.id,
          subtitleDensity: slice.style.density,
          subtitleTextFunctions: slice.style.textFunctions,
        },
      },
    });
    dbWrites += 1;
  }
}

const outputSlices = selected.map((item) => item.slice);
const summary = {
  generatedAt: new Date().toISOString(),
  totalReferences: references.length,
  selected: outputSlices.length,
  writeDb,
  dbWrites,
  criteria: {
    minSubtitleConfidence,
    minBenchmarkScore,
    riskPolicy,
    limit,
  },
  skipCounts,
  density: outputSlices.reduce((acc, item) => {
    acc[item.style.density] = (acc[item.style.density] || 0) + 1;
    return acc;
  }, {}),
  headlinePattern: outputSlices.reduce((acc, item) => {
    acc[item.style.headlinePattern] = (acc[item.style.headlinePattern] || 0) + 1;
    return acc;
  }, {}),
  topExamples: outputSlices.slice(0, 10).map((item) => ({
    referenceId: item.referenceId,
    valueScore: item.valueScore,
    benchmarkScore: item.reference.benchmarkScore,
    category: item.reference.category,
    density: item.style.density,
    headlinePattern: item.style.headlinePattern,
    ocrTexts: item.evidence.ocrTexts,
  })),
};

writeJsonl(path.join(outDir, 'subtitle-style-slices.jsonl'), outputSlices);
writeJson(path.join(outDir, 'summary.json'), summary);
await db.disconnectPrisma();

console.log(JSON.stringify(summary, null, 2));
