import crypto from 'crypto';
import {
  createTrustEdge,
  findLatestTrustScriptNode,
  getPassport,
  getTrustSubgraph,
  upsertTrustNode,
} from '@aigc-video-hub/db';
import type { Claim, Evidence, Script, Shot, VideoPassport } from '@aigc-video-hub/shared';

export type TrustNodeType = 'evidence' | 'claim' | 'shot' | 'script' | 'video';

type TrustContext = {
  runId?: string;
  taskId?: string;
  productId?: string;
  scriptId?: string;
};

type DagGraph = Awaited<ReturnType<typeof getTrustSubgraph>>;
type DagNode = DagGraph['nodes'][number];

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function computeNodeHash(content: unknown, parentIds: string[]): string {
  const payload = JSON.stringify({
    content: canonicalValue(content),
    parents: [...parentIds].sort(),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function upsertNode(
  nodeType: TrustNodeType,
  content: unknown,
  parentIds: string[],
  ctx: TrustContext,
): Promise<string> {
  const hash = computeNodeHash(content, parentIds);
  await upsertTrustNode({
    id: hash,
    contentHash: hash,
    nodeType,
    parentIds: [...parentIds].sort(),
    payload: record(content),
    runId: ctx.runId,
    taskId: ctx.taskId,
    productId: ctx.productId,
    scriptId: ctx.scriptId,
  });
  return hash;
}

export async function anchorEvidence(evidence: Evidence, ctx: TrustContext): Promise<string> {
  return upsertNode('evidence', evidence, [], ctx);
}

export async function anchorClaim(claim: Claim, evidenceHashes: string[], ctx: TrustContext): Promise<string> {
  const hash = await upsertNode('claim', claim, evidenceHashes, ctx);
  await Promise.all(
    evidenceHashes.map((evidenceId) => createTrustEdge({ sourceId: hash, targetId: evidenceId, edgeType: 'supports' })),
  );
  return hash;
}

export async function anchorShot(shot: Shot, claimHashes: string[], ctx: TrustContext): Promise<string> {
  const hash = await upsertNode('shot', shot, claimHashes, ctx);
  await Promise.all(
    claimHashes.map((claimId) => createTrustEdge({ sourceId: hash, targetId: claimId, edgeType: 'uses' })),
  );
  return hash;
}

export async function anchorScript(script: Script, shotHashes: string[], ctx: TrustContext): Promise<string> {
  const content = {
    id: script.id,
    productId: script.productId,
    narrative: script.narrative,
    shotCount: script.shots.length,
  };
  const hash = await upsertNode('script', content, shotHashes, { ...ctx, scriptId: script.id });
  await Promise.all(
    shotHashes.map((shotId) => createTrustEdge({ sourceId: hash, targetId: shotId, edgeType: 'derives' })),
  );
  return hash;
}

export async function anchorVideo(videoId: string, scriptHash: string, ctx: TrustContext): Promise<string> {
  const hash = await upsertNode('video', { videoId }, [scriptHash], ctx);
  await createTrustEdge({ sourceId: hash, targetId: scriptHash, edgeType: 'derives' });
  return hash;
}

function active(nodes: DagNode[]) {
  return nodes.filter((node) => node.status === 'active');
}

function countEvidenceBySource(evidence: DagNode[]) {
  const counts = new Map<Evidence['sourceType'], number>();
  for (const node of evidence) {
    const sourceType = record(node.payload).sourceType as Evidence['sourceType'] | undefined;
    if (sourceType) counts.set(sourceType, (counts.get(sourceType) || 0) + 1);
  }
  return [...counts.entries()].map(([sourceType, count]) => ({ sourceType, count }));
}

/**
 * Builds a passport by walking script -> shot -> claim -> evidence edges.
 * It returns null until a traceable claim/evidence chain exists, allowing the
 * legacy persisted passport handler to remain the fallback for old exports.
 */
export async function derivePassportFromDag(videoId: string): Promise<{
  passport: VideoPassport & { source: 'trust-dag' };
  graph: DagGraph;
  rootId: string;
  staleNodeIds: string[];
} | null> {
  const storedPassport = await getPassport(videoId);
  if (!storedPassport) return null;
  const root = await findLatestTrustScriptNode(storedPassport.scriptId);
  if (!root) return null;

  const graph = await getTrustSubgraph(root.id, 8, 'dependencies');
  const evidence = graph.nodes.filter((node) => node.nodeType === 'evidence');
  const claims = graph.nodes.filter((node) => node.nodeType === 'claim');
  if (!evidence.length || !claims.length) return null;

  const shots = graph.nodes.filter((node) => node.nodeType === 'shot');
  const activeEvidenceIds = new Set(active(evidence).map((node) => node.id));
  const claimEvidenceEdges = graph.edges.filter((edge) => edge.edgeType === 'supports');
  const approvedClaims = claims.filter((node) => record(node.payload).status === 'approved');
  const blockedClaims = claims.filter((node) => record(node.payload).status === 'blocked');
  const needsEvidenceClaims = claims.filter((node) => record(node.payload).status === 'needs_evidence');
  const backedClaims = approvedClaims.filter((claim) =>
    claimEvidenceEdges.some((edge) => edge.sourceId === claim.id && activeEvidenceIds.has(edge.targetId)),
  );
  const evidenceCoverage = approvedClaims.length ? backedClaims.length / approvedClaims.length : 0;
  const materialShots = active(shots).filter((node) => Boolean(record(node.payload).materialRef)).length;
  const realMaterialRatio = shots.length ? materialShots / shots.length : storedPassport.realMaterialRatio;
  const seedanceOnlyRatio = 1 - realMaterialRatio;
  const staleNodeIds = graph.nodes.filter((node) => node.status === 'stale').map((node) => node.id);
  const policyRisk: VideoPassport['policyRisk'] =
    staleNodeIds.length || blockedClaims.length ? 'high' : needsEvidenceClaims.length > 2 ? 'medium' : 'low';
  const riskFactor = policyRisk === 'low' ? 1 : policyRisk === 'medium' ? 0.5 : 0;
  const trustScore = Math.round(
    40 * evidenceCoverage +
      30 * seedanceOnlyRatio -
      20 * (backedClaims.length / Math.max(claims.length, 1)) +
      10 * riskFactor,
  );

  return {
    passport: {
      videoId,
      scriptId: storedPassport.scriptId,
      trustScore,
      evidenceCoverage: Number(evidenceCoverage.toFixed(3)),
      realMaterialRatio: Number(realMaterialRatio.toFixed(3)),
      approvedClaims: approvedClaims.length,
      needsEvidenceClaims: needsEvidenceClaims.length,
      blockedClaims: blockedClaims.length,
      repairedClaims: storedPassport.repairedClaims,
      policyRisk,
      iterationCount: storedPassport.iterationCount,
      evidenceBreakdown: countEvidenceBySource(active(evidence)),
      generatedAt: new Date().toISOString(),
      source: 'trust-dag',
    },
    graph,
    rootId: root.id,
    staleNodeIds,
  };
}
