#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch {
  // Environment can also be provided by the caller.
}

const db = require('@aigc-video-hub/db');

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

if (hasFlag('help')) {
  console.log(`Usage: npm run subtitles:decompose -- [options]

Selects high-value SubtitleStyleSlice.v1 references, downloads source MP4s, and asks Qwen-VL for
observed subtitle timing, placement, style, and overlap details.

Options:
  --limit=<n>                  Number of references to process, default 5.
  --offset=<n>                 Selection offset after sorting, default 0.
  --out-dir=<path>             Output directory, default tmp/subtitle-placement-truth.
  --video-dir=<path>           Download cache directory, default tmp/subtitle-style-videos.
  --selection=diverse|score    Candidate picker, default diverse.
  --max-duration=<seconds>     Skip longer references, 0 disables, default 75.
  --min-value-score=<n>        Minimum SubtitleStyleSlice valueScore, default 0.8.
  --dry-run                    Only print selected candidates; no download, Qwen, or DB writes.
  --download=false             Skip downloads and use cached files only.
  --analyze=false              Skip Qwen analysis.
  --write-db                   Write subtitlePlacementTruth back to ReferenceVideo.breakdownReport.
  --force                      Re-run Qwen even when cached JSON exists.
  --force-download             Re-download MP4s even when cached.
  --concurrency=<n>            Parallel Qwen workers, default 1.
  --retries=<n>                Qwen retries per item, default 1.
  --fps=<n>                    Qwen video sampling FPS, default QWEN_VL_SUBTITLE_FPS or 1.
  --max-tokens=<n>             Qwen max tokens, default 2400.
  --timeout-ms=<n>             Qwen timeout, default 240000.
  --upload-provider=qingyun-media|uguu|data-url
                               Video transport, default qingyun-media; data-url inlines the MP4.
  --proxy-over-mb=<n>          Upload a compressed proxy when source is larger, default 25.
  --proxy-max-seconds=<n>      Proxy max duration, default 75.
  --continue-on-error=false    Stop on first item failure.
  --help                       Show this help.`);
  process.exit(0);
}

const BASE_URL = process.env.QWEN_VL_BASE_URL;
const API_KEY = process.env.QWEN_VL_API_KEY;
const MODEL = process.env.QWEN_VL_MODEL_ID || 'qwen3-vl-plus';

const LIMIT = Math.max(1, Number(readArg('limit', '5')));
const OFFSET = Math.max(0, Number(readArg('offset', '0')));
const OUT_DIR = path.resolve(readArg('out-dir', 'tmp/subtitle-placement-truth'));
const VIDEO_DIR = path.resolve(readArg('video-dir', 'tmp/subtitle-style-videos'));
const SELECTION = readArg('selection', 'diverse');
const MAX_DURATION = Number(readArg('max-duration', '75'));
const MIN_VALUE_SCORE = Number(readArg('min-value-score', '0.8'));
const DRY_RUN = hasFlag('dry-run');
const DOWNLOAD = readArg('download', 'true') !== 'false' && !DRY_RUN;
const ANALYZE = readArg('analyze', 'true') !== 'false' && !DRY_RUN;
const WRITE_DB = hasFlag('write-db') && !DRY_RUN;
const FORCE = hasFlag('force');
const FORCE_DOWNLOAD = hasFlag('force-download');
const CONCURRENCY = Math.max(1, Number(readArg('concurrency', '1')));
const RETRIES = Math.max(0, Number(readArg('retries', '1')));
const TIMEOUT_MS = Number(readArg('timeout-ms', '240000'));
const FPS = Number(readArg('fps', process.env.QWEN_VL_SUBTITLE_FPS || '1'));
const MAX_TOKENS = Number(readArg('max-tokens', '2400'));
const SLEEP_MS = Math.max(0, Number(readArg('sleep-ms', '0')));
const CONTINUE_ON_ERROR = readArg('continue-on-error', 'true') !== 'false';
const PROXY_ENABLED = readArg('proxy', 'true') !== 'false';
const PROXY_OVER_MB = Number(readArg('proxy-over-mb', '25'));
const PROXY_MAX_SECONDS = Number(readArg('proxy-max-seconds', '75'));
const PROXY_DIR = path.join(OUT_DIR, 'video-proxies');
const UPLOAD_PROVIDER = readArg('upload-provider', 'qingyun-media');
const INPUT_PRICE_PER_M = Number(readArg('price-input-per-m', '0.6'));
const OUTPUT_PRICE_PER_M = Number(readArg('price-output-per-m', '6'));

