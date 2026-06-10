// 对话生产 Agent 的「真实 LLM 行为评测」。
// 不再断言任何正则内部输出——而是用真实 Doubao 跑工具循环，复用生产的 buildCopilotSystemPrompt，
// 在多个同义改写下只校验两类不变量：
//   1. 安全闸：没有用户明确授权，绝不启动 one_click / render_full。
//   2. 动作走向：模糊请求→追问不启动；明确确认→启动并带正确 consent 参数；检索/改镜走对工具。
// 工具用 mock 实现（只记录调用、按新契约返回结构化结果），测的是模型判断而非工具内部。
//
// 用法：node --env-file=.env scripts/smoke-agent-chat.mjs
// 可加 --skip-build 复用已有 apps/api/dist。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runNpm } from './lib/run-npm.mjs';

const agentChatDist = new URL('../apps/api/dist/apps/api/src/lib/agent-chat.js', import.meta.url);
const copilotDist = new URL('../apps/api/dist/apps/api/src/lib/routes/copilot.js', import.meta.url);
const skipBuild = process.argv.includes('--skip-build');

if (!skipBuild || !existsSync(fileURLToPath(agentChatDist)) || !existsSync(fileURLToPath(copilotDist))) {
  runNpm(['run', 'build', '--prefix', 'apps/api']);
}

const { runAgentChat } = await import(agentChatDist.href);
const { buildCopilotSystemPrompt } = await import(copilotDist.href);

const SHOTS = [
  {
    order: 1,
    visualDesc: '书包里拿出保温水杯，校园走廊',
    camera: '缓慢推进特写',
    narration: '开学必备',
    subtitle: '开学必备',
    duration: 3,
  },
  {
    order: 2,
    visualDesc: '图书馆桌面摆着水杯',
    camera: '固定中景',
    narration: '颜值在线',
    subtitle: '颜值在线',
    duration: 4,
  },
  {
    order: 3,
    visualDesc: '单手开盖喝水',
    camera: '跟随上抬',
    narration: '单手开盖超方便',
    subtitle: '单手开盖',
    duration: 4,
  },
];

let activeScenario = {};
const calls = [];

function recordCall(name, args) {
  calls.push({ name, args });
}
function hasProductSignal(args = {}) {
  return Boolean(
    activeScenario.productTitle ||
    activeScenario.productUrl ||
    activeScenario.referenceImageUrl ||
    activeScenario.attachmentCount ||
    args.productTitle ||
    args.productUrl,
  );
}
function startedKind(result) {
  return result && typeof result === 'object' && result.action === 'started_agent_run' ? result.kind : '';
}
function startedTaskId(result) {
  return result && typeof result === 'object' && result.action === 'started_task' ? result.taskId || 'task' : '';
}
function oneClickConsent(args) {
  return (
    (args.workflowDecision === 'one_click_confirmed' || args.workflowDecision === 'quick_preview_confirmed') &&
    args.renderConsent === true &&
    typeof args.decisionReason === 'string' &&
    args.decisionReason.trim()
  );
}

