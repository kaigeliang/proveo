import type { Express, Response } from 'express';
import {
  REFERENCE_TEXT_EMBEDDING_MODEL,
  getAgentRun,
  getTask,
  searchReferenceQdrant,
  updateAgentRun,
  updateTask,
  upsertEvidenceRecord,
} from '@aigc-video-hub/db';
import type { AgentRunKind } from '@aigc-video-hub/agent-runtime';
import type { AgentUiStreamEvent } from '@aigc-video-hub/shared';
import { createQueuedAgentRun } from '../agent-runs';
import { createAgentUiEventBuilder } from '../agent-ui';
import {
  createProductionShot,
  createQueuedTask,
  deleteProductionShot,
  getProductionScript,
  patchProductionScript,
  patchProductionShot,
  searchProductionMaterialSlices,
} from '../production';
import { runAgentChat, type AgentChatMessage, type AgentChatStreamEvent, type AgentTool } from '../agent-chat';
import { embedText } from '../clip';
import { runResearchAgent, type ResearchOutput } from '../trustloop/research';
import { vectorSearchEnabled } from '../light-mode';

export type CopilotRoutesContext = {
  sendJsonError(res: Response, status: number, error: string): void;
  safeExternalError(error: unknown): string;
};

function textValue(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function boolValue(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function cleanIdPart(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
}

function latestUserText(messages: AgentChatMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'user')
    ?.content.trim();
}

// 只做 URL 抽取，不做意图/品类判断——纯文本工具，不是"大脑"。
function parseProductInput(value: string): { title: string; productUrl?: string } {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/https?:\/\/[^\s，。)）]+/i);
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0]);
      const title = trimmed
        .replace(urlMatch[0], '')
        .replace(/^[：:，,\s]+|[：:，,\s]+$/g, '')
        .trim();
      return { title: title || url.hostname.replace(/^www\./, '') || url.toString(), productUrl: url.toString() };
    } catch {
      // Keep the original text as the product title when URL parsing fails.
    }
  }
  return { title: trimmed };
}

// 模型用 workflowDecision 表达"它判断的下一步"，是 consent 机制的一部分，不是路由正则。
const WORKFLOW_DECISIONS = [
  'answer_only',
  'status_check',
  'ask_for_product',
  'research_first',
  'script_first',
  'review_script',
  'edit_only',
  'render_confirmed',
  'one_click_confirmed',
  'quick_preview_confirmed',
] as const;

type WorkflowDecision = (typeof WORKFLOW_DECISIONS)[number];

function workflowDecisionValue(value: unknown): WorkflowDecision | '' {
  return typeof value === 'string' && WORKFLOW_DECISIONS.includes(value as WorkflowDecision)
    ? (value as WorkflowDecision)
    : '';
}

function decisionReasonValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : '';
}

function activeRunBlocked(args: Record<string, unknown>, hasActiveRun: boolean) {
  return hasActiveRun && !boolValue(args.restartCurrentRun, false);
}

// 对 LLM 输出做脱敏/语气清理（作用在模型写的文本上，不替代它）。
function professionalTone(text: string) {
  return text
    .replace(/[哦啦哈呀哟嘛～~]+(?=[。！？!?，,\n]|$)/g, '')
    .replace(/呢(?=[？?\n]|$)/g, '')
    .replace(/确认一下/g, '确认')
    .replace(/补充一下/g, '补充')
    .replace(/看一下/g, '查看')
    .replace(/我这边/g, '我')
    .replace(/([。！？!?]){2,}/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function userFacingReply(text: string) {
  const cleaned = text
    .replace(/`?(?:task|run|script)_[A-Za-z0-9_-]+`?/g, '')
    .replace(/`?ref_[A-Za-z0-9_-]+`?/g, '参考样本')
    .replace(/(?:任务|运行|剧本|参考)\s*ID\s*[:：]\s*`?[\w-]*`?/gi, '')
    .replace(/参考样本\s*[，,、:：-]?\s*/g, '参考样本')
    .replace(/[，,]\s*[，,]+/g, '，')
    .replace(/，\s*。/g, '。')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return professionalTone(cleaned);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown, limit = 4) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, limit)
    : [];
}

function compactReferenceVideo(reference: Record<string, unknown>) {
  const report = objectValue(reference.breakdownReport);
  const metadata = objectValue(reference.metadata);
  const title =
    textValue(report.title) ||
    textValue(metadata.title) ||
    textValue(reference.sourceDeclaration) ||
    textValue(reference.id, '参考视频');
  return {
    id: reference.id,
    title,
    hook: textValue(report.hook),
    category: textValue(metadata.category),
    sourceUrl: textValue(reference.sourceUrl),
    sourceDeclaration: textValue(reference.sourceDeclaration),
    licenseType: textValue(reference.licenseType),
    usageScope: textValue(reference.usageScope),
    sellingPoints: stringList(report.sellingPoints),
    score: reference.score,
    vectorScore: reference.vectorScore,
  };
}

async function searchReferenceVideosForAgent(query: string, limit: number) {
  if (!vectorSearchEnabled()) {
    return {
      mode: 'reference-vector-disabled',
      warning: 'VPS light mode disabled CLIP/Qdrant reference search.',
      results: [],
    };
  }
  try {
    const queryVector = await embedText(query);
    const searchInput = {
      queryVector,
      embeddingModel: REFERENCE_TEXT_EMBEDDING_MODEL,
      limit,
      q: query,
    };
    const results = await searchReferenceQdrant(searchInput);
    if (results.length) {
      return {
        mode: 'reference-qdrant-jina-clip-v2',
        warning: undefined,
        results: results
          .slice(0, limit)
          .map((item) => compactReferenceVideo(item as unknown as Record<string, unknown>)),
      };
    }
  } catch (error) {
    const warning = error instanceof Error ? error.message : 'reference search failed';
    return { mode: 'reference-qdrant-error', warning, results: [] };
  }

  return { mode: 'reference-empty', warning: undefined, results: [] };
}

