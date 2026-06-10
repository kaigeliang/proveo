#!/usr/bin/env node
/**
 * 批量下载 TikTok 视频（最低画质，用于后续豆包帧分析）。
 *
 * 用法：
 *   node scripts/download-tiktok-videos.mjs [--limit=20] [--concurrency=3]
 *
 * 输出目录：tmp/tiktok-videos/<videoId>.mp4
 * 幂等：已存在的文件自动跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN_FILE = path.join(ROOT, 'tmp/kalodata-test/reference-videos.import.json');
const OUT_DIR = path.join(ROOT, 'tmp/tiktok-videos');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── CLI args ──────────────────────────────────────────────────────────────────
const LIMIT       = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 9999);
const CONCURRENCY = Number(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? 3);

// ── 读取所有视频记录 ──────────────────────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(IN_FILE, 'utf-8'));
const all = (Array.isArray(raw) ? raw : raw.videos ?? []).map(v => ({
  videoId:         v.breakdownReport?.videoId ?? v.id.replace('kalodata_', ''),
  tiktokUrl:       v.breakdownReport?.tiktokUrl ?? v.sourceUrl,
  category:        v.breakdownReport?.category ?? '',
  durationSeconds: v.breakdownReport?.durationSeconds ?? 0,
})).filter(v => v.tiktokUrl);

// 跳过已下载
const todo = all.filter(v => {
  const out = path.join(OUT_DIR, `${v.videoId}.mp4`);
  return !fs.existsSync(out) || fs.statSync(out).size < 10000;
}).slice(0, LIMIT);

const total = all.length;
const done  = all.length - todo.length;
console.log(`总计: ${total}  已下载: ${done}  待下载: ${todo.length}  并发: ${CONCURRENCY}`);
if (todo.length === 0) { console.log('全部已下载。'); process.exit(0); }

// ── 下载单条 ──────────────────────────────────────────────────────────────────
function download(record) {
  const outPath = path.join(OUT_DIR, `${record.videoId}.mp4`);
  const tmpPath = outPath + '.part';

  const res = spawnSync('yt-dlp', [
    '--format', 'worstvideo[vcodec^=h264]/worst[ext=mp4]/worst',
    '--no-playlist',
    '--no-warnings',
    '--output', tmpPath,
    record.tiktokUrl,
  ], { timeout: 120000, encoding: 'utf-8' });

  if (res.status !== 0) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(res.stderr?.split('\n').filter(Boolean).pop()?.slice(0, 200) ?? 'unknown');
  }

  if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 10000) {
    throw new Error('下载文件太小或不存在');
  }

  fs.renameSync(tmpPath, outPath);
  return fs.statSync(outPath).size;
}

// ── 并发执行 ──────────────────────────────────────────────────────────────────
let finished = 0, errors = 0;
const startTime = Date.now();

async function runWorker(items) {
  for (const record of items) {
    try {
      const bytes = download(record);
      finished++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const speed   = (finished / ((Date.now() - startTime) / 1000)).toFixed(2);
      const eta     = Math.round((todo.length - finished - errors) / speed);
      console.log(
        `[${done + finished + errors}/${total}] ✓ ${record.videoId}` +
        `  ${record.category}  ${record.durationSeconds}s` +
        `  ${(bytes / 1024 / 1024).toFixed(1)}MB` +
        `  速度:${speed}条/s  ETA:${eta}s`
      );
    } catch (err) {
      errors++;
      console.error(`[ERROR] ${record.videoId}: ${err.message}`);
    }
  }
}

// 把 todo 切成 CONCURRENCY 份，并行跑
const chunks = Array.from({ length: CONCURRENCY }, (_, i) =>
  todo.filter((_, idx) => idx % CONCURRENCY === i)
);
await Promise.all(chunks.map(runWorker));

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.mp4'));
const totalMB = files.reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0) / 1024 / 1024;

console.log(`\n完成！成功: ${finished}  失败: ${errors}`);
console.log(`目录: ${OUT_DIR}`);
console.log(`已有文件: ${files.length} 个  总大小: ${totalMB.toFixed(0)} MB`);
