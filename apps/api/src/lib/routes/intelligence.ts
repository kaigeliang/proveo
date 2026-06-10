import type { Express } from 'express';
import {
  getFastMossIntelligenceStatus,
  listCreativePerformances,
  listProductReviewInsights,
  listProductVocInsights,
  listVideoSceneTruths,
} from '@aigc-video-hub/db';
import { sendApiError } from '../http/api-error';

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readLimit(value: unknown, fallback = 50) {
  const number = readNumber(value) || fallback;
  return Math.max(1, Math.min(500, Math.floor(number)));
}

function safeError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function registerIntelligenceRoutes(app: Express) {
  app.get('/api/intelligence/status', async (_req, res) => {
    try {
      res.json(await getFastMossIntelligenceStatus());
    } catch (error) {
      sendApiError(res, 503, safeError(error, 'FastMoss intelligence status unavailable'));
    }
  });

  app.get('/api/intelligence/voc', async (req, res) => {
    try {
      const insights = await listProductVocInsights({
        source: readText(req.query.source),
        platform: readText(req.query.platform),
        productTitle: readText(req.query.productTitle || req.query.q),
        category: readText(req.query.category),
        limit: readLimit(req.query.limit || req.query.k),
      });
      res.json({ insights });
    } catch (error) {
      sendApiError(res, 503, safeError(error, 'VOC insights unavailable'));
    }
  });

  app.get('/api/intelligence/reviews', async (req, res) => {
    try {
      const reviews = await listProductReviewInsights({
        source: readText(req.query.source),
        platform: readText(req.query.platform),
        productTitle: readText(req.query.productTitle || req.query.q),
        sentiment: readText(req.query.sentiment),
        minRating: readNumber(req.query.minRating),
        limit: readLimit(req.query.limit || req.query.k, 100),
      });
      res.json({ reviews });
    } catch (error) {
      sendApiError(res, 503, safeError(error, 'Review insights unavailable'));
    }
  });

  app.get('/api/intelligence/creatives', async (req, res) => {
    try {
      const creatives = await listCreativePerformances({
        source: readText(req.query.source),
        platform: readText(req.query.platform),
        productTitle: readText(req.query.productTitle || req.query.q),
        country: readText(req.query.country),
        category: readText(req.query.category),
        rankType: readText(req.query.rankType),
        minRoas: readNumber(req.query.minRoas),
        minSales: readNumber(req.query.minSales),
        limit: readLimit(req.query.limit || req.query.k, 100),
      });
      res.json({ creatives });
    } catch (error) {
      sendApiError(res, 503, safeError(error, 'Creative performance unavailable'));
    }
  });

  app.get('/api/intelligence/scenes', async (req, res) => {
    try {
      const scenes = await listVideoSceneTruths({
        source: readText(req.query.source),
        referenceVideoId: readText(req.query.referenceVideoId),
        creativePerformanceId: readText(req.query.creativePerformanceId),
        videoUrl: readText(req.query.videoUrl),
        limit: readLimit(req.query.limit || req.query.k, 100),
      });
      res.json({ scenes });
    } catch (error) {
      sendApiError(res, 503, safeError(error, 'Video scene truth unavailable'));
    }
  });
}