function compactResearchOutput(input: {
  productId: string;
  productTitle: string;
  productUrl?: string;
  output: ResearchOutput;
}) {
  const approved = input.output.claims.filter((claim) => claim.status === 'approved').length;
  const blocked = input.output.claims.filter((claim) => claim.status === 'blocked').length;
  const needsEvidence = input.output.claims.filter((claim) => claim.status === 'needs_evidence').length;
  return {
    ok: true,
    action: 'research_completed',
    productId: input.productId,
    productTitle: input.productTitle,
    productUrl: input.output.productUrl || input.productUrl,
    evidenceCount: input.output.evidence.length,
    approvedClaims: approved,
    blockedClaims: blocked,
    needsEvidenceClaims: needsEvidence,
    research: {
      productId: input.productId,
      productUrl: input.output.productUrl || input.productUrl,
      evidence: input.output.evidence,
      claims: input.output.claims,
      traces: input.output.traces,
      fromCache: input.output.fromCache,
      searchPlan: input.output.searchPlan,
    },
    evidence: input.output.evidence.slice(0, 5),
    claims: input.output.claims.slice(0, 8),
    next:
      approved > 0
        ? '可继续生成剧本分镜，或要求我先解释目标用户、痛点和卖点。'
        : '当前证据不足；可提供商品页、主图或更具体的目标市场后继续。',
  };
}

function readAttachments(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => objectValue(item)).filter((item) => textValue(item.name) || textValue(item.type))
    : [];
}

function compactTask(task: Awaited<ReturnType<typeof getTask>>) {
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    step: task.step,
    error: task.error,
    payload: task.payload,
    updatedAt: task.updatedAt,
  };
}

function compactRun(run: Awaited<ReturnType<typeof getAgentRun>>) {
  if (!run) return null;
  return {
    id: run.id,
    taskId: run.taskId,
    kind: run.kind,
    status: run.status,
    productId: run.productId,
    scriptId: run.scriptId,
    videoId: run.videoId,
    error: run.error,
    output: run.output,
    stepCount: run.steps.length,
    latestStep: run.steps[run.steps.length - 1]
      ? {
          nodeId: run.steps[run.steps.length - 1].nodeId,
          status: run.steps[run.steps.length - 1].status,
          decision: run.steps[run.steps.length - 1].decision,
          reason: run.steps[run.steps.length - 1].reason,
        }
      : null,
  };
}

async function startAgentRun(kind: AgentRunKind, runInput: Record<string, unknown>) {
  return createQueuedAgentRun({ kind, runInput });
}

// 任务已启动是确定性状态：用模板确认即可，也避免 LLM 谎称"已完成"。
// 这是全流程里唯一保留 finalReply 短路的地方。
function startedRunReply(kind: AgentRunKind, productTitle?: string) {
  if (kind === 'script_generate') {
    return productTitle
      ? `已开始为「${productTitle}」生成剧本和分镜。完成后先给你确认方案，再进入成片。`
      : '已开始生成剧本和分镜。完成后先给你确认方案，再进入成片。';
  }
  if (kind === 'render_full') return '已按确认的分镜开始生成成片。完成后可以预览和导出。';
  return productTitle ? `已开始制作「${productTitle}」的视频。` : '已开始制作视频。';
}

