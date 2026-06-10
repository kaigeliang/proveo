import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import AppRail from '../components/AppRail';
import {
  createMagicProgressState,
  type MagicActId,
  type MagicProgressActState,
  type MagicProgressState,
} from '../generation-pipeline';
import {
  API_BASE,
  normalizeResearch,
  normalizeScript,
  type AppPage,
  type MaterialAngle,
  type RenderResult,
  type RenderVersion,
  type ResearchData,
  type SearchScope,
  type ScriptData,
  type ScriptVersion,
  type TaskStatus,
} from '../studio-types';
import {
  type ChatHistoryActivityItem,
  type ChatHistoryItem,
  type ChatHistoryMessage,
  type ChatProjectSnapshot,
  useChatHistory,
} from '../useChatHistory';
import AnalyticsPage from './AnalyticsPage';
import ChatPage from './ChatPage';
import CloneRadarPage from './CloneRadarPage';
import MaterialsPage from './MaterialsPage';
import PassportPage from './PassportPage';
import ScriptPage from './ScriptPage';
import WorkflowPage from './WorkflowPage';
import '../tokens.css';
import '../agent-workflow.css';
import '../simple.css';
import '../design-system.css';
import '../workspace.css';

const PAGE_META: Record<Exclude<AppPage, 'chat'>, { title: string; desc: string }> = {
  clone: { title: '爆款配方雷达', desc: '召回最像的真实爆款，拆出可复用的成功配方。' },
  script: { title: '制作台', desc: '在同一页编辑脚本、预览镜头、生成视频和进入交付。' },
  materials: { title: '素材库', desc: '上传或检索当前商品可用素材。' },
  passport: { title: '交付结果', desc: '预览视频、下载结果和查看可信指标。' },
  workflow: { title: '内部诊断：Agent 链路', desc: '给团队排查 API、Agent 输入输出和降级路径，普通制作时可以忽略。' },
  analytics: { title: '投放诊断', desc: '生成因子 × 转化效果看板：哪些手法更能带来成交，含 A/B 与数据来源声明。' },
};

const DEBUG_PAGES = new Set<AppPage>(['workflow']);

type BusyState = 'research' | 'script' | 'compose' | 'render' | null;

type ChatStartedAgentRun = {
  taskId: string;
  runId: string;
  kind: 'one_click_video' | 'script_generate' | 'render_full' | 'repair_shot' | 'ab_test';
  productId?: string;
  productTitle?: string;
};

function activeActState(headline: string, detail?: string): MagicProgressActState {
  return { status: 'active', headline, detail };
}

function doneActState(headline: string, detail?: string, note?: string): MagicProgressActState {
  return { status: 'done', headline, detail, note };
}

function skippedActState(headline: string, detail: string): MagicProgressActState {
  return { status: 'skipped', headline, detail };
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function parseProductInput(input: string): { title: string; productUrl?: string } {
  const value = input.trim();
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { title: url.hostname.replace(/^www\./, '') || value, productUrl: url.toString() };
    }
  } catch {
    // Plain product names are valid input.
  }
  return { title: value };
}

function researchErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown';
  if (message.startsWith('严格证据模式没有拿到可核验来源')) {
    return `${message} 当前只输入商品名时，必须拿到商品页、上传素材，或带引用 URL 的联网搜索结果，才能继续生成可审计卖点。`;
  }
  return message;
}

function isAgentRunStillExecuting(message: string) {
  return message.includes('AgentRun 仍在执行');
}

function normalizeRenderResultForMedia(result: RenderResult): RenderResult {
  const agentOutput = recordFrom(result.agentOutput);
  const passport = recordFrom(result.passport || agentOutput.passport);
  const normalized: RenderResult = {
    ...result,
    videoUrl: result.videoUrl || strFrom(agentOutput.videoUrl) || undefined,
    assetUrl: result.assetUrl || strFrom(agentOutput.assetUrl) || undefined,
    previewUrl: result.previewUrl || strFrom(agentOutput.previewUrl) || undefined,
    objectKey: result.objectKey || strFrom(agentOutput.objectKey) || undefined,
    provider: result.provider || strFrom(agentOutput.provider) || undefined,
    scriptId: result.scriptId || strFrom(agentOutput.scriptId) || undefined,
  };
  if (!normalized.passport && Object.keys(passport).length > 0) {
    normalized.passport = passport as unknown as RenderResult['passport'];
  }
  return normalized;
}

function renderMediaUrl(result: RenderResult | null | undefined) {
  return result?.videoUrl || result?.assetUrl || result?.previewUrl || '';
}

function dateStamp(time = Date.now()) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(time))
    .replace(/\//g, '-');
}

function compactProjectName(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return '未命名商品';
  return trimmed.length > 18 ? `${trimmed.slice(0, 18)}…` : trimmed;
}

function versionLabel(input: { productTitle?: string; kind: '剧本' | '成片'; index: number; createdAt?: number }) {
  return `${compactProjectName(input.productTitle)} · ${dateStamp(input.createdAt)} · ${input.kind}V${String(input.index).padStart(2, '0')}`;
}

class RenderStillProcessingError extends Error {
  task: TaskStatus | null;

  constructor(task: TaskStatus | null) {
    super('出片仍在后台渲染，请稍后查看制作进度。');
    this.name = 'RenderStillProcessingError';
    this.task = task;
  }
}

function isActiveTask(task: TaskStatus | null | undefined): task is TaskStatus {
  return Boolean(task?.status && ['queued', 'pending', 'processing', 'waiting_input'].includes(task.status));
}

async function waitForRender(taskId: string, onUpdate: (task: TaskStatus) => void): Promise<RenderResult> {
  let lastTask: TaskStatus | null = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`);
    if (!response.ok) throw new Error(`出片任务 HTTP ${response.status}`);
    const task = (await response.json()) as TaskStatus;
    lastTask = task;
    onUpdate(task);
    if (task.status === 'failed') throw new Error(task.error || '出片失败');
    if (task.status === 'completed' && task.payload) return task.payload;
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  throw new RenderStillProcessingError(lastTask);
}

type AgentRunStatusResponse = {
  id: string;
  status: string;
  output?: {
    result?: Record<string, unknown>;
  };
};

type AgentRunStep = {
  nodeId: string;
  status: string;
  decision?: string | null;
  reason?: string | null;
};

function shouldStartWithCollapsedSidebar() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strFrom(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function evidenceSamplesFrom(output: Record<string, unknown>): ResearchData['evidence'] {
  return arrayFrom(output.evidence)
    .map((item) => recordFrom(item))
    .filter((item) => strFrom(item.id) && strFrom(item.text))
    .map((item) => ({
      id: strFrom(item.id),
      sourceType: (['product', 'material', 'web', 'review', 'reference', 'policy'].includes(strFrom(item.sourceType))
        ? item.sourceType
        : 'web') as ResearchData['evidence'][number]['sourceType'],
      sourceScope: (['official', 'commerce', 'review', 'social', 'general'].includes(strFrom(item.sourceScope))
        ? item.sourceScope
        : undefined) as ResearchData['evidence'][number]['sourceScope'],
      sourceUrl: strFrom(item.sourceUrl) || undefined,
      sourceTitle: strFrom(item.sourceTitle) || undefined,
      text: strFrom(item.text),
      reliability: (['high', 'medium', 'low'].includes(strFrom(item.reliability))
        ? item.reliability
        : 'medium') as ResearchData['evidence'][number]['reliability'],
      fetchedAt: strFrom(item.fetchedAt) || new Date().toISOString(),
    }));
}

function claimSamplesFrom(output: Record<string, unknown>): ResearchData['claims'] {
  const claims = arrayFrom(output.approvedClaims).length ? output.approvedClaims : output.rawClaims;
  return arrayFrom(claims)
    .map((item) => recordFrom(item))
    .filter((item) => strFrom(item.id) && strFrom(item.text))
    .map((item) => ({
      id: strFrom(item.id),
      text: strFrom(item.text),
      category: strFrom(item.category) || undefined,
      evidenceIds: arrayFrom(item.evidenceIds).map(String).filter(Boolean),
      confidence: typeof item.confidence === 'number' ? item.confidence : 0,
      status: (['approved', 'needs_evidence', 'blocked'].includes(strFrom(item.status))
        ? item.status
        : 'approved') as ResearchData['claims'][number]['status'],
    }));
}

async function fetchScriptById(scriptId: string, productId: string): Promise<ScriptData> {
  const scriptResponse = await fetch(`${API_BASE}/scripts/${encodeURIComponent(scriptId)}`);
  if (!scriptResponse.ok) throw new Error(`剧本读取 HTTP ${scriptResponse.status}`);
  return normalizeScript((await scriptResponse.json()) as Partial<ScriptData>, productId);
}

async function fetchTaskById(taskId: string): Promise<TaskStatus> {
  const taskResponse = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`);
  if (!taskResponse.ok) throw new Error(`制作任务读取 HTTP ${taskResponse.status}`);
  return (await taskResponse.json()) as TaskStatus;
}

