import type { Express, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Script, Shot } from '@aigc-video-hub/shared';
import {
  createProductionShot,
  createQueuedTask,
  deleteProductionShot,
  getProductionScript,
  patchProductionScript,
  patchProductionShot,
} from '../production';
import { scoreWithBenchmark } from '../scoring/benchmark-scorer';

type RuntimeTemplate = {
  id: string;
  name: string;
  description: string;
  strategyIds: string[];
  factorIds: string[];
  sourceVideoIds: string[];
  factors: Script['shots'][number]['factors'];
};

type GenerationProfile = 'quick_preview' | 'trusted_publish';

export type ScriptsRoutesContext = {
  templates: RuntimeTemplate[];
  readText(value: unknown, fallback?: string): string;
  readTextArray(value: unknown, fallback?: string[]): string[];
  clamp(value: number, min: number, max: number): number;
  safeMarketingText(value: string): string;
  sendJsonError(res: Response, status: number, error: string): void;
  safeExternalError(error: unknown): string;
  normalizeScriptProvider(value: unknown): 'auto' | 'local' | 'doubao';
  normalizeRetrievalMode(value: unknown): 'rag' | 'none';
  normalizeAspectRatio(value: unknown): Script['aspectRatio'];
  ensureShotTextLayers<T extends Shot>(shot: T): T;
};

