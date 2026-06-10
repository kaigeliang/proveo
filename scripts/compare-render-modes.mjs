// 对比三种视频生成连续性策略的「生成耗时」与「成片效果」。
// 用法：node --env-file=.env scripts/compare-render-modes.mjs
//
// 三种模式：
//   A independent —— 每个分镜独立 T2V 生成，再 ffmpeg 拼接（剪辑点会割裂）
//   B chain       —— 帧接力：上一镜真实尾帧作为下一镜 I2V 首帧，再拼接（跨镜连续）
//   C whole       —— 一镜到底：所有分镜写进一条多镜头 prompt，单次 Seedance 调用原生输出
//
// 复用与产品线一致的 prompt 构造器与 ffmpeg 工具，保证对比可信。

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildSeedancePrompt,
  buildSeedanceWholeVideoPrompt,
  requestSeedanceVideoWithRetry,
} from '../apps/worker/dist/apps/worker/src/seedance.js';
import {
  commandOk,
  trimVideoSegment,
  extractLastFrame,
  concatSegments,
} from '../apps/worker/dist/apps/worker/src/ffmpeg.js';
import {
  generateGptImage2ProductReference,
  isGptImage2Configured,
} from '../apps/worker/dist/apps/worker/src/gptimage2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output', 'render-compare');
const ASPECT = '9:16';
const RESOLUTION = '720x1280';
const SEEDANCE_OPTS = { ratio: ASPECT, resolution: '720p', generateAudio: false };

// ── 示例剧本：便携手持榨汁杯，动作天然连贯，最能体现「跨镜连续」差异 ──────────────
const SCRIPT = {
  narrative: '清晨厨房，一个女生用便携榨汁杯把水果打成果汁并喝下，干净治愈的一镜到底',
  visualStyle: '清新自然光、莫兰迪色调、生活化厨房场景',
  bgm: '轻柔治愈电子',
  shots: [
    {
      visualDesc:
        '清晨明亮的厨房台面，一只手把切好的草莓和蓝莓放进一个透明便携榨汁杯里，水珠新鲜，背景是模糊的窗户晨光',
      camera: '缓慢推进特写',
      duration: 4,
      transition: 'hard_cut',
    },
    {
      visualDesc: '同一个榨汁杯盖好杯盖，手指按下底部按钮，杯中水果被快速搅打成粉色果汁，气泡翻涌',
      camera: '固定特写，轻微环绕',
      duration: 4,
      transition: 'hard_cut',
    },
    {
      visualDesc: '女生拿起这杯打好的粉色果汁凑近嘴边喝了一口，露出满意放松的微笑，晨光洒在脸上',
      camera: '跟随上抬',
      duration: 4,
      transition: 'hard_cut',
    },
  ],
};

const totalDuration = SCRIPT.shots.reduce((sum, s) => sum + s.duration, 0);

