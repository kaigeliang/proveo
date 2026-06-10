import assert from 'node:assert/strict';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5001/api';
const RUN_REAL = process.env.RUN_REAL_SEEDANCE_E2E === 'true';
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAADjUddLAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA' +
  'G0lEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GkBQAABm3Q0XAAAAABJRU5ErkJggg==';
const REMOTE_REFERENCE_IMAGE = process.env.P0_E2E_REFERENCE_IMAGE_URL?.trim();

if (!RUN_REAL) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: true,
        reason: 'Set RUN_REAL_SEEDANCE_E2E=true to run the real Seedance P0 E2E smoke.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

function assertPresent(value, message) {
  assert.ok(value !== undefined && value !== null && String(value).trim(), message);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

async function waitTask(taskId, options = {}) {
  const timeoutMs = options.timeoutMs || 900_000;
  const pollMs = options.pollMs || 1500;
  const startedAt = Date.now();
  let lastTask = null;
  while (Date.now() - startedAt < timeoutMs) {
    const task = await request(`/tasks/${encodeURIComponent(taskId)}`);
    lastTask = task;
    if (task.status === 'completed') return task;
    if (task.status === 'failed') {
      throw new Error(`task ${taskId} failed at ${task.step}: ${task.error || 'unknown'}`);
    }
    if (task.status === 'cancelled') {
      throw new Error(`task ${taskId} was cancelled`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`task ${taskId} timed out; last=${JSON.stringify(lastTask)}`);
}

async function trimToOneShot(script) {
  let current = script;
  const sorted = [...(current.shots || [])].sort((a, b) => a.order - b.order);
  assert.ok(sorted.length > 0, 'script must contain at least one shot');
  for (const shot of sorted.slice(1)) {
    current = await request(`/scripts/${encodeURIComponent(current.id)}/shots/${encodeURIComponent(shot.id)}`, {
      method: 'DELETE',
    });
  }
  const first = current.shots[0];
  current = await request(`/scripts/${encodeURIComponent(current.id)}/shots/${encodeURIComponent(first.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      order: 1,
      duration: 3,
      visualDesc: 'A clean ecommerce product hero shot on a simple tabletop, clear product shape, realistic lighting.',
      camera: 'slow push-in, stable product close-up',
      narration: '先看核心卖点，画面保持真实清晰。',
      subtitle: '核心卖点',
    }),
  });
  assert.equal(current.shots.length, 1, 'script should be trimmed to one shot for low-cost P0 smoke');
  return current;
}

const runId = Date.now();
const productId = `p0-real-${runId}`;

const health = await request('/health');
assert.equal(health.ok, true, 'API health must pass');
assert.equal(health.providers?.seedanceVideo, true, 'Seedance provider must be configured');

const upload = await request('/materials/upload', {
  method: 'POST',
  body: JSON.stringify({
    productId,
    name: 'p0-real-product.png',
    sourceDeclaration: 'P0 real E2E smoke product image',
    dataUrl: PNG_DATA_URL,
  }),
});
assertPresent(upload.materialId, 'material upload should return materialId');
assertPresent(upload.taskId, 'material upload should return taskId');
const sliceTask = await waitTask(upload.taskId, { timeoutMs: 180_000 });
assert.ok(sliceTask.payload?.sliceIds?.length > 0, 'material upload should produce slices');

const scriptJob = await request('/scripts/generate', {
  method: 'POST',
  body: JSON.stringify({
    productId,
    mode: 'template',
    ref: 'tpl_comment_remix',
    freePrompt: '便携桌面收纳架 P0 真链路冒烟',
    provider: 'local',
    retrievalMode: 'none',
    generationProfile: 'quick_preview',
  }),
});
assertPresent(scriptJob.taskId, 'script generation should return taskId');
const scriptTask = await waitTask(scriptJob.taskId, { timeoutMs: 240_000 });
const scriptId = scriptTask.payload?.scriptId;
assertPresent(scriptId, 'script task should return scriptId');

let script = await request(`/scripts/${encodeURIComponent(scriptId)}`);
assert.ok(script.materialIds?.includes(upload.materialId), 'script should be grounded to uploaded material');
assert.ok(script.referenceImageUrl, 'script should bind a product reference image');
script = await trimToOneShot(script);

const renderJob = await request(`/render/${encodeURIComponent(script.id)}/export`, {
  method: 'POST',
  body: JSON.stringify({
    provider: 'seedance',
    aspectRatio: '9:16',
    resolution: '720x1280',
    audioMode: 'mute',
    retrievalMode: 'none',
    renderProfile: 'fast_preview',
    fastRender: true,
    ...(REMOTE_REFERENCE_IMAGE && { referenceImageUrl: REMOTE_REFERENCE_IMAGE }),
  }),
});
assertPresent(renderJob.taskId, 'render export should return taskId');
const renderTask = await waitTask(renderJob.taskId, { timeoutMs: 900_000, pollMs: 3000 });
const renderPayload = asRecord(renderTask.payload);
const agentOutput = asRecord(renderPayload.agentOutput);
const renderFormat = renderPayload.format || agentOutput.format;
const renderVideoUrl = renderPayload.videoUrl || agentOutput.videoUrl;
const renderPassport = asRecord(renderPayload.passport || agentOutput.passport);
assert.equal(renderFormat, 'mp4', 'render result should be mp4');
assert.match(String(renderVideoUrl || ''), /\.mp4($|\?)/, 'render should return an MP4 URL');
assert.ok(Object.keys(renderPassport).length > 0, 'render result should include passport');
assert.equal(renderPassport.scriptId, script.id, 'payload passport should link to script');

const preview = await request(`/render/${encodeURIComponent(script.id)}/preview`);
assert.equal(preview.videoUrl, renderVideoUrl, 'preview should point to the exported MP4');

const passportLookupId = renderPassport.videoId || renderPayload.videoId || renderVideoUrl;
assertPresent(passportLookupId, 'render result should expose a passport/video lookup id');
const passport = await request(`/passport/${encodeURIComponent(passportLookupId)}`);
assert.equal(passport.videoId, passportLookupId, 'passport should be retrievable by persisted video id');
assert.equal(passport.scriptId, script.id, 'passport should link to script');

console.log(
  JSON.stringify(
    {
      ok: true,
      apiBase: API_BASE,
      productId,
      materialId: upload.materialId,
      scriptId: script.id,
      renderTaskId: renderTask.id,
      videoUrl: renderVideoUrl,
      passport: {
        trustScore: passport.trustScore,
        evidenceCoverage: passport.evidenceCoverage,
        policyRisk: passport.policyRisk,
      },
      checked: [
        'material upload',
        'material slicing',
        'script generation',
        'main image binding',
        'one-shot Seedance render',
        'FFmpeg MP4 compose',
        'preview restore',
        'passport lookup',
      ],
    },
    null,
    2,
  ),
);