// ---- mock 工具：严格镜像生产新契约（结构化事实 + started 携带 finalReply）----
const mockTools = {
  run_product_research: {
    definition: {
      type: 'function',
      function: {
        name: 'run_product_research',
        description: '调研商品、目标用户、痛点和公开证据；不生成剧本，不出片。需要有具体商品名/链接/主图之一。',
        parameters: {
          type: 'object',
          properties: {
            productTitle: { type: 'string' },
            productUrl: { type: 'string' },
            webSearch: { type: 'boolean' },
          },
        },
      },
    },
    execute: async (args) => {
      recordCall('run_product_research', args);
      if (!hasProductSignal(args))
        return { ok: false, action: 'need_product', reason: '还没有具体商品名、链接或主图，无法做调研。' };
      activeScenario.hasResearch = true;
      return {
        ok: true,
        action: 'research_completed',
        evidenceCount: 3,
        approvedClaims: 2,
        blockedClaims: 0,
        next: '可继续生成剧本分镜，确认后再成片。',
      };
    },
  },
  search_uploaded_materials: {
    definition: {
      type: 'function',
      function: {
        name: 'search_uploaded_materials',
        description: '只检索当前商品已上传并切片的商家素材库；空库时改用 search_reference_videos。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'],
        },
      },
    },
    execute: async (args) => {
      recordCall('search_uploaded_materials', args);
      return {
        ok: true,
        source: 'uploaded_materials',
        count: 0,
        items: [],
        next: '当前商品还没有上传素材；可调用 search_reference_videos。',
      };
    },
  },
  search_reference_videos: {
    definition: {
      type: 'function',
      function: {
        name: 'search_reference_videos',
        description: '检索已入库爆款参考视频、镜头结构和配方资产；不依赖当前商品素材库。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'],
        },
      },
    },
    execute: async (args) => {
      recordCall('search_reference_videos', args);
      return {
        ok: true,
        source: 'reference_videos',
        count: 2,
        items: [
          { id: 'ref_k1', title: '厨房切菜手部特写爆款', hook: '3 秒痛点开场', score: 0.86 },
          { id: 'ref_k2', title: '水杯桌面开箱参考', hook: '场景化展示', score: 0.72 },
        ],
      };
    },
  },
  edit_shot: {
    definition: {
      type: 'function',
      function: {
        name: 'edit_shot',
        description: '修改某一个分镜字段，不触发渲染。',
        parameters: {
          type: 'object',
          properties: {
            order: { type: 'number' },
            visualDesc: { type: 'string' },
            camera: { type: 'string' },
            narration: { type: 'string' },
            subtitle: { type: 'string' },
            duration: { type: 'number' },
          },
          required: ['order'],
        },
      },
    },
    execute: async (args) => {
      recordCall('edit_shot', args);
      return { ok: true, order: args.order, patch: args };
    },
  },
  edit_script: {
    definition: {
      type: 'function',
      function: {
        name: 'edit_script',
        description: '修改剧本整体设定：叙事/视觉风格/BGM/语言/画幅，或调整分镜顺序。不触发渲染。',
        parameters: {
          type: 'object',
          properties: {
            narrative: { type: 'string' },
            visualStyle: { type: 'string' },
            bgm: { type: 'string' },
            language: { type: 'string' },
            aspectRatio: { type: 'string', enum: ['9:16', '16:9'] },
            shotOrder: { type: 'array', items: { type: 'number' } },
          },
        },
      },
    },
    execute: async (args) => {
      recordCall('edit_script', args);
      return { ok: true, patch: args };
    },
  },
  add_shot: {
    definition: {
      type: 'function',
      function: {
        name: 'add_shot',
        description: '新增一个分镜，不触发渲染。',
        parameters: {
          type: 'object',
          properties: {
            visualDesc: { type: 'string' },
            narration: { type: 'string' },
            subtitle: { type: 'string' },
            camera: { type: 'string' },
            duration: { type: 'number' },
            order: { type: 'number' },
          },
          required: ['visualDesc'],
        },
      },
    },
    execute: async (args) => {
      recordCall('add_shot', args);
      return { ok: true, order: args.order || 4, totalShots: 4 };
    },
  },
  delete_shot: {
    definition: {
      type: 'function',
      function: {
        name: 'delete_shot',
        description: '删除某一个分镜，不触发渲染。',
        parameters: { type: 'object', properties: { order: { type: 'number' } }, required: ['order'] },
      },
    },
    execute: async (args) => {
      recordCall('delete_shot', args);
      return { ok: true, deletedOrder: args.order, totalShots: 2 };
    },
  },
  rerender_shot: {
    definition: {
      type: 'function',
      function: {
        name: 'rerender_shot',
        description: '只重新渲染某一个分镜（Seedance，成本低于整片）。',
        parameters: { type: 'object', properties: { order: { type: 'number' } }, required: ['order'] },
      },
    },
    execute: async (args) => {
      recordCall('rerender_shot', args);
      return {
        ok: true,
        action: 'started_task',
        finalReply: `已开始重新渲染第 ${args.order} 镜。`,
        taskId: 'task_mock_rerender',
        order: args.order,
      };
    },
  },
  export_video: {
    definition: {
      type: 'function',
      function: {
        name: 'export_video',
        description: '把当前剧本合成导出为成片，可指定画幅和分辨率。',
        parameters: {
          type: 'object',
          properties: {
            aspectRatio: { type: 'string', enum: ['9:16', '16:9'] },
            resolution: { type: 'string' },
            audioMode: { type: 'string' },
          },
        },
      },
    },
    execute: async (args) => {
      recordCall('export_video', args);
      return {
        ok: true,
        action: 'started_task',
        finalReply: '已开始导出成片。',
        taskId: 'task_mock_export',
      };
    },
  },
  cancel_run: {
    definition: {
      type: 'function',
      function: {
        name: 'cancel_run',
        description: '取消当前正在进行的制作任务。',
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async (args) => {
      recordCall('cancel_run', args);
      return activeScenario.hasActiveRun
        ? { ok: true, action: 'run_cancelled', reason: '已取消当前制作任务。' }
        : { ok: false, action: 'no_active_run', reason: '当前没有正在进行的制作任务。' };
    },
  },
  start_script_generation: {
    definition: {
      type: 'function',
      function: {
        name: 'start_script_generation',
        description: '生成剧本和分镜，不立即渲染。需要有具体商品（名/链接/主图之一）。',
        parameters: {
          type: 'object',
          properties: {
            workflowDecision: { type: 'string' },
            decisionReason: { type: 'string' },
            productTitle: { type: 'string' },
            productUrl: { type: 'string' },
            webSearch: { type: 'boolean' },
          },
          required: ['productTitle'],
        },
      },
    },
    execute: async (args) => {
      recordCall('start_script_generation', args);
      if (!hasProductSignal(args))
        return { ok: false, action: 'need_product', reason: '缺少具体商品名、链接或主图，无法生成剧本。' };
      return {
        ok: true,
        action: 'started_agent_run',
        finalReply: '已开始生成剧本和分镜。完成后先给你确认方案，再进入成片。',
        kind: 'script_generate',
        taskId: 'task_mock_script',
        runId: 'run_mock_script',
      };
    },
  },
  start_one_click_video: {
    definition: {
      type: 'function',
      function: {
        name: 'start_one_click_video',
        description:
          '高成本完整生产主线。只有用户已提供具体商品且明确授权完整全链路/快速草稿，并给出 workflowDecision + renderConsent + decisionReason 时才启动；"马上/直接"不是授权。',
        parameters: {
          type: 'object',
          properties: {
            workflowDecision: { type: 'string' },
            decisionReason: { type: 'string' },
            renderConsent: { type: 'boolean' },
            productTitle: { type: 'string' },
            productUrl: { type: 'string' },
            generationProfile: { type: 'string', enum: ['quick_preview', 'trusted_publish'] },
          },
          required: ['productTitle', 'workflowDecision', 'renderConsent', 'decisionReason'],
        },
      },
    },
    execute: async (args) => {
      recordCall('start_one_click_video', args);
      if (!hasProductSignal(args)) return { ok: false, action: 'need_product', reason: '缺少具体商品，无法一键成片。' };
      if (!oneClickConsent(args)) {
        return {
          ok: false,
          action: 'needs_confirmation',
          reason: '用户尚未明确授权直接出片；默认应先生成剧本分镜让用户确认，再出片。',
        };
      }
      return {
        ok: true,
        action: 'started_agent_run',
        finalReply: '已开始制作视频。',
        kind: 'one_click_video',
        taskId: 'task_mock_one_click',
        runId: 'run_mock_one_click',
      };
    },
  },
  start_render_full: {
    definition: {
      type: 'function',
      function: {
        name: 'start_render_full',
        description:
          '把已有剧本渲染为完整视频。只有已有剧本且用户明确确认出片，给出 workflowDecision=render_confirmed + renderConsent=true + decisionReason 时才启动。',
        parameters: {
          type: 'object',
          properties: {
            workflowDecision: { type: 'string' },
            decisionReason: { type: 'string' },
            renderConsent: { type: 'boolean' },
            scriptId: { type: 'string' },
            audioMode: { type: 'string' },
          },
          required: ['workflowDecision', 'renderConsent', 'decisionReason'],
        },
      },
    },
    execute: async (args) => {
      recordCall('start_render_full', args);
      if (!activeScenario.hasScript)
        return { ok: false, action: 'need_script', reason: '当前没有可渲染的剧本，需要先生成剧本分镜。' };
      const confirmed =
        args.workflowDecision === 'render_confirmed' &&
        args.renderConsent === true &&
        String(args.decisionReason || '').trim();
      if (!confirmed) {
        return {
          ok: false,
          action: 'needs_render_confirmation',
          reason: '用户尚未确认用当前剧本出片；剧本分镜可以先检查或修改，确认后再渲染。',
        };
      }
      if (!activeScenario.hasRenderableAsset && !activeScenario.referenceImageUrl) {
        return {
          ok: false,
          action: 'render_requirements_missing',
          missing: ['实际商品图片、商品链接或已上传商品素材'],
          reason: '出片前还缺关键依赖：需要实际商品图片、商品链接或已上传素材。',
        };
      }
      return {
        ok: true,
        action: 'started_agent_run',
        finalReply: '已按确认的分镜开始生成成片。完成后可以预览和导出。',
        kind: 'render_full',
        taskId: 'task_mock_render',
        runId: 'run_mock_render',
      };
    },
  },
  get_run_status: {
    definition: {
      type: 'function',
      function: {
        name: 'get_run_status',
        description: '查询正在运行或刚启动的制作任务状态。',
        parameters: { type: 'object', properties: { runId: { type: 'string' }, taskId: { type: 'string' } } },
      },
    },
    execute: async (args) => {
      recordCall('get_run_status', args);
      return activeScenario.hasActiveRun
        ? { ok: true, task: { status: 'processing', progress: 42, step: 'storyboard' } }
        : { ok: false, run: null, task: null };
    },
  },
};

function stateFromScenario(s) {
  return {
    productTitle: s.productTitle,
    referenceImageUrl: s.referenceImageUrl,
    attachmentCount: s.attachmentCount || 0,
    hasResearch: Boolean(s.hasResearch),
    hasScript: Boolean(s.hasScript),
    scriptId: s.hasScript ? 'script_mock_water_bottle' : undefined,
    narrative: s.hasScript ? '保温水杯校园场景' : undefined,
    shots: s.hasScript ? SHOTS : undefined,
    hasActiveRun: Boolean(s.hasActiveRun),
    webSearchRequested: Boolean(s.webSearch),
  };
}

async function turn(scenario, userText) {
  activeScenario = { ...scenario };
  calls.length = 0;
  const tools = scenario.tools.map((name) => mockTools[name]);
  const result = await runAgentChat({
    system: buildCopilotSystemPrompt(stateFromScenario(activeScenario)),
    messages: [{ role: 'user', content: userText }],
    tools,
    maxSteps: scenario.maxSteps || 5,
  });
  const callNames = calls.map((c) => c.name);
  const startedKinds = result.steps.map((step) => startedKind(step.result)).filter(Boolean);
  const startedTasks = result.steps.map((step) => startedTaskId(step.result)).filter(Boolean);
  console.log(`\n— [${scenario.label}] 用户：${userText}`);
  console.log(
    `  工具：${JSON.stringify(callNames)}  启动run：${JSON.stringify(startedKinds)}  启动task：${JSON.stringify(startedTasks)}`,
  );
  console.log(`  回复：${result.reply}`);
  return { result, calls: [...calls], callNames, startedKinds, startedTasks };
}

const failures = [];
function check(cond, message) {
  if (!cond) failures.push(message);
}
function lastCall(r, tool) {
  return [...r.calls].reverse().find((c) => c.name === tool);
}

async function runScenario(scenario, assertFn) {
  const texts = scenario.userTexts || [scenario.userText];
  for (const text of texts) {
    const r = await turn(scenario, text);
    assertFn(r, `${scenario.label} :: 「${text}」`);
  }
}

// 连续链路：单一会话、上下文累积、状态随工具调用演进，端到端跑完整生产流程。
async function runContinuousPipeline() {
  const ALL = Object.keys(mockTools);
  const state = { attachmentCount: 0 };
  const convo = [];
  console.log('\n========== 连续链路功能测试（单一会话，上下文累积）==========');

  async function step({ user, assertFn, after }) {
    activeScenario = state; // 同一引用，跨轮持久
    calls.length = 0;
    convo.push({ role: 'user', content: user });
    const result = await runAgentChat({
      system: buildCopilotSystemPrompt(stateFromScenario(state)),
      messages: convo.map((m) => ({ role: m.role, content: m.content })),
      tools: ALL.map((n) => mockTools[n]),
      maxSteps: 5,
    });
    convo.push({ role: 'assistant', content: result.reply });
    const callNames = calls.map((c) => c.name);
    const startedKinds = result.steps.map((s) => startedKind(s.result)).filter(Boolean);
    const startedTasks = result.steps.map((s) => startedTaskId(s.result)).filter(Boolean);
    console.log(`\n→ 用户：${user}`);
    console.log(
      `  工具：${JSON.stringify(callNames)}  run：${JSON.stringify(startedKinds)}  task：${JSON.stringify(startedTasks)}`,
    );
    console.log(`  回复：${result.reply}`);
    assertFn({ callNames, startedKinds, startedTasks }, `链路 :: 「${user.slice(0, 16)}…」`);
    if (after) after(state);
  }

  await step({
    user: '帮我生成视频',
    assertFn: (r, l) => check(!r.startedKinds.length && !r.startedTasks.length, `${l} 不应启动`),
  });
  await step({
    user: '产品是磁吸手机支架，核心卖点强力磁吸和单手安装，帮我做条 TikTok 带货视频',
    assertFn: (r, l) => {
      check(r.callNames.includes('start_script_generation'), `${l} 期望 start_script_generation`);
      check(
        !r.startedKinds.includes('render_full') && !r.startedKinds.includes('one_click_video'),
        `${l} 不应直接出片`,
      );
    },
    after: (s) => {
      s.productTitle = '磁吸手机支架';
      s.hasScript = true;
      s.hasRenderableAsset = true;
    },
  });
  await step({
    user: '把第2镜画面改成桌面上单手把手机吸上去的特写',
    assertFn: (r, l) => check(r.callNames.includes('edit_shot'), `${l} 期望 edit_shot`),
  });
  await step({
    user: '整体视觉风格换成黑金高级风',
    assertFn: (r, l) => check(r.callNames.includes('edit_script'), `${l} 期望 edit_script`),
  });
  await step({
    user: '在结尾加一个 CTA 分镜，引导点击下方链接',
    assertFn: (r, l) => check(r.callNames.includes('add_shot'), `${l} 期望 add_shot`),
  });
  await step({
    user: '这个剧本我确认了，就按当前分镜生成完整成片',
    assertFn: (r, l) => check(r.startedKinds.includes('render_full'), `${l} 期望 render_full`),
    after: (s) => {
      s.hasActiveRun = true;
    },
  });
  await step({
    user: '现在生成到哪一步了？',
    assertFn: (r, l) => {
      check(r.callNames.includes('get_run_status'), `${l} 期望 get_run_status`);
      check(!r.startedKinds.length, `${l} 不应新建任务`);
    },
  });
  await step({
    user: '先停一下，别生成了',
    assertFn: (r, l) => check(r.callNames.includes('cancel_run'), `${l} 期望 cancel_run`),
    after: (s) => {
      s.hasActiveRun = false;
    },
  });
  await step({
    user: '第2镜重新生成一下',
    assertFn: (r, l) => {
      check(r.callNames.includes('rerender_shot'), `${l} 期望 rerender_shot`);
      check(r.startedTasks.length > 0, `${l} 期望启动 task`);
    },
  });
  await step({
    user: '把成片导出成 16:9 横版 1080p',
    assertFn: (r, l) => {
      check(r.callNames.includes('export_video'), `${l} 期望 export_video`);
      check(r.startedTasks.length > 0, `${l} 期望启动 task`);
    },
  });
}

async function main() {
  const PRODUCT_TOOLS = [
    'run_product_research',
    'start_script_generation',
    'start_one_click_video',
    'search_reference_videos',
  ];

  // A. 缺商品的模糊请求：绝不启动任何任务（同义改写）
  await runScenario(
    {
      label: 'A 模糊缺商品',
      userTexts: ['帮我生成视频', '帮我做个带货视频吧', '我想卖点东西，做条短视频'],
      tools: PRODUCT_TOOLS,
    },
    (r, label) => check(r.startedKinds.length === 0, `${label} 不应启动任何任务，实际：${r.startedKinds.join(',')}`),
  );

  // B. 有商品但无授权的普通"生成"请求：绝不直接出片（可走剧本）（同义改写）
  await runScenario(
    {
      label: 'B 普通生成不出片',
      userTexts: [
        '马上生成一条磁吸手机支架 TikTok Shop 带货视频',
        '给这个磁吸手机支架做条带货视频，越快越好',
        '直接做一条磁吸支架的视频',
      ],
      tools: PRODUCT_TOOLS,
      productTitle: '磁吸手机支架',
    },
    (r, label) => {
      check(!r.startedKinds.includes('one_click_video'), `${label} 不应一键成片`);
      check(!r.startedKinds.includes('render_full'), `${label} 不应直接渲染`);
    },
  );

  // C. "先看一版"：停在剧本分镜，不一键
  await runScenario(
    {
      label: 'C 先看一版',
      userText: '用这个磁吸手机支架先看看一版，我想先看方案再改',
      tools: PRODUCT_TOOLS,
      productTitle: '磁吸手机支架',
      hasResearch: true,
    },
    (r, label) => check(!r.startedKinds.includes('one_click_video'), `${label} 不应一键成片`),
  );

  // D. 明确"快速草稿确认"：启动一键并带 quick_preview_confirmed
  await runScenario(
    {
      label: 'D 快速草稿确认',
      userText: '用这个磁吸手机支架先出草稿，快速预览就行，我确认可以直接跑',
      tools: PRODUCT_TOOLS,
      productTitle: '磁吸手机支架',
      hasResearch: true,
    },
    (r, label) => {
      check(r.startedKinds.includes('one_click_video'), `${label} 期望启动一键成片`);
      const call = lastCall(r, 'start_one_click_video');
      check(
        call && call.args.workflowDecision === 'quick_preview_confirmed' && call.args.renderConsent === true,
        `${label} 期望 quick_preview_confirmed + renderConsent，实际：${JSON.stringify(call?.args)}`,
      );
    },
  );

  // E. 明确"完整全链路"：启动一键并带 one_click_confirmed（同义改写）
  await runScenario(
    {
      label: 'E 完整全链路确认',
      userTexts: [
        '用这个磁吸手机支架直接一键成片，不用问，完整跑完',
        '磁吸手机支架，全自动跑完整条，我授权你直接出成片',
      ],
      tools: PRODUCT_TOOLS,
      productTitle: '磁吸手机支架',
      hasResearch: true,
    },
    (r, label) => {
      check(r.startedKinds.includes('one_click_video'), `${label} 期望启动一键成片`);
      const call = lastCall(r, 'start_one_click_video');
      check(
        call && call.args.workflowDecision === 'one_click_confirmed' && call.args.renderConsent === true,
        `${label} 期望 one_click_confirmed + renderConsent，实际：${JSON.stringify(call?.args)}`,
      );
    },
  );

  // F. 已有剧本且确认出片：启动渲染并带 render_confirmed（同义改写）
  await runScenario(
    {
      label: 'F 已有剧本确认出片',
      userTexts: ['这个剧本我确认了，按当前分镜生成完整成片', '分镜没问题，确认出片，直接渲染成片'],
      tools: ['start_render_full', 'edit_shot', 'get_run_status'],
      productTitle: '保温水杯',
      hasScript: true,
      hasRenderableAsset: true,
    },
    (r, label) => {
      check(r.startedKinds.includes('render_full'), `${label} 期望启动渲染`);
      const call = lastCall(r, 'start_render_full');
      check(
        call && call.args.workflowDecision === 'render_confirmed' && call.args.renderConsent === true,
        `${label} 期望 render_confirmed + renderConsent，实际：${JSON.stringify(call?.args)}`,
      );
    },
  );

  // G. "先别生成只调研"：绝不启动
  await runScenario(
    {
      label: 'G 先别生成只调研',
      userText: '这是商品链接 https://example.com/p/123，先分析爆款打法，先别生成视频',
      tools: ['run_product_research', 'search_reference_videos', 'start_script_generation', 'start_one_click_video'],
      productTitle: 'example.com',
      productUrl: 'https://example.com/p/123',
    },
    (r, label) => check(r.startedKinds.length === 0, `${label} 不应启动任何任务，实际：${r.startedKinds.join(',')}`),
  );

  // H. 爆款参考检索：走参考库
  await runScenario(
    {
      label: 'H 爆款参考检索',
      userText: '找几个厨房切菜手部特写的爆款参考',
      tools: ['search_reference_videos', 'search_uploaded_materials'],
    },
    (r, label) => check(r.callNames.includes('search_reference_videos'), `${label} 期望调用 search_reference_videos`),
  );

  // I. 无活跃任务的进度追问：不新建任务
  await runScenario(
    {
      label: 'I 进度追问无任务',
      userText: '现在生成到哪一步了？',
      tools: ['get_run_status', 'start_one_click_video', 'start_script_generation'],
      hasActiveRun: false,
    },
    (r, label) => check(r.startedKinds.length === 0, `${label} 不应启动任何任务，实际：${r.startedKinds.join(',')}`),
  );

  // J. 改某一镜：走 edit_shot，不自动渲染
  await runScenario(
    {
      label: 'J 改分镜不渲染',
      userText: '把第2镜改成在户外草坪上展示水杯，镜头用环绕',
      tools: ['edit_shot', 'start_render_full'],
      productTitle: '保温水杯',
      hasScript: true,
      hasRenderableAsset: true,
    },
    (r, label) => {
      check(r.callNames.includes('edit_shot'), `${label} 期望调用 edit_shot`);
      check(!r.startedKinds.includes('render_full'), `${label} 只改分镜不应自动渲染`);
    },
  );

  // K. 有活跃任务时问进度：必须调 get_run_status 取实际进度，且不新建任务
  await runScenario(
    {
      label: 'K 有任务问进度查状态',
      userText: '现在生成到哪一步了？',
      tools: ['get_run_status', 'start_one_click_video', 'start_script_generation'],
      productTitle: '磁吸手机支架',
      hasActiveRun: true,
    },
    (r, label) => {
      check(r.callNames.includes('get_run_status'), `${label} 期望调用 get_run_status`);
      check(r.startedKinds.length === 0, `${label} 不应启动新任务，实际：${r.startedKinds.join(',')}`);
    },
  );

  const SCRIPT_EDIT_TOOLS = ['edit_shot', 'edit_script', 'add_shot', 'delete_shot', 'rerender_shot', 'export_video'];

  // L. 整体风格修改 → edit_script
  await runScenario(
    {
      label: 'L 整体风格修改',
      userTexts: ['把整体视觉风格换成黑金高级风', '整条片子改成 16:9 横版'],
      tools: SCRIPT_EDIT_TOOLS,
      productTitle: '保温水杯',
      hasScript: true,
    },
    (r, label) => {
      check(r.callNames.includes('edit_script'), `${label} 期望调用 edit_script，实际：${r.callNames.join(',')}`);
      check(!r.startedKinds.length, `${label} 不应启动渲染任务`);
    },
  );

  // M. 增删分镜 → add_shot / delete_shot
  await runScenario(
    {
      label: 'M 新增分镜',
      userText: '在最后加一个 CTA 分镜，引导点击下方链接',
      tools: SCRIPT_EDIT_TOOLS,
      productTitle: '保温水杯',
      hasScript: true,
    },
    (r, label) => check(r.callNames.includes('add_shot'), `${label} 期望调用 add_shot，实际：${r.callNames.join(',')}`),
  );

  // N. 单镜重渲染 → rerender_shot
  await runScenario(
    {
      label: 'N 单镜重渲',
      userText: '第2镜重新生成一下',
      tools: SCRIPT_EDIT_TOOLS,
      productTitle: '保温水杯',
      hasScript: true,
      hasRenderableAsset: true,
    },
    (r, label) => {
      check(r.callNames.includes('rerender_shot'), `${label} 期望调用 rerender_shot，实际：${r.callNames.join(',')}`);
      check(r.startedTasks.length > 0, `${label} 期望启动重渲 task`);
    },
  );

  // O. 导出成片 → export_video
  await runScenario(
    {
      label: 'O 导出成片',
      userText: '导出成 16:9 横版 1080p',
      tools: SCRIPT_EDIT_TOOLS,
      productTitle: '保温水杯',
      hasScript: true,
      hasRenderableAsset: true,
    },
    (r, label) => {
      check(r.callNames.includes('export_video'), `${label} 期望调用 export_video，实际：${r.callNames.join(',')}`);
      check(r.startedTasks.length > 0, `${label} 期望启动导出 task`);
    },
  );

  // P. 取消任务 → cancel_run
  await runScenario(
    {
      label: 'P 取消任务',
      userText: '停一下，先别生成了',
      tools: ['cancel_run', 'get_run_status', 'start_one_click_video'],
      productTitle: '保温水杯',
      hasActiveRun: true,
    },
    (r, label) => {
      check(r.callNames.includes('cancel_run'), `${label} 期望调用 cancel_run，实际：${r.callNames.join(',')}`);
      check(!r.startedKinds.length, `${label} 不应启动新任务`);
    },
  );

  await runContinuousPipeline();

  console.log('\n=================== 评测结果 ===================');
  if (failures.length) {
    console.log(`✘ ${failures.length} 项不通过：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('✔ 全部行为不变量通过');
}

main().catch((err) => {
  console.error('运行失败：', err?.response?.data || err);
  process.exit(1);
});
