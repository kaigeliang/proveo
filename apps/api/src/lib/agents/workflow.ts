import type { AgentTrace } from '@aigc-video-hub/shared';
import { getMastraProductionWorkflowRuntimeSummary } from '@aigc-video-hub/agent-runtime';

export type AgentWorkflowStageId =
  | 'chat_route'
  | 'research'
  | 'policy'
  | 'creative'
  | 'editing_graph'
  | 'production'
  | 'qa'
  | 'passport';

export type AgentWorkflowStatus = 'idle' | 'running' | 'completed' | 'failed' | 'skipped';

export type AgentWorkflowAgent = AgentTrace['agent'] | 'router' | 'passport';

export interface AgentWorkflowStageContract {
  id: AgentWorkflowStageId;
  agent: AgentWorkflowAgent;
  title: string;
  responsibility: string;
  inputs: string[];
  outputs: string[];
  fallback: string;
  traceStep: string;
  blocksOnFailure: boolean;
}

export interface AgentWorkflowStageSnapshot extends AgentWorkflowStageContract {
  status: AgentWorkflowStatus;
  startedAt?: string;
  finishedAt?: string;
  inputRefs: string[];
  outputRefs: string[];
  decision?: string;
  reason?: string;
  errorMessage?: string;
}

export interface AgentWorkflowSnapshot {
  workflowId: string;
  taskId: string;
  productId?: string;
  scriptId?: string;
  videoId?: string;
  status: AgentWorkflowStatus;
  currentStage?: AgentWorkflowStageId;
  stages: AgentWorkflowStageSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export const AGENT_WORKFLOW_BLUEPRINT: AgentWorkflowStageContract[] = [
  {
    id: 'chat_route',
    agent: 'router',
    title: 'Chat Route Agent',
    responsibility: '判断用户消息是普通问答、可信调研生成、快速预览生成，还是需要联网搜索。',
    inputs: ['userMessage', 'recentHistory', 'messageFeedbacks'],
    outputs: ['routeAction', 'productTitle', 'productId', 'searchQuery'],
    fallback: '路由模型失败时使用本地 heuristic，避免普通问候误触发生成。',
    traceStep: 'chat_route',
    blocksOnFailure: false,
  },
  {
    id: 'research',
    agent: 'research',
    title: 'Research & Evidence Agent',
    responsibility: '聚合上传素材、商品页、公开信息和评论测评，生成 evidence ledger；web_search 仅在该层发生。',
    inputs: ['product', 'productUrl', 'uploadedSlices', 'researchCache', 'TRUSTLOOP_WEB_SEARCH'],
    outputs: ['evidence[]', 'rawClaims[]', 'webReviewEvidence[]', 'researchTraces[]'],
    fallback: '优先读取 cache；外部搜索不可用时退回本地素材、商品页和 fixture。',
    traceStep: 'research.run',
    blocksOnFailure: false,
  },
  {
    id: 'policy',
    agent: 'policy',
    title: 'Policy Agent',
    responsibility: '用 block / warn / needs_evidence 三层规则过滤 claim 与脚本文案。',
    inputs: ['rawClaims[]', 'evidenceMap', 'policyRules'],
    outputs: ['approvedClaims[]', 'blockedClaims[]', 'policyHits[]'],
    fallback: 'needs_evidence 进入风险提示；block 命中立即停止后续生成。',
    traceStep: 'policy.validate_claims',
    blocksOnFailure: true,
  },
  {
    id: 'creative',
    agent: 'creative',
    title: 'Creative Script Agent',
    responsibility: '只使用 approved claim 与检索上下文生成爆款结构化分镜，不直接联网绕过证据链。',
    inputs: ['approvedClaims[]', 'retrievalContext', 'webReviewEvidence[]', 'template', 'freePrompt'],
    outputs: ['script', 'shots[]', 'claimBindings[]'],
    fallback: '模型失败时使用本地模板，并继续保留 claim/evidence 约束。',
    traceStep: 'script.generate',
    blocksOnFailure: true,
  },
  {
    id: 'editing_graph',
    agent: 'production',
    title: 'Smart Editing Agent Graph',
    responsibility: '执行素材选择、复用判断、节奏规划、转场规划和渲染前自检。',
    inputs: ['script', 'materials', 'slices', 'factorWeights'],
    outputs: ['orderedShots[]', 'reuseDecisions[]', 'transitionPlan[]'],
    fallback: '图执行异常时回退到默认镜头顺序和默认转场。',
    traceStep: 'editing_graph.plan',
    blocksOnFailure: false,
  },
  {
    id: 'production',
    agent: 'production',
    title: 'Production Agent',
    responsibility: '调用 Seedance 生成镜头资产，并合成可预览视频。',
    inputs: ['orderedShots[]', 'referenceImageUrl', 'renderProvider', 'exportOptions'],
    outputs: ['shotAssets[]', 'videoUrl', 'renderTrace[]'],
    fallback: 'Seedance 生成或合成失败时标记失败并暴露原因，不生成本地替代成片。',
    traceStep: 'production.render',
    blocksOnFailure: true,
  },
  {
    id: 'qa',
    agent: 'qa',
    title: 'QA & Repair Agent',
    responsibility: '反查 claim-evidence 链、合规规则、素材绑定和时长约束。',
    inputs: ['script', 'claims[]', 'evidence[]', 'renderedAssets[]'],
    outputs: ['auditIssues[]', 'auditMetrics', 'repairActions[]'],
    fallback: '证据不足时保留 policy 与时长检查，并明确标注缺口。',
    traceStep: 'qa.audit_script',
    blocksOnFailure: false,
  },
  {
    id: 'passport',
    agent: 'passport',
    title: 'Video Passport Agent',
    responsibility: '汇总证据覆盖、真实素材占比、claim 通过率和 policy 风险。',
    inputs: ['script', 'claims[]', 'evidence[]', 'auditMetrics', 'repairLog[]'],
    outputs: ['videoPassport'],
    fallback: '缺少 audit 时不阻塞导出，并标记 passport unavailable。',
    traceStep: 'passport.compute',
    blocksOnFailure: false,
  },
];

export type MastraWorkflowPrimitive = 'step' | 'branch' | 'parallel' | 'suspend' | 'dispatch';

export interface MastraWorkflowNodeContract {
  id: string;
  primitive: MastraWorkflowPrimitive;
  title: string;
  responsibility: string;
  mapsToStage?: AgentWorkflowStageId;
  inputs: string[];
  outputs: string[];
  resumeLabel?: string;
  dispatchTarget?: 'BullMQ:aigc.agent' | 'BullMQ:aigc.script' | 'BullMQ:aigc.render';
  uiPhase:
    | 'needs_input'
    | 'researching_product'
    | 'generating_script'
    | 'awaiting_storyboard_confirmation'
    | 'generating_video'
    | 'completed'
    | 'failed';
}

export interface MastraWorkflowEdgeContract {
  from: string;
  to: string;
  when?: string;
}

export interface MastraWorkflowPlan {
  id: string;
  version: string;
  runtime: '@mastra/core Workflow';
  executionLayer: 'BullMQ + Postgres + Worker';
  nodes: MastraWorkflowNodeContract[];
  edges: MastraWorkflowEdgeContract[];
  hitl: {
    suspendNode: string;
    resumeRoute: string;
    approvalText: string;
  };
  invariants: string[];
}

export const MASTRA_WORKFLOW_PLAN: MastraWorkflowPlan = {
  id: 'proveo-tiktok-video-production',
  version: 'mastra-workflow-v1',
  runtime: '@mastra/core Workflow',
  executionLayer: 'BullMQ + Postgres + Worker',
  nodes: [
    {
      id: 'requirements.confirm',
      primitive: 'branch',
      title: '需求确认',
      responsibility: '检查商品资料、目标平台、素材和成片授权；信息不足时只产生补充问题。',
      mapsToStage: 'chat_route',
      inputs: ['messages', 'attachments', 'activeRun', 'scriptContext'],
      outputs: ['briefAssessment', 'workflowDecision', 'missing[]'],
      uiPhase: 'needs_input',
    },
    {
      id: 'research.parallel',
      primitive: 'parallel',
      title: '并行调研',
      responsibility: '并行执行商品页抓取、当前商品素材检查、爆款参考检索和合规预检。',
      mapsToStage: 'research',
      inputs: ['briefAssessment', 'productUrl', 'productId', 'referenceImageUrl'],
      outputs: ['evidence[]', 'materialContext', 'referenceContext', 'policyHints[]'],
      uiPhase: 'researching_product',
    },
    {
      id: 'script.compose',
      primitive: 'step',
      title: '剧本生成',
      responsibility: '基于证据、爆款配方和商品资料生成 TikTok Shop US 带货脚本。',
      mapsToStage: 'creative',
      inputs: ['evidence[]', 'referenceContext', 'policyHints[]', 'briefAssessment'],
      outputs: ['scriptDraft'],
      dispatchTarget: 'BullMQ:aigc.script',
      uiPhase: 'generating_script',
    },
    {
      id: 'storyboard.compose',
      primitive: 'step',
      title: '分镜生成',
      responsibility: '把脚本拆为 Seedance 可生成的分镜、字幕和旁白，不绑定 materialRef。',
      mapsToStage: 'editing_graph',
      inputs: ['scriptDraft', 'materialContext', 'referenceContext'],
      outputs: ['storyboard', 'renderPlan'],
      uiPhase: 'generating_script',
    },
    {
      id: 'storyboard.approval',
      primitive: 'suspend',
      title: '用户确认分镜',
      responsibility: '暂停等待商家确认、修改或补素材；resume 后只继续被确认的路径。',
      mapsToStage: 'editing_graph',
      inputs: ['storyboard', 'renderPlan'],
      outputs: ['approval', 'resumeInput'],
      resumeLabel: '确认出片 / 修改分镜 / 补充素材',
      uiPhase: 'awaiting_storyboard_confirmation',
    },
    {
      id: 'render.dispatch',
      primitive: 'dispatch',
      title: 'Seedance 成片派发',
      responsibility: '用户确认后派发 render_full AgentRun；真实生成仍由 BullMQ Worker 执行。',
      mapsToStage: 'production',
      inputs: ['approval', 'scriptId', 'referenceImageUrl', 'exportOptions'],
      outputs: ['agentRun', 'task'],
      dispatchTarget: 'BullMQ:aigc.agent',
      uiPhase: 'generating_video',
    },
    {
      id: 'qa.passport',
      primitive: 'step',
      title: '质检与交付',
      responsibility: '成片后做合规、证据接地、materialRef 禁用检查和 Passport 汇总。',
      mapsToStage: 'qa',
      inputs: ['videoAsset', 'script', 'claims[]', 'evidence[]'],
      outputs: ['qaReport', 'videoPassport'],
      uiPhase: 'completed',
    },
  ],
  edges: [
    { from: 'requirements.confirm', to: 'research.parallel', when: 'brief.readyForScript=true' },
    { from: 'requirements.confirm', to: 'storyboard.approval', when: 'brief.missing.length>0' },
    { from: 'research.parallel', to: 'script.compose' },
    { from: 'script.compose', to: 'storyboard.compose' },
    { from: 'storyboard.compose', to: 'storyboard.approval' },
    { from: 'storyboard.approval', to: 'script.compose', when: 'resume.action=revise_script' },
    { from: 'storyboard.approval', to: 'render.dispatch', when: 'resume.action=confirm_render' },
    { from: 'render.dispatch', to: 'qa.passport' },
  ],
  hitl: {
    suspendNode: 'storyboard.approval',
    resumeRoute: 'POST /api/agent-runs/:runId/resume',
    approvalText: '等待你确认分镜',
  },
  invariants: [
    'Mastra 节点只负责决策、分支、暂停/恢复和派发，不直接执行 Seedance 或 FFmpeg。',
    'Postgres 保存 AgentRun/Task/Script/Passport 持久状态，Redis/BullMQ 保存持久队列。',
    '商家端只消费 AgentUiStreamEvent，不展示 workflowDecision、decisionReason、runId、taskId 或模型名。',
    '公开视频和参考视频只作为配方/结构参考，不进入当前商品素材混剪池。',
  ],
};

function nowIso() {
  return new Date().toISOString();
}

function stageIndex(id: AgentWorkflowStageId) {
  return AGENT_WORKFLOW_BLUEPRINT.findIndex((stage) => stage.id === id);
}

function toInitialStage(stage: AgentWorkflowStageContract): AgentWorkflowStageSnapshot {
  return {
    ...stage,
    status: 'idle',
    inputRefs: [],
    outputRefs: [],
  };
}

export function createAgentWorkflowSnapshot(input: {
  workflowId: string;
  taskId: string;
  productId?: string;
  scriptId?: string;
  videoId?: string;
}): AgentWorkflowSnapshot {
  const createdAt = nowIso();
  return {
    ...input,
    status: 'idle',
    stages: AGENT_WORKFLOW_BLUEPRINT.map(toInitialStage),
    createdAt,
    updatedAt: createdAt,
  };
}

export function markWorkflowStage(
  workflow: AgentWorkflowSnapshot,
  stageId: AgentWorkflowStageId,
  patch: {
    status: AgentWorkflowStatus;
    inputRefs?: string[];
    outputRefs?: string[];
    decision?: string;
    reason?: string;
    errorMessage?: string;
  },
): AgentWorkflowSnapshot {
  const updatedAt = nowIso();
  const index = stageIndex(stageId);
  if (index < 0) return { ...workflow, updatedAt };

  const stages = workflow.stages.map((stage, idx) => {
    if (idx < index && stage.status === 'idle') {
      return { ...stage, status: 'skipped' as const };
    }
    if (idx !== index) return stage;
    return {
      ...stage,
      ...patch,
      startedAt: stage.startedAt || updatedAt,
      finishedAt: patch.status === 'running' ? undefined : updatedAt,
      inputRefs: patch.inputRefs || stage.inputRefs,
      outputRefs: patch.outputRefs || stage.outputRefs,
    };
  });

  const blockingFailure = stages.find((stage) => stage.status === 'failed' && stage.blocksOnFailure);
  const allTerminal = stages.every((stage) => ['completed', 'failed', 'skipped'].includes(stage.status));
  const nextRunning = stages.find((stage) => stage.status === 'running');
  const nextIdle = stages.find((stage) => stage.status === 'idle');

  return {
    ...workflow,
    status: blockingFailure ? 'failed' : allTerminal ? 'completed' : 'running',
    currentStage: blockingFailure?.id || nextRunning?.id || nextIdle?.id,
    stages,
    updatedAt,
  };
}

export function traceFromWorkflowStage(input: {
  taskId: string;
  stage: AgentWorkflowStageSnapshot;
  agent?: AgentTrace['agent'];
}): AgentTrace {
  if (input.stage.status === 'idle' || input.stage.status === 'running') {
    throw new Error(`Cannot create a trace for unfinished stage: ${input.stage.id}`);
  }

  const fallbackAgent: AgentTrace['agent'] =
    input.stage.agent === 'router' || input.stage.agent === 'passport' ? 'production' : input.stage.agent;
  return {
    id: `trace_${input.stage.id}_${Date.now().toString(36)}`,
    taskId: input.taskId,
    agent: input.agent || fallbackAgent,
    step: input.stage.traceStep,
    inputRefs: input.stage.inputRefs,
    outputRefs: input.stage.outputRefs,
    decision: input.stage.decision || input.stage.title,
    reason: input.stage.reason || input.stage.responsibility,
    startedAt: input.stage.startedAt || nowIso(),
    finishedAt: input.stage.finishedAt || nowIso(),
    status: input.stage.status === 'failed' ? 'error' : input.stage.status === 'skipped' ? 'fallback' : 'ok',
    errorMessage: input.stage.errorMessage,
  };
}

export function summarizeAgentWorkflowBlueprint() {
  return {
    version: 'agent-workflow-v1',
    stages: AGENT_WORKFLOW_BLUEPRINT,
    mastra: MASTRA_WORKFLOW_PLAN,
    mastraRuntime: getMastraProductionWorkflowRuntimeSummary(),
    guarantees: [
      '每个 Agent 声明输入、输出、fallback 和是否阻塞主流程。',
      '只有终态 stage 会映射为 AgentTrace，避免把执行中任务记录为成功。',
      '阻塞阶段失败时 workflow 固定停留在失败节点。',
      'Research / Policy / QA / Passport 形成可核查的可信闭环。',
    ],
  };
}

// ─── 3-Agent 视图 ─────────────────────────────────────────────────────────────
// 对外展示的工程架构是 Researcher / Composer / Auditor 三个 Agent
// 每个 Agent 内部包含若干 sub-steps（对应 8-stage blueprint）

export type ThreeAgentId = 'researcher' | 'composer' | 'auditor';

export interface ThreeAgentContract {
  id: ThreeAgentId;
  name: string;
  role: string;
  subSteps: AgentWorkflowStageId[];
  blocksOnFailure: boolean;
  inputs: string[];
  outputs: string[];
  fallback: string;
}

export const THREE_AGENT_BLUEPRINT: ThreeAgentContract[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    role: '信息采集与可信声明生成',
    subSteps: ['chat_route', 'research', 'policy'],
    blocksOnFailure: false,
    inputs: ['userMessage', 'productUrl', 'uploadedMaterials', 'webSearchEnabled'],
    outputs: ['evidence[]', 'approvedClaims[]', 'blockedClaims[]', 'researchTraces[]'],
    fallback: '外部搜索不可用时退回本地素材和商品页；policy block 时挂起后续生成。',
  },
  {
    id: 'composer',
    name: 'Composer',
    role: '分镜创作与渲染生产',
    subSteps: ['creative', 'editing_graph', 'production'],
    blocksOnFailure: true,
    inputs: ['approvedClaims[]', 'retrievalContext', 'materials[]', 'renderProvider'],
    outputs: ['script', 'shots[]', 'videoUrl', 'renderTrace[]'],
    fallback: 'LLM 不可用时用本地模板；Seedance 或 FFmpeg 失败时任务失败并暴露原因。',
  },
  {
    id: 'auditor',
    name: 'Auditor',
    role: '质量审计与可信护照',
    subSteps: ['qa', 'passport'],
    blocksOnFailure: false,
    inputs: ['script', 'claims[]', 'evidence[]', 'renderedAssets[]'],
    outputs: ['auditIssues[]', 'repairActions[]', 'videoPassport'],
    fallback: '证据不足时保留合规和时长检查；passport 缺失时不阻塞导出。',
  },
];

