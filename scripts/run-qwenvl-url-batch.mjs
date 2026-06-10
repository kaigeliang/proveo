#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch {
  // dotenv is optional; env vars may also be supplied by the caller.
}

const BASE_URL = process.env.QWEN_VL_BASE_URL;
const API_KEY = process.env.QWEN_VL_API_KEY;
const MODEL = process.env.QWEN_VL_MODEL_ID || 'qwen3-vl-flash';

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=');
      return [key, rest.length > 0 ? rest.join('=') : 'true'];
    }),
);

const INPUT = args.get('input') || 'tmp/kalodata-test/qwenvl-url-candidates.json';
const OUT_DIR = args.get('out-dir') || 'tmp/kalodata-test/qwenvl-url-batch';
const LIMIT = Number(args.get('limit') || 10);
const OFFSET = Number(args.get('offset') || 0);
const CONCURRENCY = Math.max(1, Number(args.get('concurrency') || 1));
const FORCE = args.get('force') === 'true';
const CONTINUE_ON_ERROR = args.get('continue-on-error') !== 'false';
const RETRIES = Number(args.get('retries') || 1);
const TIMEOUT_MS = Number(args.get('timeout-ms') || 150000);
const FPS = Number(args.get('fps') || 1);
const MAX_TOKENS = Number(args.get('max-tokens') || 1800);
const SLEEP_MS = Number(args.get('sleep-ms') || 0);
const PROXY_ENABLED = args.get('proxy') !== 'false';
const PROXY_OVER_MB = Number(args.get('proxy-over-mb') || 20);
const PROXY_MAX_SECONDS = Number(args.get('proxy-max-seconds') || 60);
const PROXY_DIR = args.get('proxy-dir') || path.join(OUT_DIR, 'video-proxies');
const UPLOAD_PROVIDER = args.get('upload-provider') || 'uguu';
const INPUT_PRICE_PER_M = Number(args.get('price-input-per-m') || 0.6);
const OUTPUT_PRICE_PER_M = Number(args.get('price-output-per-m') || 6);
const SUMMARY_FILE = args.get('summary-file') || path.join(OUT_DIR, 'summary.json');

