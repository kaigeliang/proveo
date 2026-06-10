#!/usr/bin/env node
/**
 * 用豆包视觉分析 TikTok 视频结构。
 *
 * 流程：
 *   1. yt-dlp 获取视频 CDN 直链（无需登录）
 *   2. ffmpeg 下载最低画质视频片段并提取 4 帧：
 *      hook (1s) | 中段-1 (25%) | 中段-2 (50%) | CTA (末尾-3s)
 *   3. 4 张图 base64 → 豆包 ep-20260514115629-vhldw（支持多图视觉）
 *   4. 解析结构化 JSON，写入 tmp/tiktok-analysis/creative-features.jsonl
 *   5. 视频和帧文件立即删除
 *
 * 用法：
 *   node scripts/analyze-tiktok-videos.mjs [--limit=20] [--batch=2] [--dry-run]
 *
 * 幂等：已完成的 videoId 自动跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IN_FILE  = path.join(ROOT, 'tmp/kalodata-test/reference-videos.import.json');
const OUT_FILE = path.join(ROOT, 'tmp/tiktok-analysis/creative-features.jsonl');
const TMP_DIR  = path.join(os.tmpdir(), 'tiktok-frames');

// ── CLI args ──────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT   = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 9999);
const BATCH   = Number(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] ?? 2);

// ── Doubao config ─────────────────────────────────────────────────────────────
const dotenv = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
function envVal(key) {
  const m = dotenv.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim() : process.env[key] ?? '';
}
const ARK_BASE  = envVal('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_KEY   = envVal('ARK_API_KEY');
const ARK_MODEL = envVal('ARK_TEXT_MODEL_ID') || envVal('ARK_MODEL_ID');

if (!ARK_KEY || !ARK_MODEL) {
  console.error('[ERROR] ARK_API_KEY or ARK_TEXT_MODEL_ID not set in .env');
  process.exit(1);
}

// ── load records ──────────────────────────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(IN_FILE, 'utf-8'));
const all = (Array.isArray(raw) ? raw : raw.videos ?? []).map(v => ({
  videoId: v.breakdownReport?.videoId ?? v.id.replace('kalodata_', ''),
  tiktokUrl: v.breakdownReport?.tiktokUrl ?? v.sourceUrl,
  category: v.breakdownReport?.category ?? '',
  productTitle: v.breakdownReport?.productTitle ?? '',
  description: v.breakdownReport?.description ?? '',
  durationSeconds: v.breakdownReport?.durationSeconds ?? 0,
}));

// ── load already-processed ids ────────────────────────────────────────────────
const done = new Set();
if (fs.existsSync(OUT_FILE)) {
  fs.readFileSync(OUT_FILE, 'utf-8').split('\n').filter(Boolean).forEach(line => {
    try { done.add(JSON.parse(line).videoId); } catch {}
  });
}

const todo = all.filter(r => r.tiktokUrl && !done.has(r.videoId)).slice(0, LIMIT);
console.log(`已完成: ${done.size}  待处理: ${todo.length}  批大小: ${BATCH}`);

if (todo.length === 0) { console.log('全部已完成。'); process.exit(0); }

if (DRY_RUN) {
  console.log('[dry-run] 第一条样本：');
  console.log(todo[0]);
  process.exit(0);
}

// ── frame extraction ──────────────────────────────────────────────────────────
fs.mkdirSync(TMP_DIR, { recursive: true });

// 预下载目录（download-tiktok-videos.mjs 的输出）
const PRE_DOWNLOAD_DIR = path.join(ROOT, 'tmp/tiktok-videos');

function downloadAndExtractFrames(tiktokUrl, videoId, durationSec) {
  // 优先使用已下载的视频
  const preDownloaded = path.join(PRE_DOWNLOAD_DIR, `${videoId}.mp4`);
  let videoPath = preDownloaded;
  let shouldDelete = false;

  if (!fs.existsSync(preDownloaded) || fs.statSync(preDownloaded).size < 10000) {
    // 没有预下载文件，临时下载
    videoPath = path.join(TMP_DIR, `${videoId}.mp4`);
    shouldDelete = true;

    const dlRes = spawnSync('yt-dlp', [
      '--format', 'worstvideo[vcodec^=h264]/worst[ext=mp4]/worst',
      '--no-playlist',
      '--output', videoPath,
      '--quiet',
      tiktokUrl,
    ], { timeout: 90000, encoding: 'utf-8' });

    if (dlRes.status !== 0 || !fs.existsSync(videoPath)) {
      throw new Error(`yt-dlp download failed: ${dlRes.stderr?.slice(-300)}`);
    }
  }

  // ffmpeg 提取 4 帧
  const dur = Math.max(5, durationSec || 30);
  const timestamps = [
    1,
    Math.max(2, Math.floor(dur * 0.25)),
    Math.max(3, Math.floor(dur * 0.50)),
    Math.max(4, dur - 3),
  ];

  const frames = [];
  for (const [i, ts] of timestamps.entries()) {
    const outPath = path.join(TMP_DIR, `${videoId}_f${i}.jpg`);
    const res = spawnSync('ffmpeg', [
      '-ss', String(ts),
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '5',
      '-vf', 'scale=360:-1',
      '-y', outPath,
    ], { timeout: 15000, encoding: 'utf-8' });

    if (res.status === 0 && fs.existsSync(outPath)) {
      frames.push({ ts, path: outPath, label: ['hook', 'mid1', 'mid2', 'cta'][i] });
    }
  }

  if (shouldDelete) {
    try { fs.unlinkSync(videoPath); } catch {}
  }

  if (frames.length === 0) throw new Error('ffmpeg extracted no frames');
  return frames;
}

function framesToBase64(frames) {
  return frames.map(f => {
    const data = fs.readFileSync(f.path);
    return { label: f.label, ts: f.ts, dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` };
  });
}

function cleanFrames(frames) {
  for (const f of frames) {
    try { fs.unlinkSync(f.path); } catch {}
  }
}

// ── Doubao 视觉分析 ───────────────────────────────────────────────────────────
const axios = require(path.join(ROOT, 'node_modules/axios/dist/node/axios.cjs'));

function buildAnalysisPrompt(record, frames) {
  const frameDesc = frames.map(f => `- 帧[${f.label}] 时间戳 ${f.ts}s`).join('\n');
  return `你是一个 TikTok 带货视频营销分析师。我给你提供这个视频的 ${frames.length} 张关键帧：
${frameDesc}

商品类目：${record.category || '未知'}
商品名称：${record.productTitle || '未知'}
视频时长：${record.durationSeconds}秒
视频文案：${record.description || '无'}

请根据这些帧，对视频进行结构化分析。严格用 JSON 格式输出，不要包含任何其他文字：
{
  "hookType": "情绪共鸣型|痛点解决型|数字冲击型|悬念好奇型|产品展示型|生活场景型|人物出镜型|其他",
  "hookVisual": "<用一句话描述开头3秒的视觉内容，如'女性手持产品特写'、'对比前后效果'等>",
  "hookStrength": <1-5，5=极强>,
  "sellingPoints": ["<卖点1，≤10字>", "<卖点2>", "<卖点3>"],
  "shotStructure": ["<场景1描述，≤15字>", "<场景2>", "<场景3>", "<场景4>"],
  "ctaType": "软性引导|直接促购|限时紧迫|无明显CTA",
  "ctaVisual": "<末尾帧CTA内容，如'指向购物车'、'字幕显示链接'、'无明显CTA'等>",
  "contentStyle": "UGC手持随拍|专业棚拍|生活Vlog|开箱展示|对比测评|剧情种草",
  "hasFaceOnCamera": <true/false，是否有真人出镜>,
  "hasTextOverlay": <true/false，是否有字幕/文字贴片>,
  "hasProductDemo": <true/false，是否展示产品使用过程>
}`;
}

async function analyzeVideo(record) {
  // 1. 下载视频并提取帧（视频下载完后立即删除）
  const framePaths = downloadAndExtractFrames(record.tiktokUrl, record.videoId, record.durationSeconds);

  // 2. base64
  const framesB64 = framesToBase64(framePaths);
  cleanFrames(framePaths);

  // 4. 构建多图视觉消息
  const content = [
    { type: 'text', text: buildAnalysisPrompt(record, framesB64) },
    ...framesB64.map(f => ({
      type: 'image_url',
      image_url: { url: f.dataUrl },
    })),
  ];

  // 5. 调用豆包
  const res = await axios.post(
    `${ARK_BASE}/chat/completions`,
    {
      model: ARK_MODEL,
      messages: [{ role: 'user', content }],
      max_tokens: 500,
      temperature: 0.1,
    },
    {
      headers: {
        'Authorization': `Bearer ${ARK_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    },
  );

  const reply = res.data?.choices?.[0]?.message?.content ?? '';
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in reply: ' + reply.slice(0, 300));

  const feats = JSON.parse(m[0]);
  return {
    videoId: record.videoId,
    tiktokUrl: record.tiktokUrl,
    category: record.category,
    durationSeconds: record.durationSeconds,
    analyzedAt: new Date().toISOString(),
    ...feats,
    sellingPointCount: Array.isArray(feats.sellingPoints) ? feats.sellingPoints.length : 0,
  };
}

// ── main loop ─────────────────────────────────────────────────────────────────
const outFd = fs.openSync(OUT_FILE, 'a');
let processed = 0, errors = 0;

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const results = await Promise.allSettled(batch.map(analyzeVideo));

  for (const [j, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      fs.writeSync(outFd, JSON.stringify(result.value) + '\n');
      processed++;
    } else {
      errors++;
      console.warn(`[ERROR] ${batch[j].videoId}: ${result.reason?.message ?? result.reason}`);
    }
  }

  const pct = Math.round(((i + batch.length) / todo.length) * 100);
  console.log(`  [${pct}%] processed=${i + batch.length}/${todo.length}  errors=${errors}`);

  if (i + BATCH < todo.length) await new Promise(r => setTimeout(r, 1500));
}

fs.closeSync(outFd);
console.log(`\n完成！成功: ${processed}  失败: ${errors}`);
console.log(`输出: ${OUT_FILE}`);
