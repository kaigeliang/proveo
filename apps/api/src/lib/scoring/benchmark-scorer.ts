/**
 * Benchmark Scorer v2 — PCA(50) + LightGBM.
 *
 * Scoring pipeline for new scripts:
 *   1. embedText(referenceText)  →  1024-dim jina-clip-v2 vector
 *   2. PCA(50) projection        →  50-dim semantic features
 *   3. + structural features     →  65-dim input to LightGBM
 *   4. LightGBM predict          →  benchmarkScore ∈ [0, 1]
 *   5. Logistic classifiers      →  organicWinnerProb, lowFollowerWinnerProb
 *   6. TopK profile search       →  nearest reference examples
 *
 * Scorer model (scorer-model.json) is loaded at module init via readFileSync
 * to avoid TypeScript compiler stalling on 768KB JSON type inference.
 */
import fs from 'fs';
import path from 'path';
import type { Script } from '@aigc-video-hub/shared';
import { embedText } from '../clip';
import { vectorSearchEnabled } from '../light-mode';

// ── model types ───────────────────────────────────────────────────────────────

interface FlatTree {
  split_feature: number[];
  threshold: number[];
  left_child: number[];
  right_child: number[];
  leaf_value: number[];
}

interface LGBMModel {
  type: 'lgbm';
  base_score: number;
  trees: FlatTree[];
}

interface ScorerModel {
  version: number;
  cohorts: {
    organic_sales_videos: number[];
    high_roas_ads: number[];
    low_follower_videos: number[];
  };
  pca: {
    nComponents: number;
    mean: number[];
    components: number[][];
  };
  features: {
    names: string[];
    topCategories: string[];
    maxDurationLog: number;
    nPca: number;
    nStruct: number;
  };
  scorer: LGBMModel;
  classifiers: {
    organicWinner: LGBMModel;
    lowFollowerWinner: LGBMModel;
  };
  metrics: { test: Record<string, number> };
}

// ── public interfaces ─────────────────────────────────────────────────────────

export interface CohortSimilarities {
  organicWinner: number;
  paidRoasWinner: number;
  lowFollowerWinner: number;
}

export interface BenchmarkMatch {
  id: string;
  referenceText: string;
  category: string;
  datasets: string[];
  benchmarkScore: number;
  profileDistance: number;
  labels: {
    gmvPercentile: number | null;
    gmvPerMilleViewsPercentile: number | null;
    adRoasPercentile: number | null;
    organicWinner: boolean;
    paidValidatedWinner: boolean;
    lowFollowerWinner: boolean;
  };
}

export interface TrainedModelOutput {
  score: number;
  clampedScore: number;
  organicWinnerProb: number;
  lowFollowerWinnerProb: number;
  archetypeMatch: 'organic' | 'paid_roas' | 'low_follower';
}

export interface BenchmarkScoreResult {
  referenceText: string;
  benchmarkScore: number;
  cohortSimilarities: CohortSimilarities;
  trainedModel: TrainedModelOutput | null;
  topKMatches: BenchmarkMatch[];
  modelVersion: string;
  usedEmbedding: boolean;
}

// ── model loading ─────────────────────────────────────────────────────────────

const SCORER_MODEL_PATH = process.env.SCORER_MODEL_PATH ?? path.join(__dirname, 'scorer-model.json');

const TRAIN_PATH = resolveProjectPath(process.env.BENCHMARK_TRAIN_PATH, 'tmp/kalodata-test/benchmark-train.jsonl');

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

function resolveProjectPath(input: string | undefined, fallback: string): string {
  const value = input || fallback;
  if (path.isAbsolute(value)) return value;
  const repoPath = path.join(resolveRepoRoot(), value);
  if (fs.existsSync(repoPath)) return repoPath;
  return path.resolve(process.cwd(), value);
}

let scorerModel: ScorerModel | null = null;
let scorerLoadError: string | null = null;

function loadScorerModel(): ScorerModel | null {
  if (scorerModel) return scorerModel;
  if (scorerLoadError) return null;
  try {
    scorerModel = JSON.parse(fs.readFileSync(SCORER_MODEL_PATH, 'utf-8')) as ScorerModel;
    return scorerModel;
  } catch (err) {
    scorerLoadError = err instanceof Error ? err.message : String(err);
    console.warn(`[benchmark-scorer] scorer model not found: ${scorerLoadError}`);
    return null;
  }
}

