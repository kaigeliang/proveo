// TrustLoop QA & Repair Agent
// 在视频生成后反查 Claim-Evidence 链与 Policy，输出可修复的 issue 列表

import { v4 as uuid } from 'uuid';
import type { AgentTrace, Claim, Evidence, PolicyLevel, Script, Shot } from '../../../../../packages/shared/types';
import { scanText, POLICY_RULES_V2 } from './policy';

export type IssueKind =
  | 'unsupported_claim' // claim 引用的 evidenceIds 全部失效或不存在
  | 'unbound_narration' // shot.narration 有内容但 shot.claimIds 为空
  | 'policy_violation' // 命中 block / warn / needs_evidence 规则
  | 'forbidden_material_ref' // 最终成片禁止绑定素材切片
  | 'duration_overflow'; // 单镜或总时长超限

export type RepairAction = 'rewrite_narration' | 'replace_claim' | 'remove_shot' | 'trim_duration';

export interface AuditIssue {
  id: string;
  target: string; // shotId 或 'script' / 'global'
  kind: IssueKind;
  risk: PolicyLevel;
  text: string; // 触发文本
  matched?: string; // 命中片段
  ruleId?: string;
  repairAction: RepairAction;
  suggestedFix?: string;
}

export interface AuditResult {
  issues: AuditIssue[];
  metrics: {
    totalShots: number;
    boundShots: number;
    realMaterialShots: number;
    claimsTotal: number;
    claimsApproved: number;
    claimsBlocked: number;
    blockIssues: number;
    warnIssues: number;
    needsEvidenceIssues: number;
  };
  trace: AgentTrace;
}

function issueId(): string {
  return `issue_${uuid().slice(0, 6)}`;
}

function traceId(): string {
  return `trace_${uuid().slice(0, 8)}`;
}

// 给 IssueKind 选默认 repairAction
function defaultRepair(kind: IssueKind): RepairAction {
  switch (kind) {
    case 'unsupported_claim':
      return 'replace_claim';
    case 'unbound_narration':
      return 'rewrite_narration';
    case 'policy_violation':
      return 'rewrite_narration';
    case 'forbidden_material_ref':
      return 'rewrite_narration';
    case 'duration_overflow':
      return 'trim_duration';
  }
}

export interface AuditInput {
  taskId: string;
  script: Script;
  claims: Claim[];
  evidence: Evidence[];
  options?: {
    requireBindingAllShots?: boolean; // 默认 true
    maxShotDuration?: number; // 默认 6
    maxTotalDuration?: number; // 默认 15
  };
}

