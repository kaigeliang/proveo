import type { Express } from 'express';
import {
  getTrendDatabaseStatus,
  listTrendItems,
  listTrendSources,
  refreshTrendDatabase,
  searchQdrantEmbeddings,
} from '@aigc-video-hub/db';
import { sendApiError } from '../http/api-error';
import { createQueuedTask } from '../production';

function readLimit(value: unknown, fallback = 24) {
  const parsed = Number(value || fallback);
  return Math.max(1, Math.min(100, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metricNumber(metrics: unknown, key: string) {
  if (!metrics || typeof metrics !== 'object') return undefined;
  const value = (metrics as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function publicTrendItem(row: Awaited<ReturnType<typeof listTrendItems>>[number]) {
  return {
    id: row.id,
    sourceId: row.sourceId,
    platform: row.source.platform,
    sourceName: row.source.name,
    externalId: row.externalId,
    title: row.title,
    url: row.url || undefined,
    tags: row.tags,
    flatTags: row.flatTags,
    metrics: row.metrics || undefined,
    heatScore: metricNumber(row.metrics, 'heatScore'),
    rank: metricNumber(row.metrics, 'rank'),
    embeddingId: row.embeddingId || undefined,
    searchScore: row.searchScore,
    fetchedAt: row.fetchedAt,
    updatedAt: row.updatedAt,
  };
}

function publicVectorHit(row: Awaited<ReturnType<typeof searchQdrantEmbeddings>>[number]) {
  return {
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    embeddingModel: row.embeddingModel,
    score: row.score,
    metadata: row.metadata,
    trend: row.trend
      ? {
          id: row.trend.id,
          title: row.trend.title,
          sourceId: row.trend.sourceId,
          platform: row.trend.platform,
          url: row.trend.url,
          tags: row.trend.tags,
          metrics: row.trend.metrics,
          heatScore: metricNumber(row.trend.metrics, 'heatScore'),
          fetchedAt: row.trend.fetchedAt,
        }
      : undefined,
  };
}

async function searchVectorStore(input: {
  store?: string;
  query: string;
  ownerType?: string;
  platform?: string;
  category?: string;
  tag?: string;
  limit?: number;
}) {
  if (input.store && input.store !== 'qdrant') {
    throw new Error('趋势向量检索只支持 Qdrant');
  }
  return {
    mode: 'qdrant',
    results: await searchQdrantEmbeddings(input),
  };
}

export function registerTrendRoutes(app: Express) {
  app.get('/api/trends/status', async (_req, res) => {
    try {
      res.json(await getTrendDatabaseStatus());
    } catch (error) {
      sendApiError(res, 503, error instanceof Error ? error.message : '趋势库状态不可用');
    }
  });

  app.get('/api/trends/sources', async (req, res) => {
    try {
      const platform = readText(req.query.platform);
      const enabled =
        req.query.enabled === undefined ? undefined : req.query.enabled === 'true' || req.query.enabled === '1';
      const sources = await listTrendSources({ platform, enabled });
      res.json({
        sources: sources.map((source) => ({
          id: source.id,
          platform: source.platform,
          name: source.name,
          url: source.url || undefined,
          enabled: source.enabled,
          refreshCron: source.refreshCron || undefined,
          config: source.config || undefined,
          items: source._count.items,
          updatedAt: source.updatedAt,
        })),
      });
    } catch (error) {
      sendApiError(res, 503, error instanceof Error ? error.message : '趋势源不可用');
    }
  });

  app.get('/api/trends/items', async (req, res) => {
    try {
      const items = await listTrendItems({
        platform: readText(req.query.platform),
        sourceId: readText(req.query.sourceId),
        category: readText(req.query.category),
        tag: readText(req.query.tag),
        q: readText(req.query.q),
        limit: readLimit(req.query.limit || req.query.k),
      });
      res.json({ items: items.map(publicTrendItem) });
    } catch (error) {
      sendApiError(res, 503, error instanceof Error ? error.message : '趋势商品列表不可用');
    }
  });

  app.get('/api/trends/search', async (req, res) => {
    try {
      const q = readText(req.query.q);
      if (!q) return sendApiError(res, 400, '需要 q 查询词');
      if (req.query.mode === 'vector' || req.query.store) {
        const vectorSearch = await searchVectorStore({
          store: readText(req.query.store),
          query: q,
          ownerType: 'trend',
          platform: readText(req.query.platform),
          category: readText(req.query.category),
          tag: readText(req.query.tag),
          limit: readLimit(req.query.k || req.query.limit),
        });
        res.json({ query: q, mode: vectorSearch.mode, results: vectorSearch.results.map(publicVectorHit) });
        return;
      }
      const items = await listTrendItems({
        q,
        platform: readText(req.query.platform),
        category: readText(req.query.category),
        tag: readText(req.query.tag),
        limit: readLimit(req.query.k || req.query.limit),
      });
      res.json({ query: q, items: items.map(publicTrendItem) });
    } catch (error) {
      sendApiError(res, 503, error instanceof Error ? error.message : '趋势检索不可用');
    }
  });

  app.get('/api/trends/vector-search', async (req, res) => {
    try {
      const q = readText(req.query.q);
      if (!q) return sendApiError(res, 400, '需要 q 查询词');
      const vectorSearch = await searchVectorStore({
        store: readText(req.query.store),
        query: q,
        ownerType: readText(req.query.ownerType) || 'trend',
        platform: readText(req.query.platform),
        category: readText(req.query.category),
        tag: readText(req.query.tag),
        limit: readLimit(req.query.k || req.query.limit),
      });
      res.json({ query: q, mode: vectorSearch.mode, results: vectorSearch.results.map(publicVectorHit) });
    } catch (error) {
      sendApiError(res, 503, error instanceof Error ? error.message : '向量检索不可用');
    }
  });

  app.get('/api/trends/qdrant-search', async (req, res) => {
    try {
      const q = readText(req.query.q);
      if (!q) return sendApiError(res, 400, '需要 q 查询词');
      const results = await searchQdrantEmbeddings({
        query: q,
        ownerType: readText(req.query.ownerType) || 'trend',
        platform: readText(req.query.platform),
        category: readText(req.query.category),
        tag: readText(req.query.tag),
        limit: readLimit(req.query.k || req.query.limit),
      });
      res.json({ query: q, mode: 'qdrant', results: results.map(publicVectorHit) });
    } catch (error) {
      sendApiError(res, 503, error instanceof Error ? error.message : 'Qdrant 检索不可用');
    }
  });

  app.post('/api/trends/refresh', async (req, res) => {
    try {
      const source = readText(req.body?.source || req.query.source);
      const productId = readText(req.body?.productId || req.query.productId);
      const sync = req.body?.sync === true || req.query.sync === 'true' || req.query.sync === '1';
      if (sync) {
        const result = await refreshTrendDatabase({ source, productId });
        res.json({ pipeline: 'sync', ...result });
        return;
      }
      const task = await createQueuedTask('trend', { source, productId });
      res.status(202).json({ pipeline: 'queue', taskId: task.id, task });
    } catch (error) {
      sendApiError(res, 503, error instanceof Error ? error.message : '趋势刷新失败');
    }
  });
}