interface TrainingRecord {
  id: string;
  referenceText: string;
  datasets: string[];
  category: string;
  labels: {
    gmvPercentile: number | null;
    gmvPerMilleViewsPercentile: number | null;
    adRoasPercentile: number | null;
    organicWinner: boolean;
    paidValidatedWinner: boolean;
    lowFollowerWinner: boolean;
    benchmarkScore: number;
  };
  similarities: {
    organicWinnerSimilarity: number | null;
    paidRoasWinnerSimilarity: number | null;
    lowFollowerWinnerSimilarity: number | null;
  };
}

let cachedTraining: TrainingRecord[] | null = null;

function loadTraining(): TrainingRecord[] {
  if (cachedTraining) return cachedTraining;
  try {
    cachedTraining = fs
      .readFileSync(TRAIN_PATH, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TrainingRecord);
    return cachedTraining;
  } catch {
    cachedTraining = [];
    return cachedTraining;
  }
}

// ── math helpers ──────────────────────────────────────────────────────────────

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

function l2normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function scoreWithLightFormula(script: Script): number {
  const totalDuration = script.shots.reduce((sum, s) => sum + s.duration, 0);
  const hasHook = /hook|problem|before|after|benefit|offer|cta|save|limited/i.test(
    `${script.narrative} ${script.shots.map((shot) => shot.narration).join(' ')}`,
  );
  const durationFit = totalDuration >= 10 && totalDuration <= 18 ? 0.18 : 0.08;
  const structureFit = script.shots.length >= 3 ? 0.18 : 0.1;
  const hookFit = hasHook ? 0.2 : 0.12;
  return round4(Math.min(0.82, 0.32 + durationFit + structureFit + hookFit));
}

// ── PCA projection ────────────────────────────────────────────────────────────

function projectPCA(embedding: number[], pca: ScorerModel['pca']): number[] {
  const centered = embedding.map((v, i) => v - pca.mean[i]);
  return pca.components.map((comp) => dotProduct(centered, comp));
}

// ── LightGBM tree evaluator ───────────────────────────────────────────────────

function evalTree(features: number[], tree: FlatTree): number {
  let node = 0;
  while (node >= 0) {
    node = features[tree.split_feature[node]] <= tree.threshold[node] ? tree.left_child[node] : tree.right_child[node];
  }
  // leaf index: -(pos+1), so ~node converts to array index
  return tree.leaf_value[~node];
}