export interface ThreeAgentStageSnapshot extends ThreeAgentContract {
  status: AgentWorkflowStatus;
  startedAt?: string;
  finishedAt?: string;
  subStepSnapshots: AgentWorkflowStageSnapshot[];
  errorMessage?: string;
}

export interface ThreeAgentWorkflowSnapshot {
  workflowId: string;
  taskId: string;
  productId?: string;
  scriptId?: string;
  status: AgentWorkflowStatus;
  currentAgent?: ThreeAgentId;
  agents: ThreeAgentStageSnapshot[];
  createdAt: string;
  updatedAt: string;
}

/** 从 8-stage snapshot 推导 3-agent 视图（只读，无需数据库） */
export function deriveThreeAgentSnapshot(workflow: AgentWorkflowSnapshot): ThreeAgentWorkflowSnapshot {
  const stageMap = new Map(workflow.stages.map((s) => [s.id, s]));
  const now = new Date().toISOString();

  const agents: ThreeAgentStageSnapshot[] = THREE_AGENT_BLUEPRINT.map((blueprint) => {
    const subSnaps = blueprint.subSteps
      .map((id) => stageMap.get(id))
      .filter((s): s is AgentWorkflowStageSnapshot => Boolean(s));

    const hasRunning = subSnaps.some((s) => s.status === 'running');
    const hasFailed = subSnaps.some((s) => s.status === 'failed');
    const allDone = subSnaps.every((s) => ['completed', 'skipped', 'failed'].includes(s.status));

    const status: AgentWorkflowStatus = hasFailed ? 'failed' : hasRunning ? 'running' : allDone ? 'completed' : 'idle';
    const startedAt = subSnaps.find((s) => s.startedAt)?.startedAt;
    const finishedAt = allDone
      ? (subSnaps
          .map((s) => s.finishedAt)
          .filter(Boolean)
          .sort()
          .pop() ?? now)
      : undefined;

    return {
      ...blueprint,
      status,
      startedAt,
      finishedAt,
      subStepSnapshots: subSnaps,
      errorMessage: subSnaps.find((s) => s.errorMessage)?.errorMessage,
    };
  });

  const currentAgent = agents.find((a) => a.status === 'running')?.id ?? agents.find((a) => a.status === 'idle')?.id;

  return {
    workflowId: workflow.workflowId,
    taskId: workflow.taskId,
    productId: workflow.productId,
    scriptId: workflow.scriptId,
    status: workflow.status,
    currentAgent,
    agents,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}
