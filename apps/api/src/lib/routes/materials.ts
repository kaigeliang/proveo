import type { Express, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Material, MaterialAngle, ReferenceVideo, Slice } from '@aigc-video-hub/shared';
import {
  REFERENCE_TEXT_EMBEDDING_MODEL,
  deleteReferenceVideo,
  listReferenceVideos,
  searchReferenceQdrant,
  upsertReferenceVideo,
} from '@aigc-video-hub/db';
import {
  createQueuedTask,
  deleteProductionMaterial,
  getProductionMaterial,
  getProductionSlice,
  listProductionMaterialAngles,
  listProductionMaterials,
  saveProductionMaterial,
  searchProductionMaterialSlices,
} from '../production';
import { paginateArray, readPaginationParams } from '../http/pagination';
import { readLocalBinary, removeLocalPath } from '../providers/files';
import { embedText } from '../clip';
import { vectorSearchEnabled } from '../light-mode';

type RuntimeDirs = {
  publicDir: string;
  uploadDir: string;
  generatedDir: string;
};

type StorageClient = {
  putObject(input: { key: string; body: Buffer; contentType?: string }): Promise<{ key: string; url?: string }>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
};

export type MaterialsRoutesContext = {
  dirs: RuntimeDirs;
  upload: ReturnType<typeof multer>;
  storageClient: StorageClient;
  referenceVideos: Map<string, ReferenceVideo>;
  readText(value: unknown, fallback?: string): string;
  clamp(value: number, min: number, max: number): number;
  saveDataUrl(uploadDir: string, name: string, dataUrl: string): string | undefined;
  sendJsonError(res: Response, status: number, error: string): void;
  safeExternalError(error: unknown): string;
  persistRuntimeStore(): void;
  normalizeReferenceProvenance(reference: ReferenceVideo): ReferenceVideo;
};

