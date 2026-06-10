// TrustLoop Video Passport
// 视频导出时附一份「可信度报告」，是答辩三大亮点之一

import type { Claim, Evidence, Script, VideoPassport } from '../../../../../packages/shared/types';
import type { AuditResult } from './qa';

export interface PassportInput {
  videoId: string;
  script: Script;
  claims: Claim[];
  evidence: Evidence[];
  audit: AuditResult;
  iterationCount: number;
  repairLog: Array<{ shotId: string; action: string }>;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

export function computeVideoPassport(input: PassportInput): VideoPassport {
  const { script, claims, evidence, audit, iterationCount, repairLog } = input;

  // 1) evidenceCoverage：approved claim 中有 evidence 引用的占比
  const approvedClaims = claims.filter((c) => c.status === 'approved');
  const blockedClaims = claims.filter((c) => c.status === 'blocked');
  const needsEvidenceClaims = claims.filter((c) => c.status === 'needs_evidence');
  const evidenceSet = new Set(evidence.map((e) => e.id));

  const claimsWithEvidence = approvedClaims.filter(
    (c) => c.evidenceIds.length > 0 && c.evidenceIds.some((id) => evidenceSet.has(id)),
  );
  const evidenceCoverage = approvedClaims.length === 0 ? 0 : clamp01(claimsWithEvidence.length / approvedClaims.length);

  // 2) realMaterialRatio 保留为兼容字段；新边界下任何直接 materialRef 都是违规，正常值应为 0。
  const totalShots = script.shots.length;
  const realMaterialRatio = totalShots === 0 ? 0 : clamp01(audit.metrics.realMaterialShots / totalShots);

  // 3) policyRisk
  const policyRisk: VideoPassport['policyRisk'] =
    audit.metrics.blockIssues > 0
      ? 'high'
      : audit.metrics.warnIssues + audit.metrics.needsEvidenceIssues > 2
        ? 'medium'
        : 'low';

  // 4) trustScore 加权公式
  //   = 40 * evidenceCoverage
  //   + 30 * seedanceOnlyRatio
  //   + 20 * (evidence-backed approvedClaims/totalClaims)
  //   + 10 * policyRiskFactor
  const totalClaims = claims.length || 1;
  const claimsApprovedRatio = claimsWithEvidence.length / totalClaims;
  const policyRiskFactor = policyRisk === 'low' ? 1 : policyRisk === 'medium' ? 0.5 : 0;

  const seedanceOnlyRatio = 1 - realMaterialRatio;
  const trustScore = Math.round(
    40 * evidenceCoverage + 30 * seedanceOnlyRatio + 20 * claimsApprovedRatio + 10 * policyRiskFactor,
  );

  // 5) evidence 来源分布
  const breakdownMap = new Map<Evidence['sourceType'], number>();
  for (const e of evidence) {
    breakdownMap.set(e.sourceType, (breakdownMap.get(e.sourceType) || 0) + 1);
  }
  const evidenceBreakdown = [...breakdownMap.entries()].map(([sourceType, count]) => ({
    sourceType,
    count,
  }));

  return {
    videoId: input.videoId,
    scriptId: script.id,
    trustScore,
    evidenceCoverage: round(evidenceCoverage, 3),
    realMaterialRatio: round(realMaterialRatio, 3),
    approvedClaims: approvedClaims.length,
    needsEvidenceClaims: needsEvidenceClaims.length,
    blockedClaims: blockedClaims.length,
    repairedClaims: repairLog.length,
    policyRisk,
    iterationCount,
    evidenceBreakdown,
    generatedAt: new Date().toISOString(),
  };
}
