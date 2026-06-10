import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleDot, GitBranch, Loader2, ShieldCheck, Sparkles } from 'lucide-react';

export type AgentWorkflowStageId =
  | 'chat_route'
  | 'research'
  | 'policy'
  | 'creative'
  | 'editing_graph'
  | 'production'
  | 'qa'
  | 'passport';

type AgentWorkflowAgent = 'router' | 'research' | 'policy' | 'creative' | 'production' | 'qa' | 'passport';

interface AgentWorkflowStageContract {
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

interface AgentWorkflowResponse {
  ok: boolean;
  generatedAt: string;
  version: string;
  stages: AgentWorkflowStageContract[];
  guarantees: string[];
}

interface AgentRunStep {
  id: string;
  nodeId: string;
  agentName: string;
  status: string;
  decision?: string | null;
  reason?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  toolCalls?: AgentRunToolCall[];
}

interface AgentRunToolCall {
  id: string;
  toolName: string;
  status: string;
  latencyMs?: number | null;
  error?: string | null;
}

interface AgentRunArtifact {
  id: string;
  type: string;
  createdAt: string;
}

interface AgentRunRecord {
  id: string;
  taskId?: string | null;
  kind: string;
  status: string;
  graphVersion: string;
  steps?: AgentRunStep[];
  artifacts?: AgentRunArtifact[];
  output?: {
    result?: {
      waitingFor?: {
        fields?: string[];
        message?: string;
      };
      scriptId?: string;
      videoUrl?: string;
    };
  } | null;
  updatedAt?: string;
}

const defaultStages: AgentWorkflowStageContract[] = [
  {
    id: 'chat_route',
    agent: 'router',
    title: 'Chat Route Agent',
    responsibility: '识别用户请求并决定是否启动生成链路。',
    inputs: ['userMessage', 'recentHistory', 'messageFeedbacks'],
    outputs: ['routeAction', 'productTitle', 'productId'],
    fallback: '模型失败时使用本地 heuristic。',
    traceStep: 'chat_route',
    blocksOnFailure: false,
  },
  {
    id: 'research',
    agent: 'research',
    title: 'Research & Evidence Agent',
    responsibility: '聚合素材、商品页、公开信息和评论测评，形成 evidence ledger；web_search 只在该层发生。',
    inputs: ['product', 'productUrl', 'uploadedSlices', 'researchCache', 'TRUSTLOOP_WEB_SEARCH'],
    outputs: ['evidence[]', 'rawClaims[]', 'webReviewEvidence[]', 'researchTraces[]'],
    fallback: '搜索不可用时读取 cache、商品页与已有素材。',
    traceStep: 'research.run',
    blocksOnFailure: false,
  },
  {
    id: 'policy',
    agent: 'policy',
    title: 'Policy Agent',
    responsibility: '过滤未经证据支持或命中风险规则的 claim。',
    inputs: ['rawClaims[]', 'evidenceMap', 'policyRules'],
    outputs: ['approvedClaims[]', 'blockedClaims[]', 'policyHits[]'],
    fallback: 'block 命中时终止后续生成。',
    traceStep: 'policy.validate_claims',
    blocksOnFailure: true,
  },
  {
    id: 'creative',
    agent: 'creative',
    title: 'Creative Script Agent',
    responsibility: '从 approved claims 和检索上下文生成爆款结构化分镜，不直接联网绕过证据链。',
    inputs: ['approvedClaims[]', 'retrievalContext', 'webReviewEvidence[]', 'template'],
    outputs: ['script', 'shots[]', 'claimBindings[]'],
    fallback: '模型失败时使用本地模板，并保留 claim/evidence 约束。',
    traceStep: 'script.generate',
    blocksOnFailure: true,
  },
  {
    id: 'editing_graph',
    agent: 'production',
    title: 'Smart Editing Agent Graph',
    responsibility: '规划素材选择、镜头节奏与转场策略。',
    inputs: ['script', 'materials', 'slices', 'factorWeights'],
    outputs: ['orderedShots[]', 'reuseDecisions[]', 'transitionPlan[]'],
    fallback: '异常时回退默认镜头顺序。',
    traceStep: 'editing_graph.plan',
    blocksOnFailure: false,
  },
  {
    id: 'production',
    agent: 'production',
    title: 'Production Agent',
    responsibility: '生成镜头资产并合成可预览视频。',
    inputs: ['orderedShots[]', 'renderProvider', 'exportOptions'],
    outputs: ['shotAssets[]', 'videoUrl', 'renderTrace[]'],
    fallback: '云端失败时生成本地预览。',
    traceStep: 'production.render',
    blocksOnFailure: true,
  },
  {
    id: 'qa',
    agent: 'qa',
    title: 'QA & Repair Agent',
    responsibility: '反查 claim-evidence 链并提出修复动作。',
    inputs: ['script', 'claims[]', 'evidence[]', 'renderedAssets[]'],
    outputs: ['auditIssues[]', 'auditMetrics', 'repairActions[]'],
    fallback: '保留 policy 与时长检查。',
    traceStep: 'qa.audit_script',
    blocksOnFailure: false,
  },
  {
    id: 'passport',
    agent: 'passport',
    title: 'Video Passport Agent',
    responsibility: '生成证据覆盖与风险透明报告。',
    inputs: ['script', 'claims[]', 'auditMetrics', 'repairLog[]'],
    outputs: ['videoPassport'],
    fallback: 'audit 缺失时标记不可用。',
    traceStep: 'passport.compute',
    blocksOnFailure: false,
  },
];

const THREE_AGENT_CARDS = [
  {
    id: 'researcher',
    name: 'Researcher',
    role: '信息采集与可信声明生成',
    icon: '🔍',
    subSteps: ['chat_route', 'research', 'policy'],
    inputs: ['productUrl', 'uploadedMaterials', 'webSearch'],
    outputs: ['evidence[]', 'approvedClaims[]', 'blockedClaims[]'],
    fallback: '外部搜索不可用时退回本地素材；policy block 时挂起生成。',
  },
  {
    id: 'composer',
    name: 'Composer',
    role: '分镜创作与渲染生产',
    icon: '🎬',
    subSteps: ['creative', 'editing_graph', 'production'],
    inputs: ['approvedClaims[]', 'retrievalContext', 'materials[]'],
    outputs: ['script', 'shots[]', 'videoUrl'],
    fallback: 'LLM 不可用时用本地模板；渲染失败时生成本地预览结果。',
  },
  {
    id: 'auditor',
    name: 'Auditor',
    role: '质量审计与可信护照',
    icon: '🛡️',
    subSteps: ['qa', 'passport'],
    inputs: ['script', 'claims[]', 'evidence[]'],
    outputs: ['auditIssues[]', 'repairActions[]', 'videoPassport'],
    fallback: '证据不足时保留合规和时长检查；passport 不阻塞导出。',
  },
];

const defaultGuarantees = [
  '每个 Agent 声明输入、输出、fallback 和是否阻塞主流程。',
  '只有终态 stage 会进入 AgentTrace，运行中状态不会被误报成功。',
  '阻塞阶段失败时 workflow 停留在失败节点。',
  'Research / Policy / QA / Passport 形成可核查的可信闭环。',
];

function compactList(items: string[]) {
  return items.slice(0, 3).join(' · ') + (items.length > 3 ? ` +${items.length - 3}` : '');
}

export default function AgentWorkflowPanel({ apiBase = '/api' }: { apiBase?: string }) {
  const [data, setData] = useState<AgentWorkflowResponse | null>(null);
  const [recentRuns, setRecentRuns] = useState<AgentRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<AgentWorkflowStageId | null>('research');
  const [resumeProductId, setResumeProductId] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [viewMode, setViewMode] = useState<'3-agent' | '8-stage'>('3-agent');

  const refreshRuns = useCallback(
    async (cancelled?: () => boolean) => {
      const response = await fetch(`${apiBase}/agent-runs?limit=5`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const runs = (await response.json()) as AgentRunRecord[];
      if (!cancelled?.()) setRecentRuns(Array.isArray(runs) ? runs : []);
    },
    [apiBase],
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/agents/workflow`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as AgentWorkflowResponse;
      })
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'workflow API unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    fetch(`${apiBase}/agent-runs?limit=5`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as AgentRunRecord[];
      })
      .then((response) => {
        if (!cancelled) setRecentRuns(Array.isArray(response) ? response : []);
      })
      .catch(() => {
        if (!cancelled) setRecentRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, refreshRuns]);

  const stages = data?.stages?.length ? data.stages : defaultStages;
  const guarantees = data?.guarantees?.length ? data.guarantees : defaultGuarantees;
  const latestRun = recentRuns[0];
  const waitingFields = latestRun?.output?.result?.waitingFor?.fields || [];
  const latestToolCallCount = latestRun?.steps?.reduce((sum, step) => sum + (step.toolCalls?.length || 0), 0) || 0;
  const canCancel = Boolean(latestRun && ['queued', 'running', 'waiting_input'].includes(latestRun.status));
  const canRetry = Boolean(latestRun && ['failed', 'cancelled'].includes(latestRun.status));
  const canResume = latestRun?.status === 'waiting_input';
  const trustedStages = useMemo(
    () => stages.filter((stage) => ['research', 'policy', 'qa', 'passport'].includes(stage.agent)).length,
    [stages],
  );

  const runAgentAction = async (action: 'cancel' | 'retry' | 'resume') => {
    if (!latestRun) return;
    setActionBusy(action);
    setActionMessage('');
    try {
      const body =
        action === 'resume'
          ? {
              input: {
                productId: resumeProductId.trim() || `manual_product_${Date.now()}`,
                provider: 'local',
                retrievalMode: 'none',
              },
            }
          : {};
      const response = await fetch(`${apiBase}/agent-runs/${latestRun.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || `HTTP ${response.status}`));
      setActionMessage(
        action === 'resume'
          ? '已补充输入并重新投递。'
          : action === 'retry'
            ? `已创建 retry run：${payload.runId || 'pending'}`
            : '已提交取消请求。',
      );
      if (action === 'resume') setResumeProductId('');
      await refreshRuns();
    } catch (reason) {
      setActionMessage(reason instanceof Error ? reason.message : 'AgentRun 操作失败');
    } finally {
      setActionBusy('');
    }
  };

