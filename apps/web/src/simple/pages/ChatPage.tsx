import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clapperboard,
  Film,
  FileText,
  Globe2,
  Layers3,
  Loader2,
  Paperclip,
  Play,
  Plus,
  Square,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  API_BASE,
  type AppPage,
  type RenderResult,
  type RenderVersion,
  type ResearchData,
  type ScriptData,
} from '../studio-types';
import type { MagicProgressState } from '../generation-pipeline';
import type { AgentUiStreamEvent } from '@aigc-video-hub/shared';
import {
  deriveTitle,
  newSessionId,
  type ChatHistoryActivityItem,
  type ChatHistoryItem,
  type ChatHistoryMessage,
  type ChatProjectSnapshot,
} from '../useChatHistory';
import MagicProgress from './MagicProgress';

// ─── Types ───────────────────────────────────────────────────────────────────

type ActivityItemKind = 'chat-user' | 'chat-bot' | 'tool' | 'error';

type ActivityItem = {
  id: string;
  kind: ActivityItemKind;
  text: string;
  meta?: string;
  attachments?: ChatAttachment[];
  toolName?: string;
  toolStatus?: 'running' | 'done' | 'failed' | 'stopped';
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
};

type ActivityBlock =
  | { kind: 'item'; item: ActivityItem }
  | { kind: 'process'; id: string; ownerId: string; steps: ActivityItem[] };

type AgentChatStep = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
};

type AgentChatStartedRun = {
  taskId: string;
  runId: string;
  kind: 'one_click_video' | 'script_generate' | 'render_full' | 'repair_shot' | 'ab_test';
  productId?: string;
  productTitle?: string;
};

type AgentChatStreamEvent =
  | { type: 'agent_ui'; event: AgentUiStreamEvent }
  | { type: 'status'; phase?: string; step?: number }
  | { type: 'tool_call'; tool: string; args?: Record<string, unknown>; step?: number }
  | { type: 'tool_result'; tool: string; args?: Record<string, unknown>; result?: unknown; step?: number }
  | { type: 'started_run'; taskId?: string; runId?: string; kind?: string; productId?: string; productTitle?: string }
  | { type: 'script'; script?: Partial<ScriptData> }
  | { type: 'token'; content?: string }
  | { type: 'done'; reply?: string; steps?: AgentChatStep[]; script?: Partial<ScriptData> | null }
  | { type: 'error'; message?: string };

type ChatAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  status: 'uploading' | 'ready' | 'failed';
  materialId?: string;
  taskId?: string;
  sourceUrl?: string;
  savedToLibrary?: boolean;
  error?: string;
};

function activityFromHistory(item: ChatHistoryActivityItem): ActivityItem {
  return {
    id: item.id,
    kind: item.kind,
    text: item.kind === 'chat-bot' ? userFacingAgentText(item.text) : item.text,
    meta: item.meta,
    attachments: item.attachments,
    toolName: item.toolName,
    toolStatus: item.toolStatus,
    toolArgs: item.toolArgs,
    toolResult: item.toolResult,
  };
}