export function registerScriptsRoutes(app: Express, ctx: ScriptsRoutesContext) {
  async function assertNoOutputMaterialRef(scriptId: string, materialRef?: string) {
    if (!materialRef?.trim()) return;
    const script = await getProductionScript(scriptId);
    if (!script) throw new Error('剧本不存在');
    throw new Error('禁止绑定素材切片到分镜；素材只能作为 Seedance 生成参考，最终成片不得使用 materialRef。');
  }

  app.post('/api/scripts/generate', async (req, res) => {
    const productId = String(req.body?.productId || '').trim();
    const mode = ['imitate', 'template', 'auto'].includes(req.body?.mode) ? req.body.mode : 'auto';
    const provider = ctx.normalizeScriptProvider(req.body?.provider);
    const retrievalMode = ctx.normalizeRetrievalMode(req.body?.retrievalMode);
    const generationProfile = req.body?.generationProfile === 'quick_preview' ? 'quick_preview' : 'trusted_publish';
    if (!productId) return ctx.sendJsonError(res, 400, '需要 productId');
    try {
      const task = await createQueuedTask('script', {
        productId,
        mode,
        provider,
        retrievalMode,
        generationProfile,
        ref: req.body?.ref,
        freePrompt: req.body?.freePrompt,
      });
      res.status(202).json({ taskId: task.id, pipeline: 'queue' });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产队列不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/scripts/:id', async (req, res, next) => {
    if (req.params.id === 'templates') return next();
    try {
      const productionScript = await getProductionScript(req.params.id);
      if (productionScript) {
        res.json(productionScript);
        return;
      }
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产剧本不可用：${ctx.safeExternalError(error)}`);
    }
    return ctx.sendJsonError(res, 404, '剧本不存在');
  });

  // 模型驱动的转化预估：用真实带货视频训练的打分模型（benchmark scorer）替代 mock 转化。
  // organicWinnerProb = 分类器判定「匹配高转化自然带货视频」的概率，作为转化代理；非真实成交。
  app.get('/api/scripts/:id/conversion', async (req, res) => {
    try {
      const script = await getProductionScript(req.params.id);
      if (!script) return ctx.sendJsonError(res, 404, '剧本不存在');
      const bench = await scoreWithBenchmark(script as unknown as Script, { title: script.narrative });
      const predictedConversion = bench.trainedModel
        ? bench.trainedModel.organicWinnerProb
        : ctx.clamp((bench.cohortSimilarities.organicWinner + 1) / 2, 0, 1);
      res.json({
        scriptId: script.id,
        source: 'benchmark-model',
        modelVersion: bench.modelVersion,
        usedEmbedding: bench.usedEmbedding,
        appealScore: bench.benchmarkScore,
        predictedConversion,
        archetypeMatch: bench.trainedModel?.archetypeMatch,
        cohortSimilarities: bench.cohortSimilarities,
        label: '模型预测（真实带货视频训练，非真实成交）',
      });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `转化预测不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.patch('/api/scripts/:id', async (req, res, next) => {
    if (req.params.id === 'templates') return next();
    const patch = req.body || {};
    try {
      const script = await patchProductionScript(req.params.id, {
        ...(typeof patch.narrative === 'string' && { narrative: ctx.safeMarketingText(patch.narrative) }),
        ...(typeof patch.visualStyle === 'string' && { visualStyle: ctx.safeMarketingText(patch.visualStyle) }),
        ...(typeof patch.bgm === 'string' && { bgm: ctx.safeMarketingText(patch.bgm) }),
        ...(typeof patch.language === 'string' && { language: patch.language }),
        ...(patch.aspectRatio && { aspectRatio: ctx.normalizeAspectRatio(patch.aspectRatio) }),
        ...(Array.isArray(patch.shotOrder) && { shotOrder: ctx.readTextArray(patch.shotOrder) }),
      });
      if (!script) return ctx.sendJsonError(res, 404, '剧本不存在');
      res.json(script);
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产剧本保存失败：${ctx.safeExternalError(error)}`);
    }
  });

  app.patch('/api/scripts/:scriptId/shots/:shotId', async (req, res) => {
    const patch = req.body || {};
    try {
      if (typeof patch.materialRef === 'string') {
        await assertNoOutputMaterialRef(req.params.scriptId, patch.materialRef);
      }
      const script = await patchProductionShot(req.params.scriptId, req.params.shotId, {
        ...(typeof patch.visualDesc === 'string' && { visualDesc: patch.visualDesc }),
        ...(typeof patch.camera === 'string' && { camera: patch.camera }),
        ...(typeof patch.narration === 'string' && { narration: patch.narration }),
        ...(typeof patch.subtitle === 'string' && { subtitle: patch.subtitle }),
        ...((patch.materialRef === null || patch.materialRef === '') && { materialRef: null }),
        ...(patch.transition && { transition: patch.transition }),
        ...(Array.isArray(patch.claimIds) && { claimIds: ctx.readTextArray(patch.claimIds) }),
        ...(Array.isArray(patch.evidenceIds) && { evidenceIds: ctx.readTextArray(patch.evidenceIds) }),
        ...(Array.isArray(patch.factors) && { factors: patch.factors }),
        ...(Number.isFinite(Number(patch.duration)) && {
          duration: ctx.clamp(Math.round(Number(patch.duration)), 3, 8),
        }),
        ...(Number.isFinite(Number(patch.order)) && { order: Math.max(1, Math.round(Number(patch.order))) }),
        status: 'draft',
        clearAsset: true,
      });
      if (!script) return ctx.sendJsonError(res, 404, '剧本或分镜不存在');
      res.json(script);
    } catch (error) {
      const message = error instanceof Error ? error.message : ctx.safeExternalError(error);
      const status = message.includes('禁止绑定非当前商品素材切片') ? 400 : 503;
      return ctx.sendJsonError(res, status, status === 400 ? message : `生产分镜保存失败：${message}`);
    }
  });

  app.post('/api/scripts/:scriptId/shots', async (req, res) => {
    const body = req.body || {};
    try {
      if (typeof body.materialRef === 'string') {
        await assertNoOutputMaterialRef(req.params.scriptId, body.materialRef);
      }
    } catch (error) {
      return ctx.sendJsonError(res, 400, error instanceof Error ? error.message : '素材切片不能绑定到分镜');
    }
    const shot: Shot = ctx.ensureShotTextLayers({
      id: `shot_${uuid().slice(0, 8)}`,
      order: Number.isFinite(Number(body.order)) ? Math.max(1, Math.round(Number(body.order))) : 0,
      duration: ctx.clamp(Math.round(Number(body.duration || 3)), 3, 8),
      visualDesc: String(body.visualDesc || '新增商品场景分镜'),
      camera: String(body.camera || '固定'),
      narration: String(body.narration || '补充一个真实、可验证的商品卖点。'),
      subtitle: String(body.subtitle || body.narration || '补充卖点'),
      materialRef: undefined,
      factors: Array.isArray(body.factors)
        ? body.factors
        : [{ type: '补充分镜', value: '人工新增', sourceStrategy: 'manual_edit' }],
      status: 'draft',
    });
    try {
      const script = await createProductionShot(req.params.scriptId, shot);
      if (!script) return ctx.sendJsonError(res, 404, '剧本不存在');
      res.status(201).json(script);
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产分镜新增失败：${ctx.safeExternalError(error)}`);
    }
  });

  app.delete('/api/scripts/:scriptId/shots/:shotId', async (req, res) => {
    try {
      const script = await deleteProductionShot(req.params.scriptId, req.params.shotId);
      if (!script) return ctx.sendJsonError(res, 404, '剧本或分镜不存在');
      res.json(script);
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产分镜删除失败：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/templates', (_req, res) => {
    res.json(ctx.templates);
  });
}
