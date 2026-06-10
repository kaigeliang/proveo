import type { Express, Request, Response } from 'express';
import {
  cascadeTrustNodeStale,
  getPrisma,
  getTrustSubgraph,
  listTrustNodes,
  type TrustTraversalDirection,
} from '@aigc-video-hub/db';
import { derivePassportFromDag } from '../trust-dag';
import { sendApiError } from '../http/api-error';

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readDepth(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(12, Math.floor(parsed))) : 8;
}

function readDirection(value: unknown): TrustTraversalDirection {
  return value === 'dependents' || value === 'both' ? value : 'dependencies';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'unknown';
}

async function serveDagPassport(req: Request, res: Response) {
  try {
    const derived = await derivePassportFromDag(req.params.videoId);
    if (!derived) {
      sendApiError(res, 404, 'no traceable TrustDAG passport for this videoId');
      return;
    }
    res.json({
      ...derived.passport,
      dag: {
        rootId: derived.rootId,
        anchoredNodes: derived.graph.nodes.length,
        anchoredEdges: derived.graph.edges.length,
        staleNodeIds: derived.staleNodeIds,
      },
    });
  } catch (error) {
    sendApiError(res, 503, errorMessage(error));
  }
}

export function registerTrustDagRoutes(app: Express) {
  app.get('/api/trust-dag/passport/:videoId', (req, res) => {
    void serveDagPassport(req, res);
  });

  app.get('/api/trust-dag/nodes', async (req, res) => {
    const rootId = readText(req.query.rootId);
    try {
      if (rootId) {
        res.json(await getTrustSubgraph(rootId, readDepth(req.query.maxDepth), readDirection(req.query.direction)));
        return;
      }

      const status = req.query.status === 'active' || req.query.status === 'stale' ? req.query.status : undefined;
      const nodes = await listTrustNodes({
        productId: readText(req.query.productId) || undefined,
        scriptId: readText(req.query.scriptId) || undefined,
        nodeType: readText(req.query.nodeType) || undefined,
        status,
      });
      const nodeIds = nodes.map((node) => node.id);
      const edges = nodeIds.length
        ? await getPrisma().trustEdge.findMany({
            where: { OR: [{ sourceId: { in: nodeIds } }, { targetId: { in: nodeIds } }] },
          })
        : [];
      res.json({ nodes, edges });
    } catch (error) {
      sendApiError(res, 503, errorMessage(error));
    }
  });

  app.get('/api/trust-dag/nodes/:nodeId/dependents', async (req, res) => {
    try {
      res.json(await getTrustSubgraph(req.params.nodeId, readDepth(req.query.maxDepth), 'dependents'));
    } catch (error) {
      sendApiError(res, 503, errorMessage(error));
    }
  });

  app.post('/api/trust-dag/nodes/:nodeId/stale', async (req, res) => {
    const reason = readText(req.body?.reason) || 'source evidence invalidated';
    try {
      const root = await getPrisma().trustNode.findUnique({ where: { id: req.params.nodeId } });
      if (!root) {
        sendApiError(res, 404, 'trust node not found');
        return;
      }
      const nodes = await cascadeTrustNodeStale(root.id, reason);
      res.json({
        rootId: root.id,
        reason,
        staleNodes: nodes,
        affectedByType: nodes.reduce<Record<string, number>>((summary, node) => {
          summary[node.nodeType] = (summary[node.nodeType] || 0) + 1;
          return summary;
        }, {}),
      });
    } catch (error) {
      sendApiError(res, 503, errorMessage(error));
    }
  });
}
