#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE_URL = process.env.QWEN_VL_BASE_URL;
const API_KEY = process.env.QWEN_VL_API_KEY;
const MODEL = process.env.QWEN_VL_MODEL_ID || 'qwen3-vl-plus';
const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=');
      return [key, rest.length > 0 ? rest.join('=') : 'true'];
    }),
);
const INPUT = args.get('input') || 'tmp/kalodata-test/qwenvl-first30-local.json';
const LIMIT = Number(args.get('limit') || 3);
const OUT_DIR = args.get('out-dir') || 'tmp/kalodata-test/qwenvl-smoke';
const FORCE = args.get('force') === 'true';
const STRATEGY = args.get('strategy') || 'small-diverse';
const MIN_MB = Number(args.get('min-mb') || 0);
const MAX_MB = Number(args.get('max-mb') || Infinity);
const CONTINUE_ON_ERROR = args.get('continue-on-error') !== 'false';
const RETRIES = Number(args.get('retries') || 2);
const TIMEOUT_MS = Number(args.get('timeout-ms') || 240000);
const CACHE_DIRS = (args.get('cache-dirs') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const PROXY_ENABLED = args.get('proxy') !== 'false';
const PROXY_OVER_MB = Number(args.get('proxy-over-mb') || 20);
const PROXY_MAX_SECONDS = Number(args.get('proxy-max-seconds') || 60);
const PROXY_DIR = args.get('proxy-dir') || 'tmp/kalodata-test/qwenvl-video-proxies';
const VIDEO_FPS = Number(args.get('fps') || 2);
const INPUT_PRICE_PER_M = Number(args.get('price-input-per-m') || 0.6);
const OUTPUT_PRICE_PER_M = Number(args.get('price-output-per-m') || 6);

if (!BASE_URL || !API_KEY) {
  throw new Error('Set QWEN_VL_BASE_URL and QWEN_VL_API_KEY in the environment.');
}

function pickSmallDiverse(videos, limit) {
  const rows = videos
    .filter((item) => item.file && fs.existsSync(item.file))
    .map((item) => ({ ...item, size: fs.statSync(item.file).size }))
    .filter((item) => item.size / 1024 / 1024 >= MIN_MB && item.size / 1024 / 1024 <= MAX_MB)
    .sort((a, b) => a.size - b.size);
  const picked = [];
  const buckets = new Set();
  for (const row of rows) {
    if (buckets.has(row.bucket) && picked.length < Math.min(limit, 4)) continue;
    picked.push(row);
    buckets.add(row.bucket);
    if (picked.length >= limit) return picked;
  }
  for (const row of rows) {
    if (!picked.some((item) => item.id === row.id)) picked.push(row);
    if (picked.length >= limit) break;
  }
  return picked;
}

function pickSizeSpread(videos, limit) {
  const rows = videos
    .filter((item) => item.file && fs.existsSync(item.file))
    .map((item) => ({ ...item, size: fs.statSync(item.file).size }))
    .filter((item) => item.size / 1024 / 1024 >= MIN_MB && item.size / 1024 / 1024 <= MAX_MB)
    .sort((a, b) => a.size - b.size);
  if (rows.length <= limit) return rows;

  const picked = new Map();
  for (let i = 0; i < limit; i += 1) {
    const index = Math.round((i * (rows.length - 1)) / Math.max(1, limit - 1));
    picked.set(rows[index].id, rows[index]);
  }

  for (const row of rows) {
    if (picked.size >= limit) break;
    picked.set(row.id, row);
  }
  return [...picked.values()];
}

function pickInputOrder(videos, limit) {
  return videos
    .filter((item) => item.file && fs.existsSync(item.file))
    .map((item) => ({ ...item, size: fs.statSync(item.file).size }))
    .filter((item) => item.size / 1024 / 1024 >= MIN_MB && item.size / 1024 / 1024 <= MAX_MB)
    .slice(0, limit);
}

function contentPathFor(item) {
  return path.join(OUT_DIR, `${item.id}.json`);
}

function metaPathFor(item) {
  return path.join(OUT_DIR, `${item.id}.meta.json`);
}

function maybeCopyCachedResult(item) {
  const contentPath = contentPathFor(item);
  if (fs.existsSync(contentPath)) return false;
  for (const dir of CACHE_DIRS) {
    const cachedContentPath = path.join(dir, `${item.id}.json`);
    if (!fs.existsSync(cachedContentPath)) continue;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.copyFileSync(cachedContentPath, contentPath);
    const cachedMetaPath = path.join(dir, `${item.id}.meta.json`);
    if (fs.existsSync(cachedMetaPath)) fs.copyFileSync(cachedMetaPath, metaPathFor(item));
    return true;
  }
  return false;
}

function uploadItemFor(item) {
  if (!PROXY_ENABLED) return item;
  const mb = (item.size || fs.statSync(item.file).size) / 1024 / 1024;
  if (mb <= PROXY_OVER_MB) return item;

  fs.mkdirSync(PROXY_DIR, { recursive: true });
  const proxyFile = path.join(PROXY_DIR, `${item.id}_first${PROXY_MAX_SECONDS}s_480p.mp4`);
  if (!fs.existsSync(proxyFile)) {
    console.error(`[qwenvl] proxying ${item.id} ${mb.toFixed(2)}MB -> ${proxyFile}`);
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      item.file,
      '-t',
      String(PROXY_MAX_SECONDS),
      '-vf',
      'scale=480:-2',
      '-r',
      '8',
      '-an',
      '-movflags',
      '+faststart',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '34',
      proxyFile,
    ]);
  }
  return {
    ...item,
    originalFile: item.file,
    originalSize: item.size,
    file: proxyFile,
    size: fs.statSync(proxyFile).size,
    proxy: {
      enabled: true,
      sourceFile: item.file,
      sourceBytes: item.size,
      maxSeconds: PROXY_MAX_SECONDS,
      reason: `source_over_${PROXY_OVER_MB}mb`,
    },
  };
}