if (!BASE_URL || !API_KEY) {
  throw new Error('Set QWEN_VL_BASE_URL and QWEN_VL_API_KEY in the environment.');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentPathFor(item) {
  return path.join(OUT_DIR, `${item.id}.json`);
}

function metaPathFor(item) {
  return path.join(OUT_DIR, `${item.id}.meta.json`);
}

function estimateCost(usage) {
  const promptTokens = Number(usage?.prompt_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || 0);
  return (promptTokens * INPUT_PRICE_PER_M + completionTokens * OUTPUT_PRICE_PER_M) / 1_000_000;
}

function isTerminalQwenError(error) {
  return /data_inspection_failed|inappropriate content|Input video data may contain inappropriate|Invalid video file/i.test(
    String(error || ''),
  );
}

function maybeProxy(item) {
  if (!PROXY_ENABLED) return item;
  const size = item.size || fs.statSync(item.file).size;
  const mb = size / 1024 / 1024;
  if (mb <= PROXY_OVER_MB) return { ...item, size };

  fs.mkdirSync(PROXY_DIR, { recursive: true });
  const proxyFile = path.join(PROXY_DIR, `${item.id}_first${PROXY_MAX_SECONDS}s_480p.mp4`);
  if (!fs.existsSync(proxyFile)) {
    console.error(`[qwenvl-url] proxying ${item.id} ${mb.toFixed(2)}MB -> ${proxyFile}`);
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
    originalSize: size,
    file: proxyFile,
    size: fs.statSync(proxyFile).size,
    proxy: {
      enabled: true,
      sourceFile: item.file,
      sourceBytes: size,
      maxSeconds: PROXY_MAX_SECONDS,
      reason: `source_over_${PROXY_OVER_MB}mb`,
    },
  };
}

async function uploadWithUguu(filePath) {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  const blob = new Blob([bytes], { type: 'video/mp4' });
  form.append('files[]', blob, path.basename(filePath));
  const response = await fetch('https://uguu.se/upload.php', { method: 'POST', body: form });
  const text = await response.text();
  if (!response.ok) throw new Error(`upload HTTP ${response.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  const url = parsed?.files?.[0]?.url;
  if (!parsed?.success || !url) throw new Error(`upload failed: ${text.slice(0, 300)}`);
  return url.replace(/\\\//g, '/');
}

async function uploadVideo(filePath) {
  if (UPLOAD_PROVIDER !== 'uguu') throw new Error(`Unsupported upload-provider: ${UPLOAD_PROVIDER}`);
  return uploadWithUguu(filePath);
}

function promptFor(item) {
  return `你是电商短视频创作因子抽取器。只基于视频可见内容输出严格 JSON，不要 Markdown，不要解释。
商品标题和类目仅用于识别商品，不可替代视频证据；不要根据标题猜测不可见内容。

任务：为带货视频生成 VideoTruthSlice.v2。只抽取可验证创作因子，无法确认就填 null、false 或 unknown。

输出格式：
{
  "schema_version":"VideoTruthSlice.v2",
  "video_id":"${item.id}",
  "duration_seconds":number|null,
  "stable_factors":{
    "hook_type":{"value":"pain_point|product_demo|before_after|unboxing|social_proof|offer|lifestyle|unknown","confidence":0到1,"evidence_second":number|null},
    "product_first_visible_second":{"value":number|null,"confidence":0到1},
    "product_visible_ratio":{"value":0到1,"confidence":0到1},
    "scene_count":{"value":number|null,"confidence":0到1},
    "has_hand_demo":{"value":boolean,"confidence":0到1},
    "has_human_face":{"value":boolean,"confidence":0到1},
    "has_before_after":{"value":boolean,"confidence":0到1},
    "has_unboxing":{"value":boolean,"confidence":0到1},
    "cta_count":{"value":number,"confidence":0到1},
    "ocr_texts":{"value":["最多5条，每条<=20字"],"confidence":0到1},
    "subtitle_quality":{"value":"none|clear|partial|unclear","confidence":0到1},
    "visual_style":{"value":"home_demo|studio_demo|ugc_selfie|screen_recording|mixed|unknown","confidence":0到1},
    "risk_flags":{"value":["logo_text_error|unsafe_claim|unclear_product|none"],"confidence":0到1}
  },
  "shot_summary":["最多3条，每条<=24字"],
  "quality_control":{"status":"ok|warning","notes":["最多2条，每条<=20字"]}
}

约束：
- 不输出未列出的字段。
- stable_factors 每个因子必须出现。
- 不输出长段描述；evidence 只给秒数，不给长解释。
- 不确定时 confidence <= 0.5。

商品标题：${item.productTitle || ''}
类目：${item.category || ''}
视频时长：${item.durationSeconds ?? ''}`;
}

async function callQwen(item, videoUrl) {
  const payload = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: { url: videoUrl }, fps: FPS },
          { type: 'text', text: promptFor(item) },
        ],
      },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  clearTimeout(timer);
  const text = await response.text();
  if (!response.ok) throw new Error(`Qwen HTTP ${response.status}: ${text.slice(0, 800)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { parse_error: true, raw: content };
  }
  return { parsed, usage: json.usage || null, finishReason: json.choices?.[0]?.finish_reason };
}

async function analyze(rawItem) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!rawItem.file || !fs.existsSync(rawItem.file)) throw new Error(`missing file: ${rawItem.file || rawItem.id}`);
  const existingPath = contentPathFor(rawItem);
  const existingMetaPath = metaPathFor(rawItem);
  if (!FORCE && fs.existsSync(existingPath)) {
    const meta = fs.existsSync(existingMetaPath) ? readJson(existingMetaPath) : {};
    return {
      id: rawItem.id,
      file: rawItem.file,
      bytes: rawItem.size || fs.statSync(rawItem.file).size,
      usage: meta.usage || null,
      finishReason: meta.finishReason || 'cached',
      cached: true,
    };
  }
  if (!FORCE && fs.existsSync(existingMetaPath)) {
    const meta = readJson(existingMetaPath);
    if (meta.error && isTerminalQwenError(meta.error)) {
      return {
        id: rawItem.id,
        file: rawItem.file,
        bytes: rawItem.size || fs.statSync(rawItem.file).size,
        bucket: rawItem.bucket,
        durationSeconds: rawItem.durationSeconds,
        usage: null,
        finishReason: meta.finishReason || 'error',
        cached: true,
        error: meta.error,
        terminalError: true,
      };
    }
  }

  const uploadItem = maybeProxy({
    ...rawItem,
    size: rawItem.size || fs.statSync(rawItem.file).size,
  });
  const videoUrl = await uploadVideo(uploadItem.file);
  const startedAt = Date.now();
  const qwen = await callQwen(rawItem, videoUrl);
  const meta = {
    id: rawItem.id,
    model: MODEL,
    analyzedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    file: rawItem.file,
    bytes: rawItem.size || fs.statSync(rawItem.file).size,
    uploadFile: uploadItem.file,
    uploadBytes: uploadItem.size || fs.statSync(uploadItem.file).size,
    videoUrl,
    proxy: uploadItem.proxy || null,
    bucket: rawItem.bucket,
    durationSeconds: rawItem.durationSeconds,
    usage: qwen.usage,
    finishReason: qwen.finishReason,
    cached: false,
  };
  fs.writeFileSync(contentPathFor(rawItem), `${JSON.stringify(qwen.parsed, null, 2)}\n`);
  fs.writeFileSync(metaPathFor(rawItem), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const input = readJson(INPUT);
const allVideos = Array.isArray(input) ? input : input.videos || [];
const selected = allVideos
  .filter((item) => item.file && fs.existsSync(item.file))
  .map((item) => ({ ...item, size: fs.statSync(item.file).size }))
  .slice(OFFSET, OFFSET + LIMIT);

async function processItem(item) {
  console.error(`[qwenvl-url] analyzing ${item.id} ${(item.size / 1024 / 1024).toFixed(2)}MB`);
  let result;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      result = await analyze(item);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[qwenvl-url] ${item.id} attempt ${attempt + 1}/${RETRIES + 1} failed: ${message.slice(0, 300)}`);
      const terminalError = isTerminalQwenError(message);
      if (terminalError || attempt >= RETRIES) {
        result = {
          id: item.id,
          file: item.file,
          bytes: item.size,
          bucket: item.bucket,
          durationSeconds: item.durationSeconds,
          usage: null,
          finishReason: 'error',
          cached: false,
          error: message,
          terminalError,
        };
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(
          metaPathFor(item),
          `${JSON.stringify({ ...result, model: MODEL, analyzedAt: new Date().toISOString() }, null, 2)}\n`,
        );
        if (!CONTINUE_ON_ERROR) throw error;
        break;
      }
    }
  }
  if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  return result;
}

const results = new Array(selected.length);
let nextIndex = 0;

async function worker() {
  while (nextIndex < selected.length) {
    const currentIndex = nextIndex;
    nextIndex += 1;
    results[currentIndex] = await processItem(selected[currentIndex]);
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));

const totals = results.reduce(
  (acc, item) => {
    const usage = item.usage || {};
    acc.promptTokens += Number(usage.prompt_tokens || 0);
    acc.completionTokens += Number(usage.completion_tokens || 0);
    acc.totalTokens += Number(usage.total_tokens || 0);
    acc.videoTokens += Number(usage.prompt_tokens_details?.video_tokens || 0);
    acc.bytes += Number(item.bytes || 0);
    acc.uploadBytes += Number(item.uploadBytes || item.bytes || 0);
    acc.costUsd += estimateCost(usage);
    acc.cached += item.cached ? 1 : 0;
    acc.failures += item.error ? 1 : 0;
    acc.withUsage += usage.prompt_tokens || usage.completion_tokens || usage.total_tokens ? 1 : 0;
    return acc;
  },
  {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    videoTokens: 0,
    bytes: 0,
    uploadBytes: 0,
    costUsd: 0,
    cached: 0,
    failures: 0,
    withUsage: 0,
  },
);
const usageCount = Math.max(1, totals.withUsage);
const avgCostUsdWithUsage = totals.costUsd / usageCount;
const summary = {
  model: MODEL,
  input: INPUT,
  outDir: OUT_DIR,
  offset: OFFSET,
  limit: LIMIT,
  count: results.length,
  freshCount: results.length - totals.cached,
  cachedCount: totals.cached,
  failureCount: totals.failures,
  usageCount: totals.withUsage,
  avgPromptTokensWithUsage: Math.round(totals.promptTokens / usageCount),
  avgCompletionTokensWithUsage: Math.round(totals.completionTokens / usageCount),
  avgVideoTokensWithUsage: Math.round(totals.videoTokens / usageCount),
  avgTotalTokensWithUsage: Math.round(totals.totalTokens / usageCount),
  avgCostUsdWithUsage: Number(avgCostUsdWithUsage.toFixed(6)),
  avgSourceMB: Number((totals.bytes / Math.max(1, results.length) / 1024 / 1024).toFixed(2)),
  avgUploadMB: Number((totals.uploadBytes / Math.max(1, results.length) / 1024 / 1024).toFixed(2)),
  totals: {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    videoTokens: totals.videoTokens,
    costUsd: Number(totals.costUsd.toFixed(6)),
  },
  estimates: {
    videos100Usd: Number((avgCostUsdWithUsage * 100).toFixed(4)),
    videos900Usd: Number((avgCostUsdWithUsage * 900).toFixed(4)),
  },
  results,
};

fs.writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
