import type { Script } from '@aigc-video-hub/shared';
import { completeWithDoubao, isDoubaoTextConfigured } from '../providers/doubao';
import { evaluateObjectiveMetrics, type ObjectiveMetrics } from './objective';
import {
  scoreWithBenchmark,
  type BenchmarkScoreResult,
  type CohortSimilarities,
  type BenchmarkMatch,
} from './benchmark-scorer';
import { buildQwenAttributionInsight, type QwenAttributionInsight } from './qwen-attribution';

export type { CohortSimilarities, BenchmarkMatch };

export interface SubjectiveDimensions {
  hookStrength: number;
  emotionalResonance: number;
  sceneDiversity: number;
  salesClarity: number;
  brandSafety: number;
}

export interface JudgeScoreBreakdown extends SubjectiveDimensions {
  subjectiveComposite: number;
  objectiveComposite: number;
  objective: ObjectiveMetrics;
  durationOk: boolean;
  evidenceCoverage: number;
  sensitiveWordsOk: boolean;
  composite: number;
  normalized: number;
  // Benchmark fields (populated when mode is benchmark_*)
  benchmarkScore?: number;
  cohortSimilarities?: CohortSimilarities;
  topKMatches?: BenchmarkMatch[];
  qwenAttribution?: QwenAttributionInsight;
  qwenCalibrationLift?: number;
  qwenCalibratedBenchmarkScore?: number;
}

export interface JudgeResult {
  variantId: string;
  score: JudgeScoreBreakdown;
  reasoning: string;
  usedFallback: boolean;
  mode:
    | 'benchmark_with_llm_reasoning'
    | 'benchmark_deterministic'
    | 'llm_with_objective_metrics'
    | 'deterministic_fixture';
  benchmark?: BenchmarkScoreResult;
}

export interface JudgeOptions {
  enableLlm?: boolean;
  enableBenchmark?: boolean;
  subjectiveWeight?: number;
  objectiveWeight?: number;
  productContext?: { title?: string; category?: string };
}

// ── LLM helpers ──────────────────────────────────────────────────────────────

const BENCHMARK_REASONING_PROMPT = `你是电商视频 Auditor。根据脚本和基准相似度数据，给出简洁分析。
只返回 JSON：{"reasoning":"（≤80字的中文分析，聚焦与爆款的差距和主要原因）","improvements":["改进点1","改进点2","改进点3"]}`;

const RUBRIC_PROMPT = `你是资深电商短视频分镜评审。只评估"创意表现"，不假定任何营销事实为真（事实可信度由证据系统单独把关）。
对五项维度各给 0-3 分，严格按锚点打分：
- hookStrength 3秒钩子：0=平淡自我介绍开场；1=普通陈述；2=有明确停留理由（提问/反差/高能）；3=钩子强且与商品强相关。
- emotionalResonance 场景共鸣：0=无场景；1=泛泛场景；2=具体使用场景；3=第一人称代入、有情绪张力。
- sceneDiversity 视觉变化：0=单一镜头重复；1=镜头少且雷同；2=有运镜/景别变化；3=节奏与景别丰富且服务叙事。
- salesClarity 卖点表达：0=没讲卖点；1=卖点模糊；2=卖点清晰；3=卖点清晰且有演示/证据承接。
- brandSafety 措辞合规：0=出现绝对化/违规承诺；3=措辞克制合规。任意违规直接给 0。
只评打分，不要重写脚本。仅返回 JSON：
{"hookStrength":0,"emotionalResonance":0,"sceneDiversity":0,"salesClarity":0,"brandSafety":0,"reasoning":"≤60字中文依据"}`;

function clampDimension(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 0;
}

function round(value: number, precision = 3): number {
  const m = 10 ** precision;
  return Math.round(value * m) / m;
}

function textForScoring(script: Script): string {
  return [
    `商品: ${script.productId}`,
    `叙事: ${script.narrative}`,
    `风格: ${script.visualStyle}`,
    ...script.shots.map(
      (shot, i) => `镜头${i + 1}(${shot.duration}s,${shot.camera}): ${shot.visualDesc} | 旁白: ${shot.narration}`,
    ),
  ].join('\n');
}

