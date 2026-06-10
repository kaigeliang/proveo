import fs from 'fs';
import path from 'path';
import type { Script } from '@aigc-video-hub/shared';
import { extractScriptFactors, type MockCtrResult } from './mock-ctr';

export interface QwenAttributionFactor {
  factorId: string;
  factorType: string;
  factorValue: string;
  lift: number;
  coefficient: number;
  sampleSize: number;
  confidence: 'high' | 'medium' | 'low' | string;
  organicOnlyLift: number | null;
  lowFollowerLift: number | null;
  gmvPerMilleLift: number | null;
  evidenceVideoIds: string[];
  supportingMockFactors: string[];
}

export interface QwenAttributionInsight {
  source: 'qwen_factor_attribution';
  modelVersion: string;
  qwenModel: string;
  videoCount: number;
  matchedFactorCount: number;
  calibrationLift: number;
  calibratedBenchmarkScore: number;
  policy: string;
  matchedFactors: QwenAttributionFactor[];
}

interface RawQwenAttributionFactor {
  factor_id?: string;
  factor_type?: string;
  factor_value?: string;
  lift?: number;
  coefficient?: number;
  sample_size?: number;
  confidence?: string;
  organic_only_lift?: number | null;
  low_follower_lift?: number | null;
  gmv_per_mille_lift?: number | null;
  mock_ctr_factor_ids?: string[];
  evidence_video_ids?: string[];
}

interface RawQwenAttribution {
  model_version?: string;
  qwen_model?: string;
  video_count?: number;
  policy?: { scoring_core?: string; coefficient?: string };
  factors?: RawQwenAttributionFactor[];
}

const DEFAULT_ATTRIBUTION_PATH = path.join(
  resolveRepoRoot(),
  'tmp/kalodata-test/qwenvl-url-ingested-v2/qwenvl-factor-attribution-v1.json',
);

const ATTRIBUTION_PATH = resolveAttributionPath(process.env.QWEN_ATTRIBUTION_PATH);

let cachedAttribution: RawQwenAttribution | null | undefined;

function round(value: number, precision = 4): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function resolveRepoRoot(): string {
  let current = path.resolve(__dirname);
  const root = path.parse(current).root;
  while (current !== root) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'apps/api/package.json'))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, '../../../../..');
}

