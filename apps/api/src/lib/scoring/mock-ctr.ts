import type { Script } from '@aigc-video-hub/shared';

export interface MockCtrInput {
  script: Script;
  factorWeights?: Record<string, number>;
  impressions?: number;
  seed?: string;
  ageDays?: number;
  averageOrderValue?: number;
}

export interface MockCtrResult {
  ctr: number;
  completionRate: number;
  conversionRate: number;
  gmv: number;
  impressions: number;
  source: 'simulated';
  modelVersion: string;
  seed: string;
  timeDecay: number;
  noiseMultiplier: number;
  factorContributions: Array<{ factorId: string; coefficient: number; contribution: number }>;
}

export const MOCK_CTR_MODEL_VERSION = 'mock-ctr-v1-deterministic';
export const DEFAULT_FACTOR_EFFECTS: Record<string, number> = {
  'hook:question': 0.18,
  'hook:shock': 0.24,
  'hook:product_reveal': 0.12,
  'hook:lifestyle': 0.08,
  'bgm:upbeat': 0.06,
  'bgm:ambient': 0.02,
  'bgm:trending': 0.15,
  'camera:push': 0.04,
  'camera:whip': 0.09,
  'camera:static': -0.03,
  'proof:demonstration': 0.13,
  'cta:benefit': 0.07,
  'cta:urgency': 0.1,
  'duration:under_8': 0.12,
  'duration:8_to_12': 0.06,
  'duration:12_to_15': 0,
  'duration:over_15': -0.18,
  'selling_point_density:high': 0.11,
  'selling_point_density:medium': 0.05,
  'selling_point_density:low': -0.04,
};

const BASE_CTR = 0.042;
const BASE_COMPLETION = 0.68;
const BASE_CONVERSION = 0.031;
const BASE_GMV_PER_CONVERSION = 120;

function round(value: number, precision: number): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function normalizedFactorId(type: string, value: string): string {
  const raw = `${type}:${value}`.toLowerCase().replace(/\s+/g, '_');
  const aliases: Record<string, string> = {
    '开场hook:痛点提问': 'hook:question',
    '开场hook:高能展示': 'hook:shock',
    '镜头运动:推': 'camera:push',
    '镜头运动:固定': 'camera:static',
  };
  return aliases[raw] ?? raw;
}

export function extractScriptFactors(script: Script): string[] {
  const factors = new Set<string>();
  const duration = script.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (duration < 8) factors.add('duration:under_8');
  else if (duration <= 12) factors.add('duration:8_to_12');
  else if (duration <= 15) factors.add('duration:12_to_15');
  else factors.add('duration:over_15');

  for (const factor of script.shots.flatMap((shot) => shot.factors ?? [])) {
    const factorId = normalizedFactorId(factor.type, factor.value);
    if (DEFAULT_FACTOR_EFFECTS[factorId] !== undefined) factors.add(factorId);
  }

  const claimShots = script.shots.filter((shot) => (shot.claimIds?.length ?? 0) > 0).length;
  const density = claimShots / Math.max(script.shots.length, 1);
  if (density >= 0.6) factors.add('selling_point_density:high');
  else if (density >= 0.3) factors.add('selling_point_density:medium');
  else factors.add('selling_point_density:low');
  return [...factors].sort();
}

/**
 * Generates simulated performance only. A fixed seed and ageDays make the demo
 * reproducible; consumers must retain source='simulated' when persisting it.
 */
export function simulateCtr(input: MockCtrInput): MockCtrResult {
  const seed = input.seed || `${input.script.id}:${input.script.productId}`;
  const random = seededRandom(seed);
  const timeDecay = Math.exp(-Math.max(0, input.ageDays ?? 0) / 90);
  const factorIds = extractScriptFactors(input.script);
  const factorContributions = factorIds.map((factorId) => {
    const coefficient = input.factorWeights?.[factorId] ?? DEFAULT_FACTOR_EFFECTS[factorId] ?? 0;
    return {
      factorId,
      coefficient,
      contribution: round(coefficient * timeDecay, 4),
    };
  });
  const lift = factorContributions.reduce((sum, item) => sum + item.contribution, 0);
  const noiseMultiplier = round(0.93 + random() * 0.14, 4);
  const ctr = Math.min(0.35, Math.max(0.005, BASE_CTR * (1 + lift) * noiseMultiplier));
  const completionRate = Math.min(0.98, Math.max(0.1, BASE_COMPLETION * (1 + lift * 0.38) * (0.97 + random() * 0.06)));
  const conversionRate = Math.min(
    0.25,
    Math.max(0.001, BASE_CONVERSION * (1 + lift * 0.42) * (0.94 + random() * 0.12)),
  );
  const impressions = input.impressions ?? Math.floor(5000 + random() * 45000);
  const averageOrderValue = input.averageOrderValue ?? BASE_GMV_PER_CONVERSION;
  const gmv = impressions * ctr * conversionRate * averageOrderValue;

  return {
    ctr: round(ctr, 4),
    completionRate: round(completionRate, 3),
    conversionRate: round(conversionRate, 4),
    gmv: Math.round(gmv),
    impressions,
    source: 'simulated',
    modelVersion: MOCK_CTR_MODEL_VERSION,
    seed,
    timeDecay: round(timeDecay, 4),
    noiseMultiplier,
    factorContributions,
  };
}
