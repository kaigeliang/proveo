import type { Express, Response } from 'express';
import {
  getQdrantStoreStatus,
  reindexQdrantRetrievalDatabase,
  searchQdrantEmbeddings,
  VECTOR_TEXT_EMBEDDING_DIMS,
  VECTOR_TEXT_EMBEDDING_MODEL,
} from '@aigc-video-hub/db';
import { createQueuedTask } from '../production';

export type VideoTagRoutesContext = {
  sendJsonError(res: Response, status: number, error: string): void;
  safeExternalError(error: unknown): string;
};

function readTags(value: unknown) {
  const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function registerVideoTagRoutes(app: Express, ctx: VideoTagRoutesContext) {
  app.get('/api/video-tags/status', async (_req, res) => {
    try {
      res.json({
        provider: 'qdrant',
        mode: 'qdrant-only',
        embeddingModel: VECTOR_TEXT_EMBEDDING_MODEL,
        dims: VECTOR_TEXT_EMBEDDING_DIMS,
        qdrant: await getQdrantStoreStatus(),
        localCompressedIndex: {
          enabled: false,
          removed: true,
        },
      });
    } catch (error) {
      ctx.sendJsonError(res, 500, ctx.safeExternalError(error));
    }
  });

  app.post('/api/video-tags/reindex', async (req, res) => {
    try {
      const store = String(req.body?.store || req.query.store || 'qdrant');
      const sync = req.body?.sync === true || req.query.sync === 'true' || req.query.sync === '1';
      const reason = String(req.body?.reason || req.query.reason || 'manual');
      if (store === 'qdrant') {
        if (sync) {
          res.json({ pipeline: 'sync', ...(await reindexQdrantRetrievalDatabase({ reason })) });
          return;
        }
        const task = await createQueuedTask('index', { reason });
        res.status(202).json({ pipeline: 'queue', taskId: task.id, task });
        return;
      }
      ctx.sendJsonError(res, 400, '视频 tag 检索只支持 Qdrant，请使用 store=qdrant');
    } catch (error) {
      ctx.sendJsonError(res, 500, ctx.safeExternalError(error));
    }
  });

  app.get('/api/video-tags/search', async (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      if (!query) return ctx.sendJsonError(res, 400, '需要 q 查询词');
      const limit = Math.max(1, Math.min(100, Number(req.query.k || 12)));
      const productId = req.query.productId ? String(req.query.productId) : undefined;
      const tags = readTags(req.query.tags || req.query.tag);
      const ownerType = req.query.ownerType ? String(req.query.ownerType) : undefined;
      const results = await searchQdrantEmbeddings({
        query,
        limit,
        productId,
        tags,
        ownerType,
      });
      res.json({
        query,
        productId,
        tags,
        mode: 'qdrant',
        results: results.map((item) => ({
          id: `${item.ownerType}:${item.ownerId}`,
          ownerType: item.ownerType,
          ownerId: item.ownerId,
          productId,
          text:
            item.metadata && typeof item.metadata === 'object'
              ? String((item.metadata as Record<string, unknown>).title || '')
              : '',
          summary:
            item.metadata && typeof item.metadata === 'object'
              ? String((item.metadata as Record<string, unknown>).summary || '')
              : '',
          tags:
            item.metadata &&
            typeof item.metadata === 'object' &&
            Array.isArray((item.metadata as Record<string, unknown>).tags)
              ? ((item.metadata as Record<string, unknown>).tags as string[])
              : [],
          embeddingModel: item.embeddingModel,
          metadata: item.metadata,
          score: item.score,
          match: {
            vector:
              item.metadata && typeof item.metadata === 'object'
                ? Number((item.metadata as Record<string, unknown>).vectorScore || 0)
                : item.score,
            keyword: 0,
            tag: 0,
          },
        })),
      });
    } catch (error) {
      ctx.sendJsonError(res, 500, ctx.safeExternalError(error));
    }
  });
}
