#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch {
  // dotenv is optional; env vars may also be supplied by the caller.
}

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=');
      return [key, rest.length ? rest.join('=') : 'true'];
    }),
);

function readArg(name, fallback = '') {
  return args.get(name) ?? fallback;
}

function hasFlag(name) {
  return args.get(name) === 'true';
}

function printHelp() {
  console.log(`Usage:
  npm run qwen:reference -- [options]

Options:
  --reference-id=<id>                 Existing ReferenceVideo id to enrich.
  --source-url=<url>                  TikTok/FastMoss/source URL. Used for download or new reference metadata.
  --file=<path>                       Local MP4 to analyze.
  --video-url=<url>                   Public URL already accessible to Qwen-VL; skips upload.
  --download                          Download --source-url with yt-dlp when --file/--video-url is absent.
  --out-dir=tmp/qwenvl-reference-analysis
  --write-db                          Write ReferenceCreativeAnalysis.v1 to ReferenceVideo.breakdownReport.
  --force                             Re-run even if output JSON already exists.
  --upload-provider=qingyun-media|uguu|data-url
  --fps=1 --max-tokens=4000 --timeout-ms=240000

Output:
  ReferenceCreativeAnalysis.v1 JSON with transcript, outline, sliceTable,
  subtitle/OCR, cloneRecipe and composerHints.`);
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const BASE_URL = process.env.QWEN_VL_BASE_URL;
const API_KEY = process.env.QWEN_VL_API_KEY;
const MODEL = process.env.QWEN_VL_MODEL_ID || 'qwen3-vl-plus';
const OUT_DIR = readArg('out-dir', 'tmp/qwenvl-reference-analysis');
const FORCE = hasFlag('force');
const WRITE_DB = hasFlag('write-db');
const DOWNLOAD = hasFlag('download');
const UPLOAD_PROVIDER = readArg('upload-provider', 'qingyun-media');
const FPS = Number(readArg('fps', '1'));
const MAX_TOKENS = Number(readArg('max-tokens', '4000'));
const TIMEOUT_MS = Number(readArg('timeout-ms', '240000'));
const PROXY_OVER_MB = Number(readArg('proxy-over-mb', '28'));
const PROXY_MAX_SECONDS = Number(readArg('proxy-max-seconds', '90'));
const REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSION = 'ReferenceCreativeAnalysis.v1';

if (!BASE_URL || !API_KEY) throw new Error('Set QWEN_VL_BASE_URL and QWEN_VL_API_KEY.');

function stableHash(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function number(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function outputPathFor(id) {
  return path.join(OUT_DIR, `${id}.reference-creative-analysis.json`);
}

function metaPathFor(id) {
  return path.join(OUT_DIR, `${id}.meta.json`);
}

async function loadReference(referenceId) {
  if (!referenceId) return null;
  const db = require('@aigc-video-hub/db');
  return db.getReferenceVideo(referenceId);
}

function downloadSourceVideo(referenceId, sourceUrl) {
  if (!sourceUrl) throw new Error('--download requires --source-url or an existing reference sourceUrl.');
  const videoDir = path.join(OUT_DIR, 'videos');
  fs.mkdirSync(videoDir, { recursive: true });
  const outPath = path.join(videoDir, `${referenceId}.mp4`);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) return outPath;
  const tmpPrefix = path.join(videoDir, `${referenceId}.download`);
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
      sourceUrl,
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
    .readdirSync(videoDir)
    .filter((file) => file.startsWith(`${referenceId}.download.`))
    .map((file) => path.join(videoDir, file))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  if (!downloaded || fs.statSync(downloaded).size < 10000) throw new Error('Downloaded file is missing or too small.');
  fs.renameSync(downloaded, outPath);
  return outPath;
}

function maybeProxy(filePath, id) {
  const bytes = fs.statSync(filePath).size;
  const mb = bytes / 1024 / 1024;
  if (mb <= PROXY_OVER_MB) return { file: filePath, bytes, proxy: null };

  const proxyDir = path.join(OUT_DIR, 'video-proxies');
  fs.mkdirSync(proxyDir, { recursive: true });
  const proxyFile = path.join(proxyDir, `${id}_first${PROXY_MAX_SECONDS}s_540p.mp4`);
  if (!fs.existsSync(proxyFile)) {
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
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
    file: proxyFile,
    bytes: fs.statSync(proxyFile).size,
    proxy: {
      sourceFile: filePath,
      sourceBytes: bytes,
      maxSeconds: PROXY_MAX_SECONDS,
      reason: `source_over_${PROXY_OVER_MB}mb`,
    },
  };
}

function extractQingyunMediaUrl(payload) {
  const resp = asRecord(payload?.Resp);
  const data = asRecord(payload?.data);
  const url = text(resp.url || data.url || payload?.url);
  if (!url) throw new Error(`qingyun media upload did not return url: ${JSON.stringify(payload).slice(0, 300)}`);
  return url;
}

async function uploadWithQingyunMedia(filePath) {
  const uploadUrl = process.env.QWEN_VL_MEDIA_UPLOAD_URL || 'https://api.qingyuntop.top/openapi/v2/media/upload';
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), path.basename(filePath));
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'API-KEY': API_KEY },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`qingyun upload HTTP ${response.status}: ${body.slice(0, 500)}`);
  return extractQingyunMediaUrl(JSON.parse(body));
}