  return (
    <section className="workflow-panel" aria-label="Agent Workflow Architecture">
      <header className="workflow-hero">
        <div>
          <p className="workflow-kicker">
            <GitBranch size={14} /> TrustLoop Agent Workflow
          </p>
          <h2>3-Agent trusted video generation pipeline</h2>
          <p>Researcher → Composer → Auditor，每个 Agent 持有内聚职责，通过 TrustDAG 传递证据链。</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="workflow-view-toggle">
            <button
              type="button"
              className={`view-toggle-btn${viewMode === '3-agent' ? ' active' : ''}`}
              onClick={() => setViewMode('3-agent')}
            >
              3-Agent
            </button>
            <button
              type="button"
              className={`view-toggle-btn${viewMode === '8-stage' ? ' active' : ''}`}
              onClick={() => setViewMode('8-stage')}
            >
              8-Stage
            </button>
          </div>
          <span className="workflow-version">
            {loading ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
            {data?.version || 'agent-workflow-v1'}
          </span>
        </div>
      </header>

      {error && <div className="workflow-fallback">接口暂不可用，当前展示内置蓝图：{error}</div>}

      <div className="workflow-stats">
        <span>
          <strong>{stages.length}</strong>
          Agent stages
        </span>
        <span>
          <strong>{trustedStages}</strong>
          TrustLoop stages
        </span>
        <span>
          <strong>{stages.filter((stage) => stage.blocksOnFailure).length}</strong>
          Blocking gates
        </span>
      </div>

      {viewMode === '3-agent' && (
        <div className="three-agent-grid">
          {THREE_AGENT_CARDS.map((agent) => (
            <div key={agent.id} className={`three-agent-card ${agent.id}`}>
              <div className="three-agent-card-header">
                <span className="three-agent-icon">{agent.icon}</span>
                <div>
                  <div className="three-agent-name">{agent.name}</div>
                  <div className="three-agent-role">{agent.role}</div>
                </div>
              </div>
              <div className="three-agent-substeps">
                {agent.subSteps.map((step) => (
                  <span key={step} className="three-agent-step-chip">
                    {step}
                  </span>
                ))}
              </div>
              <div className="three-agent-io">
                <div className="three-agent-section-label">输入</div>
                <div className="three-agent-io-list">{agent.inputs.slice(0, 3).join('  ·  ')}</div>
                <div className="three-agent-section-label" style={{ marginTop: 4 }}>
                  输出
                </div>
                <div className="three-agent-io-list">{agent.outputs.slice(0, 3).join('  ·  ')}</div>
              </div>
              <div className="three-agent-fallback">
                <span className="three-agent-fallback-label">降级</span>
                {agent.fallback}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="workflow-live">
        <div className="workflow-live-head">
          <p className="workflow-kicker">
            <GitBranch size={14} /> Live AgentRun
          </p>
          {latestRun ? (
            <span className={`workflow-run-status ${latestRun.status}`}>{latestRun.status}</span>
          ) : (
            <span className="workflow-run-status empty">no runs</span>
          )}
        </div>
        {latestRun ? (
          <>
            <div className="workflow-run-summary">
              <strong>{latestRun.kind}</strong>
              <span>{latestRun.graphVersion}</span>
              <span>{latestRun.steps?.length || 0} steps</span>
              <span>{latestToolCallCount} tool calls</span>
              <span>{latestRun.artifacts?.length || 0} artifacts</span>
              {latestRun.output?.result?.scriptId && <span>script {latestRun.output.result.scriptId}</span>}
            </div>
            <div className="workflow-run-controls">
              {canResume && (
                <label className="workflow-resume-field">
                  <span>
                    {latestRun.output?.result?.waitingFor?.message || `需要补充：${waitingFields.join(', ')}`}
                  </span>
                  <input
                    value={resumeProductId}
                    onChange={(event) => setResumeProductId(event.target.value)}
                    placeholder="输入 productId 后 Resume"
                  />
                </label>
              )}
              <div className="workflow-run-actions">
                {canResume && (
                  <button
                    disabled={actionBusy === 'resume'}
                    onClick={() => void runAgentAction('resume')}
                    type="button"
                  >
                    {actionBusy === 'resume' ? 'Resuming...' : 'Resume'}
                  </button>
                )}
                {canRetry && (
                  <button disabled={actionBusy === 'retry'} onClick={() => void runAgentAction('retry')} type="button">
                    {actionBusy === 'retry' ? 'Retrying...' : 'Retry'}
                  </button>
                )}
                {canCancel && (
                  <button
                    className="danger"
                    disabled={actionBusy === 'cancel'}
                    onClick={() => void runAgentAction('cancel')}
                    type="button"
                  >
                    {actionBusy === 'cancel' ? 'Cancelling...' : 'Cancel'}
                  </button>
                )}
                <button disabled={Boolean(actionBusy)} onClick={() => void refreshRuns()} type="button">
                  Refresh
                </button>
              </div>
              {actionMessage && <small className="workflow-action-message">{actionMessage}</small>}
            </div>
            <div className="workflow-run-steps">
              {(latestRun.steps || []).map((step) => (
                <div key={step.id} className={`workflow-run-step ${step.status}`}>
                  <span className="workflow-step-icon">
                    {step.status === 'failed' ? (
                      <AlertCircle size={14} />
                    ) : step.status === 'running' ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <CheckCircle2 size={14} />
                    )}
                  </span>
                  <span>
                    <strong>{step.nodeId}</strong>
                    <small>
                      {step.agentName} · {step.decision || step.status}
                    </small>
                    {(step.reason || step.error) && <em>{step.error || step.reason}</em>}
                    {Boolean(step.toolCalls?.length) && (
                      <span className="workflow-tool-calls" aria-label={`${step.nodeId} tool calls`}>
                        {step.toolCalls?.map((tool) => (
                          <span key={tool.id} className={`workflow-tool-call ${tool.status}`}>
                            {tool.toolName}
                            {typeof tool.latencyMs === 'number' ? ` · ${tool.latencyMs}ms` : ''}
                            {tool.error ? ` · ${tool.error}` : ''}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="workflow-empty-run">
            还没有真实 AgentRun。调用 <code>POST /api/agent-runs</code> 后，这里会显示 Worker 编排时间线。
          </div>
        )}
      </div>

      {viewMode === '8-stage' && (
        <div className="workflow-list">
          {stages.map((stage, index) => {
            const open = stage.id === expanded;
            const tone = stage.blocksOnFailure
              ? 'blocking'
              : ['research', 'qa', 'passport'].includes(stage.agent)
                ? 'trust'
                : '';
            return (
              <button
                className={`workflow-stage ${tone} ${open ? 'open' : ''}`}
                key={stage.id}
                onClick={() => setExpanded(open ? null : stage.id)}
                type="button"
              >
                <span className="workflow-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="workflow-dot">
                  {stage.blocksOnFailure ? <ShieldCheck size={15} /> : <CircleDot size={15} />}
                </span>
                <span className="workflow-main">
                  <strong>{stage.title}</strong>
                  <small>
                    {stage.agent} · {stage.traceStep}
                  </small>
                  <span className="workflow-description">{stage.responsibility}</span>
                  {open && (
                    <span className="workflow-details">
                      <span>
                        <b>Inputs</b> {compactList(stage.inputs)}
                      </span>
                      <span>
                        <b>Outputs</b> {compactList(stage.outputs)}
                      </span>
                      <span>
                        <b>Fallback</b> {stage.fallback}
                      </span>
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="workflow-guarantees">
        <p>
          <Sparkles size={14} /> Architecture guarantees
        </p>
        {guarantees.map((guarantee) => (
          <span key={guarantee}>{guarantee}</span>
        ))}
      </div>
    </section>
  );
}
