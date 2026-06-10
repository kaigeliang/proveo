import type { Express, Response } from 'express';
import type { Script, TaskStatus } from '@aigc-video-hub/shared';
import { createQueuedTask, getProductionRenderPreview, getQueuedTaskResponse, retryQueuedTask } from '../production';

export type RenderRoutesContext = {
  sendJsonError(res: Response, status: number, error: string): void;
  safeExternalError(error: unknown): string;
  readText(value: unknown, fallback?: string): string;
  normalizeRenderProvider(value: unknown): 'auto' | 'local' | 'seedance';
  normalizeAspectRatio(value: unknown): Script['aspectRatio'];
  normalizeAudioMode(value: unknown): 'original' | 'voiceover' | 'mute';
  normalizeRetrievalMode(value: unknown): 'rag' | 'none';
};

function normalizeSubtitleMode(value: unknown) {
  return value === 'always' || value === 'off' || value === 'auto' ? value : 'auto';
}

function normalizeSubtitlePlacementProvider(value: unknown) {
  return value === 'local' || value === 'qwenvl' || value === 'auto' ? value : 'auto';
}

function normalizeSubtitleFontSize(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 24 && parsed <= 96 ? parsed : undefined;
}

export function registerRenderRoutes(app: Express, ctx: RenderRoutesContext) {
  app.post('/api/render/full', async (req, res) => {
    const scriptId = String(req.body?.scriptId || '').trim();
    if (!scriptId) return ctx.sendJsonError(res, 400, '需要 scriptId');
    const provider = ctx.normalizeRenderProvider(req.body?.provider);
    const exportOptions = {
      provider,
      aspectRatio: ctx.normalizeAspectRatio(req.body?.aspectRatio),
      resolution: ctx.readText(req.body?.resolution, '720x1280'),
      audioMode: ctx.normalizeAudioMode(req.body?.audioMode),
      retrievalMode: ctx.normalizeRetrievalMode(req.body?.retrievalMode),
      renderProfile: req.body?.renderProfile === 'fast_preview' ? 'fast_preview' : 'quality',
      fastRender: req.body?.fastRender === true,
      referenceImageUrl: String(req.body?.referenceImageUrl || '').trim() || undefined,
      referenceAngleLabel: String(req.body?.referenceAngleLabel || '').trim() || undefined,
      referenceAnglePrompt: String(req.body?.referenceAnglePrompt || '').trim() || undefined,
      subtitleMode: normalizeSubtitleMode(req.body?.subtitleMode),
      subtitlePlacementProvider: normalizeSubtitlePlacementProvider(req.body?.subtitlePlacementProvider),
      subtitleFontFamily: ctx.readText(req.body?.subtitleFontFamily, 'PingFang SC'),
      subtitleFontSize: normalizeSubtitleFontSize(req.body?.subtitleFontSize),
    };
    try {
      const task = await createQueuedTask('compose', { scriptId, exportOptions, ...exportOptions });
      res.status(202).json({ taskId: task.id, pipeline: 'queue' });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产队列不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.post('/api/render/shot', async (req, res) => {
    const scriptId = String(req.body?.scriptId || '').trim();
    const shotId = String(req.body?.shotId || '').trim();
    if (!scriptId || !shotId) return ctx.sendJsonError(res, 400, '需要 scriptId 和 shotId');
    const provider = ctx.normalizeRenderProvider(req.body?.provider);
    try {
      const referenceImageUrl = String(req.body?.referenceImageUrl || '').trim() || undefined;
      const referenceAnglePrompt = String(req.body?.referenceAnglePrompt || '').trim() || undefined;
      const preview = req.body?.preview === true;
      const task = await createQueuedTask('video', {
        scriptId,
        shotId,
        provider,
        referenceImageUrl,
        referenceAnglePrompt,
        preview,
      });
      res.status(202).json({ taskId: task.id, pipeline: 'queue' });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产队列不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/render/:scriptId/preview', async (req, res) => {
    try {
      const preview = await getProductionRenderPreview(req.params.scriptId);
      if (preview) {
        res.json(preview);
        return;
      }
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产预览不可用：${ctx.safeExternalError(error)}`);
    }
    return ctx.sendJsonError(res, 404, '剧本不存在');
  });

  app.post('/api/render/:scriptId/export', async (req, res) => {
    const scriptId = req.params.scriptId;
    const exportOptions = {
      aspectRatio: ctx.normalizeAspectRatio(req.body?.aspectRatio),
      resolution: req.body?.resolution || '720x1280',
      audioMode: ctx.normalizeAudioMode(req.body?.audioMode),
      retrievalMode: ctx.normalizeRetrievalMode(req.body?.retrievalMode),
      provider: ctx.normalizeRenderProvider(req.body?.provider),
      renderProfile: req.body?.renderProfile === 'fast_preview' ? 'fast_preview' : 'quality',
      fastRender: req.body?.fastRender === true,
      referenceImageUrl: String(req.body?.referenceImageUrl || '').trim() || undefined,
      referenceAngleLabel: String(req.body?.referenceAngleLabel || '').trim() || undefined,
      referenceAnglePrompt: String(req.body?.referenceAnglePrompt || '').trim() || undefined,
      subtitleMode: normalizeSubtitleMode(req.body?.subtitleMode),
      subtitlePlacementProvider: normalizeSubtitlePlacementProvider(req.body?.subtitlePlacementProvider),
      subtitleFontFamily: ctx.readText(req.body?.subtitleFontFamily, 'PingFang SC'),
      subtitleFontSize: normalizeSubtitleFontSize(req.body?.subtitleFontSize),
    };
    try {
      const task = await createQueuedTask('compose', { scriptId, exportOptions, ...exportOptions });
      res.status(202).json({ taskId: task.id, pipeline: 'queue' });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产队列不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/tasks/:taskId', async (req, res) => {
    try {
      const queued = await getQueuedTaskResponse(req.params.taskId);
      if (queued) {
        res.json(queued);
        return;
      }
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产任务状态不可用：${ctx.safeExternalError(error)}`);
    }
    return ctx.sendJsonError(res, 404, '任务不存在');
  });

  app.post('/api/tasks/:taskId/retry', async (req, res) => {
    try {
      const retry = await retryQueuedTask(req.params.taskId);
      if (!retry) return ctx.sendJsonError(res, 404, '任务不存在');
      res.status(202).json({ taskId: retry.id, retryOf: req.params.taskId, pipeline: 'queue' });
    } catch (error) {
      return ctx.sendJsonError(res, 400, error instanceof Error ? error.message : '任务重试失败');
    }
  });

  app.get('/api/tasks/:taskId/stream', async (req, res) => {
    try {
      const queued = await getQueuedTaskResponse(req.params.taskId);
      if (!queued) return ctx.sendJsonError(res, 404, '任务不存在');
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产任务状态不可用：${ctx.safeExternalError(error)}`);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const write = async () => {
      try {
        const payload = await getQueuedTaskResponse(req.params.taskId);
        if (!payload || typeof payload !== 'object') return;
        const row = payload as { status?: TaskStatus['status'] };
        res.write(`event: task:update\ndata: ${JSON.stringify(payload)}\n\n`);
        if (row.status === 'completed' || row.status === 'failed') {
          clearInterval(timer);
          res.end();
        }
      } catch (error) {
        res.write(
          `event: task:error\ndata: ${JSON.stringify({ message: `生产任务状态不可用：${ctx.safeExternalError(error)}` })}\n\n`,
        );
        clearInterval(timer);
        res.end();
      }
    };
    const timer = setInterval(() => void write(), 500);
    void write();
    req.on('close', () => clearInterval(timer));
  });

  app.get('/api/tasks/:taskId/trace', async (req, res) => {
    try {
      const queued = await getQueuedTaskResponse(req.params.taskId);
      if (queued) {
        res.json(queued.trace || []);
        return;
      }
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产任务状态不可用：${ctx.safeExternalError(error)}`);
    }
    return ctx.sendJsonError(res, 404, '任务不存在');
  });
}