export function registerMaterialsRoutes(app: Express, ctx: MaterialsRoutesContext) {
  const { dirs } = ctx;

  app.post('/api/materials/upload', ctx.upload.single('file'), async (req, res) => {
    const file = req.file;
    const body = req.body || {};
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
    const localSourceUrl = file
      ? `/uploads/${file.filename}`
      : dataUrl
        ? ctx.saveDataUrl(dirs.uploadDir, body.name || 'upload', dataUrl)
        : undefined;
    if (!localSourceUrl) return ctx.sendJsonError(res, 400, '需要上传文件或 dataUrl');

    const mime = file?.mimetype || (dataUrl.startsWith('data:video/') ? 'video' : 'image');
    const materialId = `mat_${uuid().slice(0, 10)}`;

    // 临时上传（聊天附件等）：只保留可访问 URL，不写 Material/Slice/向量，不进素材库。
    const ephemeral = ctx.readText(body.scope) === 'chat' || ctx.readText(body.persist) === 'false';
    if (ephemeral) {
      return res.status(200).json({
        materialId,
        sourceUrl: localSourceUrl,
        ephemeral: true,
        persisted: false,
      });
    }

    let sourceObjectKey: string | undefined;
    let sourceUrl = localSourceUrl;
    try {
      const ext = file?.originalname?.split('.').pop() || (mime.includes('video') ? 'mp4' : 'jpg');
      const objectKey = `materials/${materialId}.${ext}`;
      const filePath = file
        ? path.join(dirs.uploadDir, file.filename)
        : path.join(dirs.publicDir, localSourceUrl.replace(/^\//, ''));
      const fileBuffer = readLocalBinary(filePath);
      const stored = await ctx.storageClient.putObject({ key: objectKey, body: fileBuffer, contentType: mime });
      sourceObjectKey = stored.key;
      const objectUrl = stored.url || (await ctx.storageClient.getSignedUrl(stored.key, 86400 * 7));
      sourceUrl = objectUrl.includes('/objects/') ? localSourceUrl : objectUrl;
    } catch {
      // 对象存储失败降级为本地路径。
    }

    const material: Material = {
      id: materialId,
      productId: ctx.readText(body.productId) || undefined,
      name: ctx.readText(body.name || file?.originalname) || undefined,
      type: mime.includes('video') ? 'video' : 'image',
      sourceUrl,
      sourceDeclaration: String(body.sourceDeclaration || body.source || '商家上传'),
      uploadedAt: new Date(),
    };

    const seedText = `${body.productId || ''} ${body.name || file?.originalname || ''}`;
    try {
      await saveProductionMaterial({
        id: material.id,
        productId: material.productId,
        name: material.name,
        type: material.type,
        sourceUrl: material.sourceUrl,
        sourceObjectKey,
        sourceDeclaration: material.sourceDeclaration,
        uploadedAt: material.uploadedAt,
      });
      const task = await createQueuedTask('slice', { materialId: material.id, seedText });
      res.status(202).json({ materialId: material.id, taskId: task.id, pipeline: 'queue', sourceObjectKey });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产队列不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/materials', async (req, res) => {
    const type = req.query.type ? String(req.query.type) : '';
    const productId = req.query.productId ? String(req.query.productId) : '';
    const shouldPaginate =
      req.query.page !== undefined || req.query.pageSize !== undefined || req.query.limit !== undefined;
    const pagination = readPaginationParams(req.query as Record<string, unknown>, {
      defaultPageSize: 24,
      maxPageSize: 100,
    });
    try {
      const result = await listProductionMaterials({ type: type || undefined, productId: productId || undefined });
      res.json(shouldPaginate ? paginateArray(result, pagination) : result);
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产素材库不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/materials/:id/angles', async (req, res) => {
    try {
      const material = await getProductionMaterial(req.params.id);
      if (!material) return ctx.sendJsonError(res, 404, '素材不存在');
      res.json(await listProductionMaterialAngles(req.params.id));
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产角度库不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.post('/api/materials/:id/angles', async (req, res) => {
    const force = req.body?.force === true || req.body?.force === 'true';
    const includePresets = req.body?.includePresets !== false;
    const customAngles = Array.isArray(req.body?.customAngles) ? req.body.customAngles : [];

    try {
      const material = await getProductionMaterial(req.params.id);
      if (!material) return ctx.sendJsonError(res, 404, '素材不存在');
      if (material.type !== 'image') return ctx.sendJsonError(res, 422, '只有图片素材可以生成商品角度参考图');
      const existing = await listProductionMaterialAngles(material.id);
      if (existing.length && !force && !customAngles.length) {
        return res.json({ materialId: material.id, angles: existing, reused: true, pipeline: 'queue' });
      }
      const task = await createQueuedTask('angle', { materialId: material.id, force, includePresets, customAngles });
      res.status(202).json({ materialId: material.id, taskId: task.id, pipeline: 'queue' });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产角度队列不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.delete('/api/materials/:id', async (req, res) => {
    if (req.params.id === 'mat_demo_product') return ctx.sendJsonError(res, 409, '演示默认素材不能删除');

    try {
      const deleted = await deleteProductionMaterial(req.params.id);
      if (!deleted) return ctx.sendJsonError(res, 404, '素材不存在或已删除');
      res.json({
        deleted: true,
        materialId: deleted.id,
        deletedSliceIds: deleted.deletedSliceIds,
        deletedAngleIds: deleted.deletedAngleIds,
        pipeline: 'queue',
      });
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产素材库不可用：${ctx.safeExternalError(error)}`);
    }
  });

  app.get('/api/materials/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const k = ctx.clamp(Number(req.query.k || 12), 1, 50);
      const productId = req.query.productId ? String(req.query.productId) : undefined;
      if (!productId) {
        return ctx.sendJsonError(res, 400, '素材检索必须传当前商品 productId；结果只能作为 Seedance 生成参考。');
      }
      res.json(await searchProductionMaterialSlices(q, k, productId));
    } catch (error) {
      ctx.sendJsonError(res, 500, ctx.safeExternalError(error));
    }
  });

  app.get('/api/slices/:id', async (req, res) => {
    try {
      const productionSlice = await getProductionSlice(req.params.id);
      if (productionSlice) {
        res.json(productionSlice);
        return;
      }
    } catch (error) {
      return ctx.sendJsonError(res, 503, `生产切片不可用：${ctx.safeExternalError(error)}`);
    }
    return ctx.sendJsonError(res, 404, '切片不存在');
  });

  app.get('/api/reference-videos', async (_req, res) => {
    const memItems = [...ctx.referenceVideos.values()];
    if (memItems.length) return res.json(memItems);
    const dbItems = await listReferenceVideos().catch(() => []);
    if (dbItems.length) {
      for (const item of dbItems) ctx.referenceVideos.set(item.id, item as unknown as ReferenceVideo);
    }
    res.json(dbItems);
  });

  // TikTok 封面代理：服务端取 oEmbed 缩略图（避开 CORS），仅内存缓存、不入库；失败返回 thumbnailUrl=null。
  const oembedCache = new Map<
    string,
    { thumbnailUrl: string | null; title?: string; authorName?: string; at: number }
  >();
  app.get('/api/reference-videos/oembed', async (req, res) => {
    const url = ctx.readText(req.query.url);
    if (!url || !/^https?:\/\/(www\.)?tiktok\.com\//i.test(url)) {
      return ctx.sendJsonError(res, 400, '需要合法的 tiktok url');
    }
    const cached = oembedCache.get(url);
    if (cached && Date.now() - cached.at < 6 * 3600 * 1000) {
      return res.json({ thumbnailUrl: cached.thumbnailUrl, title: cached.title, authorName: cached.authorName });
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`oembed HTTP ${response.status}`);
      const payload = (await response.json()) as { thumbnail_url?: string; title?: string; author_name?: string };
      const entry = {
        thumbnailUrl: typeof payload.thumbnail_url === 'string' ? payload.thumbnail_url : null,
        title: payload.title,
        authorName: payload.author_name,
        at: Date.now(),
      };
      oembedCache.set(url, entry);
      res.json({ thumbnailUrl: entry.thumbnailUrl, title: entry.title, authorName: entry.authorName });
    } catch {
      oembedCache.set(url, { thumbnailUrl: null, at: Date.now() });
      res.json({ thumbnailUrl: null });
    }
  });

  app.get('/api/reference-videos/search', async (req, res) => {
    const q = ctx.readText(req.query.q);
    if (!q) return ctx.sendJsonError(res, 400, '需要 q 查询词');
    const limit = ctx.clamp(Number(req.query.k || req.query.limit || 12), 1, 50);
    const category = ctx.readText(req.query.category) || undefined;
    const dataset = ctx.readText(req.query.dataset) || undefined;
    const trafficType = ctx.readText(req.query.trafficType) || undefined;
    const winnerType = ctx.readText(req.query.winnerType) as 'organic' | 'paid' | 'lowFollower' | undefined;

    try {
      if (!vectorSearchEnabled()) {
        const terms = q
          .toLowerCase()
          .split(/\s+/)
          .map((term) => term.trim())
          .filter(Boolean);
        const rows = await listReferenceVideos().catch(() => []);
        const results = rows
          .map((item) => {
            const row = item as typeof item & { metadata?: unknown };
            const text = JSON.stringify({
              sourceDeclaration: row.sourceDeclaration,
              breakdownReport: row.breakdownReport,
              metadata: row.metadata,
            }).toLowerCase();
            const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
            return { ...row, score: score || 0.5, vectorScore: 0 };
          })
          .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
          .slice(0, limit);
        res.json({
          query: q,
          mode: 'reference-db-keyword-fallback',
          ownerType: 'reference',
          embeddingModel: 'disabled',
          results,
        });
        return;
      }
      const queryVector = await embedText(q);
      const searchInput = {
        queryVector,
        embeddingModel: REFERENCE_TEXT_EMBEDDING_MODEL,
        limit,
        category,
        dataset,
        trafficType,
        winnerType,
        q: ctx.readText(req.query.keyword) || undefined,
      };
      const results = await searchReferenceQdrant(searchInput);
      res.json({
        query: q,
        mode: 'reference-qdrant-jina-clip-v2',
        ownerType: 'reference',
        embeddingModel: REFERENCE_TEXT_EMBEDDING_MODEL,
        results,
      });
    } catch (error) {
      ctx.sendJsonError(res, 503, `Qdrant 参考视频检索不可用: ${ctx.safeExternalError(error)}`);
    }
  });

  app.delete('/api/reference-videos/:id', async (req, res) => {
    const record = ctx.referenceVideos.get(req.params.id);
    if (!record) {
      const dbRecord = await deleteReferenceVideo(req.params.id).catch(() => null);
      if (!dbRecord) return ctx.sendJsonError(res, 404, '参考视频不存在或已删除');
      return res.json({ deleted: true, id: req.params.id });
    }
    ctx.referenceVideos.delete(record.id);
    if (record.localVideoUrl?.startsWith('/reference-videos/')) {
      removeLocalPath(path.join(dirs.publicDir, record.localVideoUrl.replace(/^\//, '')));
    }
    ctx.persistRuntimeStore();
    deleteReferenceVideo(record.id).catch(() => undefined);
    res.json({ deleted: true, id: record.id });
  });

  app.post('/api/reference-videos/import', (req, res) => {
    const input = Array.isArray(req.body?.videos) ? req.body.videos : Array.isArray(req.body) ? req.body : [];
    if (!input.length) return ctx.sendJsonError(res, 400, '需要 videos 数组');

    const imported: ReferenceVideo[] = [];
    const skipped: Array<{ sourceUrl?: string; reason: string }> = [];
    for (const item of input) {
      const sourceUrl = String(item?.sourceUrl || '').trim();
      if (!sourceUrl) {
        skipped.push({ reason: '缺少 sourceUrl' });
        continue;
      }
      if ([...ctx.referenceVideos.values()].some((video) => video.sourceUrl === sourceUrl)) {
        skipped.push({ sourceUrl, reason: '已存在' });
        continue;
      }

      const referenceVideo: ReferenceVideo = {
        id: String(item?.id || `ref_${uuid().slice(0, 10)}`),
        sourceUrl,
        localVideoUrl: ctx.readText(item?.localVideoUrl) || undefined,
        sourceDeclaration: String(
          item?.sourceDeclaration || '公开视频来源，已保存来源声明；用于比赛演示中的参考拆解与素材说明。',
        ),
        licenseType: ctx.readText(item?.licenseType, 'public_reference'),
        usageScope:
          item?.usageScope === 'creative' || item?.usageScope === 'analysis_and_creative'
            ? item.usageScope
            : 'analysis',
        breakdownReport:
          item?.breakdownReport && typeof item.breakdownReport === 'object'
            ? item.breakdownReport
            : {
                title: String(item?.title || '爆款带货视频拆解'),
                hook: String(item?.hook || '前三秒明确痛点或利益点。'),
                sellingPoints: Array.isArray(item?.sellingPoints) ? item.sellingPoints : [],
                shots: [],
                style: String(item?.style || '短视频带货拆解'),
              },
      };
      const normalizedReference = ctx.normalizeReferenceProvenance(referenceVideo);
      ctx.referenceVideos.set(normalizedReference.id, normalizedReference);
      imported.push(normalizedReference);
      upsertReferenceVideo({
        id: normalizedReference.id,
        sourceUrl: normalizedReference.sourceUrl,
        localVideoUrl: normalizedReference.localVideoUrl,
        sourceDeclaration: normalizedReference.sourceDeclaration,
        licenseType: normalizedReference.licenseType,
        usageScope: normalizedReference.usageScope,
        breakdownReport: normalizedReference.breakdownReport as Record<string, unknown>,
      }).catch(() => undefined);
    }

    if (imported.length) ctx.persistRuntimeStore();
    res.status(201).json({ imported: imported.length, skipped, videos: imported });
  });
}