// 一致性圣经：所有镜头共享同一份，钉死商品外观 + 全片分镜清单（与产品线 processRenderFull 一致）。
const FILM_CONTEXT = [
  `【全片一致性·所有镜头共享】商品：便携手持榨汁杯。全片自始至终是同一个商品，严格保持同一外观、材质、颜色、比例与细节，不同镜头只换机位、景别与动作，绝不换成另一个商品。`,
  `统一视觉基调：${SCRIPT.visualStyle}；BGM：${SCRIPT.bgm}；整片叙事：${SCRIPT.narrative}。`,
  `全片分镜清单（仅供理解整片、保持连贯；本次只渲染指定的这一镜）：${SCRIPT.shots.map((s, i) => `${i + 1}. ${s.visualDesc}`).join('  /  ')}。`,
].join('\n');

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('下载到空文件');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function fileToDataUrl(filePath) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:image/jpeg;base64,${b64}`;
}

// ── 模式 A：每个分镜独立生成（并行），再拼接 ─────────────────────────────────────
async function runIndependent(workDir) {
  const t0 = Date.now();
  const perShot = [];
  const results = await Promise.all(
    SCRIPT.shots.map(async (shot, index) => {
      const st = Date.now();
      const prompt = buildSeedancePrompt({
        aspectRatio: ASPECT,
        duration: shot.duration,
        narrative: SCRIPT.narrative,
        visualStyle: SCRIPT.visualStyle,
        bgm: SCRIPT.bgm,
        shotIndex: index,
        shotTotal: SCRIPT.shots.length,
        prevSubtitle: undefined,
        nextSubtitle: undefined,
        visualDesc: shot.visualDesc,
        camera: shot.camera,
        subtitle: '',
        narration: '',
        transition: shot.transition,
        continuesFromPrevFrame: false,
        filmContext: FILM_CONTEXT,
      });
      const url = await requestSeedanceVideoWithRetry(prompt, SEEDANCE_OPTS, undefined, (s, n) =>
        log(`  [A 镜${index + 1}] ${s} ${n}`),
      );
      const raw = path.join(workDir, `a_raw_${index}.mp4`);
      await downloadTo(url, raw);
      const seg = path.join(workDir, `a_seg_${index}.mp4`);
      await trimVideoSegment(raw, seg, shot.duration, ASPECT, RESOLUTION, 'mute');
      const ms = Date.now() - st;
      perShot.push({ shot: index + 1, ms });
      log(`  [A 镜${index + 1}] 完成，用时 ${(ms / 1000).toFixed(1)}s`);
      return seg;
    }),
  );
  const out = path.join(OUT_DIR, 'mode_a_independent.mp4');
  await concatSegments(results, out, workDir);
  return { mode: 'A independent', totalMs: Date.now() - t0, perShot, output: out, calls: SCRIPT.shots.length };
}

// ── 模式 B：帧接力（顺序，上一镜尾帧 → 下一镜首帧），再拼接 ──────────────────────
async function runChain(workDir) {
  const t0 = Date.now();
  const perShot = [];
  const segments = [];
  let prevFrameDataUrl;
  let prevVisualDesc;
  for (let index = 0; index < SCRIPT.shots.length; index++) {
    const shot = SCRIPT.shots[index];
    const st = Date.now();
    const prompt = buildSeedancePrompt({
      aspectRatio: ASPECT,
      duration: shot.duration,
      narrative: SCRIPT.narrative,
      visualStyle: SCRIPT.visualStyle,
      bgm: SCRIPT.bgm,
      shotIndex: index,
      shotTotal: SCRIPT.shots.length,
      prevVisualDesc,
      visualDesc: shot.visualDesc,
      camera: shot.camera,
      subtitle: '',
      narration: '',
      transition: shot.transition,
      continuesFromPrevFrame: Boolean(prevFrameDataUrl),
      filmContext: FILM_CONTEXT,
    });
    const url = await requestSeedanceVideoWithRetry(prompt, SEEDANCE_OPTS, prevFrameDataUrl, (s, n) =>
      log(`  [B 镜${index + 1}] ${s} ${n}`),
    );
    const raw = path.join(workDir, `b_raw_${index}.mp4`);
    await downloadTo(url, raw);
    const seg = path.join(workDir, `b_seg_${index}.mp4`);
    await trimVideoSegment(raw, seg, shot.duration, ASPECT, RESOLUTION, 'mute');
    segments.push(seg);
    // 抽取真实尾帧，作为下一镜首帧（base64 data URL，免对象存储）
    if (index < SCRIPT.shots.length - 1) {
      const framePath = path.join(workDir, `b_frame_${index}.jpg`);
      const ok = await extractLastFrame(seg, framePath);
      prevFrameDataUrl = ok ? fileToDataUrl(framePath) : undefined;
      prevVisualDesc = shot.visualDesc;
    }
    const ms = Date.now() - st;
    perShot.push({ shot: index + 1, ms });
    log(`  [B 镜${index + 1}] 完成，用时 ${(ms / 1000).toFixed(1)}s`);
  }
  const out = path.join(OUT_DIR, 'mode_b_chain.mp4');
  await concatSegments(segments, out, workDir);
  return { mode: 'B chain', totalMs: Date.now() - t0, perShot, output: out, calls: SCRIPT.shots.length };
}

// ── 模式 C：一镜到底（单次多镜头调用）──────────────────────────────────────────
async function runWhole(workDir) {
  const t0 = Date.now();
  const prompt = buildSeedanceWholeVideoPrompt({
    aspectRatio: ASPECT,
    totalDuration,
    narrative: SCRIPT.narrative,
    visualStyle: SCRIPT.visualStyle,
    bgm: SCRIPT.bgm,
    shots: SCRIPT.shots,
  });
  log(`  [C] 单次调用，--dur ${totalDuration}`);
  const url = await requestSeedanceVideoWithRetry(prompt, SEEDANCE_OPTS, undefined, (s, n) => log(`  [C] ${s} ${n}`));
  const raw = path.join(workDir, 'c_raw.mp4');
  await downloadTo(url, raw);
  const out = path.join(OUT_DIR, 'mode_c_whole.mp4');
  // 归一到统一尺寸，时长保持模型实际输出
  await trimVideoSegment(raw, out, totalDuration, ASPECT, RESOLUTION, 'mute');
  return { mode: 'C whole', totalMs: Date.now() - t0, perShot: [], output: out, calls: 1 };
}

// ── 模式 D：多角度连贯（新默认）—— 共享商品锚图 + 各镜不同机位 I2V，可并行 ───────────
async function runMultiAngle(workDir) {
  const t0 = Date.now();
  if (!isGptImage2Configured()) throw new Error('GPTImage2 未配置，无法生成共享商品锚图');
  // 1) 生成一张共享商品锚图（全片复用，保证不同角度是同一个商品）
  log('  [D] 生成共享商品锚图…');
  const anchor = await generateGptImage2ProductReference({
    productLabel: '便携手持榨汁杯',
    visualDesc: SCRIPT.shots[0].visualDesc,
    camera: SCRIPT.shots[0].camera,
    narration: '',
    subtitle: '',
    aspectRatio: ASPECT,
    shotOrder: 1,
  });
  const anchorUrl = anchor.imageUrl;
  fs.writeFileSync(path.join(OUT_DIR, 'mode_d_anchor.txt'), anchorUrl.startsWith('data:') ? '(data URL)' : anchorUrl);
  log('  [D] 锚图就绪，开始各镜 I2V（并行）');
  // 2) 各镜从同一锚图 I2V，prompt 指定不同机位/景别
  const perShot = [];
  const segs = await Promise.all(
    SCRIPT.shots.map(async (shot, index) => {
      const st = Date.now();
      const prompt = buildSeedancePrompt({
        aspectRatio: ASPECT,
        duration: shot.duration,
        narrative: SCRIPT.narrative,
        visualStyle: SCRIPT.visualStyle,
        bgm: SCRIPT.bgm,
        shotIndex: index,
        shotTotal: SCRIPT.shots.length,
        visualDesc: shot.visualDesc,
        camera: shot.camera,
        subtitle: '',
        narration: '',
        transition: shot.transition,
        continuesFromPrevFrame: false,
        filmContext: FILM_CONTEXT,
      });
      const url = await requestSeedanceVideoWithRetry(prompt, SEEDANCE_OPTS, anchorUrl, (s, n) =>
        log(`  [D 镜${index + 1}] ${s} ${n}`),
      );
      const raw = path.join(workDir, `d_raw_${index}.mp4`);
      await downloadTo(url, raw);
      const seg = path.join(workDir, `d_seg_${index}.mp4`);
      await trimVideoSegment(raw, seg, shot.duration, ASPECT, RESOLUTION, 'mute');
      const ms = Date.now() - st;
      perShot.push({ shot: index + 1, ms });
      log(`  [D 镜${index + 1}] 完成，用时 ${(ms / 1000).toFixed(1)}s`);
      return { index, seg };
    }),
  );
  const ordered = segs.sort((a, b) => a.index - b.index).map((s) => s.seg);
  const out = path.join(OUT_DIR, 'mode_d_multiangle.mp4');
  await concatSegments(ordered, out, workDir);
  return { mode: 'D multiangle', totalMs: Date.now() - t0, perShot, output: out, calls: SCRIPT.shots.length };
}

const MODES = {
  a: ['A independent', runIndependent],
  b: ['B chain', runChain],
  c: ['C whole', runWhole],
  d: ['D multiangle', runMultiAngle],
};

async function main() {
  if (!(await commandOk('ffmpeg', ['-version']))) throw new Error('未找到 ffmpeg');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-compare-'));
  log(`输出目录：${OUT_DIR}`);
  log(`示例剧本：${SCRIPT.shots.length} 镜，总时长 ${totalDuration}s\n`);

  // 用命令行参数选择跑哪些模式，如 `... compare-render-modes.mjs d`，默认全部
  const selected = process.argv.slice(2).map((s) => s.toLowerCase());
  const toRun = (selected.length ? selected : ['a', 'b', 'c']).map((k) => MODES[k]).filter(Boolean);

  const report = [];
  for (const [name, fn] of toRun) {
    log(`▶ 开始模式 ${name}`);
    try {
      const r = await fn(workDir);
      report.push(r);
      log(`✔ 模式 ${name} 总用时 ${(r.totalMs / 1000).toFixed(1)}s\n`);
    } catch (err) {
      log(`✘ 模式 ${name} 失败：${err.message}\n`);
      report.push({ mode: name, error: err.message });
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ script: SCRIPT, report }, null, 2));

  console.log('\n================ 生成耗时对比 ================');
  console.log('模式\t\tSeedance调用\t总用时');
  for (const r of report) {
    if (r.error) {
      console.log(`${r.mode}\t-\t失败: ${r.error}`);
    } else {
      console.log(`${r.mode}\t${r.calls}\t${(r.totalMs / 1000).toFixed(1)}s\t→ ${path.basename(r.output)}`);
    }
  }
  console.log('=============================================');
  fs.rmSync(workDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('运行失败：', err);
  process.exit(1);
});