async function fetchBenchmarkReasoning(
  script: Script,
  bench: BenchmarkScoreResult,
): Promise<{ reasoning: string; improvements: string[] } | null> {
  if (!isDoubaoTextConfigured()) return null;
  try {
    const top3 = bench.topKMatches
      .slice(0, 3)
      .map(
        (m, i) =>
          `${i + 1}. [${m.category}] benchmarkScore=${m.benchmarkScore.toFixed(2)} | ${m.referenceText.slice(0, 100)}`,
      )
      .join('\n');
    const userMsg = [
      `脚本：${textForScoring(script)}`,
      '',
      `基准数据：`,
      `  自然流量爆款相似度: ${(bench.cohortSimilarities.organicWinner * 100).toFixed(1)}%`,
      `  高ROAS付费爆款相似度: ${(bench.cohortSimilarities.paidRoasWinner * 100).toFixed(1)}%`,
      `  低粉丝爆款相似度: ${(bench.cohortSimilarities.lowFollowerWinner * 100).toFixed(1)}%`,
      `  综合得分: ${bench.benchmarkScore.toFixed(3)}/1.0`,
      '',
      `对标参考（Top 3）：`,
      top3,
    ].join('\n');
    const response = await completeWithDoubao(
      {
        messages: [
          { role: 'system', content: BENCHMARK_REASONING_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      },
      20_000,
    );
    const payload = JSON.parse(String(response.choices?.[0]?.message?.content || '{}')) as Record<string, unknown>;
    return {
      reasoning: String(payload.reasoning || '').slice(0, 300),
      improvements: Array.isArray(payload.improvements)
        ? (payload.improvements as unknown[]).map(String).slice(0, 5)
        : [],
    };
  } catch {
    return null;
  }
}

async function scoreWithLlm(
  script: Script,
  enabled: boolean,
): Promise<{ breakdown: SubjectiveDimensions; reasoning: string } | null> {
  if (!enabled || !isDoubaoTextConfigured()) return null;
  try {
    const response = await completeWithDoubao(
      {
        messages: [
          { role: 'system', content: RUBRIC_PROMPT },
          { role: 'user', content: textForScoring(script) },
        ],
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      },
      20_000,
    );
    const payload = JSON.parse(String(response.choices?.[0]?.message?.content || '{}')) as Record<string, unknown>;
    return {
      breakdown: {
        hookStrength: clampDimension(payload.hookStrength),
        emotionalResonance: clampDimension(payload.emotionalResonance),
        sceneDiversity: clampDimension(payload.sceneDiversity),
        salesClarity: clampDimension(payload.salesClarity),
        brandSafety: clampDimension(payload.brandSafety),
      },
      reasoning: String(payload.reasoning || '').slice(0, 200),
    };
  } catch {
    return null;
  }
}

// ── Deterministic fallbacks ───────────────────────────────────────────────────

function deterministicSubjectiveScore(script: Script, objective: ObjectiveMetrics): SubjectiveDimensions {
  const firstText = `${script.shots[0]?.narration || ''} ${script.shots[0]?.visualDesc || ''}`;
  const allText = script.shots.map((s) => `${s.narration} ${s.subtitle}`).join(' ');
  const hookTerms = ['?', '？', '痛点', '对比', '开箱', '前后', '如何', '需要'];
  const emotionTerms = ['你', '日常', '真实', '通勤', '卧室', '家', '体验'];
  const salesTerms = ['展示', '参数', '细节', '功能', '权益', '适用', '演示'];
  const cameras = new Set(script.shots.map((s) => s.camera));
  const hookHits = hookTerms.filter((t) => firstText.includes(t)).length;
  const emotionHits = emotionTerms.filter((t) => allText.includes(t)).length;
  const salesHits = salesTerms.filter((t) => allText.includes(t)).length;
  return {
    hookStrength: hookHits >= 2 ? 3 : hookHits === 1 ? 2 : 1,
    emotionalResonance: emotionHits >= 3 ? 3 : emotionHits >= 1 ? 2 : 1,
    sceneDiversity: cameras.size >= 3 ? 3 : cameras.size === 2 ? 2 : 1,
    salesClarity: salesHits >= 3 ? 3 : salesHits >= 1 ? 2 : 1,
    brandSafety: objective.complianceScore === 1 ? 3 : 0,
  };
}

/** Compat-only proxy mapping for legacy 0-3 rubric fields; UI must show benchmarkScore/cohorts/topK as first-class fields. */
function benchmarkToSubjectiveDimensions(
  bench: BenchmarkScoreResult,
  objective: ObjectiveMetrics,
): SubjectiveDimensions {
  const clamp3 = (v: number) => Math.max(0, Math.min(3, Math.round(v * 300) / 100));
  return {
    hookStrength: clamp3(bench.cohortSimilarities.organicWinner),
    emotionalResonance: clamp3(bench.cohortSimilarities.lowFollowerWinner),
    sceneDiversity: clamp3(bench.benchmarkScore),
    salesClarity: clamp3(bench.cohortSimilarities.paidRoasWinner),
    brandSafety: objective.complianceScore === 1 ? 3 : 0,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function judgeScript(variantId: string, script: Script, options: JudgeOptions = {}): Promise<JudgeResult> {
  const objective = evaluateObjectiveMetrics(script);
  const useBenchmark = options.enableBenchmark !== false; // default true

  const requestedSubjectiveWeight = options.subjectiveWeight ?? 0.7;
  const requestedObjectiveWeight = options.objectiveWeight ?? 0.3;
  const totalWeight = requestedSubjectiveWeight + requestedObjectiveWeight || 1;
  const subjectiveWeight = requestedSubjectiveWeight / totalWeight;
  const objectiveWeight = requestedObjectiveWeight / totalWeight;

  if (useBenchmark) {
    // ── Benchmark-first path ────────────────────────────────────────────────
    const bench = await scoreWithBenchmark(script, options.productContext);
    const qwenAttribution = buildQwenAttributionInsight({
      script,
      benchmarkScore: bench.benchmarkScore,
    });
    const dimensions = benchmarkToSubjectiveDimensions(bench, objective);

    // Authoritative compliance override
    if (objective.complianceScore === 0) dimensions.brandSafety = 0;

    const subjectiveComposite =
      dimensions.hookStrength +
      dimensions.emotionalResonance +
      dimensions.sceneDiversity +
      dimensions.salesClarity +
      dimensions.brandSafety;
    const composite = round(subjectiveComposite * subjectiveWeight + objective.composite * objectiveWeight);

    // LLM is called only for reasoning text, not for scoring
    const llmInsight = options.enableLlm !== false ? await fetchBenchmarkReasoning(script, bench) : null;

    const reasoning =
      llmInsight?.reasoning ||
      `benchmark=${bench.benchmarkScore.toFixed(3)}; organic=${bench.cohortSimilarities.organicWinner.toFixed(3)}; paid=${bench.cohortSimilarities.paidRoasWinner.toFixed(3)}; lowFollower=${bench.cohortSimilarities.lowFollowerWinner.toFixed(3)}; objective=${objective.composite}/15`;

    const score: JudgeScoreBreakdown = {
      ...dimensions,
      subjectiveComposite,
      objectiveComposite: objective.composite,
      objective,
      durationOk: objective.checks.find((c) => c.id === 'duration')?.passed ?? false,
      evidenceCoverage: objective.evidenceCoverage,
      sensitiveWordsOk: objective.complianceScore === 1,
      composite,
      normalized: round(composite / 15, 4),
      benchmarkScore: bench.benchmarkScore,
      cohortSimilarities: bench.cohortSimilarities,
      topKMatches: bench.topKMatches,
      qwenAttribution: qwenAttribution ?? undefined,
      qwenCalibrationLift: qwenAttribution?.calibrationLift,
      qwenCalibratedBenchmarkScore: qwenAttribution?.calibratedBenchmarkScore,
    };

    return {
      variantId,
      score,
      reasoning,
      usedFallback: !llmInsight,
      mode: llmInsight ? 'benchmark_with_llm_reasoning' : 'benchmark_deterministic',
      benchmark: bench,
    };
  }

  // ── Legacy LLM-as-Judge path (opt-in via enableBenchmark: false) ───────────
  const llmResult = await scoreWithLlm(script, options.enableLlm ?? true);
  const usedFallback = !llmResult;
  const dimensions = llmResult?.breakdown ?? deterministicSubjectiveScore(script, objective);
  if (objective.complianceScore === 0) dimensions.brandSafety = 0;

  const subjectiveComposite =
    dimensions.hookStrength +
    dimensions.emotionalResonance +
    dimensions.sceneDiversity +
    dimensions.salesClarity +
    dimensions.brandSafety;
  const composite = round(subjectiveComposite * subjectiveWeight + objective.composite * objectiveWeight);

  const score: JudgeScoreBreakdown = {
    ...dimensions,
    subjectiveComposite,
    objectiveComposite: objective.composite,
    objective,
    durationOk: objective.checks.find((c) => c.id === 'duration')?.passed ?? false,
    evidenceCoverage: objective.evidenceCoverage,
    sensitiveWordsOk: objective.complianceScore === 1,
    composite,
    normalized: round(composite / 15, 4),
  };

  return {
    variantId,
    score,
    reasoning:
      llmResult?.reasoning ||
      `确定性 rubric + objective metrics；objective=${objective.composite}/15，未通过项=${objective.failures.length}`,
    usedFallback,
    mode: usedFallback ? 'deterministic_fixture' : 'llm_with_objective_metrics',
  };
}