if (ANALYZE && (!BASE_URL || !API_KEY)) {
  throw new Error('Set QWEN_VL_BASE_URL and QWEN_VL_API_KEY before running Qwen subtitle decomposition.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function contentPathFor(item) {
  return path.join(OUT_DIR, `${item.referenceId}.json`);
}

function metaPathFor(item) {
  return path.join(OUT_DIR, `${item.referenceId}.meta.json`);
}

function videoPathFor(item) {
  return path.join(VIDEO_DIR, `${item.referenceId}.mp4`);
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textHasHardRisk(texts) {
  const joined = texts.join(' ').toLowerCase();
  return /\b(big dick|nude|porn|sex toy|weapon|gun|cocaine|weed)\b/.test(joined);
}

function rowFromReference(reference) {
  const breakdown = reference.breakdownReport || {};
  const slice = breakdown.subtitleStyleSlice || {};
  if (slice.schemaVersion !== 'SubtitleStyleSlice.v1') return null;
  if (!reference.sourceUrl) return null;
  const durationSeconds = normalizeNumber(slice.reference?.durationSeconds || breakdown.durationSeconds, 0);
  const ocrTexts = Array.isArray(slice.evidence?.ocrTexts) ? slice.evidence.ocrTexts.map(String).filter(Boolean) : [];
  if (MAX_DURATION > 0 && durationSeconds > MAX_DURATION) return null;
  if (normalizeNumber(slice.valueScore, 0) < MIN_VALUE_SCORE) return null;
  if (textHasHardRisk(ocrTexts)) return null;
  return {
    id: reference.id,
    referenceId: reference.id,
    sourceUrl: reference.sourceUrl,
    localVideoUrl: reference.localVideoUrl || '',
    sourceDeclaration: reference.sourceDeclaration,
    licenseType: reference.licenseType || '',
    usageScope: reference.usageScope || '',
    breakdown,
    slice,
    valueScore: normalizeNumber(slice.valueScore, 0),
    benchmarkScore: normalizeNumber(slice.reference?.benchmarkScore, 0),
    category: normalizeText(slice.reference?.category, 'unknown'),
    productTitle: normalizeText(slice.reference?.productTitle),
    durationSeconds,
    density: normalizeText(slice.style?.density, 'unknown'),
    headlinePattern: normalizeText(slice.style?.headlinePattern, 'unknown'),
    textFunctions: Array.isArray(slice.style?.textFunctions) ? slice.style.textFunctions : [],
    ocrTexts,
    alreadyDecomposed:
      breakdown.subtitlePlacementTruth?.schemaVersion === 'SubtitlePlacementTruth.v1' ||
      breakdown.subtitlePlacementTruth?.schema_version === 'SubtitlePlacementTruth.v1',
  };
}

function selectByScore(rows) {
  return rows
    .slice()
    .sort((a, b) => b.valueScore - a.valueScore || b.benchmarkScore - a.benchmarkScore)
    .slice(OFFSET, OFFSET + LIMIT);
}

function selectDiverse(rows) {
  const sorted = rows.slice().sort((a, b) => b.valueScore - a.valueScore || b.benchmarkScore - a.benchmarkScore);
  const selected = [];
  const seenCategory = new Set();
  const seenHeadline = new Set();
  const seenDensity = new Set();
  const passes = [
    (item) => !seenCategory.has(item.category) && !seenHeadline.has(item.headlinePattern),
    (item) => !seenCategory.has(item.category) && !seenDensity.has(item.density),
    (item) => !seenCategory.has(item.category),
    () => true,
  ];

  for (const pass of passes) {
    for (const item of sorted) {
      if (selected.some((picked) => picked.referenceId === item.referenceId)) continue;
      if (!pass(item)) continue;
      selected.push(item);
      seenCategory.add(item.category);
      seenHeadline.add(item.headlinePattern);
      seenDensity.add(item.density);
      if (selected.length >= OFFSET + LIMIT) return selected.slice(OFFSET, OFFSET + LIMIT);
    }
  }
  return selected.slice(OFFSET, OFFSET + LIMIT);
}

function downloadVideo(item) {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const outPath = videoPathFor(item);
  if (!FORCE_DOWNLOAD && fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
    return { file: outPath, bytes: fs.statSync(outPath).size, cached: true };
  }

  const tmpPrefix = path.join(VIDEO_DIR, `${item.referenceId}.download`);
  for (const file of fs.readdirSync(VIDEO_DIR)) {
    if (file.startsWith(`${item.referenceId}.download.`)) {
      fs.rmSync(path.join(VIDEO_DIR, file), { force: true });
    }
  }

  const result = spawnSync(
    'yt-dlp',
    [
      '--format',
      'bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best',
      '--merge-output-format',
      'mp4',
      '--remux-video',
      'mp4',
      '--no-playlist',
      '--no-warnings',
      '--output',
      `${tmpPrefix}.%(ext)s`,
      item.sourceUrl,
    ],
    { timeout: 180000, encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    const message =
      result.stderr
        ?.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .pop()
        ?.slice(0, 300) || 'yt-dlp failed';
    throw new Error(message);
  }

  const downloaded = fs
    .readdirSync(VIDEO_DIR)
    .filter((file) => file.startsWith(`${item.referenceId}.download.`))
    .map((file) => path.join(VIDEO_DIR, file))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];

  if (!downloaded || !fs.existsSync(downloaded) || fs.statSync(downloaded).size < 10000) {
    throw new Error('Downloaded file is missing or too small.');
  }

  fs.renameSync(downloaded, outPath);
  return { file: outPath, bytes: fs.statSync(outPath).size, cached: false };
}

function maybeProxy(item) {
  if (!PROXY_ENABLED) return item;
  const size = item.size || fs.statSync(item.file).size;
  const mb = size / 1024 / 1024;
  if (mb <= PROXY_OVER_MB) return { ...item, size };

  fs.mkdirSync(PROXY_DIR, { recursive: true });
  const proxyFile = path.join(PROXY_DIR, `${item.referenceId}_first${PROXY_MAX_SECONDS}s_540p.mp4`);
  if (!fs.existsSync(proxyFile)) {
    console.error(`[subtitles:qwen] proxying ${item.referenceId} ${mb.toFixed(2)}MB -> ${proxyFile}`);
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
      'scale=540:-2',
      '-r',
      '10',
      '-an',
      '-movflags',
      '+faststart',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
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

function extractQingyunMediaUrl(payload) {
  const resp = payload?.Resp && typeof payload.Resp === 'object' ? payload.Resp : {};
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const url = String(resp.url || data.url || payload?.url || '');
  if (!url) throw new Error(`qingyun media upload did not return url: ${JSON.stringify(payload).slice(0, 300)}`);
  return url;
}

async function uploadWithQingyunMedia(filePath) {
  const uploadUrl = process.env.QWEN_VL_MEDIA_UPLOAD_URL || 'https://api.qingyuntop.top/openapi/v2/media/upload';
  const key = API_KEY;
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  const blob = new Blob([bytes], { type: 'video/mp4' });
  form.append('file', blob, path.basename(filePath));
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'API-KEY': key,
    },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`qingyun upload HTTP ${response.status}: ${text.slice(0, 500)}`);
  return extractQingyunMediaUrl(JSON.parse(text));
}

async function uploadVideo(filePath) {
  if (UPLOAD_PROVIDER === 'data-url') {
    const b64 = fs.readFileSync(filePath).toString('base64');
    return `data:video/mp4;base64,${b64}`;
  }
  if (UPLOAD_PROVIDER === 'qingyun-media') return uploadWithQingyunMedia(filePath);
  if (UPLOAD_PROVIDER !== 'uguu') throw new Error(`Unsupported upload-provider: ${UPLOAD_PROVIDER}`);
  return uploadWithUguu(filePath);
}

function redactedVideoUrl(url) {
  if (url.startsWith('data:')) return 'data:video/mp4;base64,<redacted>';
  return url;
}

function promptFor(item) {
  const ocrText = item.ocrTexts.slice(0, 8).join(' | ');
  return `你是电商短视频字幕版式拆解器。只基于视频可见画面输出严格 JSON，不要 Markdown，不要解释。

目标：拆解参考视频里已经存在的字幕/文字叠层如何放置。不要生成新字幕，不要根据商品标题猜测画面外内容。
如果看到的是平台水印、账号名、系统 UI、商品包装文字，请标成对应 role，不要混作 creator subtitle。

坐标规则：
- bbox 使用归一化视频坐标，原点左上角，x/y/w/h 都是 0 到 1。
- 看不准 bbox 时填 null，confidence 降到 <=0.55。
- start_second/end_second 允许近似；无法判断时填 null。

必须输出这个 JSON 结构，不要多字段：
{
  "schemaVersion":"SubtitlePlacementTruth.v1",
  "referenceId":"${item.referenceId}",
  "durationSeconds":number|null,
  "globalStyle":{
    "subtitlePresence":"clear|partial|none|unclear",
    "primaryLanguage":"en|zh|mixed|unknown",
    "density":"sparse|balanced|dense|unknown",
    "commonPosition":"top|upper_middle|center|middle_lower|bottom|mixed|unknown",
    "commonFontScale":"small|medium|large|mixed|unknown",
    "commonTextColor":"white|black|yellow|red|mixed|unknown",
    "commonStroke":"none|thin|thick|mixed|unknown",
    "commonBackground":"none|solid_box|rounded_box|shadow|mixed|unknown",
    "maxLinesObserved":number|null
  },
  "segments":[
    {
      "startSecond":number|null,
      "endSecond":number|null,
      "text":"可见文字，<=80字",
      "role":"creator_subtitle|headline|product_label|cta|watermark|platform_ui|package_text|other",
      "isCreatorSubtitle":boolean,
      "position":"top|upper_middle|center|middle_lower|bottom|left|right|unknown",
      "bbox":{"x":number,"y":number,"w":number,"h":number}|null,
      "style":{
        "fontScale":"small|medium|large|unknown",
        "textColor":"white|black|yellow|red|mixed|unknown",
        "stroke":"none|thin|thick|unknown",
        "background":"none|solid_box|rounded_box|shadow|unknown",
        "alignment":"left|center|right|unknown",
        "lineCount":number|null,
        "caseStyle":"uppercase|title|sentence|mixed|unknown"
      },
      "overlapRisk":{
        "product":"none|low|medium|high|unknown",
        "face":"none|low|medium|high|unknown",
        "hands":"none|low|medium|high|unknown",
        "platformUi":"none|low|medium|high|unknown"
      },
      "confidence":0到1,
      "evidence":"<=30字中文说明"
    }
  ],
  "placementRules":["最多6条，描述这个视频如何避开商品/脸/手/UI"],
  "ocrSummary":["最多8条可见文字"],
  "qualityControl":{"status":"ok|warning|failed","notes":["最多3条，每条<=40字"]}
}

约束：
- segments 最多 12 条，优先 creator_subtitle/headline/cta；没有字幕就返回空数组。
- 不确定是否创作者字幕时 role 用 other 或 package_text，isCreatorSubtitle=false。
- 不要输出未列出的字段。

已有粗拆 OCR 仅供对齐，不可替代视频证据：${ocrText}
商品标题：${item.productTitle}
类目：${item.category}
粗拆字幕密度：${item.density}
粗拆 hook：${item.headlinePattern}
视频ID：${item.referenceId}`;
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
    parsed = { parseError: true, raw: content };
  }
  return { parsed, usage: json.usage || null, finishReason: json.choices?.[0]?.finish_reason };
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

async function writeTruthToDb(item, truth, meta) {
  const breakdown = item.breakdown || {};
  const normalizedTruth = {
    ...truth,
    schemaVersion: truth.schemaVersion || truth.schema_version || 'SubtitlePlacementTruth.v1',
    referenceId: truth.referenceId || item.referenceId,
    source: 'qwenvl_video_reanalysis',
    model: MODEL,
    analyzedAt: meta.analyzedAt,
    sourceVideo: {
      localFile: meta.file,
      sourceUrl: item.sourceUrl,
      proxy: meta.proxy || null,
    },
  };
  await db.upsertReferenceVideo({
    id: item.referenceId,
    sourceUrl: item.sourceUrl,
    localVideoUrl: item.localVideoUrl || undefined,
    sourceDeclaration: item.sourceDeclaration,
    licenseType: item.licenseType || undefined,
    usageScope: item.usageScope || undefined,
    breakdownReport: {
      ...breakdown,
      subtitlePlacementTruth: normalizedTruth,
      creativeFeature: {
        ...(breakdown.creativeFeature || {}),
        subtitlePlacementTruthId: `subtitle_placement_${item.referenceId}`,
        subtitleCommonPosition: normalizedTruth.globalStyle?.commonPosition || 'unknown',
        subtitleCommonBackground: normalizedTruth.globalStyle?.commonBackground || 'unknown',
      },
    },
  });
}

async function analyzeItem(item) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const contentPath = contentPathFor(item);
  const metaPath = metaPathFor(item);
  if (!FORCE && fs.existsSync(contentPath)) {
    const meta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
    const truth = readJson(contentPath);
    if (WRITE_DB && !meta.dbWritten && !truth.parseError) {
      await writeTruthToDb(item, truth, { ...meta, analyzedAt: meta.analyzedAt || new Date().toISOString() });
      writeJson(metaPath, { ...meta, dbWritten: true });
    }
    return {
      referenceId: item.referenceId,
      file: item.file,
      bytes: item.size,
      cached: true,
      downloaded: item.downloaded,
      dbWritten: WRITE_DB ? true : Boolean(meta.dbWritten),
      usage: meta.usage || null,
      finishReason: meta.finishReason || 'cached',
    };
  }

  const uploadItem = maybeProxy(item);
  const videoUrl = await uploadVideo(uploadItem.file);
  const startedAt = Date.now();
  const qwen = await callQwen(item, videoUrl);
  const analyzedAt = new Date().toISOString();
  const meta = {
    referenceId: item.referenceId,
    model: MODEL,
    analyzedAt,
    elapsedMs: Date.now() - startedAt,
    file: item.file,
    bytes: item.size,
    uploadFile: uploadItem.file,
    uploadBytes: uploadItem.size || fs.statSync(uploadItem.file).size,
    uploadProvider: UPLOAD_PROVIDER,
    videoUrl: redactedVideoUrl(videoUrl),
    proxy: uploadItem.proxy || null,
    sourceUrl: item.sourceUrl,
    durationSeconds: item.durationSeconds,
    usage: qwen.usage,
    finishReason: qwen.finishReason,
    cached: false,
    dbWritten: false,
  };
  writeJson(contentPath, qwen.parsed);

  if (WRITE_DB && !qwen.parsed.parseError) {
    await writeTruthToDb(item, qwen.parsed, meta);
    meta.dbWritten = true;
  }
  writeJson(metaPath, meta);
  return {
    referenceId: item.referenceId,
    file: item.file,
    bytes: item.size,
    uploadBytes: meta.uploadBytes,
    cached: false,
    downloaded: item.downloaded,
    dbWritten: meta.dbWritten,
    usage: qwen.usage,
    finishReason: qwen.finishReason,
  };
}

async function processItem(item) {
  const selectedSummary = `${item.referenceId} score=${item.valueScore} ${item.category} ${item.durationSeconds}s`;
  console.error(`[subtitles:qwen] selected ${selectedSummary}`);
  try {
    if (DOWNLOAD) {
      const downloaded = downloadVideo(item);
      item.file = downloaded.file;
      item.size = downloaded.bytes;
      item.downloaded = !downloaded.cached;
      item.downloadCached = downloaded.cached;
    } else {
      item.file = videoPathFor(item);
      if (!fs.existsSync(item.file)) throw new Error(`cached video missing: ${item.file}`);
      item.size = fs.statSync(item.file).size;
      item.downloaded = false;
      item.downloadCached = true;
    }

    if (!ANALYZE) {
      return {
        referenceId: item.referenceId,
        file: item.file,
        bytes: item.size,
        downloaded: item.downloaded,
        skippedAnalyze: true,
      };
    }

    let result;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        result = await analyzeItem(item);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[subtitles:qwen] ${item.referenceId} attempt ${attempt + 1}/${RETRIES + 1} failed: ${message.slice(0, 300)}`,
        );
        const terminalError = isTerminalQwenError(message);
        if (terminalError || attempt >= RETRIES) {
          result = {
            referenceId: item.referenceId,
            file: item.file,
            bytes: item.size,
            downloaded: item.downloaded,
            usage: null,
            finishReason: 'error',
            error: message,
            terminalError,
          };
          writeJson(metaPathFor(item), {
            ...result,
            model: MODEL,
            analyzedAt: new Date().toISOString(),
          });
          if (!CONTINUE_ON_ERROR) throw error;
          break;
        }
      }
    }
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = {
      referenceId: item.referenceId,
      sourceUrl: item.sourceUrl,
      usage: null,
      finishReason: 'error',
      error: message,
    };
    writeJson(metaPathFor(item), {
      ...result,
      model: MODEL,
      analyzedAt: new Date().toISOString(),
    });
    if (!CONTINUE_ON_ERROR) throw error;
    return result;
  }
}

const references = await db.listReferenceVideos();
const allRows = references
  .map(rowFromReference)
  .filter(Boolean)
  .filter((item) => FORCE || !item.alreadyDecomposed);
const selected = SELECTION === 'score' ? selectByScore(allRows) : selectDiverse(allRows);
const candidateSummary = {
  generatedAt: new Date().toISOString(),
  selection: SELECTION,
  totalReferences: references.length,
  availableSubtitleStyleSlices: references.filter(
    (reference) => reference.breakdownReport?.subtitleStyleSlice?.schemaVersion === 'SubtitleStyleSlice.v1',
  ).length,
  eligible: allRows.length,
  offset: OFFSET,
  limit: LIMIT,
  maxDuration: MAX_DURATION,
  minValueScore: MIN_VALUE_SCORE,
  selected: selected.map((item) => ({
    referenceId: item.referenceId,
    valueScore: item.valueScore,
    benchmarkScore: item.benchmarkScore,
    category: item.category,
    durationSeconds: item.durationSeconds,
    density: item.density,
    headlinePattern: item.headlinePattern,
    sourceUrl: item.sourceUrl,
    ocrTexts: item.ocrTexts.slice(0, 3),
  })),
};

writeJson(path.join(OUT_DIR, 'candidates.json'), candidateSummary);

if (DRY_RUN) {
  await db.disconnectPrisma();
  console.log(JSON.stringify(candidateSummary, null, 2));
  process.exit(0);
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
    const hasUsage = usage.prompt_tokens || usage.completion_tokens || usage.total_tokens;
    acc.promptTokens += Number(usage.prompt_tokens || 0);
    acc.completionTokens += Number(usage.completion_tokens || 0);
    acc.totalTokens += Number(usage.total_tokens || 0);
    acc.videoTokens += Number(usage.prompt_tokens_details?.video_tokens || 0);
    acc.bytes += Number(item.bytes || 0);
    acc.uploadBytes += Number(item.uploadBytes || item.bytes || 0);
    acc.costUsd += estimateCost(usage);
    acc.cached += item.cached ? 1 : 0;
    acc.downloaded += item.downloaded ? 1 : 0;
    acc.failures += item.error ? 1 : 0;
    acc.dbWrites += item.dbWritten ? 1 : 0;
    acc.withUsage += hasUsage ? 1 : 0;
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
    downloaded: 0,
    failures: 0,
    dbWrites: 0,
    withUsage: 0,
  },
);

const usageCount = Math.max(1, totals.withUsage);
const summary = {
  ...candidateSummary,
  model: MODEL,
  outDir: OUT_DIR,
  videoDir: VIDEO_DIR,
  writeDb: WRITE_DB,
  analyze: ANALYZE,
  download: DOWNLOAD,
  count: results.length,
  freshCount: results.length - totals.cached,
  cachedCount: totals.cached,
  downloadedCount: totals.downloaded,
  failureCount: totals.failures,
  dbWrites: totals.dbWrites,
  usageCount: totals.withUsage,
  avgPromptTokensWithUsage: Math.round(totals.promptTokens / usageCount),
  avgCompletionTokensWithUsage: Math.round(totals.completionTokens / usageCount),
  avgVideoTokensWithUsage: Math.round(totals.videoTokens / usageCount),
  avgTotalTokensWithUsage: Math.round(totals.totalTokens / usageCount),
  avgCostUsdWithUsage: Number((totals.costUsd / usageCount).toFixed(6)),
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
    videos20Usd: Number(((totals.costUsd / usageCount) * 20).toFixed(4)),
    videos100Usd: Number(((totals.costUsd / usageCount) * 100).toFixed(4)),
    videos442Usd: Number(((totals.costUsd / usageCount) * 442).toFixed(4)),
  },
  results,
};

writeJson(path.join(OUT_DIR, 'summary.json'), summary);
await db.disconnectPrisma();
console.log(JSON.stringify(summary, null, 2));