function activityToHistory(item: ActivityItem): ChatHistoryActivityItem {
  return {
    id: item.id,
    kind: item.kind,
    text: item.kind === 'chat-bot' ? userFacingAgentText(item.text) : item.text,
    meta: item.meta,
    attachments: item.attachments?.map((file) => ({ ...file })),
    toolName: item.toolName,
    toolStatus: item.toolStatus,
    toolArgs: item.toolArgs,
    toolResult: item.toolResult,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TAGLINES = [
  { main: '今天想卖什么？', sub: '输入商品名或链接，我帮你调研卖点、写剧本、出成片' },
  { main: '今天想做什么视频？', sub: '输入商品名或链接，先生成可编辑方案' },
  { main: '把爆款配方变成可交付视频', sub: '调研 · 剧本 · 分镜 · 确认出片' },
];

const EXAMPLES = ['从商品链接', '仿写爆款', '选灵感模板'];

// 面向评审的「一键生成示例」：零输入触发剧本分镜链路，成片仍需进制作台确认。
const DEMO_PROMPT =
  '用这款便携磁吸手机支架做一条 TikTok Shop 带货视频，核心卖点：强力磁吸、单手安装、车载和桌面通用，适合通勤和自驾人群。先生成剧本和分镜，等我进制作台确认后再出片。';

const TRUST_SIGNALS = ['爆款参考可追溯', '证据链可折叠查看', '确认后 Seedance 出片'];

const TOOL_LABELS: Record<string, string> = {
  assess_project_brief: '判断下一步',
  run_product_research: '调研商品与用户',
  search_uploaded_materials: '检索素材库',
  search_reference_videos: '检索爆款参考',
  retrieve_materials: '检索素材',
  edit_shot: '修改分镜',
  start_one_click_video: '启动剧本分镜',
  start_script_generation: '启动剧本分镜',
  start_render_full: '制作台确认提醒',
  get_run_status: '查询进度',
};

const recentDateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' });

function newId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '未知大小';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentSummary(attachments: ChatAttachment[]) {
  return attachments
    .map((file) => {
      const state =
        file.status === 'uploading'
          ? '上传中'
          : file.status === 'failed'
            ? `上传失败${file.error ? `：${file.error}` : ''}`
            : file.materialId || file.savedToLibrary
              ? '已入库'
              : '已附加';
      return `${file.name} (${formatBytes(file.size)}，${state})`;
    })
    .join('、');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toolLabel(name: string) {
  return TOOL_LABELS[name] || name || '工具调用';
}

function summarizeToolArgs(args: Record<string, unknown> | undefined) {
  if (!args) return '';
  const parts: string[] = [];
  const labels: Record<string, string> = {
    query: '关键词',
    order: '镜头',
    intent: '意图',
    productTitle: '商品',
    generationProfile: '模式',
    audioMode: '声音',
    webSearch: '网络搜索',
  };
  for (const key of ['query', 'order', 'intent', 'productTitle', 'generationProfile', 'audioMode', 'webSearch']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) parts.push(`${labels[key]}：${value.trim().slice(0, 42)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${labels[key]}：${String(value)}`);
  }
  return parts.slice(0, 3).join(' · ');
}

function summarizeToolResult(result: unknown) {
  const row = asRecord(result);
  if (typeof row.error === 'string') return safeDetailValue(row.error);
  if (row.action === 'brief_checked') {
    const missing = Array.isArray(row.missing) ? row.missing.length : 0;
    if (missing > 0) return '已判断需要先补充信息';
    return '资料已具备下一步条件';
  }
  if (row.action === 'brief_required') return '需要先补商品资料';
  if (row.action === 'needs_research') return '建议先调研商品和用户';
  if (row.action === 'needs_staged_workflow') return '改为先生成剧本和分镜';
  if (row.action === 'needs_render_confirmation') return '等待确认后再渲染成片';
  if (row.action === 'render_requirements_missing') return '缺少最终视频依赖';
  if (row.action === 'active_run_in_progress') return '已有制作任务在进行';
  if (row.action === 'research_completed') {
    const evidenceCount = typeof row.evidenceCount === 'number' ? row.evidenceCount : 0;
    const approvedClaims = typeof row.approvedClaims === 'number' ? row.approvedClaims : 0;
    return `调研完成：${evidenceCount} 条资料，${approvedClaims} 条可用卖点`;
  }
  if (row.action === 'started_agent_run') {
    const kind = typeof row.kind === 'string' ? row.kind : '';
    if (kind === 'script_generate') return '已开始生成剧本和分镜';
    if (kind === 'render_full') return '已开始渲染成片';
    return '已开始制作视频';
  }
  if (typeof row.reason === 'string') return row.reason;
  if (typeof row.count === 'number') {
    return `${row.count} 条结果`;
  }
  if (row.ok === true) return '已完成';
  if (row.ok === false) {
    if (typeof row.error === 'string') return row.error;
    if ('run' in row || 'task' in row) return '当前没有正在跟踪的制作任务';
    return '未完成';
  }
  return '已返回结果';
}

function toolOwnerId(id: string) {
  const match = id.match(/^(.+)_tool_\d+_/);
  return match?.[1] || '';
}

function buildActivityBlocks(items: ActivityItem[]): ActivityBlock[] {
  const visible = items.filter(
    (item) => item.kind === 'chat-user' || item.kind === 'chat-bot' || item.kind === 'tool' || item.kind === 'error',
  );
  const pendingByOwner = new Map<string, ActivityItem[]>();
  const botIds = new Set(visible.filter((item) => item.kind === 'chat-bot').map((item) => item.id));
  const blocks: ActivityBlock[] = [];

  const appendProcess = (ownerId: string, steps: ActivityItem[]) => {
    if (!steps.length) return;
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'process' && last.ownerId === ownerId) {
      last.steps.push(...steps);
      return;
    }
    blocks.push({ kind: 'process', id: `${ownerId || steps[0].id}_process`, ownerId, steps });
  };

  visible.forEach((item) => {
    if (item.kind === 'tool') {
      const ownerId = toolOwnerId(item.id) || item.id;
      if (botIds.has(ownerId)) {
        const pending = pendingByOwner.get(ownerId) || [];
        pending.push(item);
        pendingByOwner.set(ownerId, pending);
      } else {
        appendProcess(ownerId, [item]);
      }
      return;
    }
    if (item.kind === 'chat-bot') {
      appendProcess(item.id, pendingByOwner.get(item.id) || []);
      pendingByOwner.delete(item.id);
      if (item.text.trim()) blocks.push({ kind: 'item', item });
      return;
    }
    blocks.push({ kind: 'item', item });
  });

  pendingByOwner.forEach((steps, ownerId) => appendProcess(ownerId, steps));
  return blocks;
}

function renderActivityBlock(block: ActivityBlock) {
  if (block.kind === 'process') {
    return <AgentProcessTimeline key={block.id} id={block.id} steps={block.steps} />;
  }
  const { item } = block;
  if (item.kind === 'error') {
    return (
      <div key={item.id} className="activity-error">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>{item.text}</span>
      </div>
    );
  }
  return (
    <div
      key={item.id}
      className={`activity-chat-msg ${
        item.kind === 'chat-user' ? 'activity-chat-msg--user' : 'activity-chat-msg--bot'
      }`}
    >
      <span>{item.text}</span>
      {item.attachments && item.attachments.length > 0 && (
        <div className="activity-attachments">
          {item.attachments.map((file) => (
            <span key={file.id}>
              <FileText size={12} aria-hidden="true" />
              {file.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function statusLabel(status: ActivityItem['toolStatus']) {
  if (status === 'stopped') return '已停止';
  if (status === 'failed') return '需要处理';
  if (status === 'done') return '完成';
  return '进行中';
}

function runStatusLabel(status: unknown) {
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'running' || status === 'active') return '制作中';
  if (status === 'queued' || status === 'pending') return '排队中';
  if (status === 'canceled' || status === 'cancelled') return '已取消';
  return typeof status === 'string' && status.trim() ? status : '';
}

function workflowStepLabel(step: unknown) {
  if (typeof step !== 'string') return '';
  const normalized = step.toLowerCase();
  if (normalized.includes('agent_done') || normalized.includes('done')) return '整理交付结果';
  if (normalized.includes('render') || normalized.includes('seedance') || normalized.includes('video'))
    return '生成成片';
  if (normalized.includes('storyboard') || normalized.includes('script') || normalized.includes('creative'))
    return '生成剧本分镜';
  if (normalized.includes('research') || normalized.includes('material')) return '调研参考与素材';
  if (normalized.includes('qa') || normalized.includes('audit') || normalized.includes('policy'))
    return '质量与合规检查';
  if (normalized.includes('passport')) return '生成交付页';
  return '';
}

function profileLabel(value: unknown) {
  if (value === 'quick_preview') return '快速预览';
  if (value === 'trusted_publish') return '可信发布';
  return typeof value === 'string' ? value : '';
}

function audioLabel(value: unknown) {
  if (value === 'voiceover') return 'AI 旁白';
  if (value === 'mute') return '静音预览';
  if (value === 'original') return '保留原声';
  return typeof value === 'string' ? value : '';
}

function safeDetailValue(value: unknown) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';
  return value
    .replace(/当前没有可改的剧本（缺\s*scriptId）。?/gi, '当前还没有生成剧本分镜，请先生成剧本后再修改镜头。')
    .replace(/缺\s*scriptId/gi, '缺少可编辑的剧本分镜')
    .replace(/`?(?:task|run|script)_[A-Za-z0-9_-]+`?/g, '')
    .replace(/\bscriptId\b/gi, '剧本分镜')
    .replace(/\btaskId\b/gi, '制作任务')
    .replace(/\brunId\b/gi, '制作任务')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function safeDetailList(value: unknown, limit = 5) {
  return Array.isArray(value)
    ? value
        .map((item) => safeDetailValue(item))
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function hostFromUrl(value: unknown) {
  const url = safeDetailValue(value);
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.length > 42 ? `${url.slice(0, 42)}...` : url;
  }
}

function evidenceSourceLabels(value: unknown, limit = 4) {
  return Array.isArray(value)
    ? value
        .map((item) => {
          const row = asRecord(item);
          const title = safeDetailValue(row.sourceTitle || row.text || row.sourceUrl) || '公开资料';
          const host = hostFromUrl(row.sourceUrl);
          return host ? `${title}（${host}）` : title;
        })
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function claimLabels(value: unknown, status: string, limit = 4) {
  return Array.isArray(value)
    ? value
        .map((item) => asRecord(item))
        .filter((row) => safeDetailValue(row.status) === status)
        .map((row) => safeDetailValue(row.text))
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function searchPlanLabels(value: unknown, limit = 4) {
  return Array.isArray(value)
    ? value
        .map((item) => {
          const row = asRecord(item);
          const label = safeDetailValue(row.label || row.scope);
          const queryValue = safeDetailValue(row.query);
          return [label, queryValue].filter(Boolean).join('：');
        })
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function referenceResultTitles(result: unknown) {
  const items = asRecord(result).items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const row = asRecord(item);
      return safeDetailValue(row.title || row.summary || row.hook);
    })
    .filter(Boolean)
    .slice(0, 3);
}

function processDetailLines(item: ActivityItem) {
  const lines: string[] = [];
  const args = item.toolArgs || {};
  const result = asRecord(item.toolResult);
  const ui = asRecord(result.ui);
  const uiDetailLines = safeDetailList(result.agentUiDetailLines || ui.detailLines, 8);
  if (uiDetailLines.length) return uiDetailLines;
  const query = safeDetailValue(args.query);
  const product = safeDetailValue(args.productTitle);
  const order = safeDetailValue(args.order);
  const count = typeof result.count === 'number' ? `${result.count} 条` : '';
  const add = (value: string) => {
    if (value) lines.push(value);
  };

  if (item.toolName === 'assess_project_brief') {
    const productTitle = safeDetailValue(result.productTitle) || safeDetailValue(args.productTitle);
    const missing = safeDetailList(result.missing, 4);
    const known = safeDetailList(result.known, 6);
    if (known.length) add(`已确认：${known.join('、')}。`);
    if (missing.length) {
      add(
        productTitle
          ? `我已识别到商品是「${productTitle}」，先判断能不能继续制作。`
          : '我先判断当前需求能不能进入制作。',
      );
      add(`本轮先补：${missing.join('、')}。`);
    } else if (result.readyForFullVideo) {
      add('资料、脚本和可用商品素材都已就绪，可以进入成片确认。');
    } else if (result.readyForScript) {
      add('资料已足够先推进脚本和分镜，成片仍会等你确认后再生成。');
    } else {
      add('我先停在需求确认，等补齐关键信息后再继续。');
    }
  } else if (item.toolName === 'run_product_research') {
    const productTitle = safeDetailValue(result.productTitle || args.productTitle);
    const research = asRecord(result.research);
    const evidence = Array.isArray(result.evidence) ? result.evidence : research.evidence;
    const claims = Array.isArray(result.claims) ? result.claims : research.claims;
    const searchPlan = Array.isArray(research.searchPlan) ? research.searchPlan : [];
    add(
      productTitle
        ? `我围绕「${productTitle}」查商品资料、用户痛点和可用卖点。`
        : '我开始查商品资料、用户痛点和可用卖点。',
    );
    if (typeof result.evidenceCount === 'number' || typeof result.approvedClaims === 'number') {
      const evidenceCount = typeof result.evidenceCount === 'number' ? `${result.evidenceCount} 条资料` : '';
      const approvedClaims = typeof result.approvedClaims === 'number' ? `${result.approvedClaims} 条可用表达` : '';
      add(`已整理${[evidenceCount, approvedClaims].filter(Boolean).join('，')}。`);
    }
    const planLabels = searchPlanLabels(searchPlan);
    if (planLabels.length) add(`调研范围：${planLabels.join('；')}。`);
    const sourceLabels = evidenceSourceLabels(evidence);
    if (sourceLabels.length) add(`看过的来源包括：${sourceLabels.join('；')}。`);
    const approvedLabels = claimLabels(claims, 'approved');
    if (approvedLabels.length) add(`可以使用的表达：${approvedLabels.join('；')}。`);
    const needsEvidenceLabels = claimLabels(claims, 'needs_evidence', 3);
    if (needsEvidenceLabels.length) add(`还需要证据支撑的说法：${needsEvidenceLabels.join('；')}。`);
    const blockedLabels = claimLabels(claims, 'blocked', 3);
    if (blockedLabels.length) add(`我会避开这些高风险表达：${blockedLabels.join('；')}。`);
    const next = safeDetailValue(result.next);
    if (next) add(`下一步：${next}`);
  } else if (item.toolName === 'search_uploaded_materials') {
    add(query ? `我在当前商品素材库里搜索「${query}」。` : '我在当前商品素材库里搜索可用素材。');
    add(count ? `命中 ${count}。这些素材只作为商品参考，不会被直接剪进最终视频。` : '当前商品素材库没有命中。');
  } else if (item.toolName === 'search_reference_videos') {
    add(query ? `我在爆款参考库里搜索「${query}」。` : '我在爆款参考库里搜索可参考的镜头结构。');
    if (count) add(`找到 ${count} 个参考样本，用来提炼 Hook、节奏和字幕策略。`);
    const titles = referenceResultTitles(item.toolResult);
    if (titles.length) add(`参考样例：${titles.join('；')}。`);
    add('参考库只提供方法，不会把原片当作当前商品素材复用。');
  } else if (item.toolName === 'start_one_click_video' || item.toolName === 'start_script_generation') {
    const missing = safeDetailList(result.missing, 4);
    const reply = safeDetailValue(result.reply);
    if (product) add(`制作对象：${product}。`);
    if (missing.length) add(`我没有直接启动生成，先等你确认：${missing.join('、')}。`);
    if (reply && !missing.length) add(reply);
    const profile = profileLabel(args.generationProfile);
    if (profile) add(`制作模式：${profile}。`);
    const audio = audioLabel(args.audioMode);
    if (audio) add(`声音方案：${audio}。`);
    const resultAction = safeDetailValue(result.action);
    if (resultAction === 'brief_required') add('下一步：先补关键信息，我再继续推进。');
    else if (resultAction === 'needs_staged_workflow') add('下一步：先生成剧本和分镜，确认后再出片。');
    else if (resultAction === 'active_run_in_progress') add('下一步：先跟进当前制作任务。');
    else if (
      item.toolName === 'start_script_generation' ||
      safeDetailValue(result.kind) === 'script_generate' ||
      safeDetailValue(result.downgradedFrom) === 'one_click_video'
    ) {
      add('已进入剧本和分镜生成。');
    } else add('已进入剧本和分镜生成，确认后再出片。');
  } else if (item.toolName === 'start_render_full') {
    const missing = safeDetailList(result.missing, 4);
    const reply = safeDetailValue(result.reply);
    if (missing.length) add(`我先停下，最终视频还缺：${missing.join('、')}。`);
    if (reply && !missing.length) add(reply);
    const audio = audioLabel(args.audioMode);
    if (audio) add(`声音方案：${audio}。`);
    const resultAction = safeDetailValue(result.action);
    add(
      resultAction === 'active_run_in_progress'
        ? '当前还有制作任务在运行，先等这一轮完成或暂停后再操作。'
        : resultAction === 'needs_render_confirmation'
          ? '请打开制作台检查分镜，确认无误后点击“确认成片”。'
          : resultAction === 'render_requirements_missing'
            ? '补齐后再启动成片生成。'
            : '我会用已确认的分镜启动成片生成。',
    );
  } else if (item.toolName === 'edit_shot') {
    const changedLabels: Record<string, string> = {
      visualDesc: '画面',
      camera: '镜头',
      narration: '旁白',
      subtitle: '字幕',
      duration: '时长',
    };
    const changed = Object.keys(changedLabels)
      .filter((key) => args[key] !== undefined)
      .map((key) => changedLabels[key])
      .join('、');
    add(changed ? `已修改第 ${order || ''} 镜的${changed}。` : `已定位第 ${order || ''} 镜。`);
  } else if (item.toolName === 'get_run_status') {
    const task = asRecord(result.task);
    const run = asRecord(result.run);
    const status = runStatusLabel(task.status || run.status);
    if (status) {
      add(
        `当前任务状态：${status}${typeof task.progress === 'number' ? `，进度约 ${Math.round(task.progress)}%` : ''}。`,
      );
      const step = workflowStepLabel(task.step || asRecord(run.latestStep).nodeId);
      if (step) add(`正在处理：${step}。`);
    } else {
      add('当前没有正在跟踪的制作任务。');
      add('你可以发起新视频制作，或打开交付结果查看最近成片。');
    }
  }

  if (!lines.length && item.meta) add(safeDetailValue(item.meta));
  return lines;
}

function researchSourceLinks(item: ActivityItem) {
  if (item.toolName !== 'run_product_research') return [];
  const result = asRecord(item.toolResult);
  const research = asRecord(result.research);
  const evidence = Array.isArray(result.evidence) ? result.evidence : research.evidence;
  return Array.isArray(evidence)
    ? evidence
        .map((entry) => {
          const row = asRecord(entry);
          const href = safeDetailValue(row.sourceUrl);
          if (!href || !/^https?:\/\//i.test(href)) return null;
          const title = safeDetailValue(row.sourceTitle || row.text) || hostFromUrl(href);
          return { href, title };
        })
        .filter((entry): entry is { href: string; title: string } => Boolean(entry))
        .slice(0, 4)
    : [];
}

function ProcessStepIcon({ status }: { status: ActivityItem['toolStatus'] }) {
  if (status === 'stopped') return <Square size={11} aria-hidden="true" />;
  if (status === 'failed') return <AlertTriangle size={13} aria-hidden="true" />;
  if (status === 'done') return <CheckCircle2 size={13} aria-hidden="true" />;
  return <Loader2 size={13} className="spin" aria-hidden="true" />;
}

function CinematicStage() {
  return (
    <aside className="cinematic-stage" aria-label="视频生成预览">
      <div className="cinematic-frame">
        <div className="cinematic-video-card primary">
          <span className="video-card-tag">PRODUCT</span>
          <div className="demo-product-shape" aria-hidden="true">
            <span />
            <i />
          </div>
          <strong>商品视觉</strong>
          <small>链接 / 图片 / 卖点输入</small>
        </div>
        <div className="cinematic-video-card secondary">
          <span className="video-card-tag">SHOT 03</span>
          <div className="demo-timeline-bars" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <strong>证据卖点转分镜</strong>
        </div>
        <div className="cinematic-play-orb" aria-hidden="true">
          <Play size={20} />
        </div>
      </div>
      <div className="cinematic-flow" aria-hidden="true">
        <span>
          <Sparkles size={14} /> 商品
        </span>
        <i />
        <span>
          <Layers3 size={14} /> 分镜
        </span>
        <i />
        <span>
          <Film size={14} /> 成片
        </span>
      </div>
    </aside>
  );
}

function AgentProcessTimeline({ id, steps }: { id: string; steps: ActivityItem[] }) {
  const stepIds = useMemo(() => new Set(steps.map((step) => step.id)), [steps]);
  const activeStepId = useMemo(() => {
    return (steps.find((step) => step.toolStatus === 'failed' || step.toolStatus === 'running') || steps[0])?.id || '';
  }, [steps]);
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(() => new Set());
  const [manualCollapsed, setManualCollapsed] = useState<Set<string>>(() => new Set());
  const expanded = useMemo(() => {
    const next = new Set<string>();
    if (activeStepId && !manualCollapsed.has(activeStepId)) next.add(activeStepId);
    manualExpanded.forEach((stepId) => {
      if (stepIds.has(stepId)) next.add(stepId);
    });
    manualCollapsed.forEach((stepId) => next.delete(stepId));
    return next;
  }, [activeStepId, manualCollapsed, manualExpanded, stepIds]);

  const toggleExpanded = useCallback(
    (stepId: string, isOpen: boolean) => {
      setManualExpanded((prev) => {
        const next = new Set([...prev].filter((id) => stepIds.has(id)));
        if (isOpen) next.delete(stepId);
        else next.add(stepId);
        return next;
      });
      setManualCollapsed((prev) => {
        const next = new Set([...prev].filter((id) => stepIds.has(id)));
        if (isOpen) next.add(stepId);
        else next.delete(stepId);
        return next;
      });
    },
    [stepIds],
  );

  if (!steps.length) return null;

  return (
    <section className="agent-process" aria-label="动作记录">
      <ol className="agent-process-list">
        {steps.map((step) => {
          const isOpen = expanded.has(step.id);
          const lines = processDetailLines(step);
          const links = researchSourceLinks(step);
          const status = step.toolStatus || 'running';
          const panelId = `${id}_${step.id}_panel`;
          return (
            <li key={step.id} className={`agent-process-step ${status}`}>
              <button
                type="button"
                className="agent-process-toggle"
                aria-expanded={isOpen}
                aria-controls={panelId}
                aria-label={`${step.text}，${statusLabel(status)}`}
                title={step.text}
                onClick={() => toggleExpanded(step.id, isOpen)}
              >
                <span className="agent-process-marker" aria-hidden="true">
                  <ProcessStepIcon status={status} />
                </span>
                <span className="agent-process-copy">
                  <span className="agent-process-row">
                    <span className="agent-process-step-title">{step.text}</span>
                  </span>
                </span>
                <span className="agent-process-chevron" aria-hidden="true">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              </button>
              {isOpen && (
                <div id={panelId} className="agent-process-detail">
                  {lines.length > 0 ? (
                    lines.map((line) => <p key={`${step.id}_${line}`}>{line}</p>)
                  ) : (
                    <p>这一步已完成，继续看下一步。</p>
                  )}
                  {links.length > 0 && (
                    <div className="agent-process-links" aria-label="参考来源">
                      {links.map((link) => (
                        <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
                          <span>{link.title}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ScriptHandoffBar({
  script,
  busy,
  disabled: locked,
  onOpenWorkbench,
  onRefine,
}: {
  script: ScriptData;
  busy: 'research' | 'script' | 'compose' | 'render' | null;
  disabled?: boolean;
  onOpenWorkbench: () => void;
  onRefine?: (instruction: string) => void | Promise<void>;
}) {
  const shotCount = script.shots.length;
  const duration = script.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
  const disabled = locked || busy !== null;
  return (
    <section className="script-handoff" aria-label="剧本和分镜确认">
      <span className="script-handoff-icon" aria-hidden="true">
        <Clapperboard size={16} />
      </span>
      <div className="script-handoff-copy">
        <strong>剧本和分镜已就绪</strong>
        <span>
          {shotCount} 镜 · 约 {Math.round(duration || 0)} 秒。先检查镜头、字幕和旁白，确认后再生成成片。
        </span>
      </div>
      <div className="script-handoff-actions">
        <button type="button" className="primary-button script-handoff-primary" onClick={onOpenWorkbench}>
          打开制作台
        </button>
        {onRefine && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => void onRefine('帮我检查当前剧本和分镜节奏，并给出需要调整的镜头。')}
          >
            继续优化
          </button>
        )}
      </div>
    </section>
  );
}

function normalizeAgentProductLabel(value: string) {
  return value
    .replace(/制作「/g, '')
    .replace(/[「」]/g, '')
    .replace(/[的\s]+$/g, '')
    .trim();
}

function renderResultAnchorKey(result?: RenderResult | null) {
  return result?.videoUrl || result?.assetUrl || result?.previewUrl || result?.objectKey || result?.videoId || '';
}

function refineSuggestionLabel(value: string, fallback: string) {
  const compact = value
    .replace(/[，。！？、；：,.!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return fallback;
  return compact.length > 12 ? `${compact.slice(0, 12)}…` : compact;
}

function buildRefineSuggestions(script: ScriptData | null, productTitle?: string) {
  if (!script) return ['强化开场吸引力', '突出真实使用场景', '换一个成交结尾'];
  const firstShot = script.shots[0];
  const lastShot = script.shots.at(-1);
  const product = refineSuggestionLabel(productTitle || script.narrative, '商品');
  const hook = refineSuggestionLabel(
    firstShot?.subtitle || firstShot?.narration || firstShot?.visualDesc || '',
    '开场',
  );
  const ending = refineSuggestionLabel(lastShot?.subtitle || lastShot?.narration || '', '成交结尾');
  const style = refineSuggestionLabel(script.visualStyle, '视觉风格');
  const candidates = [
    `强化「${hook}」开场`,
    `突出「${product}」使用场景`,
    `统一成「${style}」质感`,
    `换一个「${ending}」结尾`,
  ];
  return Array.from(new Set(candidates)).slice(0, 3);
}

function userFacingAgentText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const cleaned = trimmed
    .replace(/当前没有可改的剧本（缺\s*scriptId）。?/gi, '当前还没有生成剧本分镜，请先生成剧本后再修改镜头。')
    .replace(/缺\s*scriptId/gi, '缺少可编辑的剧本分镜')
    .replace(/任务\s*ID\s*[:：]\s*`?(?:task_[A-Za-z0-9_-]*)?`?[，,、;\s]*/gi, '')
    .replace(/运行\s*ID\s*[:：]\s*`?(?:run_[A-Za-z0-9_-]*)?`?[，,、;\s]*/gi, '')
    .replace(/剧本\s*ID\s*[:：]\s*`?(?:script_[A-Za-z0-9_-]*)?`?[，,、;\s]*/gi, '')
    .replace(/`?(?:task|run|script)_[A-Za-z0-9_-]+`?/g, '')
    .replace(/\bscriptId\b/gi, '剧本分镜')
    .replace(/\btaskId\b/gi, '制作任务')
    .replace(/\brunId\b/gi, '制作任务')
    .replace(/当前状态为排队中/g, '已进入制作队列')
    .replace(/全链路生产/g, '视频制作')
    .replace(/随时查询进度了解制作进展/g, '我会继续跟进制作进度')
    .replace(/[，,]\s*[，,]+/g, '，')
    .replace(/，\s*。/g, '。')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const alreadyUserFacing = cleaned.match(/^已开始制作「(.+)」的带货视频。/);
  if (alreadyUserFacing) {
    const product = normalizeAgentProductLabel(alreadyUserFacing[1]);
    return product ? `已开始制作「${product}」的带货视频方案。我会先整理调研、剧本和分镜；确认后再生成成片。` : cleaned;
  }

  if (/已成功启动|已开始|启动.*视频|制作队列/.test(cleaned) && /视频|成片|带货/.test(cleaned)) {
    const quotedProduct = cleaned.match(/「([^」]+)」/)?.[1]?.trim();
    const productMatch = cleaned.match(/(?:启动|开始)(.+?)(?:带货视频|视频制作|视频)/);
    const product = normalizeAgentProductLabel(quotedProduct || productMatch?.[1] || '');
    return product
      ? `已开始制作「${product}」的带货视频方案。我会先整理调研、剧本和分镜；确认后再生成成片。`
      : '已开始制作带货视频方案。我会先整理调研、剧本和分镜；确认后再生成成片。';
  }

  return cleaned;
}

function findStartedAgentRun(steps: AgentChatStep[] | undefined): AgentChatStartedRun | null {
  for (const step of [...(steps || [])].reverse()) {
    const result = asRecord(step.result);
    if (result.action !== 'started_agent_run') continue;
    const taskId = typeof result.taskId === 'string' ? result.taskId : '';
    const runId = typeof result.runId === 'string' ? result.runId : '';
    const kind = typeof result.kind === 'string' ? result.kind : '';
    if (!taskId || !runId) continue;
    if (
      kind !== 'one_click_video' &&
      kind !== 'script_generate' &&
      kind !== 'render_full' &&
      kind !== 'repair_shot' &&
      kind !== 'ab_test'
    ) {
      continue;
    }
    return {
      taskId,
      runId,
      kind,
      productId: typeof result.productId === 'string' ? result.productId : undefined,
      productTitle: typeof result.productTitle === 'string' ? result.productTitle : undefined,
    };
  }
  return null;
}

function findStartedAgentRunFromUiEvent(event: AgentUiStreamEvent): AgentChatStartedRun | null {
  const handles =
    event.type === 'CUSTOM' || event.type === 'TOOL_CALL_RESULT' || event.type === 'STATE_SNAPSHOT'
      ? event.type === 'STATE_SNAPSHOT'
        ? event.state.activeRun
        : event.handles
      : undefined;
  const taskId = typeof handles?.taskId === 'string' ? handles.taskId : '';
  const runId = typeof handles?.runId === 'string' ? handles.runId : '';
  const kind = typeof handles?.kind === 'string' ? handles.kind : '';
  if (!taskId || !runId) return null;
  if (
    kind !== 'one_click_video' &&
    kind !== 'script_generate' &&
    kind !== 'render_full' &&
    kind !== 'repair_shot' &&
    kind !== 'ab_test'
  ) {
    return null;
  }
  return {
    taskId,
    runId,
    kind,
    productId: typeof handles?.productId === 'string' ? handles.productId : undefined,
  };
}

function toolStatusFromAgentUi(ui: { status?: unknown }) {
  const row = asRecord(ui);
  if (row.status === 'failed') return 'failed' as const;
  if (row.status === 'running') return 'running' as const;
  return 'done' as const;
}

function shouldShowToolInMerchantTimeline(toolName?: string) {
  return toolName !== 'assess_project_brief';
}

function attachmentStatusText(file: ChatAttachment) {
  if (file.status === 'uploading') return '上传中';
  if (file.status === 'failed') return '上传失败';
  return file.materialId ? '已入库' : formatBytes(file.size);
}

function shouldUploadAsMaterial(file: File) {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

async function readAgentChatEventStream(
  response: Response,
  onEvent: (event: AgentChatStreamEvent) => void | Promise<void>,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('浏览器不支持流式响应');

  const decoder = new TextDecoder();
  let buffer = '';

  const parseBlock = async (block: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    try {
      const data = JSON.parse(dataLines.join('\n')) as unknown;
      if (eventName === 'script') await onEvent({ type: 'script', script: data as Partial<ScriptData> });
      else if (eventName === 'agent_ui') await onEvent({ type: 'agent_ui', event: data as AgentUiStreamEvent });
      else await onEvent({ ...(asRecord(data) as Record<string, unknown>), type: eventName } as AgentChatStreamEvent);
    } catch {
      /* ignore malformed SSE event */
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) await parseBlock(block);
  }
  const tail = `${buffer}${decoder.decode()}`.trim();
  if (tail) await parseBlock(tail);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

// 「打开工作台」意图：必须以打开/看 等动词开头，避免误伤普通生成/提问。
const WORKBENCH_LABELS: Partial<Record<AppPage, string>> = {
  script: '制作台（分镜 / 时间轴）',
  materials: '素材库',
  analytics: '投放诊断',
  passport: '交付结果',
  clone: '爆款配方雷达',
};
function matchWorkbenchTarget(text: string): AppPage | null {
  const t = text.trim();
  if (!/^(打开|进入|切到|跳到|前往|去|看一下|看看|看)/.test(t)) return null;
  if (/制作台|工作台|分镜|脚本|时间轴/.test(t)) return 'script';
  if (/素材/.test(t)) return 'materials';
  if (/诊断|看板|数据|投放|转化/.test(t)) return 'analytics';
  if (/交付|结果|成片|视频/.test(t)) return 'passport';
  if (/爆款|雷达|配方|参考/.test(t)) return 'clone';
  return null;
}

// ─── Chat Input ───────────────────────────────────────────────────────────────

function ChatInput({
  placement,
  value,
  disabled,
  canSubmit,
  onChange,
  onSubmit,
  attachments,
  webSearchMode,
  onFilesSelected,
  onRemoveAttachment,
  onSaveAttachment,
  onToggleWebSearch,
  placeholder,
  activityLabel,
  interruptBusy,
  onInterrupt,
}: {
  placement: 'center' | 'dock';
  value: string;
  disabled: boolean;
  canSubmit: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  attachments: ChatAttachment[];
  webSearchMode: boolean;
  onFilesSelected: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onSaveAttachment?: (id: string) => void;
  onToggleWebSearch: () => void;
  placeholder?: string;
  activityLabel?: string;
  interruptBusy?: boolean;
  onInterrupt?: () => void;
}) {
  const inputId = `${placement}-composer-file-input`;
  const toolsMenuId = `${placement}-composer-tools-menu`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolsWrapRef = useRef<HTMLDivElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const canInterrupt = Boolean(activityLabel && onInterrupt);

  useEffect(() => {
    if (!toolsOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (toolsWrapRef.current?.contains(event.target as Node)) return;
      setToolsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setToolsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [toolsOpen]);

  const openFilePicker = () => {
    if (disabled) return;
    setToolsOpen(false);
    fileInputRef.current?.click();
  };

  return (
    <form
      className={`chat-composer-wrap ${placement}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div className="chat-composer">
        <input
          id={inputId}
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          accept="image/*,video/*,.pdf,.doc,.docx,.txt,.csv,.xlsx,.xls"
          disabled={disabled}
          onChange={(event) => {
            onFilesSelected(event.target.files);
            event.currentTarget.value = '';
          }}
        />
        <div className="chat-composer-input-row">
          <textarea
            value={value}
            disabled={disabled}
            aria-label="输入商品信息或提问"
            name="chat-message"
            autoComplete="off"
            placeholder={placeholder ?? (disabled ? '处理中…' : '商品名/链接，或直接提问')}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (canSubmit) onSubmit();
              }
            }}
          />
          {canInterrupt ? (
            <div className="composer-interrupt-control" role="group" aria-label={`${activityLabel}，可停止`}>
              <span className="composer-run-state" role="status" aria-live="polite">
                <span className="composer-run-dot" aria-hidden="true" />
                <span className="composer-run-label">{activityLabel}</span>
              </span>
              <button
                type="button"
                className="chat-send stop"
                disabled={interruptBusy}
                aria-label="停止当前动作并修改需求"
                title="停止当前动作并修改需求"
                onClick={onInterrupt}
              >
                {interruptBusy ? (
                  <Loader2 size={15} className="spin" aria-hidden="true" />
                ) : (
                  <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                )}
              </button>
            </div>
          ) : null}
          {!canInterrupt || !disabled ? (
            <button type="submit" className="chat-send" disabled={!canSubmit} aria-label="发送">
              {disabled ? <Loader2 size={16} className="spin" /> : <ArrowRight size={17} />}
            </button>
          ) : null}
        </div>
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="已添加附件">
            {attachments.map((file) => (
              <span key={file.id} className={`composer-attachment ${file.status}`}>
                <FileText size={13} aria-hidden="true" />
                <span className="composer-attachment-name" title={file.name}>
                  {file.name}
                </span>
                <span className="composer-attachment-status">{attachmentStatusText(file)}</span>
                {onSaveAttachment && file.status === 'ready' && file.type.startsWith('image/') && (
                  <button
                    type="button"
                    className="composer-attachment-save"
                    disabled={disabled || file.savedToLibrary}
                    title={file.savedToLibrary ? '已存入素材库' : '存入素材库'}
                    onClick={() => onSaveAttachment(file.id)}
                  >
                    {file.savedToLibrary ? '已存库' : '存入素材库'}
                  </button>
                )}
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label={`移除 ${file.name}`}
                  disabled={disabled}
                  onClick={() => onRemoveAttachment(file.id)}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-composer-toolbar" aria-label="输入辅助工具">
          <div className="plus-menu-wrap" ref={toolsWrapRef}>
            <button
              type="button"
              className={`chat-add${toolsOpen ? ' active' : ''}${webSearchMode ? ' search-active' : ''}`}
              disabled={disabled}
              aria-label={toolsOpen ? '关闭工具菜单' : '打开工具菜单'}
              aria-expanded={toolsOpen}
              aria-controls={toolsOpen ? toolsMenuId : undefined}
              onClick={() => setToolsOpen((open) => !open)}
            >
              {toolsOpen ? <X size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
            </button>
            {toolsOpen && (
              <div id={toolsMenuId} className="plus-menu composer-tools-menu" role="menu">
                <button
                  type="button"
                  className="plus-menu-item"
                  role="menuitem"
                  disabled={disabled}
                  onClick={openFilePicker}
                >
                  <Paperclip size={16} aria-hidden="true" />
                  <span>上传文件</span>
                </button>
                <button
                  type="button"
                  className={`plus-menu-item${webSearchMode ? ' active' : ''}`}
                  role="menuitemcheckbox"
                  aria-checked={webSearchMode}
                  disabled={disabled}
                  onClick={() => {
                    onToggleWebSearch();
                    setToolsOpen(false);
                  }}
                >
                  <Globe2 size={16} aria-hidden="true" />
                  <span>网络搜索</span>
                  {webSearchMode && <span className="plus-menu-status" aria-hidden="true" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ChatPage({
  productId,
  productTitle,
  research,
  script,
  task,
  activeAgentRunId,
  busy,
  error,
  quickInput: _quickInput,
  magicProgress,
  renderVersions,
  activeRenderVersionId,
  initialMessages,
  initialActivityItems,
  projectSnapshot,
  historyItems,
  sessionId,
  onChatReferenceImage,
  onQuickInputChange,
  onNavigate: _onNavigate,
  onUseResult,
  onSelectResult,
  onRegenerate,
  onAgentRunStarted,
  onAgentScriptUpdated,
  onOpenWorkbench,
  onPauseGeneration,
  pauseGenerationBusy,
  onSelectSession,
  onPersistSession,
}: {
  productId: string;
  productTitle?: string;
  research: ResearchData | null;
  script: ScriptData | null;
  task: { id: string; status?: string } | null;
  activeAgentRunId?: string | null;
  busy: 'research' | 'script' | 'compose' | 'render' | null;
  error: string | null;
  quickInput: string;
  magicProgress: MagicProgressState;
  renderVersions?: RenderVersion[];
  activeRenderVersionId?: string | null;
  initialMessages?: ChatHistoryMessage[];
  initialActivityItems?: ChatHistoryActivityItem[];
  projectSnapshot?: ChatProjectSnapshot;
  historyItems?: ChatHistoryItem[];
  sessionId?: string;
  onChatReferenceImage?: (url: string | null) => void;
  onQuickInputChange: (input: string) => void;
  onNavigate: (page: 'script') => void;
  onUseResult: (renderVersionId?: string) => void;
  onSelectResult?: (renderVersionId: string) => void;
  onRegenerate: () => void;
  onAgentRunStarted?: (run: AgentChatStartedRun) => void;
  onAgentScriptUpdated?: (script: Partial<ScriptData>) => void;
  onOpenWorkbench?: (page: AppPage) => void;
  onPauseGeneration?: () => void | Promise<void>;
  pauseGenerationBusy?: boolean;
  onSelectSession?: (sessionId: string) => void;
  onPersistSession?: (session: Omit<ChatHistoryItem, 'createdAt' | 'updatedAt'> & { createdAt?: number }) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [activityItems, setActivityItems] = useState<ActivityItem[]>(() =>
    initialActivityItems?.length
      ? initialActivityItems.map(activityFromHistory)
      : (initialMessages || []).map((m) => ({
          id: m.id,
          kind: m.role === 'user' ? ('chat-user' as const) : ('chat-bot' as const),
          text: m.role === 'assistant' ? userFacingAgentText(m.text) : m.text,
        })),
  );
  const [activeSubject, setActiveSubject] = useState(productTitle || '');
  const [routeBusy, setRouteBusy] = useState(false);
  const [tagline] = useState(TAGLINES[0]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [webSearchMode, setWebSearchMode] = useState(false);
  const [progressAnchorItemId, setProgressAnchorItemId] = useState<string | null>(null);

  const sessionIdRef = useRef(sessionId || newSessionId());
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const latestActivityItemIdRef = useRef('__start__');
  const onPersistSessionRef = useRef(onPersistSession);
  const streamAbortRef = useRef<AbortController | null>(null);
  const latestStartedRunRef = useRef<AgentChatStartedRun | null>(null);
  const interruptNoticeShownRef = useRef(false);
  const [interruptBusy, setInterruptBusy] = useState(false);

  useEffect(() => {
    onPersistSessionRef.current = onPersistSession;
  }, [onPersistSession]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  const hasMagicProgress = Object.values(magicProgress.acts).some((act) => act.status !== 'pending');
  const hasStarted = activityItems.length > 0 || busy !== null || Boolean(error) || hasMagicProgress;
  const showMagicProgress = Boolean(busy || magicProgress.renderResult || hasMagicProgress);
  const renderResultKey = renderResultAnchorKey(magicProgress.renderResult);
  const renderInProgress = busy === 'render' || magicProgress.acts.render.status === 'active';
  const latestActivityItemId = activityItems.at(-1)?.id || '__start__';
  const refineSuggestions = useMemo(() => buildRefineSuggestions(script, productTitle), [productTitle, script]);
  const hasUploadingAttachment = attachments.some((file) => file.status === 'uploading');
  const disabled = routeBusy || hasUploadingAttachment;
  const canSubmit = (prompt.trim().length > 0 || attachments.length > 0) && !disabled;
  const recentItems = (historyItems || []).filter((item) => item.id !== sessionIdRef.current).slice(0, 3);
  const latestChatItem = [...activityItems]
    .reverse()
    .find((item) => item.kind === 'chat-user' || item.kind === 'chat-bot');
  const showThinking = routeBusy && latestChatItem?.kind === 'chat-user';
  const canInterrupt = routeBusy || Boolean(onPauseGeneration);
  const interruptLabel = canInterrupt ? (routeBusy ? '正在思考' : '正在制作') : undefined;
  const activeTaskId =
    task?.status && ['queued', 'pending', 'processing', 'waiting_input'].includes(task.status) ? task.id : undefined;
  const actionLocked = disabled || busy !== null || Boolean(activeTaskId);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const scrollElement = document.scrollingElement || document.documentElement;
    const bottom = Math.max(scrollElement.scrollHeight, document.body.scrollHeight);

    logEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    chatBodyRef.current?.scrollTo({ top: chatBodyRef.current.scrollHeight, behavior });
    scrollElement.scrollTo({ top: bottom, behavior });
    window.scrollTo({ top: bottom, behavior });
  }, []);

  useEffect(() => {
    latestActivityItemIdRef.current = latestActivityItemId;
  }, [latestActivityItemId]);

  useEffect(() => {
    if (!showMagicProgress) {
      setProgressAnchorItemId(null);
      return;
    }
    if (renderResultKey || renderInProgress) return;
    setProgressAnchorItemId((current) => {
      if (current && activityItems.some((item) => item.id === current)) return current;
      return activityItems.at(-1)?.id || '__start__';
    });
  }, [activityItems, renderInProgress, renderResultKey, showMagicProgress]);

  useEffect(() => {
    if (!showMagicProgress || (!renderResultKey && !renderInProgress)) return;
    setProgressAnchorItemId(latestActivityItemIdRef.current);
  }, [renderInProgress, renderResultKey, showMagicProgress]);

  const { activityBlocksBeforeProgress, activityBlocksAfterProgress } = useMemo(() => {
    if (!showMagicProgress || !progressAnchorItemId) {
      return { activityBlocksBeforeProgress: buildActivityBlocks(activityItems), activityBlocksAfterProgress: [] };
    }
    const progressAnchorIndex = activityItems.findIndex((item) => item.id === progressAnchorItemId);
    const splitIndex = Math.max(0, progressAnchorIndex + 1);
    return {
      activityBlocksBeforeProgress: buildActivityBlocks(activityItems.slice(0, splitIndex)),
      activityBlocksAfterProgress: buildActivityBlocks(activityItems.slice(splitIndex)),
    };
  }, [activityItems, progressAnchorItemId, showMagicProgress]);

  useEffect(() => {
    scrollChatToBottom('smooth');
    const frame = window.requestAnimationFrame(() => scrollChatToBottom('smooth'));
    const settleTimer = window.setTimeout(() => scrollChatToBottom('auto'), 120);
    const mediaTimer = window.setTimeout(() => scrollChatToBottom('auto'), 360);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.clearTimeout(mediaTimer);
    };
  }, [
    activityItems,
    busy,
    magicProgress.acts.compose.status,
    magicProgress.acts.render.status,
    magicProgress.renderTask?.progress,
    magicProgress.renderTask?.status,
    progressAnchorItemId,
    renderInProgress,
    renderResultKey,
    routeBusy,
    script?.id,
    showMagicProgress,
    scrollChatToBottom,
    task?.id,
    task?.status,
  ]);

  const addItem = useCallback((item: ActivityItem) => {
    setActivityItems((prev) => [...prev, item]);
  }, []);

  const replaceBotText = useCallback((botId: string, text: string) => {
    setActivityItems((prev) =>
      prev.map((item) => (item.id === botId ? { ...item, text: userFacingAgentText(text) } : item)),
    );
  }, []);

  const upsertToolItem = useCallback((toolId: string, patch: Partial<ActivityItem>) => {
    setActivityItems((prev) => {
      const index = prev.findIndex((item) => item.id === toolId);
      if (index === -1) {
        return [
          ...prev,
          {
            id: toolId,
            kind: 'tool' as const,
            text: patch.text || '工具调用中',
            meta: patch.meta,
            toolName: patch.toolName,
            toolStatus: patch.toolStatus || 'running',
            toolArgs: patch.toolArgs,
          },
        ];
      }
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }, []);

  const stopRunningToolItems = useCallback(() => {
    setActivityItems((prev) =>
      prev.map((item) =>
        item.kind === 'tool' && item.toolStatus === 'running'
          ? { ...item, toolStatus: 'stopped', meta: '已停止，等待你修改需求' }
          : item,
      ),
    );
  }, []);

  // Persist session when chat messages appear (uses ref so history updates don't loop)
  useEffect(() => {
    const persist = onPersistSessionRef.current;
    if (!persist) return;
    const chatItems = activityItems.filter((i) => i.kind === 'chat-user' || i.kind === 'chat-bot');
    if (!chatItems.some((i) => i.kind === 'chat-user')) return;
    const firstUser = chatItems.find((i) => i.kind === 'chat-user');
    const title = deriveTitle({ productTitle: activeSubject, firstUserText: firstUser?.text });
    persist({
      id: sessionIdRef.current,
      title,
      productId: productId || latestStartedRunRef.current?.productId || undefined,
      productTitle: activeSubject || undefined,
      scriptId: script?.id,
      taskId: task?.id || latestStartedRunRef.current?.taskId,
      runId: activeAgentRunId || latestStartedRunRef.current?.runId || undefined,
      messages: chatItems.map((i) => ({
        id: i.id,
        role: i.kind === 'chat-user' ? 'user' : 'assistant',
        text: i.kind === 'chat-bot' ? userFacingAgentText(i.text) : i.text,
      })),
      activityItems: activityItems.map(activityToHistory),
      magicProgress,
      projectSnapshot,
    });
  }, [activityItems, activeAgentRunId, magicProgress, productId, activeSubject, projectSnapshot, script?.id, task?.id]);

  const interruptAgent = async () => {
    if (!canInterrupt || interruptBusy) return;
    setInterruptBusy(true);
    try {
      interruptNoticeShownRef.current = true;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      if (onPauseGeneration) await onPauseGeneration();
      stopRunningToolItems();
      setRouteBusy(false);
      setPrompt((current) => current || '请按我的新要求调整：');
      addItem({
        id: newId(),
        kind: 'chat-bot',
        text:
          latestStartedRunRef.current || onPauseGeneration
            ? '已停止当前动作。你可以直接修改需求后重新提交，我会按新的要求继续。'
            : '已停止当前思考。你可以直接修改需求后重新提交。',
      });
    } finally {
      setInterruptBusy(false);
    }
  };

  const submitInput = async (text: string, attachedFiles: ChatAttachment[], options?: { webSearch?: boolean }) => {
    // 1) 打开工作台（VS Code 式扩展）：纯导航，不生成。
    if (onOpenWorkbench && !attachedFiles.length) {
      const target = matchWorkbenchTarget(text);
      if (target) {
        addItem({ id: newId(), kind: 'chat-user', text });
        addItem({ id: newId(), kind: 'chat-bot', text: `已为你打开${WORKBENCH_LABELS[target]}。` });
        onOpenWorkbench(target);
        return;
      }
    }

    // 2) 聊天里贴的商品图作为本次生成的临时参考图（grounding），不入素材库。
    const imageRef = attachedFiles.find((f) => f.type.startsWith('image/') && f.sourceUrl)?.sourceUrl;
    if (onChatReferenceImage) {
      onChatReferenceImage(
        imageRef ? (imageRef.startsWith('http') ? imageRef : `${window.location.origin}${imageRef}`) : null,
      );
    }
    const userId = newId();
    const botId = newId();
    const routeMessage = attachedFiles.length ? `${text}\n\n附件：${attachmentSummary(attachedFiles)}` : text;
    const thinkingStartedAt = Date.now();
    addItem({ id: userId, kind: 'chat-user', text, attachments: attachedFiles });
    setRouteBusy(true);
    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    interruptNoticeShownRef.current = false;
    if (!onPauseGeneration) latestStartedRunRef.current = null;
    let botInserted = false;
    let streamedReply = '';
    let startedRun: AgentChatStartedRun | null = null;
    let agentUiProtocolSeen = false;
    let agentUiTextSeen = false;

    const waitForThinkingCue = async () => {
      const remaining = 420 - (Date.now() - thinkingStartedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
    };

    const ensureBotItem = async () => {
      if (botInserted) return;
      await waitForThinkingCue();
      botInserted = true;
      addItem({ id: botId, kind: 'chat-bot', text: '' });
    };

    const handleStartedRun = async (started: AgentChatStartedRun) => {
      startedRun = started;
      latestStartedRunRef.current = started;
      if (started.productTitle) {
        setActiveSubject(started.productTitle);
        onQuickInputChange(started.productTitle);
      }
      onAgentRunStarted?.(started);
    };

    try {
      const resp = await fetch(`${API_BASE}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        signal: controller.signal,
        body: JSON.stringify({
          stream: true,
          messages: [
            ...activityItems
              .filter((i) => i.kind === 'chat-user' || i.kind === 'chat-bot')
              .slice(-10)
              .map((i) => ({
                role: i.kind === 'chat-user' ? 'user' : 'assistant',
                content: i.kind === 'chat-bot' ? userFacingAgentText(i.text) : i.text,
              })),
            { role: 'user', content: routeMessage },
          ],
          attachments: attachedFiles.map((file) => ({
            name: file.name,
            size: file.size,
            type: file.type,
            status: file.status,
            materialId: file.materialId,
            taskId: file.taskId,
            error: file.error,
          })),
          productId,
          productTitle: activeSubject || productTitle,
          scriptId: script?.id,
          activeRunId: activeAgentRunId || undefined,
          activeTaskId,
          referenceImageUrl: imageRef,
          hasResearch: research !== null,
          hasScript: script !== null,
          webSearch: options?.webSearch === true,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await readAgentChatEventStream(resp, async (event) => {
        if (event.type === 'agent_ui') {
          agentUiProtocolSeen = true;
          const uiEvent = event.event;
          if (uiEvent.type === 'TEXT_MESSAGE_CONTENT') {
            agentUiTextSeen = true;
            streamedReply += uiEvent.delta || '';
            await ensureBotItem();
            replaceBotText(botId, streamedReply);
            return;
          }
          if (uiEvent.type === 'TOOL_CALL_START') {
            if (!shouldShowToolInMerchantTimeline(uiEvent.toolName)) return;
            const toolId = `${botId}_${uiEvent.toolCallId}`;
            await ensureBotItem();
            upsertToolItem(toolId, {
              toolName: uiEvent.toolName,
              toolStatus: 'running',
              text: uiEvent.ui.title,
              meta: uiEvent.ui.summary,
              toolArgs: {},
              toolResult: { ui: uiEvent.ui, agentUiDetailLines: uiEvent.ui.detailLines || [] },
            });
            return;
          }
          if (uiEvent.type === 'TOOL_CALL_RESULT') {
            if (!shouldShowToolInMerchantTimeline(uiEvent.toolName)) return;
            const toolId = `${botId}_${uiEvent.toolCallId}`;
            upsertToolItem(toolId, {
              toolName: uiEvent.toolName,
              toolStatus: toolStatusFromAgentUi(uiEvent.ui),
              text: uiEvent.ui.title,
              meta: uiEvent.ui.summary,
              toolArgs: {},
              toolResult: { ui: uiEvent.ui, agentUiDetailLines: uiEvent.ui.detailLines || [] },
            });
            const started = findStartedAgentRunFromUiEvent(uiEvent);
            if (started && !startedRun) await handleStartedRun(started);
            return;
          }
          if (uiEvent.type === 'CUSTOM') {
            const started = findStartedAgentRunFromUiEvent(uiEvent);
            if (started && !startedRun) await handleStartedRun(started);
            return;
          }
          if (uiEvent.type === 'RUN_ERROR') {
            throw new Error(uiEvent.message || 'Agent 流式响应失败');
          }
          return;
        }
        if (event.type === 'token') {
          if (agentUiTextSeen) return;
          const token = event.content || '';
          streamedReply += token;
          await ensureBotItem();
          replaceBotText(botId, streamedReply);
          return;
        }
        if (event.type === 'tool_call') {
          if (agentUiProtocolSeen) return;
          const tool = event.tool || 'unknown';
          if (!shouldShowToolInMerchantTimeline(tool)) return;
          const toolId = `${botId}_tool_${event.step || 0}_${tool}`;
          await ensureBotItem();
          upsertToolItem(toolId, {
            toolName: tool,
            toolStatus: 'running',
            text: toolLabel(tool),
            meta: summarizeToolArgs(event.args),
            toolArgs: event.args,
          });
          return;
        }
        if (event.type === 'tool_result') {
          if (agentUiProtocolSeen) return;
          const tool = event.tool || 'unknown';
          if (!shouldShowToolInMerchantTimeline(tool)) return;
          const toolId = `${botId}_tool_${event.step || 0}_${tool}`;
          const result = asRecord(event.result);
          const failed = typeof result.error === 'string' || result.ok === false;
          upsertToolItem(toolId, {
            toolName: tool,
            toolStatus: failed ? 'failed' : 'done',
            text: toolLabel(tool),
            meta: summarizeToolResult(event.result),
            toolArgs: event.args,
            toolResult: event.result,
          });
          return;
        }
        if (event.type === 'started_run') {
          const started = findStartedAgentRun([{ tool: 'started_run', args: {}, result: event }]);
          if (started && !startedRun) await handleStartedRun(started);
          return;
        }
        if (event.type === 'script' && event.script && onAgentScriptUpdated) {
          onAgentScriptUpdated(event.script);
          return;
        }
        if (event.type === 'done') {
          if (event.script && onAgentScriptUpdated) onAgentScriptUpdated(event.script);
          if (!startedRun) {
            const started = findStartedAgentRun(event.steps);
            if (started) await handleStartedRun(started);
          }
          const reply = userFacingAgentText(event.reply?.trim() || streamedReply.trim() || '我已经处理完这一步。');
          await ensureBotItem();
          setActivityItems((prev) =>
            prev.map((item) => (item.id === botId && !item.text.trim() ? { ...item, text: reply } : item)),
          );
          return;
        }
        if (event.type === 'error') {
          throw new Error(event.message || 'Agent 流式响应失败');
        }
      });
    } catch (chatError) {
      if (isAbortError(chatError)) {
        if (!interruptNoticeShownRef.current) {
          await ensureBotItem();
          stopRunningToolItems();
          replaceBotText(botId, '已停止当前动作。你可以修改需求后重新提交。');
          interruptNoticeShownRef.current = true;
        }
        return;
      }
      addItem({ id: newId(), kind: 'error', text: '生产 Agent 暂时不可用，请重试。' });
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
      setRouteBusy(false);
    }
  };

  const handleSubmit = async () => {
    const text = prompt.trim() || (attachments.length ? '请基于附件继续处理' : '');
    if ((!text && !attachments.length) || disabled) return;
    const attachedFiles = attachments;
    setPrompt('');
    setAttachments([]);
    await submitInput(text, attachedFiles, { webSearch: webSearchMode });
  };

  // 保留 File 以便用户点「存入素材库」时正常入库（不带 scope=chat）。
  const attachmentFilesRef = useRef<Map<string, File>>(new Map());
  const saveAttachmentToLibrary = async (attachmentId: string) => {
    const file = attachmentFilesRef.current.get(attachmentId);
    if (!file) return;
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('name', file.name);
      body.append('sourceDeclaration', '商家上传（对话框存入素材库）');
      if (productId) body.append('productId', productId);
      const response = await fetch(`${API_BASE}/materials/upload`, { method: 'POST', body });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAttachments((prev) =>
        prev.map((item) => (item.id === attachmentId ? { ...item, savedToLibrary: true } : item)),
      );
    } catch {
      /* 忽略：失败不影响对话 */
    }
  };

  const uploadAttachment = async (attachmentId: string, file: File) => {
    if (!shouldUploadAsMaterial(file)) {
      setAttachments((prev) =>
        prev.map((item) => (item.id === attachmentId ? { ...item, status: 'ready' as const } : item)),
      );
      return;
    }

    try {
      const body = new FormData();
      body.append('file', file);
      body.append('name', file.name);
      body.append('sourceDeclaration', '对话框附件（临时上下文）');
      // 聊天附件是本次对话的临时上下文，不入素材库（scope=chat → 后端跳过 Material/Slice/向量）。
      body.append('scope', 'chat');

      const response = await fetch(`${API_BASE}/materials/upload`, { method: 'POST', body });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { materialId?: string; sourceUrl?: string };
      // 临时上传不标记 materialId（它没真正入库），只留可用 URL。
      setAttachments((prev) =>
        prev.map((item) =>
          item.id === attachmentId ? { ...item, status: 'ready' as const, sourceUrl: payload.sourceUrl } : item,
        ),
      );
    } catch (uploadError) {
      setAttachments((prev) =>
        prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: 'failed' as const,
                error: uploadError instanceof Error ? uploadError.message : '上传失败',
              }
            : item,
        ),
      );
    }
  };

  const handleFilesSelected = (files: FileList | null) => {
    if (!files?.length) return;
    const availableSlots = Math.max(0, 8 - attachments.length);
    if (availableSlots === 0) return;
    const selected = Array.from(files)
      .slice(0, availableSlots)
      .map((file) => ({
        file,
        attachment: {
          id: newId(),
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          status: 'uploading' as const,
        },
      }));
    setAttachments((prev) => [...prev, ...selected.map((item) => item.attachment)].slice(0, 8));
    selected.forEach((item) => {
      attachmentFilesRef.current.set(item.attachment.id, item.file);
      void uploadAttachment(item.attachment.id, item.file);
    });
  };

  return (
    <main id="main-content" className={`chat-shell${hasStarted ? ' expanded' : ' initial'}`}>
      {!hasStarted ? (
        /* ── Landing ─────────────────────────────────────────────── */
        <div className="initial-wrap cinematic-entry">
          <section className="initial-prompt cinematic-copy">
            <div className="initial-logo">
              <span className="initial-logo-mark" />
            </div>
            <p className="cinematic-kicker">AI video production studio</p>
            <h1 className="initial-headline">{tagline.main}</h1>
            <p className="initial-sub">{tagline.sub}</p>
            <div className="cinematic-composer-panel">
              <ChatInput
                placement="center"
                value={prompt}
                disabled={disabled}
                canSubmit={canSubmit}
                onChange={setPrompt}
                onSubmit={() => void handleSubmit()}
                attachments={attachments}
                webSearchMode={webSearchMode}
                onFilesSelected={handleFilesSelected}
                onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((item) => item.id !== id))}
                onSaveAttachment={saveAttachmentToLibrary}
                onToggleWebSearch={() => setWebSearchMode((value) => !value)}
                placeholder="粘贴商品链接，或描述一个想要制作的视频…"
                activityLabel={interruptLabel}
                interruptBusy={interruptBusy || pauseGenerationBusy}
                onInterrupt={() => void interruptAgent()}
              />
            </div>
            <button
              type="button"
              className="initial-demo-cta"
              disabled={disabled}
              onMouseMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                event.currentTarget.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
                event.currentTarget.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
              }}
              onClick={() => void submitInput(DEMO_PROMPT, [], { webSearch: false })}
              title="用内置示例商品直接跑完整一键成片，快速看到全链路"
            >
              <Sparkles size={16} aria-hidden="true" />
              <span>一键生成示例视频 · 看完整链路</span>
            </button>
            <div className="initial-examples cinematic-actions" aria-label="首页入口">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="example-chip"
                  disabled={disabled}
                  onClick={() => setPrompt(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
            <ul className="initial-trust" aria-label="核心能力">
              {TRUST_SIGNALS.map((signal) => (
                <li key={signal}>
                  <ShieldCheck size={13} aria-hidden="true" />
                  <span>{signal}</span>
                </li>
              ))}
            </ul>
            <section className="initial-recent" aria-label="最近作品">
              <div className="initial-recent-head">
                <h2>最近作品</h2>
                {recentItems.length > 0 && <span>{recentItems.length} 个可继续项目</span>}
              </div>
              <div className="initial-recent-grid">
                {recentItems.map((item) => {
                  const lastUserMessage = [...item.messages].reverse().find((message) => message.role === 'user');
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className="initial-recent-card"
                      onClick={() => onSelectSession?.(item.id)}
                      disabled={!onSelectSession}
                    >
                      <span className="initial-recent-thumb">
                        <Sparkles size={20} aria-hidden="true" />
                      </span>
                      <strong>{item.title}</strong>
                      <small>{lastUserMessage?.text || item.productTitle || '继续这个项目'}</small>
                      <em>{recentDateFormatter.format(new Date(item.updatedAt))}</em>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="initial-recent-card initial-recent-card--new"
                  onClick={() => setPrompt('')}
                >
                  <span className="initial-recent-new-icon">
                    <Plus size={18} aria-hidden="true" />
                  </span>
                  <strong>新建</strong>
                </button>
              </div>
            </section>
          </section>
          <CinematicStage />
        </div>
      ) : (
        /* ── Active: activity log ─────────────────────────────────── */
        <div ref={chatBodyRef} className="chat-body">
          {activeSubject && (
            <div className="activity-subject">
              <Sparkles size={12} aria-hidden="true" />
              <span>{activeSubject}</span>
            </div>
          )}

          <div className="activity-log">
            {activityBlocksBeforeProgress.map(renderActivityBlock)}
            {showMagicProgress && (
              <MagicProgress
                state={magicProgress}
                error={error || activityItems.find((item) => item.kind === 'error')?.text || null}
                renderVersions={renderVersions}
                activeRenderVersionId={activeRenderVersionId}
                onUseResult={onUseResult}
                onSelectResult={onSelectResult}
                onRegenerate={
                  actionLocked
                    ? undefined
                    : () => {
                        addItem({
                          id: newId(),
                          kind: 'chat-bot',
                          text: '正在基于当前剧本和分镜再生成一版。上一版不会被覆盖，完成后可以在成片版本里切换。',
                        });
                        onRegenerate();
                      }
                }
                onRefine={actionLocked ? undefined : (instruction) => submitInput(instruction, [])}
                refineSuggestions={refineSuggestions}
                onPause={onPauseGeneration}
                pauseBusy={pauseGenerationBusy}
              />
            )}
            {activityBlocksAfterProgress.map(renderActivityBlock)}
            {showThinking && (
              <div
                className="activity-chat-msg activity-chat-msg--bot activity-chat-msg--thinking"
                role="status"
                aria-live="polite"
              >
                <Loader2 size={14} className="spin" aria-hidden="true" />
                <span>思考中…</span>
              </div>
            )}
            {script && !magicProgress.renderResult && !renderInProgress && (
              <ScriptHandoffBar
                script={script}
                busy={busy}
                disabled={actionLocked}
                onOpenWorkbench={onUseResult}
                onRefine={actionLocked ? undefined : (instruction) => submitInput(instruction, [])}
              />
            )}
          </div>

          <div ref={logEndRef} className="chat-log-end" aria-hidden />
        </div>
      )}

      {/* Fixed dock — visible once a session starts */}
      {hasStarted && (
        <ChatInput
          placement="dock"
          value={prompt}
          disabled={disabled}
          canSubmit={canSubmit}
          onChange={setPrompt}
          onSubmit={() => void handleSubmit()}
          attachments={attachments}
          webSearchMode={webSearchMode}
          onFilesSelected={handleFilesSelected}
          onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((item) => item.id !== id))}
          onSaveAttachment={saveAttachmentToLibrary}
          onToggleWebSearch={() => setWebSearchMode((value) => !value)}
          placeholder={disabled ? '处理中…' : '继续提问，或输入新商品名开始新对话'}
          activityLabel={interruptLabel}
          interruptBusy={interruptBusy || pauseGenerationBusy}
          onInterrupt={() => void interruptAgent()}
        />
      )}
    </main>
  );
}