function estimateCost(usage) {
  const promptTokens = Number(usage?.prompt_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || 0);
  return (promptTokens * INPUT_PRICE_PER_M + completionTokens * OUTPUT_PRICE_PER_M) / 1_000_000;
}

function promptFor(item) {
  return `你是电商短视频视频理解模型。只返回严格 JSON，不要 Markdown。
请根据视频输出 VideoTruthSlice v1。只采纳可观察事实，不要猜测为什么卖爆。
字段：schema_version, video_id, duration_seconds, stable_factors[], observations, shot_structure[], inferred_factors[], quality_control。
stable_factors 每项包含 factor_id,value,numeric_value,confidence,tier='stable',scoring_eligible,evidence[start_second,end_second,reason]。
稳定因子只允许来自可观察事实：hook_type, product_first_visible_second, product_visible_ratio, scene_count, has_hand_demo, has_human_face, has_before_after, has_unboxing, cta_count, ocr_texts, subtitle_quality, visual_style, risk_flags。
inferred_factors 可包含 selling_points/audience 等推断字段，但 scoring_eligible 必须为 false。
商品标题：${item.productTitle || ''}
类目：${item.category || ''}
候选桶：${item.bucket || ''}
视频ID：${item.id}`;
}

async function analyze(item) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const contentPath = contentPathFor(item);
  const metaPath = metaPathFor(item);
  const copied = maybeCopyCachedResult(item);
  if (!FORCE && fs.existsSync(contentPath)) {
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};
    return {
      id: item.id,
      bucket: item.bucket,
      file: item.file,
      bytes: item.size,
      durationSeconds: item.durationSeconds,
      usage: meta.usage || null,
      finishReason: meta.finishReason || 'cached',
      cached: true,
      copied,
    };
  }

  const uploadItem = uploadItemFor(item);
  const b64 = fs.readFileSync(uploadItem.file).toString('base64');
  const payload = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: { url: `data:video/mp4;base64,${b64}` }, fps: VIDEO_FPS },
          { type: 'text', text: promptFor(item) },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 2200,
    response_format: { type: 'json_object' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content || '{}';
  const result = {
    id: item.id,
    bucket: item.bucket,
    file: item.file,
    bytes: item.size,
    uploadFile: uploadItem.file,
    uploadBytes: uploadItem.size,
    proxy: uploadItem.proxy || null,
    durationSeconds: item.durationSeconds,
    usage: json.usage || null,
    finishReason: json.choices?.[0]?.finish_reason,
    cached: false,
  };
  fs.writeFileSync(contentPath, `${content}\n`);
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        ...result,
        model: MODEL,
        analyzedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return result;
}

