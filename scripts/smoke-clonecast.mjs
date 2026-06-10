#!/usr/bin/env node
/**
 * CloneCast production smoke.
 *
 * Requires API + Postgres + Redis + Worker. It verifies the core path:
 * recipe extraction -> queued clone script -> benchmark score.
 */

const BASE = (process.env.API_BASE_URL || 'http://127.0.0.1:5001').replace(/\/$/, '');
const PRODUCT_ID = `clonecast_smoke_${Date.now()}`;

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return body;
}

async function waitTask(taskId) {
  let last;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const task = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
    last = task;
    if (task.status === 'failed') throw new Error(`task failed: ${task.error || task.step}`);
    if (task.status === 'completed') return task;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`task timeout: ${taskId}, last=${last?.status}/${last?.step}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n▶ CloneCast smoke\n');

const health = await request('/api/health');
assert(health.ok === true, 'API health failed');
console.log('  ✓ API health');

const extracted = await request('/api/recipes/extract', {
  method: 'POST',
  body: JSON.stringify({
    sourceUrl: `https://example.com/reference-video-${Date.now()}.mp4`,
    query: 'kitchen peeler hand demo before after product reveal',
    productId: PRODUCT_ID,
    title: '厨房削皮器爆款手部演示配方',
  }),
});
assert(extracted.recipe?.id, 'recipe id missing');
assert(Array.isArray(extracted.recipe.segments) && extracted.recipe.segments.length > 0, 'recipe segments missing');
assert(
  Array.isArray(extracted.recipe.factors?.canonical) && extracted.recipe.factors.canonical.length > 0,
  'recipe canonical factors missing',
);
console.log(`  ✓ recipe extracted: ${extracted.recipe.id}`);

const clone = await request(`/api/recipes/${encodeURIComponent(extracted.recipe.id)}/clone`, {
  method: 'POST',
  body: JSON.stringify({
    productId: PRODUCT_ID,
    productTitle: '厨房削皮器',
    provider: 'local',
    generationProfile: 'quick_preview',
  }),
});
assert(clone.taskId && clone.cloneId, 'clone response missing taskId/cloneId');
console.log(`  ✓ clone queued: ${clone.taskId}`);

const task = await waitTask(clone.taskId);
const scriptId = task.payload?.scriptId || task.payload?.result?.scriptId;
assert(scriptId, 'scriptId missing after clone task');
console.log(`  ✓ script generated: ${scriptId}`);

const score = await request(`/api/recipes/${encodeURIComponent(extracted.recipe.id)}/score`, {
  method: 'POST',
  body: JSON.stringify({ scriptId, cloneId: clone.cloneId }),
});
assert(typeof score.compositeScore === 'number', 'compositeScore missing');
assert(Array.isArray(score.recipeFactors), 'recipeFactors missing');
assert(Array.isArray(score.scriptFactors), 'scriptFactors missing');
console.log(`  ✓ scored: benchmark=${score.benchmarkScore ?? 'n/a'} composite=${score.compositeScore}`);

console.log('\nCloneCast smoke passed.\n');