// 策略的唯一来源：客观状态事实 + LLM 判断准则。路由和行为评测共用，保证测的就是生产策略。
export function buildCopilotSystemPrompt(state: {
  productTitle?: string;
  referenceImageUrl?: string;
  attachmentCount?: number;
  hasResearch: boolean;
  hasScript: boolean;
  scriptId?: string;
  narrative?: string;
  shots?: Array<{
    order: number;
    visualDesc: string;
    camera: string;
    narration: string;
    subtitle: string;
    duration: number;
  }>;
  hasActiveRun: boolean;
  webSearchRequested?: boolean;
}): string {
  const attachmentCount = state.attachmentCount || 0;
  const productFact = state.productTitle
    ? `已知商品「${state.productTitle}」`
    : state.referenceImageUrl || attachmentCount > 0
      ? '用户提供了商品主图/附件，但没有明确商品名'
      : '用户尚未提供具体商品（没有商品名、链接或主图）';
  const facts = [
    '当前项目状态（客观事实，据此判断；不要假设未列出的东西已经具备）：',
    `- 商品：${productFact}`,
    state.referenceImageUrl ? '- 商品主图：已提供，可作为渲染参考' : '',
    `- 调研证据：${state.hasResearch ? '已有' : '尚无'}`,
    `- 剧本分镜：${state.hasScript ? '已生成（见下方分镜）' : '尚未生成'}`,
    `- 活跃制作任务：${state.hasActiveRun ? '有，可查询进度' : '无'}`,
  ]
    .filter(Boolean)
    .join('\n');

  const shotContext =
    state.hasScript && state.shots && state.shots.length
      ? `当前剧本分镜${state.narrative ? `，叙事「${state.narrative}」` : ''}：\n${state.shots
          .slice()
          .sort((a, b) => a.order - b.order)
          .map(
            (s) =>
              `镜${s.order}：画面=${s.visualDesc}｜镜头=${s.camera}｜旁白=${s.narration}｜字幕=${s.subtitle}｜${s.duration}s`,
          )
          .join('\n')}`
      : '当前还没有生成分镜剧本。';

  return [
    '你是 Proveo 的生产控制 Agent：把用户的自然语言请求转成可执行的视频生产动作，并基于工具结果继续推进。你对用户表现为一个 Agent，背后通过工具触发 Researcher（调研证据）、Composer（剧本分镜）、Renderer（Seedance 成片）、Auditor（合规质检）等生产链路。',
    facts,
    [
      '工作方式：',
      '- 你自己理解用户意图、判断资料是否足够、缺什么，并用自己的话回复；不要等工具替你做语义判断，也不要套固定话术。',
      '- 寒暄、感谢、情绪、能力咨询、取消/退出等非生产意图，直接自然回复，不调用任何生产工具，也不要把短句当商品名。',
      '- 资料足够时必须调用工具执行动作，不要把可执行动作写成"你可以点击…"的建议。',
      '- 工具返回缺信息（action=need_product/need_script/needs_confirmation/needs_render_confirmation/render_requirements_missing）时，把缺的东西和下一步用自己的话问清楚，不要强行启动。',
    ].join('\n'),
    [
      '默认走分阶段、可审查的链路，不要一上来就出成片：',
      '- 普通"做条视频/生成视频/马上生成/开始制作"表示想要方案，不等于授权直接渲染成片。资料够就先 start_script_generation 出剧本分镜让用户确认；资料不够就先追问本轮最关键的 3-4 个问题（具体商品/卖点、目标平台、时长、人群或素材里最缺的几项），不要一次列满所有字段，也不要先问品牌名/Logo 这类可选项。',
      '- 用户只给模糊品类（"厨房用品/数码产品/家居好物"），不能自己脑补成具体商品；请用户给具体商品名/链接、核心功能和可用素材。',
      '- 进入剧本分镜的最低要求：有具体商品（名/链接/主图之一），且至少有一个可核验的卖点或资料路径。',
      '- "马上/直接/一键/急"只表示用户着急，不代表信息完整，也不代表授权越过确认门。',
    ].join('\n'),
    [
      '高成本动作的安全闸（必须遵守）：',
      '- 当前产品策略：对话里不直接出片。即使用户说"直接成片/完整跑完/一键全链路/快速草稿预览"，也先 start_script_generation 生成剧本分镜；用户必须进入制作台检查并点击"确认成片"后，才允许渲染完整视频。',
      '- 不要调用 start_one_click_video。该工具会被后端降级为 start_script_generation，仅用于兼容旧模型调用。',
      '- 不要在对话里调用 start_render_full；只有制作台的确认按钮可以触发完整成片。',
      '- 用户说"先别生成/只要调研/只要脚本/先看方案/先看一版"时，不得调用 start_one_click_video 或 start_render_full。',
    ].join('\n'),
    [
      '其它路由：',
      '- 用户明确要调研/爆款打法/参考分析且已有具体商品：run_product_research。',
      '- 找"我上传的素材/素材库/商品主图视频切片"：先 search_uploaded_materials；空库或要爆款灵感/参考镜头结构/竞品配方：search_reference_videos。',
      '- 改某一镜的画面/台词/字幕/时长：edit_shot；改整体叙事/视觉风格/BGM/语言/画幅或调分镜顺序：edit_script；增删分镜：add_shot / delete_shot。以上都不触发渲染。',
      '- 用户改完某镜想重新出该镜：rerender_shot（只重渲单镜，成本低）；用户要导出/出成片/换画幅导出：export_video。',
      '- 用户说「停一下/取消/别生成了」且有活跃任务：cancel_run。',
      '- 问进度/是否完成/失败原因：get_run_status；如果没有活跃任务，直接说明当前没有正在跟踪的制作任务，不要新建任务。',
      '- 只问当前剧本/节奏/分镜是否 OK 且上下文足够时：直接基于上方分镜回复，不要为了评价去检索参考库。',
    ].join('\n'),
    [
      '硬约束：',
      '- 不编造工具没返回的信息；不声称剧本或视频已完成，除非工具结果给出对应 id/url。',
      '- 不自己生成完整剧本 JSON；剧本只能由 start_script_generation 或 start_one_click_video 进入 Worker 主线。',
      '- 用户要求"全网最强/100%/永久/医学级/根治"等无法证明或高风险表述时，不照写；改成有证据支撑的合规说法，并说明哪些词不能用。',
      '- 上传素材切片和参考视频只能作为 Seedance 生成参考，不能裁切/混剪进成片，不能绑定 materialRef；ReferenceVideo 是爆款配方/镜头结构参考，不是当前商品真实素材。',
      '- 回复简短、面向普通商家用户：不要暴露 runId/taskId/scriptId 等内部编号；语气专业克制，不用"哦/啦/哈/呢/呀"结尾，不说"马上就好/稍等一下"这类空泛安抚。',
      '- 启动剧本分镜任务后只说"已开始生成方案，完成后到制作台检查分镜并确认成片"；不要暗示已经在渲染完整视频。改分镜后给镜号；失败时给可行动原因。',
    ].join('\n'),
    shotContext,
    state.webSearchRequested
      ? '用户已开启网络搜索：优先补充公开证据、用户痛点和爆款参考；默认仍只到剧本分镜确认点，不自动出片。'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function registerCopilotRoutes(app: Express, ctx: CopilotRoutesContext) {
  // 对话生产主线：LLM 读取项目状态后自行判断意图与缺口，选择工具执行；工具只回客观事实+硬安全闸。
  app.post('/api/agent/chat', async (req, res) => {
    const wantsStream =
      String(req.headers.accept || '')
        .toLowerCase()
        .includes('text/event-stream') || req.body?.stream === true;
    const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages: AgentChatMessage[] = rawMessages
      .map((m: unknown) => {
        const row = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
        const role = row.role === 'assistant' ? 'assistant' : 'user';
        const content = typeof row.content === 'string' ? row.content : '';
        return { role, content } as AgentChatMessage;
      })
      .filter((m: AgentChatMessage) => m.content.trim());
    if (!messages.length) return ctx.sendJsonError(res, 400, '缺少 messages');

    const productId = textValue(req.body?.productId) || undefined;
    const productTitle = textValue(req.body?.productTitle) || undefined;
    const scriptId = textValue(req.body?.scriptId) || undefined;
    const activeRunId = textValue(req.body?.activeRunId) || undefined;
    const activeTaskId = textValue(req.body?.activeTaskId) || undefined;
    const referenceImageUrl = textValue(req.body?.referenceImageUrl) || undefined;
    const attachments = readAttachments(req.body?.attachments);
    const latestText = latestUserText(messages) || '';
    const webSearchRequested = boolValue(req.body?.webSearch, false);
    let hasResearchContext = boolValue(req.body?.hasResearch, false);
    const hasScriptContext = boolValue(req.body?.hasScript, Boolean(scriptId));
    let inferredProductTitle = productTitle;

    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const uiEvents = createAgentUiEventBuilder({
      runId: `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      messageId: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    });
    const sendUi = (event: AgentUiStreamEvent | null) => {
      if (event) send('agent_ui', event);
    };

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      sendUi(uiEvents.runStarted());
      sendUi(uiEvents.state('preparing', 'running', '正在准备生产 Agent'));
      send('status', { phase: 'preparing' });
    }

    try {
      // 当前剧本（用于改分镜 + 让模型知道现有分镜）。闭包内随编辑刷新。
      let script = scriptId ? await getProductionScript(scriptId) : undefined;
      const hasActiveRun = () => Boolean(activeRunId || activeTaskId);
      const currentProductId = () => productId;
      // "什么算有商品锚点"只在这一处定义，三个启动工具共用，避免逻辑散落。
      const resolveAnchor = (args: Record<string, unknown>) => {
        const parsed = parseProductInput(
          textValue(args.productTitle || args.title || inferredProductTitle || latestText),
        );
        const title = textValue(args.productTitle || args.title || inferredProductTitle || parsed.title);
        const productUrl = textValue(args.productUrl || parsed.productUrl);
        const hasAnchor = Boolean(title || productUrl || currentProductId() || referenceImageUrl || attachments.length);
        return { title, productUrl, hasAnchor };
      };

      const workflowDecisionProperty = {
        type: 'string',
        enum: [...WORKFLOW_DECISIONS],
        description:
          '你结合完整上下文判断出的下一步。必须参考当前是否已有商品、调研、剧本、活跃任务和用户最新补充，不要只按关键词判断。',
      };
      const decisionReasonProperty = {
        type: 'string',
        description: '一句话说明这个 workflowDecision 的上下文依据，面向内部审计，不要包含内部编号。',
      };
      const restartCurrentRunProperty = {
        type: 'boolean',
        description: '只有用户明确要求重新开始、重跑或覆盖当前制作任务时才为 true。',
      };

      const tools: AgentTool[] = [
        {
          definition: {
            type: 'function',
            function: {
              name: 'run_product_research',
              description:
                '先做商品/用户/卖点/公开证据调研，不生成剧本也不出片。用户明确要求调研、爆款打法、参考分析时调用；需要有具体商品名、链接或主图之一。',
              parameters: {
                type: 'object',
                properties: {
                  productTitle: { type: 'string', description: '商品名、商品链接或用户描述的卖点' },
                  productUrl: { type: 'string', description: '可选商品链接' },
                  webSearch: { type: 'boolean', description: '是否联网补证据，默认 true' },
                },
              },
            },
          },
          execute: async (args) => {
            const { title, productUrl, hasAnchor } = resolveAnchor(args);
            if (!hasAnchor) {
              return { ok: false, action: 'need_product', reason: '还没有具体商品名、链接或主图，无法做调研。' };
            }
            const nextProductId = currentProductId() || `chat_${cleanIdPart(title || productUrl) || Date.now()}`;
            const output = await runResearchAgent({
              productId: nextProductId,
              productUrl: productUrl || undefined,
              product: {
                id: nextProductId,
                title: title || productUrl || nextProductId,
                category: '未知品类',
                price: '',
                audience: '',
                description: latestText,
                sellingPoints: [],
                assets: [],
                reviewStatus: 'approved',
              },
              uploadedSlices: [],
              webSearch: boolValue(args.webSearch, true),
              strictEvidence: false,
              searchScopes: ['official', 'commerce', 'review', 'social'],
            });
            await upsertEvidenceRecord(nextProductId, output as unknown as Record<string, unknown>).catch(
              () => undefined,
            );
            hasResearchContext = true;
            inferredProductTitle = title || productUrl || inferredProductTitle;
            return compactResearchOutput({
              productId: nextProductId,
              productTitle: title || productUrl || nextProductId,
              productUrl: productUrl || undefined,
              output,
            });
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'search_uploaded_materials',
              description:
                '只检索当前商品已经上传并切片的商家素材库。用户明确要找"我上传的素材/素材库/商品主图视频切片"时调用；空库时再改用 search_reference_videos。',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: '检索关键词，如「厨房 切菜 手部特写」' },
                  limit: { type: 'number', description: '返回数量，默认 6' },
                },
                required: ['query'],
              },
            },
          },
          execute: async (args) => {
            const query = String(args.query || '').trim();
            const limit = Math.max(1, Math.min(12, Number(args.limit) || 6));
            if (!query) return { ok: true, source: 'uploaded_materials', count: 0, items: [], note: '空查询' };
            const scopedProductId = currentProductId();
            if (!scopedProductId) {
              return {
                ok: true,
                source: 'uploaded_materials',
                count: 0,
                items: [],
                reason: '当前没有 productId，不能做商品隔离的上传素材库检索。',
                next: '可调用 search_reference_videos 检索爆款参考视频，或请用户上传商品主图/视频后再搜素材库。',
              };
            }
            const slices = await searchProductionMaterialSlices(query, limit, scopedProductId);
            return {
              ok: true,
              source: 'uploaded_materials',
              productId: scopedProductId,
              count: slices.length,
              items: slices.map((s) => ({ id: s.id, summary: s.summary, tags: s.tags, score: s.score })),
              next: slices.length
                ? '这些素材只能作为 Seedance 生成参考，不能绑定 materialRef 或裁切入最终成片。'
                : '当前商品素材库没有命中；可调用 search_reference_videos 检索爆款参考视频。',
            };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'search_reference_videos',
              description:
                '检索已入库的爆款参考视频、ReferenceVideo 拆解和配方资产。无需当前商品素材库；用户要灵感、爆款参考、镜头方法、竞品结构或上传素材为空时调用。',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: '检索关键词，如「厨房切菜手部特写 爆款带货」' },
                  limit: { type: 'number', description: '返回数量，默认 6' },
                },
                required: ['query'],
              },
            },
          },
          execute: async (args) => {
            const query = String(args.query || '').trim();
            const limit = Math.max(1, Math.min(12, Number(args.limit) || 6));
            if (!query) return { ok: true, source: 'reference_videos', count: 0, items: [], note: '空查询' };
            const result = await searchReferenceVideosForAgent(query, limit);
            return {
              ok: true,
              source: 'reference_videos',
              mode: result.mode,
              warning: result.warning,
              count: result.results.length,
              items: result.results,
              next: result.results.length
                ? '参考视频只用于爆款配方、镜头结构、字幕策略和 Seedance 生成参考；不要复用或裁切原片素材。'
                : '参考库也没有命中；可换关键词、提供商品链接或上传商品主图。',
            };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'edit_shot',
              description: '修改当前剧本里某一个分镜的字段（秒级，不触发渲染）。只在用户想改某一镜时调用。',
              parameters: {
                type: 'object',
                properties: {
                  order: { type: 'number', description: '要改的镜号，从 1 开始' },
                  visualDesc: { type: 'string', description: '画面（主体+动作+场景），无文字/UI' },
                  camera: { type: 'string', description: '镜头运动，中文' },
                  narration: { type: 'string', description: '口播旁白' },
                  subtitle: { type: 'string', description: '字幕，≤24 字' },
                  duration: { type: 'number', description: '时长秒，3-8；当前 Seedance 模型不支持 1-2 秒镜头' },
                },
                required: ['order'],
              },
            },
          },
          execute: async (args) => {
            if (!script)
              return { ok: false, action: 'need_script', reason: '当前还没有生成剧本分镜，请先生成剧本后再修改镜头。' };
            const order = Number(args.order) || 0;
            const target = script.shots.find((shot) => shot.order === order);
            if (!target) return { ok: false, error: `找不到第 ${order} 镜。` };
            const patch: Record<string, unknown> = {};
            for (const key of ['visualDesc', 'camera', 'narration', 'subtitle'] as const) {
              if (typeof args[key] === 'string' && String(args[key]).trim()) patch[key] = String(args[key]).trim();
            }
            if (Number.isFinite(Number(args.duration)))
              patch.duration = Math.max(3, Math.min(8, Math.round(Number(args.duration))));
            if (!Object.keys(patch).length) return { ok: false, error: '没有要改的字段。' };
            await patchProductionShot(script.id, target.id, { ...patch, status: 'draft', clearAsset: true });
            script = await getProductionScript(script.id);
            return { ok: true, order, patch };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'edit_script',
              description:
                '修改当前剧本的整体设定：叙事/视觉风格/BGM/语言/画幅，或调整分镜顺序。改单个分镜的画面台词用 edit_shot，增删分镜用 add_shot / delete_shot。不触发渲染。',
              parameters: {
                type: 'object',
                properties: {
                  narrative: { type: 'string', description: '整体叙事/脚本主线' },
                  visualStyle: { type: 'string', description: '视觉风格，如「黑金高级风」「夏日度假风」' },
                  bgm: { type: 'string', description: 'BGM 风格描述' },
                  language: { type: 'string', description: '字幕/旁白语言，如 zh / en' },
                  aspectRatio: { type: 'string', enum: ['9:16', '16:9'], description: '画幅比例' },
                  shotOrder: {
                    type: 'array',
                    items: { type: 'number' },
                    description: '按目标顺序排列的当前镜号，如 [3,1,2] 表示把第3镜挪到最前。',
                  },
                },
              },
            },
          },
          execute: async (args) => {
            if (!script)
              return {
                ok: false,
                action: 'need_script',
                reason: '当前还没有生成剧本分镜，请先生成剧本后再修改整体设定。',
              };
            const patch: Record<string, unknown> = {};
            for (const key of ['narrative', 'visualStyle', 'bgm', 'language'] as const) {
              if (typeof args[key] === 'string' && String(args[key]).trim()) patch[key] = String(args[key]).trim();
            }
            if (args.aspectRatio === '9:16' || args.aspectRatio === '16:9') patch.aspectRatio = args.aspectRatio;
            if (Array.isArray(args.shotOrder) && args.shotOrder.length) {
              const byOrder = new Map(script.shots.map((shot) => [shot.order, shot.id]));
              const ids = args.shotOrder
                .map((order) => byOrder.get(Number(order)))
                .filter((id): id is string => Boolean(id));
              if (ids.length === script.shots.length) patch.shotOrder = ids;
            }
            if (!Object.keys(patch).length) return { ok: false, error: '没有要改的剧本字段。' };
            await patchProductionScript(script.id, patch);
            script = await getProductionScript(script.id);
            return { ok: true, patch };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'add_shot',
              description: '在当前剧本里新增一个分镜（不触发渲染）。',
              parameters: {
                type: 'object',
                properties: {
                  visualDesc: { type: 'string', description: '画面（主体+动作+场景），无文字/UI' },
                  narration: { type: 'string', description: '口播旁白' },
                  subtitle: { type: 'string', description: '字幕，≤24 字' },
                  camera: { type: 'string', description: '镜头运动，中文' },
                  duration: { type: 'number', description: '时长秒，3-8' },
                  order: { type: 'number', description: '插入位置（镜号），默认追加到最后' },
                },
                required: ['visualDesc'],
              },
            },
          },
          execute: async (args) => {
            if (!script)
              return { ok: false, action: 'need_script', reason: '当前还没有生成剧本分镜，请先生成剧本后再新增镜头。' };
            const visualDesc = textValue(args.visualDesc);
            if (!visualDesc) return { ok: false, error: '需要说明这一镜的画面内容。' };
            const duration = Number.isFinite(Number(args.duration))
              ? Math.max(3, Math.min(8, Math.round(Number(args.duration))))
              : 4;
            const order = Number.isFinite(Number(args.order))
              ? Math.round(Number(args.order))
              : script.shots.length + 1;
            await createProductionShot(script.id, {
              id: `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              order,
              duration,
              visualDesc,
              camera: textValue(args.camera, '固定中景'),
              narration: textValue(args.narration),
              subtitle: textValue(args.subtitle),
              factors: [],
              status: 'draft',
            });
            script = await getProductionScript(script.id);
            return { ok: true, order, totalShots: script?.shots.length };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'delete_shot',
              description: '删除当前剧本里的某一个分镜（不触发渲染）。',
              parameters: {
                type: 'object',
                properties: { order: { type: 'number', description: '要删除的镜号，从 1 开始' } },
                required: ['order'],
              },
            },
          },
          execute: async (args) => {
            if (!script)
              return { ok: false, action: 'need_script', reason: '当前还没有生成剧本分镜，请先生成剧本后再删除镜头。' };
            const order = Number(args.order) || 0;
            const target = script.shots.find((shot) => shot.order === order);
            if (!target) return { ok: false, error: `找不到第 ${order} 镜。` };
            if (script.shots.length <= 1) return { ok: false, error: '剧本至少要保留一个分镜。' };
            await deleteProductionShot(script.id, target.id);
            script = await getProductionScript(script.id);
            return { ok: true, deletedOrder: order, totalShots: script?.shots.length };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'rerender_shot',
              description:
                '只重新渲染当前剧本里的某一个分镜（Seedance 生成，成本低于整片）。用户改完某镜想重出该镜时调用。',
              parameters: {
                type: 'object',
                properties: { order: { type: 'number', description: '要重渲的镜号，从 1 开始' } },
                required: ['order'],
              },
            },
          },
          execute: async (args) => {
            if (!script) return { ok: false, action: 'need_script', reason: '当前没有剧本，无法重渲分镜。' };
            const order = Number(args.order) || 0;
            const target = script.shots.find((shot) => shot.order === order);
            if (!target) return { ok: false, error: `找不到第 ${order} 镜。` };
            const task = await createQueuedTask('video', {
              scriptId: script.id,
              shotId: target.id,
              provider: 'seedance',
              referenceImageUrl,
            });
            return {
              ok: true,
              action: 'started_task',
              finalReply: `已开始重新渲染第 ${order} 镜，完成后可在制作台预览该镜。`,
              taskId: task.id,
              order,
            };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'export_video',
              description: '把当前剧本合成导出为成片，可指定画幅和分辨率。用户说「导出/出成片/导成横版」等时调用。',
              parameters: {
                type: 'object',
                properties: {
                  aspectRatio: { type: 'string', enum: ['9:16', '16:9'], description: '画幅，默认 9:16' },
                  resolution: { type: 'string', description: '分辨率，如 720x1280 / 1080x1920 / 1920x1080' },
                  audioMode: { type: 'string', enum: ['original', 'voiceover', 'mute'] },
                },
              },
            },
          },
          execute: async (args) => {
            const targetScriptId = textValue(scriptId || script?.id);
            if (!targetScriptId) return { ok: false, action: 'need_script', reason: '当前没有可导出的剧本。' };
            const aspectRatio = args.aspectRatio === '16:9' ? '16:9' : '9:16';
            const exportOptions = {
              provider: 'seedance',
              aspectRatio,
              resolution: textValue(args.resolution, aspectRatio === '16:9' ? '1280x720' : '720x1280'),
              audioMode:
                args.audioMode === 'original' || args.audioMode === 'voiceover' || args.audioMode === 'mute'
                  ? args.audioMode
                  : 'voiceover',
              retrievalMode: 'rag',
              renderProfile: 'quality',
              referenceImageUrl,
            };
            const task = await createQueuedTask('compose', {
              scriptId: targetScriptId,
              exportOptions,
              ...exportOptions,
            });
            return {
              ok: true,
              action: 'started_task',
              finalReply: `已开始导出成片（${aspectRatio}，${exportOptions.resolution}）。完成后可在交付结果预览和下载。`,
              taskId: task.id,
            };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'cancel_run',
              description: '取消当前正在进行的制作任务。用户说「停一下/取消/别生成了」且有活跃任务时调用。',
              parameters: { type: 'object', properties: {} },
            },
          },
          execute: async (args) => {
            void args;
            if (!hasActiveRun()) {
              return { ok: false, action: 'no_active_run', reason: '当前没有正在进行的制作任务。' };
            }
            if (activeRunId) {
              await updateAgentRun(activeRunId, { status: 'cancelled', error: '用户在对话中取消' }).catch(
                () => undefined,
              );
            }
            if (activeTaskId) {
              await updateTask(activeTaskId, {
                status: 'cancelled',
                progress: 0,
                step: 'agent_cancelled',
                error: '用户在对话中取消',
              }).catch(() => undefined);
            }
            return { ok: true, action: 'run_cancelled', reason: '已取消当前制作任务。' };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'start_script_generation',
              description:
                '生成剧本和分镜，不立即渲染视频。需要有具体商品（名/链接/主图之一）；资料够时优先走这条，让用户先确认方案。',
              parameters: {
                type: 'object',
                properties: {
                  workflowDecision: workflowDecisionProperty,
                  decisionReason: decisionReasonProperty,
                  restartCurrentRun: restartCurrentRunProperty,
                  productTitle: { type: 'string', description: '商品名、商品链接或用户描述的卖点' },
                  productUrl: { type: 'string', description: '可选商品链接' },
                  webSearch: { type: 'boolean', description: '是否允许 Researcher 联网补证据' },
                },
                required: ['productTitle'],
              },
            },
          },
          execute: async (args) => {
            const { title, productUrl, hasAnchor } = resolveAnchor(args);
            if (activeRunBlocked(args, hasActiveRun())) {
              return {
                ok: true,
                action: 'active_run_in_progress',
                reason: '已有制作任务在进行中，未重新启动；用户明确要求重来时才重启。',
              };
            }
            if (!hasAnchor) {
              return { ok: false, action: 'need_product', reason: '缺少具体商品名、链接或主图，无法生成剧本。' };
            }
            const nextTitle = title || latestText;
            const nextProductId = currentProductId() || `chat_${cleanIdPart(nextTitle) || Date.now()}`;
            const workflowDecision = workflowDecisionValue(args.workflowDecision);
            const decisionReason = decisionReasonValue(args.decisionReason);
            const run = await startAgentRun('script_generate', {
              productId: nextProductId,
              title: nextTitle,
              productUrl: productUrl || undefined,
              webSearch: boolValue(args.webSearch, true),
              generationProfile: 'trusted_publish',
              retrievalMode: 'rag',
              freePrompt: latestText || nextTitle,
              provider: 'auto',
              mode: 'auto',
              referenceImageUrl,
            });
            return {
              ok: true,
              action: 'started_agent_run',
              finalReply: startedRunReply('script_generate', nextTitle),
              workflowDecision: workflowDecision || 'script_first',
              decisionReason,
              productId: nextProductId,
              productTitle: nextTitle,
              ...run,
            };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'start_one_click_video',
              description:
                '兼容旧模型调用：不要直接出片。该工具现在只会降级启动剧本分镜生成，完整视频必须由用户进制作台确认后才渲染。',
              parameters: {
                type: 'object',
                properties: {
                  workflowDecision: workflowDecisionProperty,
                  decisionReason: decisionReasonProperty,
                  renderConsent: {
                    type: 'boolean',
                    description:
                      '只有用户在当前上下文中已经确认要直接生成成片、完整跑完或快速视频草稿时才为 true；普通"做条视频"不是确认。',
                  },
                  restartCurrentRun: restartCurrentRunProperty,
                  productTitle: { type: 'string', description: '商品名、商品链接或用户描述的卖点' },
                  productUrl: { type: 'string', description: '可选商品链接' },
                  webSearch: { type: 'boolean', description: '是否允许 Researcher 联网补证据' },
                  generationProfile: {
                    type: 'string',
                    enum: ['quick_preview', 'trusted_publish'],
                    description: '快速预览或可信发布模式',
                  },
                  audioMode: {
                    type: 'string',
                    enum: ['original', 'voiceover', 'mute'],
                    description: '成片声音模式',
                  },
                },
                required: ['productTitle', 'workflowDecision', 'renderConsent', 'decisionReason'],
              },
            },
          },
          execute: async (args) => {
            const { title, productUrl, hasAnchor } = resolveAnchor(args);
            const workflowDecision = workflowDecisionValue(args.workflowDecision);
            const decisionReason = decisionReasonValue(args.decisionReason);
            if (activeRunBlocked(args, hasActiveRun())) {
              return { ok: true, action: 'active_run_in_progress', reason: '已有制作任务在进行中，未重新启动。' };
            }
            if (!hasAnchor) {
              return { ok: false, action: 'need_product', reason: '缺少具体商品，无法生成剧本分镜。' };
            }
            const nextTitle = title || latestText;
            const nextProductId = currentProductId() || `chat_${cleanIdPart(nextTitle) || Date.now()}`;
            const run = await startAgentRun('script_generate', {
              productId: nextProductId,
              title: nextTitle,
              productUrl: productUrl || undefined,
              webSearch: boolValue(args.webSearch, true),
              generationProfile: 'trusted_publish',
              retrievalMode: 'rag',
              freePrompt: latestText || nextTitle,
              provider: 'auto',
              mode: 'auto',
              referenceImageUrl,
            });
            return {
              ok: true,
              action: 'started_agent_run',
              finalReply: startedRunReply('script_generate', nextTitle),
              workflowDecision: workflowDecision || 'script_first',
              decisionReason,
              downgradedFrom: 'one_click_video',
              reason: '已按当前策略先生成剧本分镜，完整成片需进入制作台确认。',
              productId: nextProductId,
              productTitle: nextTitle,
              ...run,
            };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'start_render_full',
              description:
                '兼容旧模型调用：聊天里不要直接出片。完整视频必须由用户进入制作台检查分镜，并点击"确认成片"按钮后才渲染。',
              parameters: {
                type: 'object',
                properties: {
                  workflowDecision: workflowDecisionProperty,
                  decisionReason: decisionReasonProperty,
                  renderConsent: {
                    type: 'boolean',
                    description: '只有用户在当前上下文中确认要用已有分镜生成成片时才为 true。',
                  },
                  restartCurrentRun: restartCurrentRunProperty,
                  scriptId: { type: 'string', description: '要渲染的剧本 ID，默认使用当前剧本' },
                  audioMode: { type: 'string', enum: ['original', 'voiceover', 'mute'] },
                },
                required: ['workflowDecision', 'renderConsent', 'decisionReason'],
              },
            },
          },
          execute: async (args) => {
            const targetScriptId = textValue(args.scriptId || scriptId || script?.id);
            const workflowDecision = workflowDecisionValue(args.workflowDecision);
            const decisionReason = decisionReasonValue(args.decisionReason);
            if (activeRunBlocked(args, hasActiveRun())) {
              return { ok: true, action: 'active_run_in_progress', reason: '已有制作任务在进行中，未重新启动。' };
            }
            if (!targetScriptId) {
              return { ok: false, action: 'need_script', reason: '当前没有可渲染的剧本，需要先生成剧本分镜。' };
            }
            return {
              ok: true,
              action: 'needs_render_confirmation',
              finalReply: '剧本和分镜已准备好。请打开制作台检查镜头，确认无误后点击“确认成片”再开始渲染。',
              workflowDecision,
              decisionReason,
              scriptId: targetScriptId,
              reason: '聊天入口不直接消耗成片渲染额度，完整出片只能由制作台确认按钮触发。',
            };
          },
        },
        {
          definition: {
            type: 'function',
            function: {
              name: 'get_run_status',
              description: '查询正在运行或刚启动的 AgentRun/Task 状态。用户追问进度、是否完成、失败原因时调用。',
              parameters: {
                type: 'object',
                properties: {
                  runId: { type: 'string', description: 'AgentRun ID，默认使用当前 activeRunId' },
                  taskId: { type: 'string', description: 'Task ID，默认使用当前 activeTaskId' },
                },
              },
            },
          },
          execute: async (args) => {
            const targetRunId = textValue(args.runId || activeRunId);
            const targetTaskId = textValue(args.taskId || activeTaskId);
            const [run, task] = await Promise.all([
              targetRunId ? getAgentRun(targetRunId) : Promise.resolve(null),
              targetTaskId ? getTask(targetTaskId) : Promise.resolve(null),
            ]);
            return {
              ok: Boolean(run || task),
              run: compactRun(run),
              task: compactTask(task),
            };
          },
        },
      ];

      const system = buildCopilotSystemPrompt({
        productTitle: inferredProductTitle,
        referenceImageUrl,
        attachmentCount: attachments.length,
        hasResearch: hasResearchContext,
        hasScript: hasScriptContext || Boolean(script),
        scriptId: script?.id,
        narrative: script?.narrative,
        shots: script?.shots.map((s) => ({
          order: s.order,
          visualDesc: s.visualDesc,
          camera: s.camera,
          narration: s.narration,
          subtitle: s.subtitle,
          duration: s.duration,
        })),
        hasActiveRun: hasActiveRun(),
        webSearchRequested,
      });

      const onEvent = wantsStream
        ? (event: AgentChatStreamEvent) => {
            if (event.type === 'done') {
              sendUi(uiEvents.textEnd());
              sendUi(uiEvents.done());
              if (script) send('script', script);
              send('done', { reply: userFacingReply(event.reply), steps: event.steps, script: script || null });
              return;
            }
            if (event.type === 'tool_result') {
              sendUi(uiEvents.toolResult(event.tool, event.args, event.result, event.step));
              const startedEvent = uiEvents.runStartedCustom(event.result);
              if (startedEvent) sendUi(startedEvent);
              send('tool_result', event);
              const result = event.result && typeof event.result === 'object' ? event.result : null;
              if ((result as { action?: unknown } | null)?.action === 'started_agent_run') {
                send('started_run', result);
              }
              return;
            }
            if (event.type === 'tool_call') {
              sendUi(uiEvents.toolStart(event.tool, event.args, event.step));
              send(event.type, event);
              return;
            }
            if (event.type === 'token') {
              if (event.content) sendUi(uiEvents.text(event.content));
              send(event.type, event);
              return;
            }
            if (event.type === 'status') {
              const title =
                event.phase === 'tooling'
                  ? '正在执行制作动作'
                  : event.phase === 'typing'
                    ? '正在整理回复'
                    : event.phase === 'wrapping'
                      ? '正在收尾'
                      : '正在理解需求';
              sendUi(uiEvents.state('preparing', 'running', title));
              send(event.type, event);
              return;
            }
            return;
          }
        : undefined;

      const result = await runAgentChat({ system, messages, tools, onEvent });
      if (wantsStream) {
        if (!res.writableEnded) res.end();
      } else {
        res.json({ reply: userFacingReply(result.reply), steps: result.steps, script: script || null });
      }
    } catch (error) {
      if (wantsStream) {
        sendUi(uiEvents.error(`Agent 对话失败：${ctx.safeExternalError(error)}`));
        send('error', { message: `Agent 对话失败：${ctx.safeExternalError(error)}` });
        res.end();
        return;
      }
      return ctx.sendJsonError(res, 503, `Agent 对话失败：${ctx.safeExternalError(error)}`);
    }
  });
}