async function uploadWithUguu(filePath) {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append('files[]', new Blob([bytes], { type: 'video/mp4' }), path.basename(filePath));
  const response = await fetch('https://uguu.se/upload.php', { method: 'POST', body: form });
  const body = await response.text();
  if (!response.ok) throw new Error(`upload HTTP ${response.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body);
  const url = parsed?.files?.[0]?.url;
  if (!parsed?.success || !url) throw new Error(`upload failed: ${body.slice(0, 300)}`);
  return url.replace(/\\\//g, '/');
}

async function videoUrlFor(filePath) {
  if (UPLOAD_PROVIDER === 'data-url') return `data:video/mp4;base64,${fs.readFileSync(filePath).toString('base64')}`;
  if (UPLOAD_PROVIDER === 'qingyun-media') return uploadWithQingyunMedia(filePath);
  if (UPLOAD_PROVIDER === 'uguu') return uploadWithUguu(filePath);
  throw new Error(`Unsupported upload-provider: ${UPLOAD_PROVIDER}`);
}

function promptFor(input) {
  return `你是电商短视频端到端创作分析器。只基于视频可见画面、可听/可读口播、OCR 输出严格 JSON，不要 Markdown，不要解释。

目标：把参考视频拆成可被 Composer 和 CloneCast 以配方/策略形式消费的结构化分析资产。不要复用原视频素材，只学习结构、节奏、字幕和创作策略。

必须输出这个 JSON 结构，不要多字段：
{
  "schemaVersion":"${REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSION}",
  "referenceId":"${input.referenceId}",
  "durationSeconds":number|null,
  "transcript":[
    {"startSecond":number|null,"endSecond":number|null,"text":"<=160 chars","role":"hook|education|proof|demo|offer|cta|other"}
  ],
  "outline":[
    {"startSecond":number|null,"endSecond":number|null,"role":"hook|proof|demo|offer|cta","title":"<=40 chars","summary":"<=120 chars","visualGoal":"<=80 chars","narrativeFunction":"<=80 chars"}
  ],
  "sliceTable":[
    {
      "startSecond":number|null,
      "endSecond":number|null,
      "role":"hook|proof|demo|offer|cta|bridge",
      "shootingScene":"indoor|outdoor|home|studio|screen|mixed|unknown",
      "cameraTechnique":"static|handheld|close_up|macro|push_in|cutaway|screen_recording|mixed|unknown",
      "visualContent":"<=160 chars",
      "narration":"<=180 chars",
      "ocrText":["最多4条，每条<=50 chars"],
      "highlightReason":"<=120 chars",
      "reuseScore":0到1,
      "composerUse":"open_with_hook|prove_claim|show_product|explain_benefit|handle_objection|cta|avoid"
    }
  ],
  "subtitleOcr":{
    "presence":"none|clear|partial|unclear",
    "density":"sparse|balanced|dense|unknown",
    "primaryLanguage":"en|zh|mixed|unknown",
    "segments":[
      {"startSecond":number|null,"endSecond":number|null,"text":"<=80 chars","position":"top|middle_lower|bottom|mixed|unknown","role":"headline|subtitle|cta|package_text|ui|other"}
    ],
    "placementRules":["最多6条，描述字幕如何避开商品/脸/手/UI"]
  },
  "cloneRecipe":{
    "pace":"fast|standard|slow",
    "segments":[
      {"t":"0-3s","role":"hook|proof|demo|offer|cta","tactic":"<=120 chars","shot":"static|push|macro|handheld|cutaway|screen","bgm":"trending|upbeat|calm|none"}
    ],
    "factors":["最多12个，snake_case，如 hook_question, early_product, clear_ocr, hand_demo"],
    "productAdaptationQuestions":["最多5条，生成前必须回答的问题"]
  },
  "composerHints":{
    "mustKeep":["最多6条结构/节奏规则"],
    "avoid":["最多6条不要复刻或风险点"],
    "shotSelectionRules":["最多6条素材选择规则"],
    "subtitlePolicy":["最多6条字幕/OCR策略"]
  },
  "qualityControl":{"status":"ok|warning|failed","notes":["最多4条，每条<=80 chars"]}
}

约束：
- transcript 最多 40 条；outline 最多 8 条；sliceTable 最多 20 条；subtitleOcr.segments 最多 16 条。
- cloneRecipe.segments 必须能压缩到 15 秒内用于新商品短视频。
- 不确定时填 unknown/null，并在 qualityControl.notes 说明。

已知元信息：
商品标题：${input.productTitle || ''}
类目：${input.category || ''}
原始描述：${input.description || ''}
已有 Qwen 粗因子：${JSON.stringify(input.existingQwen || {}).slice(0, 1200)}`;
}

async function callQwen(input, videoUrl) {
  const payload = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: { url: videoUrl }, fps: FPS },
          { type: 'text', text: promptFor(input) },
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
  const body = await response.text();
  if (!response.ok) throw new Error(`Qwen HTTP ${response.status}: ${body.slice(0, 800)}`);
  const parsed = JSON.parse(body);
  const content = parsed.choices?.[0]?.message?.content || '{}';
  return {
    analysis: JSON.parse(content),
    usage: parsed.usage || null,
    finishReason: parsed.choices?.[0]?.finish_reason || null,
  };
}

function normalizeSegmentRole(value, fallback = 'demo') {
  const role = text(value).toLowerCase();
  return ['hook', 'proof', 'demo', 'offer', 'cta'].includes(role) ? role : fallback;
}

function normalizeAnalysis(raw, input, meta) {
  const analysis = asRecord(raw);
  const cloneRecipe = asRecord(analysis.cloneRecipe);
  const subtitleOcr = asRecord(analysis.subtitleOcr);
  const normalized = {
    schemaVersion: REFERENCE_CREATIVE_ANALYSIS_SCHEMA_VERSION,
    referenceId: input.referenceId,
    source: 'qwenvl_reference_analysis',
    model: MODEL,
    analyzedAt: meta.analyzedAt,
    durationSeconds: number(analysis.durationSeconds),
    transcript: asArray(analysis.transcript)
      .slice(0, 40)
      .map((row) => {
        const item = asRecord(row);
        return {
          startSecond: number(item.startSecond),
          endSecond: number(item.endSecond),
          text: text(item.text).slice(0, 200),
          role: text(item.role, 'other').slice(0, 24),
        };
      }),
    outline: asArray(analysis.outline)
      .slice(0, 8)
      .map((row, index) => {
        const item = asRecord(row);
        return {
          startSecond: number(item.startSecond),
          endSecond: number(item.endSecond),
          role: normalizeSegmentRole(item.role, index === 0 ? 'hook' : 'demo'),
          title: text(item.title).slice(0, 60),
          summary: text(item.summary).slice(0, 180),
          visualGoal: text(item.visualGoal).slice(0, 120),
          narrativeFunction: text(item.narrativeFunction).slice(0, 120),
        };
      }),
    sliceTable: asArray(analysis.sliceTable)
      .slice(0, 20)
      .map((row, index) => {
        const item = asRecord(row);
        return {
          startSecond: number(item.startSecond),
          endSecond: number(item.endSecond),
          role: text(item.role, index === 0 ? 'hook' : 'demo').slice(0, 32),
          shootingScene: text(item.shootingScene, 'unknown').slice(0, 32),
          cameraTechnique: text(item.cameraTechnique, 'unknown').slice(0, 40),
          visualContent: text(item.visualContent).slice(0, 220),
          narration: text(item.narration).slice(0, 240),
          ocrText: asArray(item.ocrText)
            .map((v) => text(v).slice(0, 80))
            .filter(Boolean)
            .slice(0, 4),
          highlightReason: text(item.highlightReason).slice(0, 180),
          reuseScore: Math.max(0, Math.min(1, number(item.reuseScore, 0))),
          composerUse: text(item.composerUse, 'show_product').slice(0, 40),
        };
      }),
    subtitleOcr: {
      presence: text(subtitleOcr.presence, 'unknown'),
      density: text(subtitleOcr.density, 'unknown'),
      primaryLanguage: text(subtitleOcr.primaryLanguage, 'unknown'),
      segments: asArray(subtitleOcr.segments)
        .slice(0, 16)
        .map((row) => {
          const item = asRecord(row);
          return {
            startSecond: number(item.startSecond),
            endSecond: number(item.endSecond),
            text: text(item.text).slice(0, 100),
            position: text(item.position, 'unknown'),
            role: text(item.role, 'other'),
          };
        }),
      placementRules: asArray(subtitleOcr.placementRules)
        .map((v) => text(v).slice(0, 120))
        .filter(Boolean)
        .slice(0, 6),
    },
    cloneRecipe: {
      pace: text(cloneRecipe.pace, 'standard'),
      segments: asArray(cloneRecipe.segments)
        .slice(0, 5)
        .map((row, index) => {
          const item = asRecord(row);
          return {
            t: text(item.t, `${index * 3}-${Math.min(15, (index + 1) * 3)}s`),
            role: normalizeSegmentRole(item.role, index === 0 ? 'hook' : index >= 4 ? 'cta' : 'demo'),
            tactic: text(item.tactic).slice(0, 160),
            shot: text(item.shot, index === 0 ? 'push' : 'static').slice(0, 40),
            bgm: text(item.bgm, index === 0 ? 'trending' : 'upbeat').slice(0, 40),
          };
        }),
      factors: asArray(cloneRecipe.factors)
        .map((v) => text(v).slice(0, 64))
        .filter(Boolean)
        .slice(0, 12),
      productAdaptationQuestions: asArray(cloneRecipe.productAdaptationQuestions)
        .map((v) => text(v).slice(0, 160))
        .filter(Boolean)
        .slice(0, 5),
    },
    composerHints: {
      mustKeep: asArray(asRecord(analysis.composerHints).mustKeep)
        .map((v) => text(v).slice(0, 140))
        .filter(Boolean)
        .slice(0, 6),
      avoid: asArray(asRecord(analysis.composerHints).avoid)
        .map((v) => text(v).slice(0, 140))
        .filter(Boolean)
        .slice(0, 6),
      shotSelectionRules: asArray(asRecord(analysis.composerHints).shotSelectionRules)
        .map((v) => text(v).slice(0, 140))
        .filter(Boolean)
        .slice(0, 6),
      subtitlePolicy: asArray(asRecord(analysis.composerHints).subtitlePolicy)
        .map((v) => text(v).slice(0, 140))
        .filter(Boolean)
        .slice(0, 6),
    },
    qualityControl: {
      status: text(asRecord(analysis.qualityControl).status, 'warning'),
      notes: asArray(asRecord(analysis.qualityControl).notes)
        .map((v) => text(v).slice(0, 120))
        .filter(Boolean)
        .slice(0, 4),
    },
    sourceVideo: {
      sourceUrl: input.sourceUrl || null,
      localFile: meta.localFile || null,
      proxy: meta.proxy || null,
      publicVideoUrl: meta.publicVideoUrl?.startsWith('data:')
        ? 'data:video/mp4;base64,<redacted>'
        : meta.publicVideoUrl,
    },
  };

  if (!normalized.cloneRecipe.segments.length) {
    normalized.cloneRecipe.segments = normalized.outline.slice(0, 5).map((item, index) => ({
      t: `${index * 3}-${Math.min(15, (index + 1) * 3)}s`,
      role: item.role,
      tactic: item.narrativeFunction || item.summary || item.title || '复刻参考视频结构',
      shot: index === 0 ? 'push' : 'static',
      bgm: index === 0 ? 'trending' : 'upbeat',
    }));
  }

  return normalized;
}

async function writeToDb(input, analysis) {
  const db = require('@aigc-video-hub/db');
  const existing = input.referenceId ? await db.getReferenceVideo(input.referenceId) : null;
  const breakdown = asRecord(existing?.breakdownReport);
  const id = input.referenceId;
  if (!id) throw new Error('--write-db requires --reference-id or --source-url.');
  return db.upsertReferenceVideo({
    id,
    sourceUrl: input.sourceUrl || existing?.sourceUrl || '',
    localVideoUrl: existing?.localVideoUrl || undefined,
    localObjectKey: existing?.localObjectKey || undefined,
    sourceDeclaration:
      existing?.sourceDeclaration || '用户提供或内部授权参考视频；仅用于结构化拆解和配方分析，不复用原视频素材。',
    licenseType: existing?.licenseType || undefined,
    usageScope: existing?.usageScope || 'analysis',
    breakdownReport: {
      ...breakdown,
      referenceCreativeAnalysis: analysis,
    },
  });
}

async function main() {
  const requestedReferenceId = text(readArg('reference-id'));
  const existing = await loadReference(requestedReferenceId);
  const sourceUrl = text(readArg('source-url')) || existing?.sourceUrl || '';
  const referenceId = requestedReferenceId || `ref_${stableHash(sourceUrl || readArg('file') || readArg('video-url'))}`;
  const breakdown = asRecord(existing?.breakdownReport);
  const input = {
    referenceId,
    sourceUrl,
    productTitle: text(breakdown.productTitle || breakdown.metadata?.productTitle || breakdown.title),
    category: text(breakdown.category || breakdown.metadata?.category),
    description: text(breakdown.description || breakdown.referenceText),
    existingQwen: asRecord(breakdown.qwenTruthSlice),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = outputPathFor(referenceId);
  const metaPath = metaPathFor(referenceId);
  if (!FORCE && fs.existsSync(outPath)) {
    const cached = readJson(outPath);
    if (WRITE_DB) await writeToDb(input, cached);
    console.log(JSON.stringify({ referenceId, cached: true, output: outPath, wroteDb: WRITE_DB }, null, 2));
    return;
  }

  let publicVideoUrl = text(readArg('video-url'));
  let localFile = text(readArg('file'));
  if (!publicVideoUrl && !localFile && DOWNLOAD) localFile = downloadSourceVideo(referenceId, sourceUrl);
  if (!publicVideoUrl && !localFile) {
    throw new Error('Provide --video-url, --file, or --download with --source-url/reference-id.');
  }

  let proxy = null;
  if (!publicVideoUrl) {
    const prepared = maybeProxy(path.resolve(localFile), referenceId);
    localFile = prepared.file;
    proxy = prepared.proxy;
    publicVideoUrl = await videoUrlFor(localFile);
  }

  const analyzedAt = new Date().toISOString();
  const result = await callQwen(input, publicVideoUrl);
  const analysis = normalizeAnalysis(result.analysis, input, { analyzedAt, localFile, proxy, publicVideoUrl });
  writeJson(outPath, analysis);
  writeJson(metaPath, {
    referenceId,
    model: MODEL,
    usage: result.usage,
    finishReason: result.finishReason,
    analyzedAt,
    localFile,
    proxy,
    publicVideoUrl: publicVideoUrl.startsWith('data:') ? 'data:video/mp4;base64,<redacted>' : publicVideoUrl,
  });
  if (WRITE_DB) await writeToDb(input, analysis);
  console.log(
    JSON.stringify(
      {
        referenceId,
        output: outPath,
        meta: metaPath,
        wroteDb: WRITE_DB,
        transcript: analysis.transcript.length,
        outline: analysis.outline.length,
        slices: analysis.sliceTable.length,
        recipeSegments: analysis.cloneRecipe.segments.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
