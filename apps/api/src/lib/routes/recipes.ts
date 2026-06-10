import type { Express, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import type { CloneRecipe, CloneRecipeSegment, Script } from '@aigc-video-hub/shared';
import { DEFAULT_FACTOR_EFFECTS, extractScriptFactors } from '../scoring/mock-ctr';
import { judgeScript } from '../scoring/judge';
import { embedText } from '../clip';
import { createQueuedTask, getProductionScript } from '../production';
import { vectorSearchEnabled } from '../light-mode';
import {
  REFERENCE_TEXT_EMBEDDING_MODEL,
  createRecipeClone,
  getRecipe,
  getReferenceVideo,
  listRecipes,
  searchReferenceQdrant,
  updateRecipeClone,
  upsertRecipe,
} from '@aigc-video-hub/db';

type RecipeRoutesContext = {
  readText(value: unknown, fallback?: string): string;
  clamp(value: number, min: number, max: number): number;
  sendJsonError(res: Response, status: number, error: string): void;
  safeExternalError(error: unknown): string;
  normalizeScriptProvider(value: unknown): 'auto' | 'local' | 'doubao';
  normalizeRetrievalMode(value: unknown): 'rag' | 'none';
};

type ReferenceLike = {
  id: string;
  sourceUrl?: string | null;
  sourceDeclaration?: string | null;
  breakdownReport?: unknown;
  metadata?: unknown;
  score?: number;
  vectorScore?: number;
};

const MOCK_FACTOR_TYPES = new Set(Object.keys(DEFAULT_FACTOR_EFFECTS).map((id) => id.split(':')[0]));
const REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSION = 'ReferenceCreativeAnalysis.v1';
const LEGACY_REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSIONS = new Set([
  '',
  'ReferenceCreativeAnalysis',
  'ReferenceCreativeAnalysis.v2',
]);

function stableId(prefix: string, value: string) {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${prefix}_${hash}`;
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textFrom(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberFrom(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeReferenceCreativeAnalysis(value: unknown): Record<string, unknown> {
  const analysis = recordFrom(value);
  if (!Object.keys(analysis).length) return {};
  const schemaVersion = textFrom(analysis.schemaVersion);
  if (
    schemaVersion === REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSION ||
    !LEGACY_REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSIONS.has(schemaVersion)
  ) {
    return analysis;
  }
  return { ...analysis, schemaVersion: REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSION };
}

function factorId(type: string, value: string) {
  return `${type}:${value}`;
}

function setFactor(byType: Record<string, string>, type: string, value: string) {
  const id = factorId(type, value);
  if (MOCK_FACTOR_TYPES.has(type) && DEFAULT_FACTOR_EFFECTS[id] !== undefined) {
    byType[type] = value;
  }
}

function mapRawFactorsToMock(rawFactors: string[], durationSeconds?: number) {
  const byType: Record<string, string> = {
    hook: 'question',
    proof: 'demonstration',
    cta: 'benefit',
    bgm: 'upbeat',
    selling_point_density: 'medium',
    duration:
      typeof durationSeconds === 'number'
        ? durationSeconds < 8
          ? 'under_8'
          : durationSeconds <= 12
            ? '8_to_12'
            : durationSeconds <= 15
              ? '12_to_15'
              : 'over_15'
        : '8_to_12',
  };

  for (const factor of rawFactors.map((item) => item.toLowerCase())) {
    if (factor.includes('hook_type:pain') || factor.includes('problem') || factor.includes('hook_question'))
      setFactor(byType, 'hook', 'question');
    if (factor.includes('hook_type:before') || factor.includes('shock')) setFactor(byType, 'hook', 'shock');
    if (factor.includes('hook_type:product') || factor.includes('unboxing') || factor.includes('early_product'))
      setFactor(byType, 'hook', 'product_reveal');
    if (factor.includes('hook_type:lifestyle') || factor.includes('lifestyle')) setFactor(byType, 'hook', 'lifestyle');
    if (
      factor.includes('has_hand_demo:true') ||
      factor.includes('has_before_after:true') ||
      factor.includes('hand_demo') ||
      factor.includes('before_after')
    ) {
      setFactor(byType, 'proof', 'demonstration');
    }
    if (factor.includes('cta_count:multi') || factor.includes('hook_type:offer')) setFactor(byType, 'cta', 'urgency');
    if (factor.includes('cta_count:one')) setFactor(byType, 'cta', 'benefit');
    if (factor.includes('visual_style:macro') || factor.includes('visual_style:action'))
      setFactor(byType, 'bgm', 'trending');
    if (factor.includes('visual_style:lifestyle') || factor.includes('visual_style:outdoor')) {
      setFactor(byType, 'bgm', 'ambient');
    }
    if (
      factor.includes('product_visible_ratio:high') ||
      factor.includes('scene_count:five_plus') ||
      factor.includes('clear_ocr')
    ) {
      setFactor(byType, 'selling_point_density', 'high');
    }
    if (factor.includes('product_visible_ratio:low') || factor.includes('cta_count:none')) {
      setFactor(byType, 'selling_point_density', 'low');
    }
  }

  const canonical = Object.entries(byType)
    .map(([type, value]) => factorId(type, value))
    .filter((id) => DEFAULT_FACTOR_EFFECTS[id] !== undefined)
    .sort();

  return { canonical, byType, raw: rawFactors };
}

function roleForSegment(text: string, index: number): CloneRecipeSegment['role'] {
  const value = text.toLowerCase();
  if (index === 0 || value.includes('hook') || value.includes('开场') || value.includes('痛点')) return 'hook';
  if (value.includes('cta') || value.includes('收尾') || value.includes('优惠')) return 'cta';
  if (value.includes('对比') || value.includes('证明') || value.includes('证据')) return 'proof';
  if (value.includes('场景') || value.includes('演示')) return 'demo';
  return index >= 3 ? 'offer' : 'demo';
}

function normalizeReferenceAnalysisSegments(analysis: Record<string, unknown>): CloneRecipeSegment[] {
  const cloneRecipe = recordFrom(analysis.cloneRecipe);
  const segments: CloneRecipeSegment[] = [];
  for (const [index, item] of arrayFrom(cloneRecipe.segments).entries()) {
    const row = recordFrom(item);
    const role = textFrom(row.role);
    const tactic = textFrom(row.tactic || row.summary || row.title);
    if (!tactic) continue;
    segments.push({
      t: textFrom(row.t, `${index * 3}-${Math.min(15, (index + 1) * 3)}s`),
      role: ['hook', 'proof', 'demo', 'offer', 'cta'].includes(role)
        ? (role as CloneRecipeSegment['role'])
        : roleForSegment(tactic, index),
      tactic,
      shot: textFrom(row.shot, index === 0 ? 'push' : 'static'),
      bgm: textFrom(row.bgm, index === 0 ? 'trending' : 'upbeat'),
    });
    if (segments.length >= 5) break;
  }
  return segments;
}

function normalizeSegments(
  report: Record<string, unknown>,
  qwen: Record<string, unknown>,
  referenceAnalysis: Record<string, unknown> = {},
): CloneRecipeSegment[] {
  const analysisSegments = normalizeReferenceAnalysisSegments(referenceAnalysis);
  if (analysisSegments.length) return analysisSegments;

  const shotStructure = arrayFrom(qwen.shotStructure)
    .map((item) => textFrom(item))
    .filter(Boolean);
  const reportShots = arrayFrom(report.shots)
    .map((item) => {
      const row = recordFrom(item);
      return textFrom(row.description || row.visual || row.tactic || item);
    })
    .filter(Boolean);
  const source = shotStructure.length ? shotStructure : reportShots;
  const fallback = [
    '前三秒商品出现，用痛点或高能产品动作抓住注意力',
    '用手部演示或前后对比证明核心卖点',
    '切到真实生活场景，说明适用人群和使用方式',
    '用细节特写补充可信证据',
    '回到商品主体，给出保守利益点 CTA',
  ];
  const items = (source.length ? source : fallback).slice(0, 5);
  const slotSeconds = Math.max(2, Math.round(15 / Math.max(items.length, 1)));
  return items.map((item, index) => ({
    t: `${index * slotSeconds}-${Math.min(15, (index + 1) * slotSeconds)}s`,
    role: roleForSegment(item, index),
    tactic: item,
    shot: index === 0 ? 'push' : item.includes('特写') ? 'macro' : 'static',
    bgm: index === 0 ? 'trending' : 'upbeat',
  }));
}

function referenceToRecipe(reference: ReferenceLike, input: { productId?: string; title?: string } = {}): CloneRecipe {
  const report = recordFrom(reference.breakdownReport);
  const referenceAnalysis = normalizeReferenceCreativeAnalysis(report.referenceCreativeAnalysis);
  const analysisCloneRecipe = recordFrom(referenceAnalysis.cloneRecipe);
  const metadata = recordFrom(reference.metadata);
  const labels = recordFrom(metadata.labels || report.benchmarkLabel);
  const qwen = recordFrom(metadata.qwenTruth || report.qwenTruthSlice);
  const qwenFactorIds = arrayFrom(qwen.factorIds).map(String).filter(Boolean);
  const normalizedFactors = arrayFrom(qwen.normalizedFactors)
    .map((item) => textFrom(recordFrom(item).factorId))
    .filter(Boolean);
  const reportFactors = arrayFrom(report.factors).map(String).filter(Boolean);
  const analysisFactors = arrayFrom(analysisCloneRecipe.factors).map(String).filter(Boolean);
  const rawFactors = [...new Set([...analysisFactors, ...qwenFactorIds, ...normalizedFactors, ...reportFactors])];
  const durationSeconds =
    numberFrom(referenceAnalysis.durationSeconds) ||
    numberFrom(metadata.durationSeconds) ||
    numberFrom(report.durationSeconds) ||
    numberFrom(labels.durationSeconds);
  const factors = mapRawFactorsToMock(rawFactors, durationSeconds);
  const title =
    input.title ||
    textFrom(report.productTitle) ||
    textFrom(metadata.title) ||
    textFrom(report.title) ||
    textFrom(metadata.category, '爆款参考配方');
  const category = textFrom(metadata.category || report.category) || undefined;
  const scoring = {
    benchmarkScore: numberFrom(metadata.benchmarkScore) ?? numberFrom(labels.benchmarkScore) ?? null,
    vectorScore: numberFrom(reference.vectorScore) ?? null,
    searchScore: numberFrom(reference.score) ?? null,
    labels,
  };
  return {
    id: stableId('rcp', `${reference.id}:${title}:${rawFactors.join('|')}`),
    sourceUrl: textFrom(reference.sourceUrl) || undefined,
    sourceReferenceId: reference.id,
    sourceDeclaration:
      textFrom(reference.sourceDeclaration) || '公开爆款来源，仅作结构化拆解和配方分析，不复用原视频素材。',
    productId: input.productId,
    title,
    category,
    durationSeconds,
    pace: textFrom(analysisCloneRecipe.pace) || (durationSeconds && durationSeconds <= 12 ? '快剪' : '标准节奏'),
    segments: normalizeSegments(report, qwen, referenceAnalysis),
    factors,
    visual: {
      prototype: labels.organicWinner ? 'organicWinner' : labels.lowFollowerWinner ? 'lowFollowerWinner' : 'reference',
      qwenTruth: qwen,
      referenceCreativeAnalysis: referenceAnalysis,
      sourceEmbeddingModel: REFERENCE_TEXT_EMBEDDING_MODEL,
    },
    scoring,
    status: 'ready',
  };
}

function fallbackRecipe(input: {
  sourceUrl?: string;
  query?: string;
  productId?: string;
  title?: string;
}): CloneRecipe {
  const title = input.title || input.query || input.sourceUrl || '手动爆款配方';
  const factors = mapRawFactorsToMock(['hook_type:product_demo', 'has_hand_demo:true', 'cta_count:one'], 12);
  return {
    id: stableId('rcp', `manual:${title}:${input.sourceUrl || ''}`),
    sourceUrl: input.sourceUrl,
    sourceDeclaration: '用户提供的爆款链接尚未完成视觉拆解；当前使用保守配方模板，可后续用 QwenVL 复核。',
    productId: input.productId,
    title,
    category: undefined,
    durationSeconds: 12,
    pace: '快剪',
    segments: normalizeSegments({}, {}),
    factors,
    visual: {
      prototype: 'manual-fallback',
      sourceEmbeddingModel: 'none',
    },
    scoring: {
      benchmarkScore: null,
      vectorScore: null,
      searchScore: null,
      labels: {},
    },
    status: 'ready',
  };
}

function publicRecipe(
  row: Awaited<ReturnType<typeof upsertRecipe>> | NonNullable<Awaited<ReturnType<typeof getRecipe>>>,
) {
  const recipe = row as unknown as Omit<CloneRecipe, 'createdAt' | 'updatedAt'> & {
    clones?: unknown;
    createdAt?: Date | string;
    updatedAt?: Date | string;
  };
  return {
    ...recipe,
    createdAt: recipe.createdAt instanceof Date ? recipe.createdAt.toISOString() : recipe.createdAt,
    updatedAt: recipe.updatedAt instanceof Date ? recipe.updatedAt.toISOString() : recipe.updatedAt,
  };
}

function recipePrompt(recipe: CloneRecipe, productTitle: string) {
  const factors = recipe.factors.canonical.join(', ');
  const segments = recipe.segments.map((segment) => `${segment.t} ${segment.role}: ${segment.tactic}`).join(' / ');
  return `${productTitle || recipe.title}。按 CloneCast 配方复刻结构，不复用原片素材。配方因子=${factors}。镜头结构=${segments}`;
}

async function findReferenceForExtraction(input: {
  referenceId?: string;
  query?: string;
  sourceUrl?: string;
  category?: string;
}) {
  if (input.referenceId) {
    const reference = await getReferenceVideo(input.referenceId);
    if (reference) return reference;
  }

  const query = input.query || input.sourceUrl || '';
  if (!query) return undefined;

  if (!vectorSearchEnabled()) return undefined;

  try {
    const queryVector = await embedText(query);
    const searchInput = {
      queryVector,
      embeddingModel: REFERENCE_TEXT_EMBEDDING_MODEL,
      limit: 1,
      category: input.category,
      q: undefined,
    };
    const [hit] = (await searchReferenceQdrant(searchInput)) || [];
    return hit;
  } catch (error) {
    throw new Error(`Qdrant recipe reference retrieval failed: ${error instanceof Error ? error.message : error}`);
  }
}

export function registerRecipeRoutes(app: Express, ctx: RecipeRoutesContext) {
  app.get('/api/recipes', async (req, res) => {
    try {
      const productId = ctx.readText(req.query.productId) || undefined;
      const category = ctx.readText(req.query.category) || undefined;
      const limit = ctx.clamp(Number(req.query.limit || 50), 1, 200);
      const rows = await listRecipes({ productId, category, limit });
      res.json(rows.map(publicRecipe));
    } catch (error) {
      ctx.sendJsonError(res, 503, `配方库不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.post('/api/recipes/extract', async (req, res) => {
    const referenceId = ctx.readText(req.body?.referenceId) || undefined;
    const query = ctx.readText(req.body?.query) || undefined;
    const sourceUrl = ctx.readText(req.body?.sourceUrl) || undefined;
    const productId = ctx.readText(req.body?.productId) || undefined;
    const title = ctx.readText(req.body?.title) || undefined;
    const category = ctx.readText(req.body?.category) || undefined;

    if (!referenceId && !query && !sourceUrl) {
      return ctx.sendJsonError(res, 400, '需要 referenceId、query 或 sourceUrl');
    }

    try {
      const reference = await findReferenceForExtraction({ referenceId, query, sourceUrl, category });
      const recipe = reference
        ? referenceToRecipe(reference as ReferenceLike, { productId, title })
        : fallbackRecipe({ sourceUrl, query, productId, title });
      const saved = await upsertRecipe(recipe);
      res.status(201).json({
        recipe: publicRecipe(saved),
        source: reference ? 'reference_video' : 'fallback_template',
      });
    } catch (error) {
      ctx.sendJsonError(res, 503, `爆款配方拆解失败：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/recipes/:id', async (req, res) => {
    try {
      const recipe = await getRecipe(req.params.id);
      if (!recipe) return ctx.sendJsonError(res, 404, '配方不存在');
      res.json(publicRecipe(recipe));
    } catch (error) {
      ctx.sendJsonError(res, 503, `配方读取失败：${ctx.safeExternalError(error)}`);
    }
  });

  app.post('/api/recipes/:id/clone', async (req, res) => {
    const productId = ctx.readText(req.body?.productId);
    if (!productId) return ctx.sendJsonError(res, 400, '需要 productId');

    try {
      const row = await getRecipe(req.params.id);
      if (!row) return ctx.sendJsonError(res, 404, '配方不存在');
      const recipe = publicRecipe(row) as CloneRecipe;
      const productTitle = ctx.readText(req.body?.productTitle, productId);
      const generationProfile = req.body?.generationProfile === 'trusted_publish' ? 'trusted_publish' : 'quick_preview';
      const task = await createQueuedTask('script', {
        productId,
        mode: 'imitate',
        provider: ctx.normalizeScriptProvider(req.body?.provider),
        retrievalMode: ctx.normalizeRetrievalMode(req.body?.retrievalMode || 'rag'),
        generationProfile,
        ref: recipe.sourceReferenceId || recipe.id,
        freePrompt: recipePrompt(recipe, productTitle),
      });
      const cloneId = `rcl_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const clone = await createRecipeClone({
        id: cloneId,
        recipeId: recipe.id,
        productId,
        taskId: task.id,
        status: 'queued',
      });
      res.status(202).json({
        recipe,
        clone,
        cloneId,
        taskId: task.id,
        pipeline: 'queue',
      });
    } catch (error) {
      ctx.sendJsonError(res, 503, `配方克隆任务创建失败：${ctx.safeExternalError(error)}`);
    }
  });

  app.post('/api/recipes/:id/score', async (req, res) => {
    const scriptId = ctx.readText(req.body?.scriptId);
    if (!scriptId) return ctx.sendJsonError(res, 400, '需要 scriptId');

    try {
      const row = await getRecipe(req.params.id);
      if (!row) return ctx.sendJsonError(res, 404, '配方不存在');
      const recipe = publicRecipe(row) as CloneRecipe;
      const script = (await getProductionScript(scriptId)) as Script | undefined;
      if (!script) return ctx.sendJsonError(res, 404, '剧本不存在');
      const judge = await judgeScript(`clone_${recipe.id}_${scriptId}`, script, {
        productContext: { title: recipe.title, category: recipe.category || script.productId },
      });
      const scriptFactors = new Set(extractScriptFactors(script));
      const missingFactors = recipe.factors.canonical.filter((factor) => !scriptFactors.has(factor));
      const response = {
        recipeId: recipe.id,
        scriptId,
        benchmarkScore: judge.score.benchmarkScore ?? null,
        compositeScore: judge.score.composite,
        cohortSimilarities: judge.score.cohortSimilarities,
        topKMatches: judge.score.topKMatches,
        qwenAttribution: judge.score.qwenAttribution,
        qwenCalibrationLift: judge.score.qwenCalibrationLift,
        qwenCalibratedBenchmarkScore: judge.score.qwenCalibratedBenchmarkScore,
        recipeFactors: recipe.factors.canonical,
        scriptFactors: [...scriptFactors],
        missingFactors,
        reasoning: judge.reasoning,
        improvements: missingFactors.length
          ? missingFactors.slice(0, 3).map((factor) => `补齐 ${factor}，让脚本更贴近目标爆款配方。`)
          : ['配方因子已覆盖，下一步可进入成片审片。'],
      };
      const cloneId = ctx.readText(req.body?.cloneId);
      if (cloneId) {
        await updateRecipeClone(cloneId, {
          scriptId,
          status: 'scored',
          benchmarkScore:
            typeof response.benchmarkScore === 'number' && Number.isFinite(response.benchmarkScore)
              ? response.benchmarkScore
              : undefined,
          missingFactors,
          scoreBreakdown: response,
        }).catch(() => undefined);
      }
      res.json(response);
    } catch (error) {
      ctx.sendJsonError(res, 503, `配方评分失败：${ctx.safeExternalError(error)}`);
    }
  });
}