function predictLGBM(features: number[], model: LGBMModel): number {
  return model.base_score + model.trees.reduce((sum, tree) => sum + evalTree(features, tree), 0);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── feature vector builder ────────────────────────────────────────────────────

function buildFeatureVector(
  pcaFeatures: number[],
  simOrganic: number,
  simPaidRoas: number,
  simLowFollower: number,
  durationSeconds: number,
  category: string,
  model: ScorerModel,
): number[] {
  const { topCategories, maxDurationLog } = model.features;
  const durNorm = Math.log1p(Math.max(0, durationSeconds)) / maxDurationLog;
  const catOhe = topCategories.map((c) => (c === category ? 1 : 0));
  const catOther = topCategories.includes(category) ? 0 : 1;
  return [...pcaFeatures, simOrganic, simPaidRoas, simLowFollower, durNorm, ...catOhe, catOther];
}

// ── TopK profile distance search ──────────────────────────────────────────────

function profileDistance(q: CohortSimilarities, r: TrainingRecord['similarities']): number {
  const dO = q.organicWinner - (r.organicWinnerSimilarity ?? 0);
  const dP = q.paidRoasWinner - (r.paidRoasWinnerSimilarity ?? 0);
  const dL = q.lowFollowerWinner - (r.lowFollowerWinnerSimilarity ?? 0);
  return Math.sqrt(dO * dO + dP * dP + dL * dL);
}

// ── public API ────────────────────────────────────────────────────────────────

/** Build reference text for a script (same format as ingest-kalodata-exports.mjs). */
export function buildScriptReferenceText(script: Script, ctx?: { title?: string; category?: string }): string {
  const narration = script.shots
    .map((s) => s.narration)
    .filter(Boolean)
    .join(' ');
  const desc = narration || script.narrative;
  const totalDuration = script.shots.reduce((sum, s) => sum + s.duration, 0);
  return [desc, ctx?.title ?? script.productId, ctx?.category ?? '', `duration:${totalDuration}`]
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score a script against the Kalodata benchmark.
 *
 * Primary score: LightGBM on PCA(50) + cohort similarities + category + duration.
 * Falls back to cohort-formula score if model is unavailable.
 */
export async function scoreWithBenchmark(
  script: Script,
  ctx?: { title?: string; category?: string },
  topK = 5,
): Promise<BenchmarkScoreResult> {
  const referenceText = buildScriptReferenceText(script, ctx);
  const totalDuration = script.shots.reduce((sum, s) => sum + s.duration, 0);
  const category = ctx?.category ?? '';
  const model = loadScorerModel();

  if (!vectorSearchEnabled()) {
    const benchmarkScore = scoreWithLightFormula(script);
    return {
      referenceText,
      benchmarkScore,
      cohortSimilarities: { organicWinner: 0, paidRoasWinner: 0, lowFollowerWinner: 0 },
      trainedModel: {
        score: benchmarkScore,
        clampedScore: benchmarkScore,
        organicWinnerProb: benchmarkScore,
        lowFollowerWinnerProb: round4(Math.max(0.1, benchmarkScore - 0.12)),
        archetypeMatch: 'organic',
      },
      topKMatches: [],
      modelVersion: 'light-mode-formula-fallback',
      usedEmbedding: false,
    };
  }

  const rawEmbedding = await embedText(referenceText);
  if (!rawEmbedding || rawEmbedding.length === 0) {
    return {
      referenceText,
      benchmarkScore: 0.5,
      cohortSimilarities: { organicWinner: 0, paidRoasWinner: 0, lowFollowerWinner: 0 },
      trainedModel: null,
      topKMatches: [],
      modelVersion: 'fallback-no-embedding',
      usedEmbedding: false,
    };
  }

  const vector = l2normalize(rawEmbedding);

  // cohort similarities (use model cohorts if available, else formula fallback)
  const cohortData = model?.cohorts;
  const simOrganic = cohortData ? dotProduct(vector, cohortData.organic_sales_videos) : 0;
  const simPaidRoas = cohortData ? dotProduct(vector, cohortData.high_roas_ads) : 0;
  const simLowFol = cohortData ? dotProduct(vector, cohortData.low_follower_videos) : 0;

  const cohortSimilarities: CohortSimilarities = {
    organicWinner: round4(simOrganic),
    paidRoasWinner: round4(simPaidRoas),
    lowFollowerWinner: round4(simLowFol),
  };

  // trained model inference
  let trainedModel: TrainedModelOutput | null = null;
  let benchmarkScore: number;

  if (model) {
    const pcaFeats = projectPCA(vector, model.pca);
    const features = buildFeatureVector(pcaFeats, simOrganic, simPaidRoas, simLowFol, totalDuration, category, model);

    const rawScore = predictLGBM(features, model.scorer);
    const rawOrgLogit = predictLGBM(features, model.classifiers.organicWinner);
    const rawLfLogit = predictLGBM(features, model.classifiers.lowFollowerWinner);

    const sims: Array<[string, number]> = [
      ['organic', simOrganic],
      ['paid_roas', simPaidRoas],
      ['low_follower', simLowFol],
    ];
    const archetypeMatch = sims.reduce((best, cur) =>
      cur[1] > best[1] ? cur : best,
    )[0] as TrainedModelOutput['archetypeMatch'];

    trainedModel = {
      score: round4(rawScore),
      clampedScore: round4(Math.max(0, Math.min(1, rawScore))),
      organicWinnerProb: round4(sigmoid(rawOrgLogit)),
      lowFollowerWinnerProb: round4(sigmoid(rawLfLogit)),
      archetypeMatch,
    };
    benchmarkScore = trainedModel.clampedScore;
  } else {
    // formula fallback when model file is missing
    benchmarkScore = round4(Math.min(1, 0.5 * simOrganic + 0.25 * simPaidRoas + 0.17 * simLowFol));
  }

  // TopK reference search
  const records = loadTraining();
  const topKMatches: BenchmarkMatch[] = records
    .filter((r) => r.similarities && r.labels?.benchmarkScore !== undefined)
    .map((r) => ({ r, dist: profileDistance(cohortSimilarities, r.similarities) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, topK)
    .map(({ r, dist }) => ({
      id: r.id,
      referenceText: r.referenceText,
      category: r.category,
      datasets: r.datasets,
      benchmarkScore: r.labels.benchmarkScore,
      profileDistance: Math.round(dist * 1e4) / 1e4,
      labels: {
        gmvPercentile: r.labels.gmvPercentile,
        gmvPerMilleViewsPercentile: r.labels.gmvPerMilleViewsPercentile,
        adRoasPercentile: r.labels.adRoasPercentile,
        organicWinner: r.labels.organicWinner,
        paidValidatedWinner: r.labels.paidValidatedWinner,
        lowFollowerWinner: r.labels.lowFollowerWinner,
      },
    }));

  return {
    referenceText,
    benchmarkScore,
    cohortSimilarities,
    trainedModel,
    topKMatches,
    modelVersion: model ? `kalodata-lgbm-v2+jina-clip-v2` : 'formula-fallback',
    usedEmbedding: true,
  };
}