const input = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
const videos = Array.isArray(input) ? input : input.videos || [];
const selected =
  STRATEGY === 'size-spread'
    ? pickSizeSpread(videos, LIMIT)
    : STRATEGY === 'input-order'
      ? pickInputOrder(videos, LIMIT)
      : pickSmallDiverse(videos, LIMIT);
const results = [];

for (const item of selected) {
  console.error(`[qwenvl] analyzing ${item.id} ${item.bucket} ${(item.size / 1024 / 1024).toFixed(2)}MB`);
  let result;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      result = await analyze(item);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[qwenvl] ${item.id} attempt ${attempt + 1}/${RETRIES + 1} failed: ${message.slice(0, 300)}`);
      if (attempt >= RETRIES) {
        result = {
          id: item.id,
          bucket: item.bucket,
          file: item.file,
          bytes: item.size,
          durationSeconds: item.durationSeconds,
          usage: null,
          finishReason: 'error',
          cached: false,
          error: message,
        };
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(
          metaPathFor(item),
          `${JSON.stringify({ ...result, model: MODEL, analyzedAt: new Date().toISOString() }, null, 2)}\n`,
        );
        if (!CONTINUE_ON_ERROR) throw error;
      }
    }
  }
  results.push(result);
}

const totals = results.reduce(
  (acc, item) => {
    const usage = item.usage || {};
    const hasUsage = usage.prompt_tokens || usage.completion_tokens || usage.total_tokens;
    acc.promptTokens += Number(usage.prompt_tokens || 0);
    acc.completionTokens += Number(usage.completion_tokens || 0);
    acc.totalTokens += Number(usage.total_tokens || 0);
    acc.bytes += item.bytes || 0;
    acc.costUsd += estimateCost(usage);
    acc.cached += item.cached ? 1 : 0;
    acc.failures += item.error ? 1 : 0;
    acc.withUsage += hasUsage ? 1 : 0;
    return acc;
  },
  {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    bytes: 0,
    costUsd: 0,
    cached: 0,
    failures: 0,
    withUsage: 0,
  },
);
const freshCount = results.length - totals.cached;
const usageCount = Math.max(1, totals.withUsage);
const avgPromptTokensWithUsage = Math.round(totals.promptTokens / usageCount);
const avgCompletionTokensWithUsage = Math.round(totals.completionTokens / usageCount);
const avgTotalTokensWithUsage = Math.round(totals.totalTokens / usageCount);
const avgCostUsdWithUsage = totals.costUsd / usageCount;

const summary = {
  model: MODEL,
  count: results.length,
  freshCount,
  cachedCount: totals.cached,
  failureCount: totals.failures,
  usageCount: totals.withUsage,
  pricing: {
    inputUsdPerMillionTokens: INPUT_PRICE_PER_M,
    outputUsdPerMillionTokens: OUTPUT_PRICE_PER_M,
  },
  avgPromptTokensWithUsage,
  avgCompletionTokensWithUsage,
  avgTotalTokensWithUsage,
  avgCostUsdWithUsage: Number(avgCostUsdWithUsage.toFixed(6)),
  avgMB: Number((totals.bytes / Math.max(1, results.length) / 1024 / 1024).toFixed(2)),
  totals: {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    costUsd: Number(totals.costUsd.toFixed(6)),
  },
  estimates: {
    videos30Usd: Number((avgCostUsdWithUsage * 30).toFixed(4)),
    videos115Usd: Number((avgCostUsdWithUsage * 115).toFixed(4)),
    videos120Usd: Number((avgCostUsdWithUsage * 120).toFixed(4)),
  },
  results,
};

fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
