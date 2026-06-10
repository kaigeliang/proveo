import assert from 'node:assert/strict';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5001/api';
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return data;
}

async function waitTask(taskId) {
  for (let index = 0; index < 180; index += 1) {
    const task = await request(`/tasks/${taskId}`);
    if (task.status === 'completed') return task;
    if (task.status === 'failed') {
      throw new Error(`task ${taskId} failed: ${task.error}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`task ${taskId} timed out`);
}

function scriptText(script) {
  return [
    script.narrative,
    script.visualStyle,
    ...(script.constraints || []),
    ...(script.shots || []).flatMap((shot) => [shot.visualDesc, shot.narration, shot.subtitle]),
  ]
    .filter(Boolean)
    .join(' ');
}

function assertNoDefaultCommerceCta(script, message) {
  assert.doesNotMatch(scriptText(script), /点击小黄车|点小黄车|立即下单|马上购买|点击购买|点购物车/, message);
}

const runId = Date.now();
const productId = `smoke-product-${runId}`;
const foreignProductId = `smoke-foreign-${runId}`;
const health = await request('/health');
assert.equal(health.ok, true, 'API health check must pass');

const ungroundedGeneration = await request('/scripts/generate', {
  method: 'POST',
  body: JSON.stringify({
    productId: `smoke-unverified-${runId}`,
    mode: 'auto',
    freePrompt: '尚未导入素材的商品',
    provider: 'local',
  }),
});
const ungroundedTask = await waitTask(ungroundedGeneration.taskId);
const ungroundedScript = await request(`/scripts/${ungroundedTask.payload.scriptId}`);
assert.match(ungroundedScript.narrative, /暂无已核验证据/, 'ungrounded scripts disclose that they are not publishable');
assert.ok(
  ungroundedScript.shots.every((shot) => shot.narration.includes('暂无获批卖点')),
  'ungrounded scripts cannot state unsupported product benefits',
);
assertNoDefaultCommerceCta(ungroundedScript, 'ungrounded script avoids default purchase CTA');

async function uploadProductImage(targetProductId, name) {
  const upload = await request('/materials/upload', {
    method: 'POST',
    body: JSON.stringify({
      productId: targetProductId,
      name,
      sourceDeclaration: '冒烟测试上传商品主图',
      dataUrl: PNG_DATA_URL,
    }),
  });
  assert.ok(upload.materialId && upload.taskId, 'material upload returns task identifiers');
  const sliceTask = await waitTask(upload.taskId);
  assert.ok(sliceTask.payload.sliceIds.length > 0, 'uploaded material produces searchable slices');
  return { upload, sliceTask };
}

const primaryMaterial = await uploadProductImage(productId, 'smoke-main.png');
const foreignMaterial = await uploadProductImage(foreignProductId, 'smoke-other.png');
const materialSearch = await request(`/materials/search?q=&k=20&productId=${encodeURIComponent(productId)}`);
assert.ok(
  materialSearch.some((slice) => slice.materialId === primaryMaterial.upload.materialId),
  'active product material appears in scoped search',
);
assert.equal(
  materialSearch.some((slice) => slice.materialId === foreignMaterial.upload.materialId),
  false,
  "scoped search must not mix another product's assets",
);

const research = await request('/research/run', {
  method: 'POST',
  body: JSON.stringify({
    productId,
    product: { title: '冒烟测试便携投影仪', category: '数码家电' },
    uploadedSliceIds: primaryMaterial.sliceTask.payload.sliceIds,
    noCache: true,
    localOnly: true,
  }),
});
assert.ok(
  research.evidence.some((evidence) => evidence.sourceType === 'material'),
  'uploaded product material must enter the evidence ledger',
);
assert.ok(
  research.claims.some((claim) => claim.status === 'approved' && claim.evidenceIds.length > 0),
  'offline research must create evidence-backed approved claims',
);

const generated = await request('/scripts/generate', {
  method: 'POST',
  body: JSON.stringify({
    productId,
    mode: 'template',
    ref: 'tpl_comment_remix',
    freePrompt: '便携投影仪 评论答疑',
    provider: 'local',
  }),
});
const scriptTask = await waitTask(generated.taskId);
const scriptId = scriptTask.payload.scriptId;
let script = await request(`/scripts/${scriptId}`);
assert.equal(script.sourceMode, 'template', 'selected creative mode is stored');
assert.equal(script.sourceRef, 'tpl_comment_remix', 'selected template is stored');
assert.ok(script.materialIds.includes(primaryMaterial.upload.materialId), 'script remains grounded to product assets');
assert.match(script.referenceImageUrl, /^\/uploads\//, 'uploaded product image is bound for rendering');
assert.ok(
  script.shots.every((shot) => shot.claimIds.length > 0 && shot.evidenceIds.length > 0),
  'publishable narration is bound to approved evidence for every shot',
);
assertNoDefaultCommerceCta(script, 'grounded script avoids default purchase CTA');

script = await request(`/scripts/${scriptId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    narrative: '基于真实商品主图的评论答疑版本。',
    visualStyle: '真实桌面实拍',
    bgm: '轻快信息感',
    aspectRatio: '16:9',
  }),
});
assert.equal(script.aspectRatio, '16:9', 'script metadata changes persist');

const shotId = script.shots[0].id;
const patched = await request(`/scripts/${scriptId}/shots/${shotId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    narration: '先参考这张真实主图，再生成新的展示镜头。',
    subtitle: '参考主图生成',
  }),
});
assert.equal(patched.shots.find((shot) => shot.id === shotId).materialRef, undefined, 'shots do not bind materialRef');

const shotRender = await request('/render/shot', {
  method: 'POST',
  body: JSON.stringify({ scriptId, shotId, provider: 'seedance' }),
});
const shotTask = await waitTask(shotRender.taskId);
assert.ok(shotTask.payload.assetUrl, 'single-shot rerender returns a media asset');

const beforeFeedback = await request(`/analytics/overview?scriptId=${encodeURIComponent(scriptId)}`);
assert.equal(beforeFeedback.dataMode, 'empty', 'new video must not show invented performance');

const fullRender = await request(`/render/${scriptId}/export`, {
  method: 'POST',
  body: JSON.stringify({
    provider: 'seedance',
    aspectRatio: '16:9',
    resolution: '1280x720',
    audioMode: 'mute',
  }),
});
const renderTask = await waitTask(fullRender.taskId);
assert.equal(renderTask.payload.format, 'mp4', 'Seedance export must produce a playable MP4');
assert.match(renderTask.payload.videoUrl, /\.mp4$/, 'export result points to an MP4');
assert.ok(renderTask.payload.passport, 'each exported video receives a passport');
const passport = await request(`/passport/${renderTask.id}`);
assert.equal(passport.videoId, renderTask.id, "passport is retrievable by the exported video's id");
assert.equal(passport.scriptId, scriptId, 'passport is linked to the script');
assert.ok(passport.evidenceCoverage > 0, 'passport exposes evidence coverage for grounded narration');

const preview = await request(`/render/${scriptId}/preview`);
assert.equal(preview.videoUrl, renderTask.payload.videoUrl, 'preview points to the exported video');
script = await request(`/scripts/${scriptId}`);
assert.equal(script.aspectRatio, '16:9', 'export ratio stays on the script');

const perf = await request('/feedback/ingest', {
  method: 'POST',
  body: JSON.stringify({
    scriptId,
    videoId: renderTask.id,
    impressions: 2200,
    ctr: 0.052,
    completionRate: 0.61,
    conversionRate: 0.044,
    gmv: 9300,
  }),
});
const overview = await request(`/analytics/overview?scriptId=${encodeURIComponent(scriptId)}`);
assert.equal(overview.dataMode, 'observed', 'recorded performance is labeled as observed');
assert.equal(overview.totalVideos, 1, "dashboard is scoped to this exported video's script");
assert.equal(overview.totalImpressions, 2200, "dashboard reads the current video's submitted impressions");
const emptyOverview = await request(`/analytics/overview?scriptId=${encodeURIComponent(`unobserved-${runId}`)}`);
assert.equal(emptyOverview.dataMode, 'empty', "a different video cannot inherit another video's metrics");

const attribution = await request(`/analytics/attribution?scriptId=${encodeURIComponent(scriptId)}`);
const compliance = await request('/compliance/check', {
  method: 'POST',
  body: JSON.stringify({ targetType: 'script', targetId: scriptId }),
});
const rules = await request('/compliance/rules');

console.log(
  JSON.stringify(
    {
      api: API_BASE,
      health: health.ok,
      productId,
      isolatedMaterialResults: materialSearch.length,
      materialEvidence: research.evidence.length,
      scriptId,
      template: script.sourceRef,
      groundedMaterialIds: script.materialIds,
      shotTask: {
        status: shotTask.status,
        assetUrl: shotTask.payload.assetUrl,
      },
      renderTask: {
        status: renderTask.status,
        videoUrl: renderTask.payload.videoUrl,
        passportId: passport.videoId,
      },
      analytics: {
        dataMode: overview.dataMode,
        totalVideos: overview.totalVideos,
        impressions: overview.totalImpressions,
        attributionCount: attribution.length,
      },
      feedbackId: perf.id,
      compliance: {
        level: compliance.level,
        hits: compliance.hits.length,
      },
      rules: rules.length,
    },
    null,
    2,
  ),
);