function resolveAttributionPath(input: string | undefined): string {
  if (!input) return DEFAULT_ATTRIBUTION_PATH;
  if (path.isAbsolute(input)) return input;
  const repoPath = path.join(resolveRepoRoot(), input);
  if (fs.existsSync(repoPath)) return repoPath;
  return path.resolve(process.cwd(), input);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function loadAttribution(): RawQwenAttribution | null {
  if (cachedAttribution !== undefined) return cachedAttribution;
  try {
    cachedAttribution = JSON.parse(fs.readFileSync(ATTRIBUTION_PATH, 'utf-8')) as RawQwenAttribution;
  } catch {
    cachedAttribution = null;
  }
  return cachedAttribution;
}

function scriptFactorSet(
  script: Script,
  factorContributions: MockCtrResult['factorContributions'] | undefined,
): Set<string> {
  return new Set([
    ...extractScriptFactors(script),
    ...(factorContributions || []).map((item) => item.factorId).filter(Boolean),
  ]);
}

function matchesScriptFactor(row: RawQwenAttributionFactor, scriptFactors: Set<string>): string[] {
  const supporting = new Set<string>();
  if (row.factor_id && scriptFactors.has(row.factor_id)) supporting.add(row.factor_id);
  for (const factorId of row.mock_ctr_factor_ids || []) {
    if (scriptFactors.has(factorId)) supporting.add(factorId);
  }
  return [...supporting];
}

function hasDirectScriptFactorMatch(row: RawQwenAttributionFactor, scriptFactors: Set<string>): boolean {
  return Boolean(row.factor_id && scriptFactors.has(row.factor_id));
}

export function buildQwenAttributionInsight(input: {
  script: Script;
  benchmarkScore: number;
  factorContributions?: MockCtrResult['factorContributions'];
}): QwenAttributionInsight | null {
  const attribution = loadAttribution();
  if (!attribution?.factors?.length) return null;

  const factors = scriptFactorSet(input.script, input.factorContributions);
  const matchedFactors = attribution.factors
    .map((row) => ({
      row,
      directMatch: hasDirectScriptFactorMatch(row, factors),
      supportingMockFactors: matchesScriptFactor(row, factors),
    }))
    .filter(({ row, supportingMockFactors }) => {
      if (!row.factor_id || supportingMockFactors.length === 0) return false;
      if (finiteNumber(row.sample_size) < 5) return false;
      return finiteNumber(row.coefficient) !== 0 || finiteNumber(row.lift) !== 0;
    })
    .filter(({ row, directMatch }) => {
      // mock_ctr_factor_ids are intentionally coarse bridges. Only direct Qwen
      // factor matches can carry negative calibration; coarse matches are used
      // as positive evidence so we don't punish a script for a different hook
      // subtype that happened to share the same mock CTR bucket.
      return directMatch || finiteNumber(row.coefficient) > 0;
    })
    .map(({ row, supportingMockFactors }) => ({
      factorId: String(row.factor_id),
      factorType: String(row.factor_type || row.factor_id?.split(':')[0] || ''),
      factorValue: String(row.factor_value || row.factor_id?.split(':').slice(1).join(':') || 'present'),
      lift: finiteNumber(row.lift),
      coefficient: finiteNumber(row.coefficient),
      sampleSize: finiteNumber(row.sample_size),
      confidence: String(row.confidence || 'low'),
      organicOnlyLift: typeof row.organic_only_lift === 'number' ? row.organic_only_lift : null,
      lowFollowerLift: typeof row.low_follower_lift === 'number' ? row.low_follower_lift : null,
      gmvPerMilleLift: typeof row.gmv_per_mille_lift === 'number' ? row.gmv_per_mille_lift : null,
      evidenceVideoIds: Array.isArray(row.evidence_video_ids) ? row.evidence_video_ids.map(String).slice(0, 5) : [],
      supportingMockFactors,
    }))
    .sort((left, right) => {
      const confidenceRank = (value: string) => (value === 'high' ? 3 : value === 'medium' ? 2 : 1);
      return (
        confidenceRank(right.confidence) - confidenceRank(left.confidence) ||
        Math.abs(right.coefficient) - Math.abs(left.coefficient) ||
        right.sampleSize - left.sampleSize
      );
    })
    .slice(0, 8);

  if (!matchedFactors.length) return null;

  const calibrationBySupport = new Map<string, number>();
  for (const factor of matchedFactors) {
    const keys = factor.supportingMockFactors.length ? factor.supportingMockFactors : [factor.factorId];
    for (const key of keys) {
      const current = calibrationBySupport.get(key) ?? 0;
      if (Math.abs(factor.coefficient) > Math.abs(current)) calibrationBySupport.set(key, factor.coefficient);
    }
  }

  const calibrationLift = round(
    Math.max(
      -0.08,
      Math.min(
        0.12,
        [...calibrationBySupport.values()].reduce((sum, coefficient) => sum + coefficient, 0),
      ),
    ),
  );

  return {
    source: 'qwen_factor_attribution',
    modelVersion: attribution.model_version || 'attribution-v1-from-qwenvl-real-winners',
    qwenModel: attribution.qwen_model || 'unknown',
    videoCount: finiteNumber(attribution.video_count),
    matchedFactorCount: matchedFactors.length,
    calibrationLift,
    calibratedBenchmarkScore: round(clamp01(input.benchmarkScore + calibrationLift)),
    policy:
      attribution.policy?.scoring_core ||
      'Qwen factors are used as an explainable calibration layer; the primary benchmark scorer is unchanged.',
    matchedFactors,
  };
}
