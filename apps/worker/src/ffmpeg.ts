import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SubtitleOverlayEvent, SubtitlePosition } from './subtitles';

// ─── shell 执行 ─────────────────────────────────────────────────────────────

type RunResult = { stdout: string; stderr: string };

export function runCommand(command: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function commandOk(command: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(command, args, 8_000);
    return true;
  } catch {
    return false;
  }
}

let ffmpegFilterList: Set<string> | undefined;

async function ffmpegFilterAvailable(filterName: string): Promise<boolean> {
  if (!ffmpegFilterList) {
    try {
      const { stdout, stderr } = await runCommand('ffmpeg', ['-hide_banner', '-filters'], 10_000);
      // `ffmpeg -filters` 行格式：`<flags> <name> <in->out> <desc>`，flags 是 T/S/C/. 组成的标志列。
      // 不能把 flags 字符并进 name 的字符类——否则首字母为 s/c/t 的滤镜（subtitles/scale/…）会被吃掉首字母。
      ffmpegFilterList = new Set(
        `${stdout}\n${stderr}`
          .split('\n')
          .map((line) => line.trim().match(/^\S+\s+([a-z0-9_]+)\s+[A-Za-z0-9]+->/i)?.[1])
          .filter((item): item is string => Boolean(item)),
      );
    } catch {
      ffmpegFilterList = new Set();
    }
  }
  return ffmpegFilterList.has(filterName);
}

// ─── 媒体探测 ────────────────────────────────────────────────────────────────

