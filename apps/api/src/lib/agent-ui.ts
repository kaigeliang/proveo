import { EventSchemas, EventType } from '@ag-ui/core';
import type {
  AgentUiHiddenHandles,
  AgentUiPhase,
  AgentUiState,
  AgentUiStreamEvent,
  AgentUiVisiblePayload,
  AgentUiVisibleStatus,
} from '@aigc-video-hub/shared';

function nowTimestamp() {
  return Date.now();
}

function validateAgentUiEvent(event: AgentUiStreamEvent) {
  EventSchemas.parse(event);
  return event;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeText(value: unknown, max = 90) {
  return textValue(value)
    .replace(/当前没有可改的剧本（缺\s*scriptId）。?/gi, '当前还没有生成剧本分镜，请先生成剧本后再修改镜头。')
    .replace(/缺\s*scriptId/gi, '缺少可编辑的剧本分镜')
    .replace(/`?(?:task|run|script)_[A-Za-z0-9_-]+`?/g, '')
    .replace(/\bscriptId\b/gi, '剧本分镜')
    .replace(/\btaskId\b/gi, '制作任务')
    .replace(/\brunId\b/gi, '制作任务')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function safeList(value: unknown, limit = 4) {
  return Array.isArray(value)
    ? value
        .map((item) => safeText(item, 80))
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function productSummary(args: Record<string, unknown>, result?: Record<string, unknown>) {
  const product = safeText(result?.productTitle || args.productTitle || args.title, 48);
  return product ? `商品：${product}` : undefined;
}

function countSummary(result: Record<string, unknown>, noun = '结果') {
  return typeof result.count === 'number' ? `${result.count} 条${noun}` : undefined;
}

function runHandles(result: Record<string, unknown>): AgentUiHiddenHandles | undefined {
  const handles: AgentUiHiddenHandles = {
    runId: textValue(result.runId) || undefined,
    taskId: textValue(result.taskId) || undefined,
    productId: textValue(result.productId) || undefined,
    scriptId: textValue(result.scriptId) || undefined,
    videoId: textValue(result.videoId) || undefined,
    kind: textValue(result.kind) || undefined,
  };
  return Object.values(handles).some(Boolean) ? handles : undefined;
}

function phaseForTool(toolName: string, result?: Record<string, unknown>): AgentUiPhase {
  const action = textValue(result?.action);
  if (action === 'brief_required') return 'needs_input';
  if (action === 'needs_render_confirmation') return 'awaiting_storyboard_confirmation';
  if (action === 'render_requirements_missing') return 'failed_need_materials';
  if (toolName === 'assess_project_brief') return 'needs_input';
  if (toolName === 'run_product_research' || toolName === 'search_reference_videos') return 'researching_product';
  if (toolName === 'search_uploaded_materials') return 'researching_product';
  if (toolName === 'start_script_generation') return 'generating_script';
  if (toolName === 'start_one_click_video') return 'generating_script';
  if (toolName === 'start_render_full') return 'generating_video';
  if (toolName === 'get_run_status') return 'checking_status';
  if (toolName === 'edit_shot') return 'editing_storyboard';
  return 'preparing';
}

function titleForTool(toolName: string, phase: AgentUiPhase, status: AgentUiVisibleStatus) {
  if (phase === 'needs_input') return status === 'done' ? '需要补充信息' : '确认制作需求';
  if (phase === 'researching_product') {
    if (toolName === 'search_reference_videos') return status === 'done' ? '爆款参考已整理' : '正在检索爆款参考';
    if (toolName === 'search_uploaded_materials') return status === 'done' ? '素材库已检查' : '正在检查素材库';
    return status === 'done' ? '商品调研已完成' : '正在调研商品';
  }
  if (phase === 'generating_script') return status === 'done' ? '剧本分镜已进入队列' : '正在生成剧本分镜';
  if (phase === 'awaiting_storyboard_confirmation') return '等待你确认分镜';
  if (phase === 'generating_video') return status === 'done' ? '视频生成已进入队列' : '正在生成视频';
  if (phase === 'failed_need_materials') return '生成失败，需要补素材';
  if (phase === 'checking_status') return status === 'done' ? '制作进度已更新' : '正在查询制作进度';
  if (phase === 'editing_storyboard') return status === 'done' ? '分镜已修改' : '正在修改分镜';
  return status === 'failed' ? '制作步骤失败' : status === 'done' ? '制作步骤完成' : '正在准备';
}

function briefDetails(result: Record<string, unknown>) {
  const missing = safeList(result.missing, 4);
  const known = safeList(result.known, 5);
  const lines: string[] = [];
  if (known.length) lines.push(`已确认：${known.join('、')}。`);
  if (missing.length) lines.push(`本轮先补：${missing.join('、')}。`);
  else if (result.readyForFullVideo) lines.push('脚本、分镜和商品素材已满足成片确认条件。');
  else if (result.readyForScript) lines.push('资料已足够先生成剧本和分镜，成片会等你确认后再开始。');
  else lines.push('先停在需求确认，补齐关键信息后再继续。');
  return lines;
}

function researchDetails(result: Record<string, unknown>) {
  const lines: string[] = [];
  const evidenceCount = typeof result.evidenceCount === 'number' ? result.evidenceCount : undefined;
  const approvedClaims = typeof result.approvedClaims === 'number' ? result.approvedClaims : undefined;
  if (evidenceCount !== undefined || approvedClaims !== undefined) {
    lines.push(
      `已整理${[
        evidenceCount !== undefined ? `${evidenceCount} 条资料` : '',
        approvedClaims !== undefined ? `${approvedClaims} 条可用表达` : '',
      ]
        .filter(Boolean)
        .join('，')}。`,
    );
  }
  const next = safeText(result.next, 120);
  if (next) lines.push(`下一步：${next}`);
  return lines;
}

function referenceDetails(result: Record<string, unknown>) {
  const lines: string[] = [];
  if (typeof result.count === 'number') {
    lines.push(
      result.count > 0
        ? `找到 ${result.count} 个参考样本，用来提炼 Hook、节奏和字幕策略。`
        : '当前没有命中参考样本，可换关键词或补充商品资料。',
    );
  }
  lines.push('参考库只提供方法，不会把原片当作当前商品素材复用。');
  return lines;
}

function materialDetails(result: Record<string, unknown>) {
  const lines: string[] = [];
  if (typeof result.count === 'number') {
    lines.push(
      result.count > 0
        ? `命中 ${result.count} 条当前商品素材，只作为 Seedance 生成参考。`
        : '当前商品素材库没有命中，可改查爆款参考或上传商品主图。',
    );
  }
  return lines;
}

function statusDetails(result: Record<string, unknown>) {
  const task = asRecord(result.task);
  const run = asRecord(result.run);
  const status = safeText(task.status || run.status, 32);
  if (!status) return ['当前没有正在跟踪的制作任务。'];
  const progress = typeof task.progress === 'number' ? `，进度约 ${Math.round(task.progress)}%` : '';
  return [`当前制作状态：${status}${progress}。`];
}

function resultDetails(toolName: string, result: Record<string, unknown>) {
  if (toolName === 'assess_project_brief') return briefDetails(result);
  if (toolName === 'run_product_research') return researchDetails(result);
  if (toolName === 'search_reference_videos') return referenceDetails(result);
  if (toolName === 'search_uploaded_materials') return materialDetails(result);
  if (toolName === 'get_run_status') return statusDetails(result);
  const missing = safeList(result.missing, 4);
  if (missing.length) return [`还缺：${missing.join('、')}。`];
  const reply = safeText(result.finalReply || result.reply, 140);
  return reply ? [reply] : [];
}

function summaryForTool(toolName: string, args: Record<string, unknown>, result?: Record<string, unknown>) {
  if (result?.error) return safeText(result.error, 120);
  if (toolName === 'search_reference_videos' || toolName === 'search_uploaded_materials') {
    return result ? countSummary(result, '结果') : safeText(args.query, 80) || undefined;
  }
  if (
    toolName === 'run_product_research' ||
    toolName === 'start_script_generation' ||
    toolName === 'start_one_click_video'
  ) {
    return productSummary(args, result);
  }
  if (toolName === 'start_render_full') return '使用已确认的分镜生成成片';
  if (toolName === 'edit_shot') return args.order ? `第 ${String(args.order)} 镜` : undefined;
  return undefined;
}

export function createAgentUiEventBuilder(input: { runId: string; messageId: string; threadId?: string }) {
  let seq = 0;
  const eventId = () => `agui_${Date.now().toString(36)}_${++seq}`;
  const threadId = input.threadId || input.runId;
  const base = () => ({ eventId: eventId(), timestamp: nowTimestamp() });
  const state = (phase: AgentUiPhase, status: AgentUiVisibleStatus, title: string, summary?: string): AgentUiState => ({
    phase,
    status,
    title,
    summary,
  });

  return {
    runStarted(): AgentUiStreamEvent {
      return validateAgentUiEvent({
        type: EventType.RUN_STARTED,
        ...base(),
        threadId,
        runId: input.runId,
        state: state('preparing', 'running', '正在准备生产 Agent'),
      });
    },
    state(phase: AgentUiPhase, status: AgentUiVisibleStatus, title: string, summary?: string): AgentUiStreamEvent {
      const snapshot = state(phase, status, title, summary);
      return validateAgentUiEvent({
        type: EventType.STATE_SNAPSHOT,
        ...base(),
        snapshot,
        state: snapshot,
      });
    },
    toolStart(toolName: string, args: Record<string, unknown>, step?: number): AgentUiStreamEvent {
      const phase = phaseForTool(toolName);
      const ui: AgentUiVisiblePayload = {
        phase,
        status: 'running',
        title: titleForTool(toolName, phase, 'running'),
        summary: summaryForTool(toolName, args),
      };
      return validateAgentUiEvent({
        type: EventType.TOOL_CALL_START,
        ...base(),
        toolCallId: `tool_${step || 0}_${toolName}`,
        toolCallName: toolName,
        toolName,
        step,
        ui,
      });
    },
    toolResult(toolName: string, args: Record<string, unknown>, result: unknown, step?: number): AgentUiStreamEvent {
      const row = asRecord(result);
      const failed = typeof row.error === 'string' || row.ok === false;
      const phase = phaseForTool(toolName, row);
      const status: AgentUiVisibleStatus =
        phase === 'needs_input' || phase === 'awaiting_storyboard_confirmation'
          ? 'waiting'
          : failed
            ? 'failed'
            : 'done';
      const ui: AgentUiVisiblePayload = {
        phase,
        status,
        title: titleForTool(toolName, phase, status),
        summary: summaryForTool(toolName, args, row),
        detailLines: resultDetails(toolName, row),
      };
      const handles = runHandles(row);
      return validateAgentUiEvent({
        type: EventType.TOOL_CALL_RESULT,
        ...base(),
        toolCallId: `tool_${step || 0}_${toolName}`,
        messageId: input.messageId,
        content: JSON.stringify({ ui, handles }),
        role: 'tool',
        toolName,
        step,
        ui,
        handles,
      });
    },
    runStartedCustom(result: unknown): AgentUiStreamEvent | null {
      const row = asRecord(result);
      const handles = runHandles(row);
      if (!handles?.runId || !handles.taskId) return null;
      const kind = textValue(handles.kind);
      const phase: AgentUiPhase = kind === 'render_full' ? 'generating_video' : 'generating_script';
      const ui: AgentUiVisiblePayload = {
        phase,
        status: 'running',
        title: kind === 'render_full' ? '正在生成视频' : '正在生成剧本分镜',
        summary: productSummary({}, row),
      };
      return validateAgentUiEvent({
        type: EventType.CUSTOM,
        ...base(),
        name: 'agent.run.started',
        value: { ui, handles },
        ui,
        handles,
      });
    },
    text(delta: string): AgentUiStreamEvent {
      return validateAgentUiEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        ...base(),
        messageId: input.messageId,
        delta,
      });
    },
    textEnd(): AgentUiStreamEvent {
      return validateAgentUiEvent({ type: EventType.TEXT_MESSAGE_END, ...base(), messageId: input.messageId });
    },
    done(): AgentUiStreamEvent {
      return validateAgentUiEvent({
        type: EventType.RUN_FINISHED,
        ...base(),
        threadId,
        runId: input.runId,
        outcome: { type: 'success' },
        state: state('completed', 'done', '制作 Agent 已完成本轮响应'),
      });
    },
    error(message: string): AgentUiStreamEvent {
      return validateAgentUiEvent({
        type: EventType.RUN_ERROR,
        ...base(),
        runId: input.runId,
        message: safeText(message, 160) || 'Agent 对话失败',
        state: state('failed', 'failed', '制作 Agent 响应失败'),
      });
    },
  };
}