export function auditScript(input: AuditInput): AuditResult {
  const startedAt = new Date().toISOString();
  const requireBinding = input.options?.requireBindingAllShots ?? true;
  const maxShotDuration = input.options?.maxShotDuration ?? 6;
  const maxTotalDuration = input.options?.maxTotalDuration ?? 15;

  const evidenceMap = new Map(input.evidence.map((e) => [e.id, e]));
  const claimMap = new Map(input.claims.map((c) => [c.id, c]));

  const issues: AuditIssue[] = [];

  // 1) 每个 shot：检查绑定 / policy / 素材 / 时长
  let boundShots = 0;
  let realMaterialShots = 0;

  for (const shot of input.script.shots) {
    // 1a) claim 绑定校验
    if (requireBinding && shot.narration.trim() && (!shot.claimIds || shot.claimIds.length === 0)) {
      issues.push({
        id: issueId(),
        target: shot.id,
        kind: 'unbound_narration',
        risk: 'needs_evidence',
        text: shot.narration,
        repairAction: defaultRepair('unbound_narration'),
        suggestedFix: '为该 shot 绑定至少一个 approved claim 或改写为通用展示文案。',
      });
    } else if (shot.claimIds && shot.claimIds.length > 0) {
      boundShots += 1;
      // 1b) claim 引用的 evidenceIds 是否存在
      for (const cid of shot.claimIds) {
        const claim = claimMap.get(cid);
        if (!claim) {
          issues.push({
            id: issueId(),
            target: shot.id,
            kind: 'unsupported_claim',
            risk: 'block',
            text: shot.narration,
            ruleId: cid,
            repairAction: 'replace_claim',
            suggestedFix: `claim ${cid} 不存在，需要替换。`,
          });
          continue;
        }
        if (claim.status === 'blocked') {
          issues.push({
            id: issueId(),
            target: shot.id,
            kind: 'unsupported_claim',
            risk: 'block',
            text: claim.text,
            ruleId: cid,
            repairAction: 'replace_claim',
            suggestedFix: `claim 已被 Policy Agent 拒绝：${claim.policyHits?.[0]?.reason || '违反合规'}`,
          });
          continue;
        }
        const validEvidence = claim.evidenceIds.filter((id) => evidenceMap.has(id));
        if (validEvidence.length === 0 && claim.status === 'needs_evidence') {
          issues.push({
            id: issueId(),
            target: shot.id,
            kind: 'unsupported_claim',
            risk: 'needs_evidence',
            text: claim.text,
            ruleId: cid,
            repairAction: 'replace_claim',
            suggestedFix: '该 claim 无可追溯 evidence，建议替换或补充证据。',
          });
        }
      }
    }

    // 1c) policy 扫描
    const combinedText = [shot.narration, shot.subtitle, shot.visualDesc].filter(Boolean).join(' ');
    for (const hit of scanText(combinedText, POLICY_RULES_V2)) {
      issues.push({
        id: issueId(),
        target: shot.id,
        kind: 'policy_violation',
        risk: hit.rule.level,
        text: combinedText,
        matched: hit.match,
        ruleId: hit.rule.id,
        repairAction: defaultRepair('policy_violation'),
        suggestedFix: hit.rule.suggestion,
      });
    }

    // 1d) 禁止素材切片直接进入成片
    if (shot.materialRef) {
      realMaterialShots += 1;
      issues.push({
        id: issueId(),
        target: shot.id,
        kind: 'forbidden_material_ref',
        risk: 'block',
        text: shot.materialRef,
        repairAction: defaultRepair('forbidden_material_ref'),
        suggestedFix: '清空 materialRef，并只把素材切片作为 Seedance 生成参考。',
      });
    }

    // 1e) 单镜时长
    if (shot.duration > maxShotDuration) {
      issues.push({
        id: issueId(),
        target: shot.id,
        kind: 'duration_overflow',
        risk: 'warn',
        text: `单镜时长 ${shot.duration}s`,
        repairAction: 'trim_duration',
        suggestedFix: `压缩到 ${maxShotDuration}s 以内。`,
      });
    }
  }

  // 2) 总时长
  const totalDuration = input.script.shots.reduce((sum, s) => sum + s.duration, 0);
  if (totalDuration > maxTotalDuration) {
    issues.push({
      id: issueId(),
      target: 'script',
      kind: 'duration_overflow',
      risk: 'block',
      text: `总时长 ${totalDuration}s`,
      repairAction: 'trim_duration',
      suggestedFix: `总时长必须 ≤ ${maxTotalDuration}s`,
    });
  }

  // 3) global policy（脚本级别）
  const globalText = [input.script.narrative, input.script.visualStyle, input.script.bgm].filter(Boolean).join(' ');
  for (const hit of scanText(globalText, POLICY_RULES_V2)) {
    issues.push({
      id: issueId(),
      target: 'global',
      kind: 'policy_violation',
      risk: hit.rule.level,
      text: globalText,
      matched: hit.match,
      ruleId: hit.rule.id,
      repairAction: 'rewrite_narration',
      suggestedFix: hit.rule.suggestion,
    });
  }

  const claimsApproved = input.claims.filter((c) => c.status === 'approved').length;
  const claimsBlocked = input.claims.filter((c) => c.status === 'blocked').length;

  const blockIssues = issues.filter((i) => i.risk === 'block').length;
  const warnIssues = issues.filter((i) => i.risk === 'warn').length;
  const needsEvidenceIssues = issues.filter((i) => i.risk === 'needs_evidence').length;

  const trace: AgentTrace = {
    id: traceId(),
    taskId: input.taskId,
    agent: 'qa',
    step: 'audit_script',
    inputRefs: [input.script.id, ...input.claims.map((c) => c.id)],
    outputRefs: issues.map((i) => i.id),
    decision: `审计完成：${issues.length} 个 issue（block ${blockIssues} / warn ${warnIssues} / needs_evidence ${needsEvidenceIssues}）`,
    reason: `binding ${boundShots}/${input.script.shots.length}，forbidden_material_ref ${realMaterialShots}/${input.script.shots.length}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: blockIssues > 0 ? 'fallback' : 'ok',
  };

  return {
    issues,
    metrics: {
      totalShots: input.script.shots.length,
      boundShots,
      realMaterialShots,
      claimsTotal: input.claims.length,
      claimsApproved,
      claimsBlocked,
      blockIssues,
      warnIssues,
      needsEvidenceIssues,
    },
    trace,
  };
}

// repairShot 把"重跑单镜"抽象成回调，让 spec-runtime 注入实际生成逻辑
// 这样 qa.ts 不依赖 spec-runtime 内部的 rankSlicesForQuery / runAgentGraph
export interface RepairContext {
  taskId: string;
  script: Script;
  issue: AuditIssue;
  claims: Claim[];
  evidence: Evidence[];
}

export interface RepairExecutors {
  rewriteNarration: (shot: Shot, ctx: RepairContext) => Promise<{ narration: string; subtitle: string }>;
  replaceClaim: (shot: Shot, ctx: RepairContext) => Promise<{ claimIds: string[] }>;
  trimDuration: (shot: Shot, ctx: RepairContext) => Promise<{ duration: number }>;
  removeShot: (shot: Shot, ctx: RepairContext) => Promise<void>;
}

export async function repairShot(
  ctx: RepairContext,
  executors: RepairExecutors,
): Promise<{ shot?: Shot; removed: boolean; trace: AgentTrace }> {
  const startedAt = new Date().toISOString();
  const targetShot = ctx.script.shots.find((s) => s.id === ctx.issue.target);

  if (!targetShot) {
    return {
      removed: false,
      trace: {
        id: traceId(),
        taskId: ctx.taskId,
        agent: 'qa',
        step: 'repair_shot',
        inputRefs: [ctx.issue.id],
        outputRefs: [],
        decision: 'skip',
        reason: `shot ${ctx.issue.target} 不存在`,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'fallback',
      },
    };
  }

  let removed = false;
  let summary = '';
  try {
    switch (ctx.issue.repairAction) {
      case 'rewrite_narration': {
        const { narration, subtitle } = await executors.rewriteNarration(targetShot, ctx);
        targetShot.narration = narration;
        targetShot.subtitle = subtitle;
        summary = `改写台词：${narration.slice(0, 30)}...`;
        break;
      }
      case 'replace_claim': {
        const { claimIds } = await executors.replaceClaim(targetShot, ctx);
        targetShot.claimIds = claimIds;
        summary = `替换 claim：${claimIds.join(',')}`;
        break;
      }
      case 'trim_duration': {
        const { duration } = await executors.trimDuration(targetShot, ctx);
        targetShot.duration = duration;
        summary = `压缩时长到 ${duration}s`;
        break;
      }
      case 'remove_shot': {
        await executors.removeShot(targetShot, ctx);
        removed = true;
        summary = '移除分镜';
        break;
      }
    }
  } catch (err) {
    return {
      shot: targetShot,
      removed: false,
      trace: {
        id: traceId(),
        taskId: ctx.taskId,
        agent: 'qa',
        step: 'repair_shot',
        inputRefs: [ctx.issue.id, targetShot.id],
        outputRefs: [],
        decision: 'failed',
        reason: err instanceof Error ? err.message : 'unknown',
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'error',
        errorMessage: err instanceof Error ? err.message : undefined,
      },
    };
  }

  return {
    shot: targetShot,
    removed,
    trace: {
      id: traceId(),
      taskId: ctx.taskId,
      agent: 'qa',
      step: 'repair_shot',
      inputRefs: [ctx.issue.id, targetShot.id],
      outputRefs: [targetShot.id],
      decision: summary,
      reason: `${ctx.issue.kind} → ${ctx.issue.repairAction}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'ok',
    },
  };
}
