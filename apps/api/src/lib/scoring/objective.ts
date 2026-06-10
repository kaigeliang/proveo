import type { Script } from '@aigc-video-hub/shared';

export interface ObjectiveMetricCheck {
  id: 'duration' | 'evidence' | 'materials' | 'pacing' | 'transitions' | 'compliance';
  label: string;
  value: number;
  score: number;
  target: string;
  passed: boolean;
  detail: string;
}

export interface ObjectiveMetrics {
  totalDuration: number;
  evidenceCoverage: number;
  materialCoverage: number;
  pacingScore: number;
  transitionCoverage: number;
  complianceScore: number;
  normalized: number;
  composite: number;
  passed: boolean;
  failures: string[];
  checks: ObjectiveMetricCheck[];
}

export interface ObjectiveOptions {
  maxDuration?: number;
  minEvidenceCoverage?: number;
  minMaterialCoverage?: number;
}

export const SENSITIVE_MARKETING_TERMS = [
  '第一',
  '最好',
  '最强',
  '唯一',
  '治愈',
  '治疗',
  '根治',
  '彻底解决',
  '无效退款',
  '包治',
  '保证效果',
  '绝对',
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, precision = 4): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

export function findSensitiveMarketingTerms(script: Script): string[] {
  const text = [
    script.narrative,
    script.visualStyle,
    ...script.constraints,
    ...script.shots.flatMap((shot) => [shot.narration, shot.subtitle, shot.visualDesc]),
  ].join(' ');
  return SENSITIVE_MARKETING_TERMS.filter((term) => text.includes(term));
}

/**
 * Deterministic, no-provider metrics suitable for QA records and tournament ranking.
 * The metrics assess observable structure only; evidence validity remains the QA agent's job.
 */
export function evaluateObjectiveMetrics(script: Script, options: ObjectiveOptions = {}): ObjectiveMetrics {
  const maxDuration = options.maxDuration ?? 15;
  const minEvidenceCoverage = options.minEvidenceCoverage ?? 0.5;
  const shots = script.shots;
  const totalDuration = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const narratedShots = shots.filter((shot) => shot.narration.trim().length > 0);
  const evidenceBoundShots = narratedShots.filter(
    (shot) => (shot.claimIds?.length ?? 0) > 0 || (shot.evidenceIds?.length ?? 0) > 0,
  );
  const materialShots = shots.filter((shot) => Boolean(shot.materialRef));
  const generationOnlyCoverage = shots.length > 0 ? (shots.length - materialShots.length) / shots.length : 1;
  const pacedShots = shots.filter((shot) => shot.duration >= 1 && shot.duration <= 5);
  const transitions = shots.slice(0, -1).filter((shot) => Boolean(shot.transition));
  const sensitiveTerms = findSensitiveMarketingTerms(script);

  const durationScore = totalDuration > 0 ? clamp01(maxDuration / totalDuration) : 0;
  const evidenceCoverage =
    narratedShots.length > 0 ? evidenceBoundShots.length / narratedShots.length : shots.length > 0 ? 1 : 0;
  const pacingScore = shots.length > 0 ? pacedShots.length / shots.length : 0;
  const transitionCoverage = shots.length <= 1 ? 1 : transitions.length / (shots.length - 1);
  const complianceScore = sensitiveTerms.length === 0 ? 1 : 0;

  const checks: ObjectiveMetricCheck[] = [
    {
      id: 'duration',
      label: '15 秒时长约束',
      value: totalDuration,
      score: durationScore,
      target: `0 < duration <= ${maxDuration}s`,
      passed: totalDuration > 0 && totalDuration <= maxDuration,
      detail: `总时长 ${totalDuration}s`,
    },
    {
      id: 'evidence',
      label: '叙述证据覆盖',
      value: evidenceCoverage,
      score: clamp01(evidenceCoverage / minEvidenceCoverage),
      target: `>= ${Math.round(minEvidenceCoverage * 100)}%`,
      passed: evidenceCoverage >= minEvidenceCoverage,
      detail: `${evidenceBoundShots.length}/${narratedShots.length || 0} 个有旁白镜头绑定 claim/evidence`,
    },
    {
      id: 'materials',
      label: 'Seedance 生成纯度',
      value: generationOnlyCoverage,
      score: generationOnlyCoverage,
      target: '0 个镜头绑定 materialRef',
      passed: materialShots.length === 0,
      detail: `${materialShots.length}/${shots.length || 0} 个镜头仍绑定素材切片`,
    },
    {
      id: 'pacing',
      label: '单镜节奏',
      value: pacingScore,
      score: pacingScore,
      target: '每镜 1-5s',
      passed: pacingScore === 1,
      detail: `${pacedShots.length}/${shots.length || 0} 个镜头处于合理时长`,
    },
    {
      id: 'transitions',
      label: '转场标注覆盖',
      value: transitionCoverage,
      score: transitionCoverage,
      target: '>= 50%',
      passed: transitionCoverage >= 0.5,
      detail: `${transitions.length}/${Math.max(0, shots.length - 1)} 个镜头边界有转场`,
    },
    {
      id: 'compliance',
      label: '确定性敏感词预检',
      value: complianceScore,
      score: complianceScore,
      target: '无高风险宣传词',
      passed: complianceScore === 1,
      detail: sensitiveTerms.length === 0 ? '未命中高风险宣传词' : `命中: ${sensitiveTerms.join(', ')}`,
    },
  ];

  const weights: Record<ObjectiveMetricCheck['id'], number> = {
    duration: 0.2,
    evidence: 0.25,
    materials: 0.15,
    pacing: 0.15,
    transitions: 0.05,
    compliance: 0.2,
  };
  const normalized = checks.reduce((sum, check) => sum + check.score * weights[check.id], 0);
  const criticalChecks = new Set<ObjectiveMetricCheck['id']>(['duration', 'evidence', 'compliance']);
  const failures = checks.filter((check) => !check.passed).map((check) => `${check.label}: ${check.detail}`);

  return {
    totalDuration,
    evidenceCoverage: round(evidenceCoverage),
    materialCoverage: round(generationOnlyCoverage),
    pacingScore: round(pacingScore),
    transitionCoverage: round(transitionCoverage),
    complianceScore,
    normalized: round(normalized),
    composite: round(normalized * 15, 3),
    passed: checks.filter((check) => criticalChecks.has(check.id)).every((check) => check.passed),
    failures,
    checks,
  };
}
