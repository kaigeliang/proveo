const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5001/api';
const projectId = `smoke_p0_${Date.now()}`;
const now = Date.now();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text };
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `${options.method || 'GET'} ${path} HTTP ${response.status}: ${body.error || JSON.stringify(body)}`,
    );
  }
  return body;
}

const scriptVersionId = `${projectId}_script_v01`;
const renderVersionId = `${projectId}_render_v01`;
const taskId = `${projectId}_task`;
const runId = `${projectId}_run`;
const session = {
  id: projectId,
  title: 'P0 快照烟测商品',
  productId: `${projectId}_product`,
  productTitle: 'P0 快照烟测商品',
  scriptId: `${projectId}_script`,
  taskId,
  runId,
  messages: [
    { id: `${projectId}_msg_user`, role: 'user', text: '帮我生成一条商品带货视频' },
    { id: `${projectId}_msg_bot`, role: 'assistant', text: '剧本和分镜已就绪。' },
  ],
  activityItems: [
    { id: `${projectId}_act_user`, kind: 'chat-user', text: '帮我生成一条商品带货视频' },
    { id: `${projectId}_act_bot`, kind: 'chat-bot', text: '剧本和分镜已就绪。' },
  ],
  magicProgress: {
    subject: 'P0 快照烟测商品',
    acts: {},
    renderTask: { id: taskId, status: 'processing', progress: 53, step: 'seedance_polling' },
  },
  projectSnapshot: {
    productId: `${projectId}_product`,
    productTitle: 'P0 快照烟测商品',
    scriptVersions: [
      {
        id: scriptVersionId,
        label: 'P0 快照烟测商品 · 2026-06-08 · 剧本V01',
        createdAt: now,
        sourceRunId: runId,
        script: {
          id: `${projectId}_script`,
          productId: `${projectId}_product`,
          generationProfile: 'quick_preview',
          narrative: '用真实卖点讲清楚商品价值。',
          visualStyle: 'clean ecommerce',
          aspectRatio: '9:16',
          language: 'zh-CN',
          shots: [
            {
              id: `${projectId}_shot_1`,
              order: 1,
              duration: 5,
              visualDesc: '商品主图清晰入镜',
              narration: '先看这个核心卖点。',
              subtitle: '核心卖点',
              factors: [],
              status: 'draft',
            },
          ],
        },
      },
    ],
    activeScriptVersionId: scriptVersionId,
    renderVersions: [
      {
        id: renderVersionId,
        label: 'P0 快照烟测商品 · 2026-06-08 · 成片V01',
        createdAt: now,
        scriptVersionId,
        taskId,
        result: {
          scriptId: `${projectId}_script`,
          videoId: `${projectId}_video`,
          videoUrl: 'http://127.0.0.1:5001/generated/p0-smoke.mp4',
          format: 'mp4',
          provider: 'seedance',
        },
      },
    ],
    activeRenderVersionId: renderVersionId,
    task: { id: taskId, status: 'processing', progress: 53, step: 'seedance_polling' },
    activeAgentRunId: runId,
    activeRunKind: 'render_full',
  },
  createdAt: now,
  updatedAt: now,
};

try {
  const saved = await request(`/projects/${encodeURIComponent(projectId)}/snapshot`, {
    method: 'PUT',
    body: JSON.stringify({ session }),
  });
  assert(saved.ok === true, 'snapshot save did not return ok=true');
  assert(saved.session?.id === projectId, 'saved snapshot id mismatch');

  const listed = await request('/projects?limit=20');
  assert(
    Array.isArray(listed.items) && listed.items.some((item) => item.id === projectId),
    'saved project missing from list',
  );

  const fetched = await request(`/projects/${encodeURIComponent(projectId)}/snapshot`);
  const restored = fetched.session;
  assert(restored?.projectSnapshot?.activeAgentRunId === runId, 'active run handle was not restored');
  assert(restored?.projectSnapshot?.task?.id === taskId, 'active task handle was not restored');
  assert(restored?.projectSnapshot?.scriptVersions?.[0]?.id === scriptVersionId, 'script version was not restored');
  assert(restored?.projectSnapshot?.renderVersions?.[0]?.id === renderVersionId, 'render version was not restored');
  assert(restored?.activityItems?.length === 2, 'conversation activity items were not restored');

  await request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  console.log(
    JSON.stringify(
      {
        ok: true,
        apiBase: API_BASE,
        checked: [
          'project snapshot save',
          'project list',
          'snapshot restore',
          'version tree restore',
          'delete cleanup',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  try {
    await request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  } catch {
    // ignore cleanup failures; the main error is reported below.
  }
  throw error;
}