export async function mediaDuration(input: string): Promise<number> {
  try {
    const { stdout } = await runCommand(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input],
      15_000,
    );
    const d = Number(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

export async function hasAudioStream(input: string): Promise<boolean> {
  try {
    const { stdout } = await runCommand(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input,
      ],
      10_000,
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ─── 视频段处理 ──────────────────────────────────────────────────────────────

type VideoSize = { width: number; height: number };

function outputSize(aspectRatio: '9:16' | '16:9', resolution = '720x1280'): VideoSize {
  const match = resolution.match(/^(\d{3,4})x(\d{3,4})$/);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  return aspectRatio === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
}

function buildVideoFilter(size: VideoSize): string {
  return `[0:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24,format=yuv420p[vout]`;
}

function audioTrimFilter(duration: number, speed = 1): string {
  return speed !== 1 ? `atempo=${speed.toFixed(4)},atrim=0:${duration}` : `atrim=0:${duration}`;
}

export async function trimVideoSegment(
  input: string,
  output: string,
  targetDuration: number,
  aspectRatio: '9:16' | '16:9',
  resolution?: string,
  audioMode: 'original' | 'voiceover' | 'mute' = 'original',
  startTime = 0,
): Promise<void> {
  const size = outputSize(aspectRatio, resolution);
  const sourceDuration = await mediaDuration(input);
  const availableDuration = startTime > 0 && sourceDuration > startTime ? sourceDuration - startTime : sourceDuration;
  const speed =
    availableDuration > targetDuration + 0.25 ? Math.max(1, Math.min(4, availableDuration / targetDuration)) : 1;
  const needsAudio = audioMode !== 'mute';
  const timeoutMs = Math.max(20_000, targetDuration * 5_000);
  const stillImage = /\.(png|jpe?g|webp|gif)$/i.test(input);

  const inputArgs = stillImage
    ? ['-y', '-loop', '1', '-framerate', '24', '-i', input]
    : ['-y', ...(startTime > 0 ? ['-ss', String(startTime)] : []), '-i', input];
  const filterArgs = [
    '-t',
    String(targetDuration),
    '-filter_complex',
    buildVideoFilter(size),
    '-map',
    '[vout]',
    '-r',
    '24',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
  ];

  const runTrim = async (withAudio: boolean) => {
    if (!withAudio) {
      await runCommand('ffmpeg', [...inputArgs, ...filterArgs, '-an', output], timeoutMs);
      return;
    }
    if (await hasAudioStream(input)) {
      await runCommand(
        'ffmpeg',
        [
          ...inputArgs,
          ...filterArgs,
          '-map',
          '0:a:0',
          '-af',
          audioTrimFilter(targetDuration, speed),
          '-c:a',
          'aac',
          output,
        ],
        timeoutMs,
      );
    } else {
      await runCommand(
        'ffmpeg',
        [
          ...inputArgs,
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=392:sample_rate=44100',
          ...filterArgs,
          '-map',
          '1:a:0',
          '-af',
          `volume=0.035,apad=pad_dur=${targetDuration},atrim=0:${targetDuration}`,
          '-c:a',
          'aac',
          output,
        ],
        timeoutMs,
      );
    }
  };

  try {
    await runTrim(needsAudio);
  } catch {
    await runTrim(false);
  }
}

// 帧接力连续性：抽取一个已渲染分镜的「真实尾帧」，作为下一镜的 I2V 首帧，让跨剪辑点画面自然延续。
export async function extractLastFrame(input: string, output: string): Promise<boolean> {
  const duration = await mediaDuration(input);
  // 取临近结尾的一帧（留 0.05s 余量，避免落到黑场/解码尾边界）。
  const seek = duration > 0.1 ? Math.max(0, duration - 0.05) : 0;
  try {
    await runCommand('ffmpeg', ['-y', '-ss', String(seek), '-i', input, '-frames:v', '1', '-q:v', '2', output], 20_000);
    return fs.existsSync(output) && fs.statSync(output).size > 0;
  } catch {
    return false;
  }
}

// ─── 拼接合并 ────────────────────────────────────────────────────────────────

export async function concatSegments(segments: string[], output: string, workDir: string): Promise<void> {
  const listFile = path.join(workDir, `concat_${Date.now()}.txt`);
  fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
  try {
    await runCommand('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}

function xfadeName(transition: string): string {
  return transition === 'whip' ? 'wipeleft' : 'fade';
}

async function mergeWithTransition(
  first: string,
  second: string,
  output: string,
  transition: string,
  workDir: string,
): Promise<void> {
  const d1 = await mediaDuration(first);
  const d2 = await mediaDuration(second);
  const desired = transition === 'hard_cut' ? 0 : 0.35;
  const duration = Math.min(desired, Math.max(0, d1 - 0.08), Math.max(0, d2 - 0.08));

  if (duration < 0.15) {
    await concatSegments([first, second], output, workDir);
    return;
  }

  const offset = Math.max(0, d1 - duration);
  const vf = `[0:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v0];[1:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v1];[v0][v1]xfade=transition=${xfadeName(transition)}:duration=${duration.toFixed(3)}:offset=${offset.toFixed(3)},format=yuv420p[vout]`;
  const af = `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0];[1:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];[a0][a1]acrossfade=d=${duration.toFixed(3)}:c1=tri:c2=tri[aout]`;

  await runCommand('ffmpeg', [
    '-y',
    '-i',
    first,
    '-i',
    second,
    '-filter_complex',
    `${vf};${af}`,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-r',
    '24',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    output,
  ]);
}

export type TransitionPlan = {
  segment: string;
  transition: string;
  duration: number;
  shotOrder: number;
};

export type TransitionResult = { softTransitions: number; fallbackHardCuts: number };

export async function concatWithTransitions(
  plans: TransitionPlan[],
  output: string,
  workDir: string,
): Promise<TransitionResult> {
  if (!plans.length) throw new Error('没有可合成的视频分镜');
  if (plans.length === 1) {
    fs.copyFileSync(plans[0].segment, output);
    return { softTransitions: 0, fallbackHardCuts: 0 };
  }

  const allHardCut = plans.every((p, i) => i >= plans.length - 1 || p.transition === 'hard_cut');
  if (allHardCut) {
    await concatSegments(
      plans.map((p) => p.segment),
      output,
      workDir,
    );
    return { softTransitions: 0, fallbackHardCuts: 0 };
  }

  let current = plans[0].segment;
  let softTransitions = 0;
  let fallbackHardCuts = 0;

  for (let i = 1; i < plans.length; i++) {
    const prev = plans[i - 1];
    const next = plans[i];
    const pairOutput =
      i === plans.length - 1 ? output : path.join(workDir, `transition_${String(i).padStart(2, '0')}.mp4`);

    if (prev.transition === 'hard_cut') {
      await concatSegments([current, next.segment], pairOutput, workDir);
    } else {
      try {
        await mergeWithTransition(current, next.segment, pairOutput, prev.transition, workDir);
        softTransitions++;
      } catch {
        await concatSegments([current, next.segment], pairOutput, workDir);
        fallbackHardCuts++;
      }
    }
    current = pairOutput;
  }

  return { softTransitions, fallbackHardCuts };
}

// ─── 字幕层 ──────────────────────────────────────────────────────────────────

function assTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const centiseconds = Math.floor((safeSeconds % 1) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(
    centiseconds,
  ).padStart(2, '0')}`;
}

function assText(value: string) {
  return value.replace(/[{}]/g, '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\N').trim();
}

function assPosition(position: SubtitlePosition, size: VideoSize) {
  const x = Math.round(size.width / 2);
  if (position === 'top') return `{\\an8\\pos(${x},${Math.round(size.height * 0.14)})}`;
  if (position === 'middle_lower') return `{\\an2\\pos(${x},${Math.round(size.height * 0.68)})}`;
  return `{\\an2\\pos(${x},${Math.round(size.height * 0.82)})}`;
}

function assFontSize(size: VideoSize) {
  const shortSide = Math.min(size.width, size.height);
  return Math.max(32, Math.round(shortSide * 0.058));
}

function buildAss(input: { events: SubtitleOverlayEvent[]; size: VideoSize; fontFamily: string; fontSize?: number }) {
  const fontSize = input.fontSize || assFontSize(input.size);
  const lines = input.events
    .filter((event) => event.text.trim() && event.end > event.start)
    .map((event) => {
      const override = assPosition(event.position, input.size);
      return `Dialogue: 0,${assTime(event.start)},${assTime(event.end)},Default,,0,0,0,,${override}${assText(
        event.text,
      )}`;
    });

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${input.size.width}
PlayResY: ${input.size.height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,${input.fontFamily},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,4,2,2,42,42,72,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${lines.join('\n')}
`;
}

function escapeFilterPath(filePath: string) {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function escapeSvg(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSubtitleSvg(input: {
  event: SubtitleOverlayEvent;
  size: VideoSize;
  fontFamily: string;
  fontSize?: number;
}) {
  const fontSize = input.fontSize || assFontSize(input.size);
  const lineHeight = Math.round(fontSize * 1.28);
  const lines = input.event.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  const displayLines = lines.length ? lines : [input.event.text.trim()];
  const maxChars = Math.max(...displayLines.map((line) => line.length), 1);
  const boxWidth = Math.min(Math.round(input.size.width * 0.84), Math.round(maxChars * fontSize * 0.86 + 72));
  const boxHeight = Math.round(displayLines.length * lineHeight + 34);
  const x = Math.round(input.size.width / 2);
  const y =
    input.event.position === 'top'
      ? Math.round(input.size.height * 0.14)
      : input.event.position === 'middle_lower'
        ? Math.round(input.size.height * 0.68)
        : Math.round(input.size.height * 0.82);
  const textStartY = Math.round(y - ((displayLines.length - 1) * lineHeight) / 2 + fontSize * 0.34);
  const tspans = displayLines
    .map((line, index) => `<tspan x="${x}" y="${textStartY + index * lineHeight}">${escapeSvg(line)}</tspan>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.size.width}" height="${input.size.height}" viewBox="0 0 ${input.size.width} ${input.size.height}">
<rect width="${input.size.width}" height="${input.size.height}" fill="none"/>
<rect x="${Math.round(x - boxWidth / 2)}" y="${Math.round(y - boxHeight / 2)}" width="${boxWidth}" height="${boxHeight}" rx="18" fill="#000000" fill-opacity="0.42"/>
<text text-anchor="middle" font-family="${escapeSvg(input.fontFamily)}" font-size="${fontSize}" font-weight="700" fill="#ffffff" stroke="#000000" stroke-opacity="0.7" stroke-width="5" paint-order="stroke fill">${tspans}</text>
</svg>`;
}

async function rasterizeSubtitleSvg(svgPath: string, pngPath: string, workDir: string) {
  if (await commandOk('sips', ['--help'])) {
    try {
      await runCommand('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], 20_000);
      if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) return true;
    } catch {
      // Try Quick Look below.
    }
  }

  if (await commandOk('qlmanage', ['-m'])) {
    try {
      await runCommand('qlmanage', ['-t', '-s', '1280', '-o', workDir, svgPath], 20_000);
      const quickLookPath = `${svgPath}.png`;
      if (fs.existsSync(quickLookPath) && fs.statSync(quickLookPath).size > 0) {
        fs.copyFileSync(quickLookPath, pngPath);
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function overlayEnable(event: SubtitleOverlayEvent) {
  return `between(t\\,${event.start.toFixed(3)}\\,${event.end.toFixed(3)})`;
}

async function addSubtitleLayerWithOverlay(
  input: string,
  output: string,
  events: SubtitleOverlayEvent[],
  options: {
    aspectRatio: '9:16' | '16:9';
    resolution?: string;
    fontFamily?: string;
    fontSize?: number;
  },
): Promise<{ applied: boolean; note: string }> {
  if (!(await ffmpegFilterAvailable('overlay'))) {
    fs.copyFileSync(input, output);
    return { applied: false, note: '当前 FFmpeg 缺少 overlay filter，跳过字幕层。' };
  }

  const size = outputSize(options.aspectRatio, options.resolution);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-overlay-'));
  const overlays: Array<{ event: SubtitleOverlayEvent; pngPath: string }> = [];

  try {
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const svgPath = path.join(tmpDir, `subtitle_${String(index + 1).padStart(2, '0')}.svg`);
      const pngPath = path.join(tmpDir, `subtitle_${String(index + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(
        svgPath,
        buildSubtitleSvg({
          event,
          size,
          fontFamily: options.fontFamily || 'PingFang SC',
          fontSize: options.fontSize,
        }),
        'utf-8',
      );
      if (await rasterizeSubtitleSvg(svgPath, pngPath, tmpDir)) overlays.push({ event, pngPath });
    }

    if (!overlays.length) {
      fs.copyFileSync(input, output);
      return { applied: false, note: '字幕图片栅格化不可用，跳过字幕层。' };
    }

    const inputArgs = ['-y', '-i', input, ...overlays.flatMap((item) => ['-loop', '1', '-i', item.pngPath])];
    const duration = await mediaDuration(input);
    const filterSteps = ['[0:v]format=rgba[v0]'];
    overlays.forEach((item, index) => {
      const overlayInput = index + 1;
      const previous = index === 0 ? '[v0]' : `[v${index}]`;
      const next = `[v${index + 1}]`;
      filterSteps.push(`[${overlayInput}:v]format=rgba[ov${index + 1}]`);
      filterSteps.push(`${previous}[ov${index + 1}]overlay=0:0:enable=${overlayEnable(item.event)}${next}`);
    });
    filterSteps.push(`[v${overlays.length}]format=yuv420p[vout]`);

    await runCommand(
      'ffmpeg',
      [
        ...inputArgs,
        '-filter_complex',
        filterSteps.join(';'),
        '-map',
        '[vout]',
        '-map',
        '0:a?',
        ...(duration > 0 ? ['-t', String(duration)] : []),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        output,
      ],
      Math.max(30_000, overlays.length * 8_000),
    );
    return { applied: true, note: `已用 overlay 叠加 ${overlays.length} 条后期字幕。` };
  } catch (error) {
    fs.copyFileSync(input, output);
    return {
      applied: false,
      note: `字幕 overlay 失败，保留无字幕视频：${error instanceof Error ? error.message : '未知错误'}`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function addSubtitleLayerWithAss(
  input: string,
  output: string,
  events: SubtitleOverlayEvent[],
  options: {
    aspectRatio: '9:16' | '16:9';
    resolution?: string;
    fontFamily?: string;
    fontSize?: number;
  },
): Promise<{ applied: boolean; note: string }> {
  const size = outputSize(options.aspectRatio, options.resolution);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-'));
  const assFile = path.join(tmpDir, 'subtitles.ass');

  // 生产环境（非 macOS）需要可用的中文字体，否则 libass 回退到丑字甚至豆腐块。
  // 设 SUBTITLE_FONTS_DIR 指向打包好的中文字体目录（如 Noto Sans SC），并用 SUBTITLE_FONT_FAMILY 指定字体名。
  const fontsDir = process.env.SUBTITLE_FONTS_DIR?.trim();
  const fontFamily = options.fontFamily || process.env.SUBTITLE_FONT_FAMILY?.trim() || 'PingFang SC';
  try {
    fs.writeFileSync(
      assFile,
      buildAss({
        events,
        size,
        fontFamily,
        fontSize: options.fontSize,
      }),
      'utf-8',
    );
    await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        input,
        '-vf',
        `subtitles=filename=${escapeFilterPath(assFile)}${fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : ''}`,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        output,
      ],
      Math.max(30_000, events.length * 5_000),
    );
    return { applied: true, note: `已叠加 ${events.length} 条后期字幕。` };
  } catch (error) {
    fs.copyFileSync(input, output);
    return {
      applied: false,
      note: `字幕叠加失败，保留无字幕视频：${error instanceof Error ? error.message : '未知错误'}`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 解析一个可用的中文字体文件，供 drawtext 使用（drawtext 不走 fontconfig）。
function resolveCjkFontFile(): string | undefined {
  const fromEnv = process.env.SUBTITLE_FONT_FILE?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  ];
  return candidates.find((file) => fs.existsSync(file));
}

// drawtext 字幕：定位可靠（不像 SVG→qlmanage 会把文字甩到角落），自带描边和半透明底框。
async function addSubtitleLayerWithDrawtext(
  input: string,
  output: string,
  events: SubtitleOverlayEvent[],
  options: { aspectRatio: '9:16' | '16:9'; resolution?: string; fontSize?: number },
): Promise<{ applied: boolean; note: string }> {
  const fontFile = resolveCjkFontFile();
  if (!fontFile) return { applied: false, note: '未找到可用中文字体文件，跳过 drawtext 字幕。' };
  const size = outputSize(options.aspectRatio, options.resolution);
  const fontSize = options.fontSize || assFontSize(size);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-dt-'));
  try {
    // 字体复制到无空格临时路径，避开 ffmpeg filter 的路径转义坑。
    const safeFont = path.join(tmpDir, `font${path.extname(fontFile) || '.ttc'}`);
    fs.copyFileSync(fontFile, safeFont);
    const filters = events.map((event, index) => {
      const txtPath = path.join(tmpDir, `cap_${index}.txt`);
      fs.writeFileSync(txtPath, event.text.replace(/\r?\n/g, '\n').trim(), 'utf-8');
      const yFactor = event.position === 'top' ? 0.14 : event.position === 'middle_lower' ? 0.68 : 0.82;
      return [
        `drawtext=fontfile=${escapeFilterPath(safeFont)}`,
        `textfile=${escapeFilterPath(txtPath)}`,
        `fontsize=${fontSize}`,
        'fontcolor=white',
        // 只保留描边 + 阴影，不要半透明底框（与 ASS 风格一致）。
        'borderw=5',
        'bordercolor=black',
        'shadowcolor=black@0.5',
        'shadowx=1',
        'shadowy=1',
        'line_spacing=8',
        'x=(w-text_w)/2',
        `y=h*${yFactor}-text_h/2`,
        `enable=${overlayEnable(event)}`,
      ].join(':');
    });
    await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        input,
        '-vf',
        filters.join(','),
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        output,
      ],
      Math.max(30_000, events.length * 5_000),
    );
    return { applied: true, note: `已用 drawtext 叠加 ${events.length} 条后期字幕。` };
  } catch (error) {
    fs.copyFileSync(input, output);
    return { applied: false, note: `drawtext 字幕失败：${error instanceof Error ? error.message : '未知错误'}` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function addSubtitleLayer(
  input: string,
  output: string,
  events: SubtitleOverlayEvent[],
  options: {
    aspectRatio: '9:16' | '16:9';
    resolution?: string;
    fontFamily?: string;
    fontSize?: number;
  },
): Promise<{ applied: boolean; note: string }> {
  const usableEvents = events.filter((event) => event.text.trim() && event.end > event.start);
  if (!usableEvents.length) {
    fs.copyFileSync(input, output);
    return { applied: false, note: '没有可叠加的字幕事件。' };
  }

  // 优先级：libass（样式最好）→ drawtext（定位可靠）→ SVG overlay（最后手段，定位差）。
  if (await ffmpegFilterAvailable('subtitles')) {
    const assResult = await addSubtitleLayerWithAss(input, output, usableEvents, options);
    if (assResult.applied) return assResult;
  }

  if (await ffmpegFilterAvailable('drawtext')) {
    const drawResult = await addSubtitleLayerWithDrawtext(input, output, usableEvents, options);
    if (drawResult.applied) return drawResult;
  }

  return addSubtitleLayerWithOverlay(input, output, usableEvents, options);
}

// ─── 音频层 ──────────────────────────────────────────────────────────────────

export async function addVoiceoverLayer(
  input: string,
  output: string,
  narrationText: string,
): Promise<{ mixed: boolean; note: string }> {
  const hasSay = await commandOk('say', ['-v', '?']);
  if (!hasSay) {
    fs.copyFileSync(input, output);
    return { mixed: false, note: 'macOS say 不可用，跳过 TTS。' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const narFile = path.join(tmpDir, 'narration.txt');
  const aiffFile = path.join(tmpDir, 'voiceover.aiff');

  try {
    fs.writeFileSync(narFile, narrationText, 'utf-8');
    await runCommand('say', ['-o', aiffFile, '-f', narFile]);
    const duration = await mediaDuration(input);

    if (await hasAudioStream(input)) {
      await runCommand('ffmpeg', [
        '-y',
        '-i',
        input,
        '-i',
        aiffFile,
        '-filter_complex',
        `[1:a]atrim=0:${duration},volume=0.85[tts];[0:a][tts]amix=inputs=2:duration=first[aout]`,
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        output,
      ]);
    } else {
      await runCommand('ffmpeg', [
        '-y',
        '-i',
        input,
        '-i',
        aiffFile,
        '-filter_complex',
        `[1:a]atrim=0:${duration},volume=0.85[aout]`,
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        output,
      ]);
    }
    return { mixed: true, note: '已混入 TTS 旁白。' };
  } catch (err) {
    fs.copyFileSync(input, output);
    return { mixed: false, note: `TTS 混音失败：${err instanceof Error ? err.message : '未知错误'}` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