function workbenchDemoImage(seed: string, accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34332f"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
  </defs>
  <rect width="720" height="1280" fill="url(#bg)"/>
  <rect x="118" y="164" width="486" height="350" rx="38" fill="#fffdf8" opacity=".94"/>
  <rect x="174" y="238" width="374" height="160" rx="34" fill="${accent}" opacity=".92"/>
  <circle cx="360" cy="319" r="48" fill="#fffdf8" opacity=".88"/>
  <rect x="270" y="622" width="180" height="360" rx="46" fill="#fffdf8"/>
  <rect x="304" y="676" width="112" height="248" rx="28" fill="#111827"/>
  <path d="M250 986h220l-34 104H284z" fill="#f7f4ed"/>
  <text x="360" y="1118" text-anchor="middle" font-family="Inter, Arial" font-size="34" font-weight="700" fill="#fffdf8">${seed}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function createWorkbenchDemoState() {
  const productId = 'demo_workbench_mount';
  const productTitle = '磁吸车载手机支架宣传片';
  const now = new Date().toISOString();
  const heroImage = workbenchDemoImage('MAGNETIC MOUNT', '#129fb2');
  const closeImage = workbenchDemoImage('ONE HAND SETUP', '#0e6574');
  const proofImage = workbenchDemoImage('STABLE DRIVE', '#687e3c');
  const research = normalizeResearch(
    {
      productId,
      evidence: [
        {
          id: 'demo-evidence-1',
          sourceType: 'product',
          sourceScope: 'commerce',
          text: '磁吸结构用于单手放置手机，适合车内短时固定演示。',
          reliability: 'high',
          fetchedAt: now,
        },
        {
          id: 'demo-evidence-2',
          sourceType: 'reference',
          sourceScope: 'social',
          text: '参考爆款通常以痛点开场、近景动作和稳定性对比收束。',
          reliability: 'medium',
          fetchedAt: now,
        },
      ],
      claims: [
        {
          id: 'demo-claim-1',
          text: '单手放置，减少开车前整理手机的动作成本。',
          evidenceIds: ['demo-evidence-1'],
          confidence: 0.84,
          status: 'approved',
        },
        {
          id: 'demo-claim-2',
          text: '强磁稳定性需避免绝对化承诺，保留场景演示表达。',
          evidenceIds: ['demo-evidence-2'],
          confidence: 0.72,
          status: 'needs_evidence',
        },
      ],
      traces: [],
    },
    productId,
  );
  const script = normalizeScript(
    {
      id: 'demo_workbench_script',
      productId,
      narrative: '用真实车内痛点切入，快速展示单手吸附、角度调整和驾驶场景稳定感。',
      visualStyle: '米色系电商工具预览，干净近景，少量青色强调',
      aspectRatio: '9:16',
      language: 'zh-CN',
      shots: [
        {
          id: 'demo-shot-1',
          order: 1,
          duration: 3,
          visualDesc: '驾驶员上车后手机无处安放，镜头给到中控台和手部动作。',
          narration: '上车第一件事，手机别再到处滑。',
          subtitle: '手机别再到处滑',
          camera: '手持近景',
          status: 'done',
          assetUrl: heroImage,
        },
        {
          id: 'demo-shot-2',
          order: 2,
          duration: 3,
          visualDesc: '手机单手靠近支架，吸附后自动居中，动作保持一镜到底。',
          narration: '单手一贴，视线自然回到前方。',
          subtitle: '单手一贴',
          camera: '推近',
          status: 'done',
          assetUrl: closeImage,
        },
        {
          id: 'demo-shot-3',
          order: 3,
          duration: 3,
          visualDesc: '横竖屏角度快速切换，展示导航和短暂停车查看消息两种状态。',
          narration: '横竖都能调，导航角度更顺手。',
          subtitle: '横竖都能调',
          camera: '固定',
          status: 'draft',
        },
        {
          id: 'demo-shot-4',
          order: 4,
          duration: 3,
          visualDesc: '模拟轻微颠簸路面，画面重点放在手机稳定和支架贴合。',
          narration: '颠簸路面，也要稳稳看得见。',
          subtitle: '稳稳看得见',
          camera: '轻微跟拍',
          status: 'done',
          assetUrl: proofImage,
        },
        {
          id: 'demo-shot-5',
          order: 5,
          duration: 3,
          visualDesc: '产品定格在中控台，字幕给出购买动作，背景保持留白。',
          narration: '适合每天通勤的车载小升级。',
          subtitle: '通勤小升级',
          camera: '固定',
          status: 'draft',
        },
      ],
    },
    productId,
  );
  const selectedAngle: MaterialAngle = {
    id: 'demo-angle-front',
    materialId: 'demo-material-main',
    productId,
    view: 'front',
    key: 'front',
    label: '主图参考',
    imageUrl: heroImage,
    referenceImageUrl: heroImage,
    sourceImageUrl: heroImage,
    promptHint: 'car dashboard magnetic phone mount, clean ecommerce product shot',
    provider: 'local',
    status: 'ready',
    createdAt: now,
  };
  return { productId, productTitle, research, script, selectedAngle };
}

function createPassportDemoState() {
  const productId = 'demo_passport_mount';
  const productTitle = '磁吸车载手机支架宣传片';
  const now = new Date().toISOString();
  const videoUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4';
  const research = normalizeResearch(
    {
      productId,
      evidence: [
        {
          id: 'pe-001',
          sourceType: 'product',
          sourceScope: 'commerce',
          sourceUrl: 'https://item.jd.com/10086.html',
          sourceTitle: '京东商品页',
          text: 'N52钕磁铁，额定吸力≥80N，通过SGS实验室第三方检测。',
          reliability: 'high',
          fetchedAt: now,
        },
        {
          id: 'pe-002',
          sourceType: 'review',
          sourceScope: 'commerce',
          sourceTitle: '用户评论区（TOP20）',
          text: '1238条4.9星评价中92%提及"高速不晃落"；多名用户演示单手2秒吸附视频。',
          reliability: 'high',
          fetchedAt: now,
        },
        {
          id: 'pe-003',
          sourceType: 'reference',
          sourceScope: 'social',
          sourceTitle: 'TikTok爆款参考',
          text: 'TikTok US同类单品近30天GMV破50w美元，高互动标签#magneticmount 200M播放。',
          reliability: 'medium',
          fetchedAt: now,
        },
      ],
      claims: [
        {
          id: 'pc-001',
          text: 'N52钕磁铁吸力≥80N，SGS检测认证',
          evidenceIds: ['pe-001'],
          confidence: 0.97,
          status: 'approved',
        },
        {
          id: 'pc-002',
          text: '92%用户好评：高速行驶不晃不落',
          evidenceIds: ['pe-002'],
          confidence: 0.91,
          status: 'approved',
        },
        {
          id: 'pc-003',
          text: '单手2秒吸附，省去开车整理时间',
          evidenceIds: ['pe-001', 'pe-002'],
          confidence: 0.88,
          status: 'approved',
        },
        {
          id: 'pc-004',
          text: 'TikTok同类爆款，全球口碑认证',
          evidenceIds: ['pe-003'],
          confidence: 0.75,
          status: 'needs_evidence',
        },
      ],
      traces: [],
    },
    productId,
  );
  const passport: RenderResult['passport'] = {
    videoId: videoUrl,
    scriptId: 'demo_passport_script',
    trustScore: 82.4,
    evidenceCoverage: 0.75,
    realMaterialRatio: 1,
    blockedClaims: 0,
    needsEvidenceClaims: 1,
    policyRisk: 'low',
  };
  const renderResult: RenderResult = {
    scriptId: 'demo_passport_script',
    videoId: videoUrl,
    videoUrl,
    provider: 'seedance',
    format: 'mp4',
    passport,
  };
  const task: TaskStatus = {
    id: 'demo_passport_task',
    status: 'completed',
    progress: 100,
    step: 'agent_done',
    elapsedMs: 158000,
    elapsedText: '2m 38s',
  };
  return { productId, productTitle, research, renderResult, task };
}

export default function StudioPage() {
  const [page, setPage] = useState<AppPage>('chat');
  const [productId, setProductId] = useState('');
  const [productTitle, setProductTitle] = useState('');
  const [research, setResearch] = useState<ResearchData | null>(null);
  const [script, setScript] = useState<ScriptData | null>(null);
  const [scriptVersions, setScriptVersions] = useState<ScriptVersion[]>([]);
  const [activeScriptVersionId, setActiveScriptVersionId] = useState<string | null>(null);
  const [selectedAngle, setSelectedAngle] = useState<MaterialAngle | null>(null);
  const [task, setTask] = useState<TaskStatus | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [renderVersions, setRenderVersions] = useState<RenderVersion[]>([]);
  const [activeRenderVersionId, setActiveRenderVersionId] = useState<string | null>(null);
  const [sessionReferenceImage, setSessionReferenceImage] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [activeAgentRunId, setActiveAgentRunId] = useState<string | null>(null);
  const [activeRunKind, setActiveRunKind] = useState<ChatStartedAgentRun['kind'] | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicProgress, setMagicProgress] = useState<MagicProgressState>(() => createMagicProgressState());
  const [quickInput, setQuickInput] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(shouldStartWithCollapsedSidebar);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [restoredMessages, setRestoredMessages] = useState<ChatHistoryMessage[] | null>(null);
  const [restoredActivityItems, setRestoredActivityItems] = useState<ChatHistoryActivityItem[] | null>(null);
  const [toast, setToast] = useState<{ id: string; text: string; action?: () => void } | null>(null);
  const history = useChatHistory();
  const scriptNotifiedRef = useRef(false);
  const researchNotifiedRef = useRef(false);
  const renderNotifiedRef = useRef(false);
  const pauseRequestedRef = useRef(false);

  const clearRenderVersions = useCallback(() => {
    setRenderVersions([]);
    setActiveRenderVersionId(null);
    setRenderResult(null);
    setMagicProgress((current) => ({ ...current, renderResult: null }));
  }, []);

  const clearProjectVersions = useCallback(() => {
    setScriptVersions([]);
    setActiveScriptVersionId(null);
    clearRenderVersions();
  }, [clearRenderVersions]);

  const registerScriptVersion = useCallback(
    (nextScript: ScriptData, sourceRunId?: string) => {
      const existing = scriptVersions.find((version) => version.script.id === nextScript.id);
      const createdAt = existing?.createdAt ?? Date.now();
      const id = existing?.id || `script_version_${createdAt}_${Math.random().toString(36).slice(2, 7)}`;
      const label =
        existing?.label ||
        versionLabel({
          productTitle: productTitle || nextScript.productId,
          kind: '剧本',
          index: scriptVersions.length + 1,
          createdAt,
        });
      const version: ScriptVersion = { id, label, createdAt, script: nextScript, sourceRunId };

      setScriptVersions((current) => {
        const index = current.findIndex((item) => item.id === id || item.script.id === nextScript.id);
        if (index === -1) return [...current, version];
        const updated = [...current];
        updated[index] = {
          ...updated[index],
          script: nextScript,
          sourceRunId: sourceRunId || updated[index].sourceRunId,
        };
        return updated;
      });
      setActiveScriptVersionId(id);
      setScript(nextScript);
      return id;
    },
    [productTitle, scriptVersions],
  );

  const updateActiveScript = useCallback(
    (nextScript: ScriptData) => {
      if (!activeScriptVersionId) {
        registerScriptVersion(nextScript, activeAgentRunId || undefined);
        return;
      }
      setScript(nextScript);
      setScriptVersions((current) =>
        current.map((version) => (version.id === activeScriptVersionId ? { ...version, script: nextScript } : version)),
      );
    },
    [activeAgentRunId, activeScriptVersionId, registerScriptVersion],
  );

  const registerRenderVersion = useCallback(
    (result: RenderResult, taskId?: string) => {
      const normalized = normalizeRenderResultForMedia(result);
      if (!renderMediaUrl(normalized)) return false;
      const existingRender = taskId ? renderVersions.find((version) => version.taskId === taskId) : undefined;
      const scriptVersionId =
        existingRender?.scriptVersionId ||
        activeScriptVersionId ||
        (script ? registerScriptVersion(script, activeAgentRunId || undefined) : undefined);
      const createdAt = existingRender?.createdAt || Date.now();
      const id = existingRender?.id || `render_version_${createdAt}_${Math.random().toString(36).slice(2, 7)}`;
      setRenderVersions((current) => {
        const existingIndex = current.findIndex((item) => item.id === id || (taskId && item.taskId === taskId));
        if (existingIndex !== -1) {
          const updated = [...current];
          updated[existingIndex] = {
            ...updated[existingIndex],
            scriptVersionId,
            taskId: taskId || updated[existingIndex].taskId,
            result: normalized,
          };
          return updated;
        }
        const index = current.filter((item) => item.scriptVersionId === scriptVersionId).length + 1;
        return [
          ...current,
          {
            id,
            label: existingRender?.label || versionLabel({ productTitle, kind: '成片', index, createdAt }),
            createdAt,
            scriptVersionId,
            taskId,
            result: normalized,
          },
        ];
      });
      setActiveRenderVersionId(id);
      setRenderResult(normalized);
      setMagicProgress((current) => ({ ...current, renderResult: normalized }));
      renderNotifiedRef.current = false;
      return true;
    },
    [activeAgentRunId, activeScriptVersionId, productTitle, registerScriptVersion, renderVersions, script],
  );

  const selectRenderVersion = useCallback(
    (versionId: string) => {
      const version = renderVersions.find((item) => item.id === versionId);
      if (!version) return;
      if (version.scriptVersionId) {
        const scriptVersion = scriptVersions.find((item) => item.id === version.scriptVersionId);
        if (scriptVersion) {
          setActiveScriptVersionId(scriptVersion.id);
          setScript(scriptVersion.script);
        }
      }
      setActiveRenderVersionId(version.id);
      setRenderResult(version.result);
      setMagicProgress((current) => ({ ...current, renderResult: version.result }));
    },
    [renderVersions, scriptVersions],
  );

  const selectScriptVersion = useCallback(
    (versionId: string) => {
      const version = scriptVersions.find((item) => item.id === versionId);
      if (!version) return;
      setActiveScriptVersionId(version.id);
      setScript(version.script);
      const relatedRenders = renderVersions.filter((item) => item.scriptVersionId === version.id);
      const nextRender = relatedRenders.find((item) => item.id === activeRenderVersionId) || relatedRenders.at(-1);
      setActiveRenderVersionId(nextRender?.id || null);
      setRenderResult(nextRender?.result || null);
      setMagicProgress((current) => ({
        ...current,
        baselineScriptId: version.script.id,
        finalScriptId: version.script.id,
        renderResult: nextRender?.result || null,
      }));
    },
    [activeRenderVersionId, renderVersions, scriptVersions],
  );

  const renameScriptVersion = useCallback((versionId: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setScriptVersions((current) =>
      current.map((version) => (version.id === versionId ? { ...version, label: nextLabel } : version)),
    );
  }, []);

  const renameRenderVersion = useCallback((versionId: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setRenderVersions((current) =>
      current.map((version) => (version.id === versionId ? { ...version, label: nextLabel } : version)),
    );
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') !== 'workbench') return undefined;
    const timer = window.setTimeout(() => {
      const demo = createWorkbenchDemoState();
      setPage('script');
      setProductId(demo.productId);
      setProductTitle(demo.productTitle);
      setResearch(demo.research);
      setScript(demo.script);
      const createdAt = Date.now();
      const scriptVersionId = `script_version_${createdAt}_demo`;
      setScriptVersions([
        {
          id: scriptVersionId,
          label: versionLabel({ productTitle: demo.productTitle, kind: '剧本', index: 1, createdAt }),
          createdAt,
          script: demo.script,
        },
      ]);
      setActiveScriptVersionId(scriptVersionId);
      setSelectedAngle(demo.selectedAngle);
      setTask(null);
      clearRenderVersions();
      setBusy(null);
      setError(null);
      setMagicProgress(createMagicProgressState());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [clearRenderVersions]);

  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') !== 'passport') return undefined;
    const timer = window.setTimeout(() => {
      const demo = createPassportDemoState();
      setPage('passport');
      setProductId(demo.productId);
      setProductTitle(demo.productTitle);
      setResearch(demo.research);
      setTask(demo.task);
      setRenderResult(demo.renderResult);
      setBusy(null);
      setError(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const syncSidebarToViewport = (event: MediaQueryList | MediaQueryListEvent) => {
      setSidebarCollapsed(event.matches);
    };

    syncSidebarToViewport(media);
    media.addEventListener('change', syncSidebarToViewport);
    return () => media.removeEventListener('change', syncSidebarToViewport);
  }, []);

  const updateMagic = useCallback((patch: (current: MagicProgressState) => MagicProgressState) => {
    setMagicProgress((current) => patch(current));
  }, []);

  const updateMagicAct = useCallback(
    (actId: MagicActId, act: MagicProgressActState) => {
      updateMagic((current) => ({ ...current, acts: { ...current.acts, [actId]: act } }));
    },
    [updateMagic],
  );

  // Defer setState into the next tick so the effect body itself stays synchronization-only.
  const showToast = useCallback((text: string, action: () => void) => {
    window.setTimeout(() => {
      setToast({ id: `t_${Date.now()}`, text, action });
    }, 0);
  }, []);

  // Show toast when work completes outside the relevant page
  useEffect(() => {
    if (research && !researchNotifiedRef.current) {
      researchNotifiedRef.current = true;
      if (page !== 'chat' && page !== 'script') {
        showToast('调研完成，正在生成分镜…', () => setPage('chat'));
      }
    }
  }, [research, page, showToast]);

  useEffect(() => {
    if (script && !scriptNotifiedRef.current) {
      scriptNotifiedRef.current = true;
      if (page !== 'chat') {
        showToast('分镜脚本已就绪，点击回到对话查看', () => setPage('chat'));
      }
    }
  }, [script, page, showToast]);

  useEffect(() => {
    if (renderResult && !renderNotifiedRef.current) {
      renderNotifiedRef.current = true;
      if (page !== 'chat') {
        showToast('视频已生成，点击回到对话查看', () => setPage('chat'));
      }
    }
  }, [renderResult, page, showToast]);

  // Auto-dismiss toast after 8s
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const projectSnapshot = useMemo<ChatProjectSnapshot>(
    () => ({
      productId: productId || undefined,
      productTitle: productTitle || undefined,
      research,
      selectedAngle,
      scriptVersions,
      activeScriptVersionId,
      renderVersions,
      activeRenderVersionId,
      renderResult,
      task,
      activeAgentRunId,
      activeRunKind,
    }),
    [
      activeAgentRunId,
      activeRenderVersionId,
      activeRunKind,
      activeScriptVersionId,
      productId,
      productTitle,
      renderResult,
      renderVersions,
      research,
      scriptVersions,
      selectedAngle,
      task,
    ],
  );
  const activeHistoryItem = activeSessionId ? history.get(activeSessionId) : undefined;

  const reset = () => {
    if (activeSessionId) {
      const current = history.get(activeSessionId);
      if (current) {
        history.upsert({
          ...current,
          magicProgress,
          projectSnapshot,
          updatedAt: Date.now(),
        });
      }
    }
    setPage('chat');
    setResetKey((value) => value + 1);
    setProductId('');
    setProductTitle('');
    setResearch(null);
    setScript(null);
    setSelectedAngle(null);
    setTask(null);
    clearProjectVersions();
    setBusy(null);
    setActiveAgentRunId(null);
    setActiveRunKind(null);
    setPauseBusy(false);
    pauseRequestedRef.current = false;
    setError(null);
    setMagicProgress(createMagicProgressState());
    setQuickInput('');
    setActiveSessionId(undefined);
    setRestoredMessages(null);
    setRestoredActivityItems(null);
    setToast(null);
    scriptNotifiedRef.current = false;
    researchNotifiedRef.current = false;
    renderNotifiedRef.current = false;
  };

  const persistSession = useCallback(
    (session: Omit<ChatHistoryItem, 'createdAt' | 'updatedAt'> & { createdAt?: number }) => {
      const now = Date.now();
      history.upsert({
        ...session,
        productId: session.productId || productId || undefined,
        productTitle: session.productTitle || productTitle || undefined,
        scriptId: session.scriptId || script?.id || task?.payload?.scriptId || renderResult?.scriptId || undefined,
        taskId: session.taskId || task?.id || undefined,
        runId: session.runId || activeAgentRunId || renderResult?.agentRunId || undefined,
        magicProgress: session.magicProgress || magicProgress,
        projectSnapshot: session.projectSnapshot || projectSnapshot,
        createdAt: session.createdAt ?? now,
        updatedAt: now,
      });
      setActiveSessionId(session.id);
    },
    [activeAgentRunId, history, magicProgress, productId, productTitle, projectSnapshot, renderResult, script, task],
  );

  async function resumeRenderTaskFromSnapshot(taskId: string) {
    setBusy('render');
    setError(null);
    try {
      const result = await waitForRender(taskId, (nextTask) => {
        setTask(nextTask);
        updateMagic((current) => ({ ...current, renderTask: nextTask }));
      });
      const registered = registerRenderVersion(result, taskId);
      if (registered) {
        const normalized = normalizeRenderResultForMedia(result);
        updateMagicAct('render', doneActState('✓ 带货视频已生成', renderMediaUrl(normalized)));
      }
    } catch (renderError) {
      if (renderError instanceof RenderStillProcessingError) {
        if (renderError.task) {
          setTask(renderError.task);
          updateMagic((current) => ({ ...current, renderTask: renderError.task }));
        }
        updateMagicAct('render', activeActState('仍在后台渲染', '任务仍在处理，稍后会继续刷新结果。'));
        return;
      }
      setError(`恢复成片任务失败：${renderError instanceof Error ? renderError.message : 'render unavailable'}`);
      updateMagicAct('render', {
        status: 'error',
        headline: '恢复成片任务失败',
        detail: renderError instanceof Error ? renderError.message : 'render unavailable',
      });
    } finally {
      setBusy(null);
    }
  }

  async function resumeAgentRunFromSnapshot(input: {
    taskId: string;
    runId: string;
    productId: string;
    kind?: ChatStartedAgentRun['kind'] | null;
  }) {
    const kind = input.kind || 'script_generate';
    const stage: Exclude<BusyState, null> =
      kind === 'script_generate' ? 'compose' : kind === 'render_full' ? 'render' : 'render';
    let keepAgentRunActive = false;
    setBusy(stage);
    setActiveAgentRunId(input.runId);
    setActiveRunKind(kind);
    setError(null);
    try {
      const payload = await pollAgentRun({ ...input, kind });
      if (kind !== 'script_generate') {
        const registered = registerRenderVersion(payload, input.taskId);
        if (registered) {
          const normalized = normalizeRenderResultForMedia(payload);
          updateMagicAct('render', doneActState('✓ 带货视频已生成', renderMediaUrl(normalized)));
        }
      } else {
        updateMagicAct('compose', doneActState('✓ 剧本与分镜已生成', '可以继续修改，或确认后生成成片'));
        updateMagicAct('render', skippedActState('确认后出片', '本轮默认不消耗成片渲染额度。'));
      }
    } catch (resumeError) {
      const message = resumeError instanceof Error ? resumeError.message : 'unknown';
      if (isAgentRunStillExecuting(message)) {
        keepAgentRunActive = true;
        setError(null);
        updateMagicAct(stage, activeActState('仍在后台制作', '任务耗时较长，可稍后查看任务状态。'));
        return;
      }
      setError(`恢复制作任务失败：${researchErrorMessage(resumeError)}`);
      updateMagicAct(stage, {
        status: 'error',
        headline: stage === 'render' ? '恢复出片失败' : '恢复 Agent 链路失败',
        detail: message,
      });
    } finally {
      setBusy(null);
      if (!keepAgentRunActive) {
        setActiveAgentRunId(null);
        setActiveRunKind(null);
      }
    }
  }

  const selectSession = async (sessionId: string) => {
    const found = history.get(sessionId);
    if (!found) return;
    if (sessionId === activeSessionId) {
      setPage('chat');
      return;
    }
    if (activeSessionId) {
      const current = history.get(activeSessionId);
      if (current) {
        history.upsert({
          ...current,
          magicProgress,
          projectSnapshot,
          updatedAt: Date.now(),
        });
      }
    }
    setActiveSessionId(sessionId);
    const snapshot = found.projectSnapshot;
    setProductId(snapshot?.productId || found.productId || '');
    setProductTitle(snapshot?.productTitle || found.productTitle || '');
    setResearch(null);
    setScript(null);
    setScriptVersions([]);
    setActiveScriptVersionId(null);
    setSelectedAngle(null);
    setTask(null);
    clearRenderVersions();
    setError(null);
    setMagicProgress(found.magicProgress || createMagicProgressState());
    setQuickInput('');
    setBusy(null);
    setActiveAgentRunId(snapshot?.activeAgentRunId || null);
    setActiveRunKind(snapshot?.activeRunKind || null);
    setPauseBusy(false);
    pauseRequestedRef.current = false;
    setRestoredActivityItems(found.activityItems || null);
    setRestoredMessages(found.messages);
    setPage('chat');
    setResetKey((value) => value + 1);

    if (snapshot) {
      const versions = snapshot.scriptVersions || [];
      const activeScriptId = snapshot.activeScriptVersionId || versions.at(-1)?.id || null;
      const activeScriptVersion = versions.find((item) => item.id === activeScriptId) || versions.at(-1) || null;
      const renders = snapshot.renderVersions || [];
      const activeRenderId = snapshot.activeRenderVersionId || renders.at(-1)?.id || null;
      const activeRender = renders.find((item) => item.id === activeRenderId) || renders.at(-1) || null;
      const snapshotTask = snapshot.task || null;
      setResearch(snapshot.research || null);
      setSelectedAngle(snapshot.selectedAngle || null);
      setScriptVersions(versions);
      setActiveScriptVersionId(activeScriptVersion?.id || null);
      setScript(activeScriptVersion?.script || null);
      setRenderVersions(renders);
      setActiveRenderVersionId(activeRender?.id || null);
      setRenderResult(snapshot.renderResult || activeRender?.result || null);
      setTask(snapshotTask);
      setMagicProgress((current) => ({
        ...current,
        subject: snapshot.productTitle || found.productTitle || current.subject,
        baselineScriptId: activeScriptVersion?.script.id || current.baselineScriptId,
        finalScriptId: activeScriptVersion?.script.id || current.finalScriptId,
        renderTask: snapshotTask || current.renderTask,
        renderResult: snapshot.renderResult || activeRender?.result || current.renderResult,
      }));
      if (isActiveTask(snapshotTask)) {
        const restoreProductId =
          snapshot.productId || found.productId || activeScriptVersion?.script.productId || `restored_${sessionId}`;
        if (snapshot.activeAgentRunId) {
          void resumeAgentRunFromSnapshot({
            taskId: snapshotTask.id,
            runId: snapshot.activeAgentRunId,
            productId: restoreProductId,
            kind: snapshot.activeRunKind,
          });
        } else {
          void resumeRenderTaskFromSnapshot(snapshotTask.id);
        }
      }
      return;
    }

    const restoredProductId = found.productId || (found.scriptId ? `restored_${found.scriptId}` : '');
    const scriptPromise: Promise<ScriptData | null> =
      found.scriptId && restoredProductId ? fetchScriptById(found.scriptId, restoredProductId) : Promise.resolve(null);
    const taskPromise: Promise<TaskStatus | null> = found.taskId ? fetchTaskById(found.taskId) : Promise.resolve(null);
    const [scriptResult, taskResult] = await Promise.allSettled([scriptPromise, taskPromise] as const);
    if (scriptResult.status === 'fulfilled' && scriptResult.value) {
      const nextScript = scriptResult.value;
      setProductId(nextScript.productId);
      registerScriptVersion(nextScript, found.runId);
      setMagicProgress((current) => ({
        ...current,
        subject: found.productTitle || nextScript.productId,
        baselineScriptId: nextScript.id,
        finalScriptId: nextScript.id,
      }));
    } else if (found.scriptId && scriptResult.status === 'rejected') {
      setError(`恢复剧本分镜失败：${scriptResult.reason instanceof Error ? scriptResult.reason.message : 'unknown'}`);
    }
    if (taskResult.status === 'fulfilled' && taskResult.value) {
      const nextTask = taskResult.value;
      setTask(nextTask);
      if (found.runId && ['queued', 'pending', 'processing', 'waiting_input'].includes(nextTask.status)) {
        setActiveAgentRunId(found.runId);
      }
      if (nextTask.payload) {
        const registered = registerRenderVersion(nextTask.payload, nextTask.id);
        setMagicProgress((current) => ({
          ...current,
          renderTask: nextTask,
          renderResult: registered
            ? normalizeRenderResultForMedia(nextTask.payload as RenderResult)
            : current.renderResult,
        }));
      } else {
        setMagicProgress((current) => ({ ...current, renderTask: nextTask }));
      }
    }
  };

  async function pollAgentRun(input: {
    taskId: string;
    runId: string;
    productId: string;
    kind?: ChatStartedAgentRun['kind'];
  }): Promise<RenderResult> {
    let scriptLoaded = false;
    let lastCompletedNodes = new Set<string>();
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const [taskResponse, runResponse, stepsResponse] = await Promise.all([
        fetch(`${API_BASE}/tasks/${encodeURIComponent(input.taskId)}`),
        fetch(`${API_BASE}/agent-runs/${encodeURIComponent(input.runId)}`),
        fetch(`${API_BASE}/agent-runs/${encodeURIComponent(input.runId)}/steps`),
      ]);
      if (!taskResponse.ok) throw new Error(`Agent task HTTP ${taskResponse.status}`);
      if (!runResponse.ok) throw new Error(`AgentRun HTTP ${runResponse.status}`);
      const nextTask = (await taskResponse.json()) as TaskStatus;
      const run = (await runResponse.json()) as AgentRunStatusResponse;
      const steps = stepsResponse.ok ? ((await stepsResponse.json()) as AgentRunStep[]) : [];
      const agentOutput = recordFrom(nextTask.payload?.agentOutput || run.output?.result);
      const completedNodes = new Set(steps.filter((step) => step.status === 'completed').map((step) => step.nodeId));
      lastCompletedNodes = completedNodes.size ? completedNodes : lastCompletedNodes;

      setTask(nextTask);
      updateMagic((current) => ({ ...current, renderTask: nextTask }));

      if (lastCompletedNodes.has('research.evidence') || agentOutput.evidence) {
        const evidence = evidenceSamplesFrom(agentOutput);
        const claims = claimSamplesFrom(agentOutput);
        if (evidence.length || claims.length) {
          setResearch(normalizeResearch({ evidence, claims }, input.productId));
          updateMagic((current) => ({
            ...current,
            evidenceSamples: evidence.filter((item) => item.sourceType !== 'material').slice(0, 8),
            claimSamples: claims,
          }));
          updateMagicAct('research', doneActState('✓ 商品调研完成', 'Agent graph 已返回 evidence ledger'));
          updateMagicAct(
            'evidence',
            evidence.length
              ? doneActState(
                  `✓ 证据链已接入 ${evidence.length} 条来源`,
                  evidence
                    .slice(0, 3)
                    .map((item) => item.sourceTitle || item.sourceUrl || item.id)
                    .join(' · '),
                )
              : skippedActState('证据链暂空', 'Agent graph 未返回可展示 evidence'),
          );
        } else {
          updateMagicAct('research', doneActState('✓ 商品调研节点完成', '等待最终 payload 汇总 evidence'));
          updateMagicAct('evidence', activeActState('证据链汇总中', 'research.evidence 已完成'));
        }
      }

      const scriptId = strFrom(agentOutput.scriptId || nextTask.payload?.scriptId);
      if (scriptId && !scriptLoaded) {
        const nextScript = await fetchScriptById(scriptId, input.productId);
        scriptLoaded = true;
        registerScriptVersion(nextScript, input.runId);
        updateMagic((current) => ({ ...current, baselineScriptId: scriptId, finalScriptId: scriptId }));
        updateMagicAct('compose', doneActState('✓ 剧本与分镜已完成', '可在制作台检查镜头、字幕和旁白'));
      } else if (lastCompletedNodes.has('creative.script')) {
        updateMagicAct('compose', activeActState('脚本校验与分镜规划中', 'Agent graph: creative/storyboard/validator'));
      }

      if (
        input.kind !== 'script_generate' &&
        (lastCompletedNodes.has('production.render') || nextTask.step === 'done')
      ) {
        updateMagicAct('render', activeActState(`渲染中 · ${nextTask.progress ?? 0}%`, nextTask.step || 'agent'));
      }
      if (input.kind !== 'script_generate' && lastCompletedNodes.has('passport.compute')) {
        updateMagicAct(
          'render',
          doneActState('✓ 视频与护照已生成', strFrom(agentOutput.videoUrl) || 'Agent graph completed'),
        );
      }

      if (nextTask.status === 'failed' || run.status === 'failed')
        throw new Error(nextTask.error || 'AgentRun 执行失败');
      if (nextTask.status === 'cancelled' || run.status === 'cancelled') throw new Error('AgentRun 已取消');
      if (nextTask.status === 'waiting_input' || run.status === 'waiting_input')
        throw new Error('AgentRun 等待补充输入');
      if (nextTask.status === 'completed' && nextTask.payload) {
        return nextTask.payload;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 800));
    }
    throw new Error('AgentRun 仍在执行，请稍后查看任务状态。');
  }

  const pauseGeneration = async () => {
    if (!activeAgentRunId || pauseBusy) return;
    pauseRequestedRef.current = true;
    setPauseBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/agent-runs/${encodeURIComponent(activeAgentRunId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '用户暂停生成' }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setBusy(null);
      setTask((current) =>
        current
          ? { ...current, status: 'cancelled' as const, progress: current.progress ?? 0, step: 'agent_cancelled' }
          : current,
      );
      setMagicProgress((current) => {
        const activeAct =
          (Object.entries(current.acts).find(([, act]) => act.status === 'active')?.[0] as MagicActId | undefined) ||
          'render';
        return {
          ...current,
          acts: {
            ...current.acts,
            [activeAct]: skippedActState('已暂停生成', '后台 AgentRun 已取消，可修改需求后重新提交。'),
          },
        };
      });
      setError('已暂停生成，可修改需求后重新提交。');
      setActiveRunKind(null);
    } catch (pauseError) {
      pauseRequestedRef.current = false;
      setError(`暂停失败：${pauseError instanceof Error ? pauseError.message : 'unknown'}`);
    } finally {
      setPauseBusy(false);
    }
  };

  async function runScriptPipeline(input: {
    productId: string;
    title: string;
    productUrl?: string;
    webSearch: boolean;
    searchScopes?: SearchScope[];
    generationProfile: 'quick_preview' | 'trusted_publish';
    retrievalMode: 'rag' | 'none';
  }) {
    setPage('chat');
    setProductId(input.productId);
    setProductTitle(input.title);
    setResearch(null);
    setScript(null);
    setSelectedAngle(null);
    setTask(null);
    clearProjectVersions();
    setError(null);
    setQuickInput('');
    setActiveRunKind('script_generate');
    scriptNotifiedRef.current = false;
    researchNotifiedRef.current = false;
    renderNotifiedRef.current = false;
    setMagicProgress({
      ...createMagicProgressState(),
      subject: input.title,
      productUrl: input.productUrl,
      acts: {
        ...createMagicProgressState().acts,
        research: activeActState(
          '读懂你的商品',
          input.productUrl ? '主图 · 卖点 · 适用人群' : '仅商品名，将联网补证据',
        ),
        render: skippedActState('确认后出片', '先检查剧本和分镜，确认后再调用 Seedance。'),
      },
    });

    let stage: Exclude<BusyState, null> = 'research';
    let keepAgentRunActive = false;
    try {
      stage = 'research';
      setBusy('research');
      const response = await fetch(`${API_BASE}/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'script_generate',
          productId: input.productId,
          title: input.title,
          productUrl: input.productUrl,
          webSearch: input.webSearch,
          searchScopes: input.searchScopes,
          generationProfile: input.generationProfile,
          retrievalMode: input.retrievalMode,
          freePrompt: input.title,
          provider: 'auto',
          mode: 'auto',
          aspectRatio: '9:16',
          referenceImageUrl: selectedAngle?.referenceImageUrl || sessionReferenceImage || undefined,
          referenceAngleLabel: selectedAngle?.label,
          referenceAnglePrompt: selectedAngle?.promptHint,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { taskId?: string; runId?: string };
      if (!payload.taskId || !payload.runId) throw new Error('agent-runs endpoint 未返回 taskId/runId');
      setActiveAgentRunId(payload.runId);
      setActiveRunKind('script_generate');
      const initial: TaskStatus = { id: payload.taskId, status: 'pending', progress: 0, step: 'agent_queue_submitted' };
      setTask(initial);
      updateMagic((current) => ({ ...current, renderTask: initial }));

      stage = 'compose';
      setBusy('compose');
      updateMagicAct('compose', activeActState('Agent 编排剧本与分镜', 'research → policy → creative → storyboard'));
      await pollAgentRun({
        taskId: payload.taskId,
        runId: payload.runId,
        productId: input.productId,
        kind: 'script_generate',
      });
      updateMagicAct('compose', doneActState('✓ 剧本与分镜已生成', '可以继续修改，或确认后生成成片'));
      updateMagicAct('render', skippedActState('确认后出片', '本轮默认不消耗成片渲染额度。'));
      setPage('chat');
    } catch (pipelineError) {
      const message = pipelineError instanceof Error ? pipelineError.message : 'unknown';
      if (pauseRequestedRef.current && message === 'AgentRun 已取消') {
        setError('已暂停生成，可修改需求后重新提交。');
        updateMagicAct(stage, skippedActState('已暂停生成', '后台 AgentRun 已取消，可修改需求后重新提交。'));
        return;
      }
      if (isAgentRunStillExecuting(message)) {
        keepAgentRunActive = true;
        setError(null);
        updateMagicAct(stage, activeActState('仍在后台制作', '任务耗时较长，可稍后查看任务状态。'));
        return;
      }
      setError(`生成失败：${researchErrorMessage(pipelineError)}`);
      if (stage === 'research') {
        updateMagicAct('research', { status: 'error', headline: '调研失败', detail: message });
      } else if (stage === 'compose') {
        updateMagicAct('compose', { status: 'error', headline: 'Agent 脚本链路失败', detail: message });
      }
    } finally {
      setBusy(null);
      if (!keepAgentRunActive) {
        setActiveAgentRunId(null);
        setActiveRunKind(null);
      }
      setPauseBusy(false);
      pauseRequestedRef.current = false;
    }
  }

  async function trackAgentRunFromChat(started: ChatStartedAgentRun) {
    const nextProductId = started.productId || productId || `chat_${Date.now()}`;
    const nextTitle = started.productTitle || productTitle || quickInput || '对话生成项目';
    setPage('chat');
    setProductId(nextProductId);
    setProductTitle(nextTitle);
    setTask(null);
    setError(null);
    setActiveAgentRunId(started.runId);
    setActiveRunKind(started.kind);
    pauseRequestedRef.current = false;

    if (started.kind === 'one_click_video' || started.kind === 'script_generate') {
      clearProjectVersions();
      setResearch(null);
      setScript(null);
      setSelectedAngle(null);
      scriptNotifiedRef.current = false;
      researchNotifiedRef.current = false;
      renderNotifiedRef.current = false;
    }

    setMagicProgress({
      ...createMagicProgressState(),
      subject: nextTitle,
      acts: {
        ...createMagicProgressState().acts,
        research:
          started.kind === 'render_full'
            ? skippedActState('沿用现有剧本', '本轮只执行成片渲染')
            : activeActState('读懂你的商品', 'Researcher 正在整理商品、素材与证据'),
        compose:
          started.kind === 'render_full'
            ? skippedActState('沿用现有分镜', '不重新生成剧本')
            : activeActState('Agent 编排脚本与校验', 'research → policy → creative → storyboard'),
        render:
          started.kind === 'script_generate'
            ? skippedActState('暂不渲染视频', '用户本轮只要求剧本/分镜')
            : activeActState('生产成片', 'Renderer 等待或正在调用 Seedance'),
      },
    });

    const initial: TaskStatus = { id: started.taskId, status: 'pending', progress: 0, step: 'agent_queue_submitted' };
    setTask(initial);
    updateMagic((current) => ({ ...current, renderTask: initial }));

    let stage: Exclude<BusyState, null> = started.kind === 'render_full' ? 'render' : 'research';
    let keepAgentRunActive = false;
    try {
      setBusy(stage);
      if (started.kind !== 'render_full') {
        stage = 'compose';
        setBusy('compose');
      }
      if (started.kind !== 'script_generate') {
        stage = 'render';
        setBusy('render');
      }
      const payload = await pollAgentRun({
        taskId: started.taskId,
        runId: started.runId,
        productId: nextProductId,
        kind: started.kind,
      });
      if (started.kind !== 'script_generate') {
        const registered = registerRenderVersion(payload, started.taskId);
        if (registered) {
          const result = normalizeRenderResultForMedia(payload);
          updateMagicAct('render', doneActState('✓ 带货视频已生成', renderMediaUrl(result)));
        } else {
          updateMagicAct('render', {
            status: 'error',
            headline: '成片任务完成但未返回视频地址',
            detail: '后端 payload 没有 videoUrl / assetUrl，请检查渲染产物或稍后查询任务。',
          });
        }
      } else {
        updateMagicAct('compose', doneActState('✓ 剧本与分镜已生成', '可以继续要求修改分镜或直接成片'));
        updateMagicAct('render', skippedActState('确认后出片', '本轮默认不消耗成片渲染额度。'));
      }
    } catch (agentError) {
      const message = agentError instanceof Error ? agentError.message : 'unknown';
      if (isAgentRunStillExecuting(message)) {
        keepAgentRunActive = true;
        setError(null);
        updateMagicAct(stage, activeActState('仍在后台制作', '任务耗时较长，可稍后查看任务状态。'));
        return;
      }
      setError(`生产 Agent 失败：${researchErrorMessage(agentError)}`);
      updateMagicAct(stage, {
        status: 'error',
        headline: stage === 'render' ? '出片失败' : 'Agent 链路失败',
        detail: message,
      });
    } finally {
      setBusy(null);
      if (!keepAgentRunActive) {
        setActiveAgentRunId(null);
        setActiveRunKind(null);
      }
      setPauseBusy(false);
      pauseRequestedRef.current = false;
    }
  }

  const quickGenerate = async (input: string, webSearch = true, searchScopes?: SearchScope[]) => {
    const parsed = parseProductInput(input);
    const nextProductId = `quick_${Date.now()}`;
    await runScriptPipeline({
      productId: nextProductId,
      title: parsed.title,
      productUrl: parsed.productUrl,
      webSearch: webSearch ?? !parsed.productUrl,
      searchScopes,
      generationProfile: 'quick_preview',
      retrievalMode: 'none',
    });
  };

  const render = async (opts?: { navigate?: boolean; returnToChat?: boolean }) => {
    if (!script) return;
    const navigate = opts?.navigate === true;
    if (opts?.returnToChat) setPage('chat');
    setBusy('render');
    setTask(null);
    setError(null);
    setMagicProgress((current) => ({
      ...current,
      renderTask: null,
      acts: {
        ...current.acts,
        render: activeActState('Seedance 出片中', '正在按确认后的分镜生成完整视频。'),
      },
    }));
    try {
      const response = await fetch(`${API_BASE}/render/${encodeURIComponent(script.id)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scriptId: script.id,
          provider: 'seedance',
          aspectRatio: script.aspectRatio || '9:16',
          retrievalMode: script.generationProfile === 'quick_preview' ? 'none' : 'rag',
          renderProfile: script.generationProfile === 'quick_preview' ? 'fast_preview' : 'quality',
          // 默认保留 Seedance 生成的原声/背景音（不接 TTS，零额外成本）。想要真人口播再切 voiceover。
          audioMode: 'original',
          referenceImageUrl: selectedAngle?.referenceImageUrl,
          referenceAngleLabel: selectedAngle?.label,
          referenceAnglePrompt: selectedAngle?.promptHint,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { taskId?: string };
      if (!payload.taskId) throw new Error('render endpoint 未返回 taskId');
      const initial: TaskStatus = { id: payload.taskId, status: 'pending', progress: 0, step: 'queued' };
      setTask(initial);
      const result = await waitForRender(payload.taskId, (nextTask) => {
        setTask(nextTask);
        updateMagic((current) => ({ ...current, renderTask: nextTask }));
      });
      const registered = registerRenderVersion(result, payload.taskId);
      if (registered) {
        const normalized = normalizeRenderResultForMedia(result);
        updateMagicAct('render', doneActState('✓ 带货视频已生成', renderMediaUrl(normalized)));
      } else {
        throw new Error('成片任务完成但未返回 videoUrl / assetUrl');
      }
      if (navigate) setPage('script');
    } catch (renderError) {
      if (renderError instanceof RenderStillProcessingError) {
        if (renderError.task) {
          setTask(renderError.task);
          updateMagic((current) => ({ ...current, renderTask: renderError.task }));
        }
        setError(null);
        updateMagicAct(
          'render',
          activeActState('仍在后台渲染', 'Seedance 处理时间超过前端等待窗口，可稍后查看制作进度。'),
        );
        return;
      }
      setTask({
        id: script.id,
        status: 'failed',
        progress: 0,
        step: 'render failed',
        error: renderError instanceof Error ? renderError.message : 'render unavailable',
      });
      setError(`Render endpoint 失败：${renderError instanceof Error ? renderError.message : 'render unavailable'}`);
      updateMagicAct('render', {
        status: 'error',
        headline: '出片失败',
        detail: renderError instanceof Error ? renderError.message : 'render unavailable',
      });
    } finally {
      setBusy(null);
    }
  };

  const previewFirstShot = async () => {
    const firstShot = script?.shots?.[0];
    if (!script || !firstShot) return;
    setBusy('render');
    setTask(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/render/shot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scriptId: script.id,
          shotId: firstShot.id,
          provider: 'seedance',
          referenceImageUrl: selectedAngle?.referenceImageUrl,
          referenceAnglePrompt: selectedAngle?.promptHint,
          preview: true,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { taskId?: string };
      if (!payload.taskId) throw new Error('render/shot endpoint 未返回 taskId');
      const initial: TaskStatus = { id: payload.taskId, status: 'pending', progress: 0, step: 'queued' };
      setTask(initial);
      await waitForRender(payload.taskId, setTask);
      const scriptResponse = await fetch(`${API_BASE}/scripts/${encodeURIComponent(script.id)}`);
      if (!scriptResponse.ok) throw new Error(`剧本读取 HTTP ${scriptResponse.status}`);
      updateActiveScript(normalizeScript((await scriptResponse.json()) as Partial<ScriptData>, script.productId));
    } catch (previewError) {
      if (previewError instanceof RenderStillProcessingError) {
        if (previewError.task) setTask(previewError.task);
        setError(null);
        return;
      }
      setError(`首镜预览失败：${previewError instanceof Error ? previewError.message : 'render unavailable'}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`simple-root chat-root page-${page}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <AppRail
        activePage={page}
        collapsed={sidebarCollapsed}
        history={history.items}
        activeSessionId={activeSessionId}
        productTitle={productTitle || undefined}
        hasResearch={research !== null}
        hasScript={script !== null}
        busy={busy}
        taskProgress={task?.progress}
        onNavigate={setPage}
        onReset={reset}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        onSelectSession={selectSession}
        onDeleteSession={(id) => {
          history.remove(id);
          if (activeSessionId === id) reset();
        }}
      />
      {page === 'chat' ? (
        <ChatPage
          key={resetKey}
          productId={productId}
          productTitle={productTitle || undefined}
          research={research}
          script={script}
          task={task}
          activeAgentRunId={activeAgentRunId}
          busy={busy}
          error={error}
          magicProgress={magicProgress}
          renderVersions={renderVersions}
          activeRenderVersionId={activeRenderVersionId}
          quickInput={quickInput}
          initialMessages={restoredMessages || activeHistoryItem?.messages || undefined}
          initialActivityItems={restoredActivityItems || activeHistoryItem?.activityItems || undefined}
          projectSnapshot={projectSnapshot}
          historyItems={history.items}
          sessionId={activeSessionId}
          onChatReferenceImage={setSessionReferenceImage}
          onQuickInputChange={setQuickInput}
          onNavigate={setPage}
          onUseResult={(renderVersionId) => {
            if (renderVersionId) selectRenderVersion(renderVersionId);
            setPage('script');
          }}
          onSelectResult={selectRenderVersion}
          onRegenerate={() => {
            if (script) void render({ navigate: false });
            else if (productTitle) void quickGenerate(productTitle, true);
          }}
          onAgentRunStarted={(run) => void trackAgentRunFromChat(run)}
          onAgentScriptUpdated={(nextScript) => {
            const nextProductId = nextScript.productId || script?.productId || productId;
            if (nextProductId)
              registerScriptVersion(normalizeScript(nextScript, nextProductId), activeAgentRunId || undefined);
          }}
          onOpenWorkbench={setPage}
          onPauseGeneration={activeAgentRunId ? () => void pauseGeneration() : undefined}
          pauseGenerationBusy={pauseBusy}
          onSelectSession={selectSession}
          onPersistSession={persistSession}
        />
      ) : (
        <main id="main-content" className={`utility-shell${page === 'script' ? ' utility-shell--workbench' : ''}`}>
          {page !== 'script' && (
            <header className="utility-head">
              <div>
                <p className="assistant-work-kicker">
                  {DEBUG_PAGES.has(page) ? 'Internal diagnostics' : 'Production flow'}
                </p>
                <h1>{PAGE_META[page].title}</h1>
                <p>{PAGE_META[page].desc}</p>
              </div>
              {error && <span className="tag amber">Action required</span>}
            </header>
          )}
          {page === 'clone' && <CloneRadarPage querySeed={productTitle} />}
          {page === 'script' && (
            <ScriptPage
              research={research}
              script={script}
              busy={busy}
              error={error}
              task={task}
              renderResult={renderResult}
              renderVersions={renderVersions}
              activeRenderVersionId={activeRenderVersionId}
              scriptVersions={scriptVersions}
              activeScriptVersionId={activeScriptVersionId}
              selectedAngle={selectedAngle}
              productTitle={productTitle || undefined}
              onScriptChange={updateActiveScript}
              onSelectScriptVersion={selectScriptVersion}
              onSelectRenderVersion={selectRenderVersion}
              onRenameScriptVersion={renameScriptVersion}
              onRenameRenderVersion={renameRenderVersion}
              onRender={() => render({ returnToChat: true })}
              onPreviewFirstShot={previewFirstShot}
              onNavigateStart={() => setPage('chat')}
              onNavigateMaterials={() => setPage('materials')}
              onNavigatePassport={() => setPage('passport')}
            />
          )}
          {page === 'materials' && (
            <MaterialsPage
              productId={productId}
              querySeed={productTitle}
              selectedAngle={selectedAngle}
              onAngleSelect={setSelectedAngle}
            />
          )}
          {page === 'passport' && (
            <PassportPage
              task={task}
              result={renderResult}
              renderVersions={renderVersions}
              activeRenderVersionId={activeRenderVersionId}
              script={script}
              research={research}
              onSelectRenderVersion={selectRenderVersion}
            />
          )}
          {page === 'workflow' && <WorkflowPage />}
          {page === 'analytics' && <AnalyticsPage script={script} />}
        </main>
      )}

      {toast && (
        <div className="task-toast" role="status" aria-live="polite">
          <button
            type="button"
            className="task-toast-body"
            onClick={() => {
              toast.action?.();
              setToast(null);
            }}
          >
            <CheckCircle2 size={15} aria-hidden="true" />
            <span>{toast.text}</span>
          </button>
          <button type="button" className="task-toast-close" onClick={() => setToast(null)} aria-label="关闭通知">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
