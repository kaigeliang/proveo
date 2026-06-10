import axios from 'axios';

function envValue(name: string) {
  return process.env[name]?.replace(/[​-‍﻿]/g, '').trim();
}

function compactLine(value: unknown, maxLength: number) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function summarizeSeedanceData(value: unknown, maxLength = 900): string {
  if (typeof value === 'string') return compactLine(value, maxLength);
  if (value === null || value === undefined) return '';
  try {
    return compactLine(JSON.stringify(value), maxLength);
  } catch {
    return compactLine(String(value), maxLength);
  }
}

function describeSeedanceError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : '未知错误';
  }
  const status = error.response?.status;
  const statusText = error.response?.statusText;
  const body = summarizeSeedanceData(error.response?.data);
  const code = error.code ? ` code=${error.code}` : '';
  const statusPart = status ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : error.message || '网络错误';
  return [statusPart + code, body].filter(Boolean).join('；响应=');
}

function seedanceRequestDurationSeconds(targetDuration: number) {
  const configured = Number(envValue('SEEDANCE_REQUEST_DURATION_SECONDS'));
  if (Number.isFinite(configured) && configured > 0) return Math.max(3, Math.round(configured));
  // doubao-seedance-1-5-pro rejects `--dur 2`; 5s is a confirmed safe generation window.
  // The Worker trims the returned clip to the script shot duration with FFmpeg.
  return Math.max(5, Math.round(targetDuration));
}

export function isSeedanceConfigured(): boolean {
  return Boolean(
    envValue('ARK_API_KEY') &&
    envValue('ARK_VIDEO_MODEL_ID') &&
    process.env.ARK_ENABLE_VIDEO !== 'false' &&
    process.env.SPEC_ENABLE_SEEDANCE !== 'false',
  );
}

function arkHeaders() {
  return {
    Authorization: `Bearer ${envValue('ARK_API_KEY')}`,
    'Content-Type': 'application/json',
  };
}

function readTaskId(data: unknown): string {
  const obj = data as Record<string, unknown>;
  return String(obj?.id || obj?.task_id || obj?.taskId || '');
}

function readTaskStatus(data: unknown): string {
  const obj = data as Record<string, unknown>;
  return String(obj?.status || '').toLowerCase();
}

function isTerminalSuccessStatus(status: string) {
  return ['done', 'succeeded', 'success', 'completed', 'complete'].includes(status);
}

function isTerminalFailureStatus(status: string) {
  return ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status);
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => deepStrings(item));
  if (value && typeof value === 'object') return Object.values(value).flatMap((item) => deepStrings(item));
  return [];
}

function readVideoUrl(data: unknown): string {
  const obj = data as Record<string, unknown>;
  const content = obj?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const video = (item as Record<string, unknown>)?.video_url;
      if (typeof video === 'string' && video) return video;
    }
  }
  const direct = String(obj?.video_url || obj?.videoUrl || obj?.url || '');
  if (direct) return direct;
  return deepStrings(data).find((item) => /^https?:\/\/.+\.(mp4|mov|webm|m3u8)(\?|$)/i.test(item)) || '';
}

export function buildSeedancePrompt(params: {
  aspectRatio: string;
  duration: number;
  narrative: string;
  visualStyle: string;
  bgm: string;
  shotIndex: number;
  shotTotal: number;
  prevSubtitle?: string;
  nextSubtitle?: string;
  prevVisualDesc?: string;
  visualDesc: string;
  camera: string;
  subtitle: string;
  narration: string;
  transition?: string;
  continuesFromPrevFrame?: boolean;
  // 全片共享、逐字一致的「一致性圣经」：钉死商品外观 + 全片分镜清单，所有并发镜头注入同一份，保证跨镜连贯。
  filmContext?: string;
}): string {
  // Seedance 官方提示词结构：主体 + 动作 + 场景 + 镜头 + 风格，用直白自然语言描述「镜头里看得见的画面」。
  // 把最具体的画面放最前面（模型主要靠它生成），元指令/负向约束放最后。
  const isLast = params.shotIndex >= params.shotTotal - 1;
  const transitionCue =
    params.transition === 'whip'
      ? '镜尾保留同方向运动动势，便于下一镜快速甩切。'
      : params.transition === 'fade'
        ? '镜尾运动收束、构图稳定，便于下一镜淡入淡出。'
        : '镜尾画面清晰完整、动作收住，便于下一镜硬切。';

  // 连贯性有两种：
  // 1) 帧接力（continuesFromPrevFrame）—— 单镜内连续动作，画面从上一镜尾帧自然延续，不切场景；
  // 2) 多角度连贯（默认）—— 各镜是同一商品/同一风格，但刻意换机位、换景别去展示商品的不同细节，
  //    靠商品一致性 + 统一风格 + 节奏顺滑保持观感连贯，而不是把两镜画面焊在一起。
  const continuityLine = params.continuesFromPrevFrame
    ? `连续镜头：本镜首帧即上一镜的结尾画面，请从该画面自然延续运动，保持同一空间、同一商品、同一光线与色调，只推进动作与镜头，不要跳到新场景或重置构图。${
        params.prevVisualDesc ? `上一镜内容：${compactLine(params.prevVisualDesc, 140)}` : ''
      }`
    : `本镜与全片是同一个商品、同一套视觉风格与光线调色；请用上面的机位/景别从一个新的角度或景别展示商品，与相邻镜头形成干净利落的切换，露出本镜独有的细节，不要重复其它镜头的构图，也不要把画面和上一镜焊在一起。整片靠商品一致与节奏顺滑保持观感连贯。`;
  const visualDesc = compactLine(params.visualDesc, 260);
  const camera = compactLine(params.camera || '稳定固定镜头', 120);
  const visualStyle = compactLine(params.visualStyle, 160);
  const bgm = compactLine(params.bgm, 80);
  const narrative = compactLine(params.narrative, 220);
  const filmContext = compactLine(params.filmContext, 520);
  const requestDuration = seedanceRequestDurationSeconds(params.duration);
  const targetDuration = Math.max(1, Math.round(params.duration));

  return [
    // 主体 + 动作 + 场景（最核心，写成一句可拍的画面）
    visualDesc,
    // 镜头运动
    `镜头运动：${camera}。镜头节奏贴合「${bgm}」的情绪，开篇即入主体、结尾收稳。`,
    // 风格
    `画面风格：${visualStyle}，真实可发布的竖屏短视频原片质感，自然光影、真实材质与合理景深。`,
    // 全局语境（弱约束，帮助模型理解整片调性）
    `这是一条电商带货短视频的第 ${params.shotIndex + 1}/${params.shotTotal} 个镜头，生成约 ${requestDuration} 秒原片；前 ${targetDuration} 秒完成本镜主要动作，便于后期裁切。整片叙事：${narrative}。`,
    // 一致性圣经（所有并发镜头共享同一份，钉死商品外观 + 全片分镜清单 → 跨镜连贯）
    filmContext,
    continuityLine,
    !isLast ? transitionCue : '',
    // 负向约束 / 硬规则（Seedance 对直白负向词有效）
    [
      `硬性要求：${params.aspectRatio} 竖屏满画幅构图，不要黑边、不要分屏、不要拼贴或多段蒙太奇。`,
      '只拍这一个连续镜头里的一个主要动作，不要在同一镜里塞多个场景或多个卖点。',
      '商品是清晰可辨的画面主体，材质、颜色、比例全程真实一致；若有参考图必须严格沿用其外观，只改变场景、角度或手部动作。',
      '镜头开始 1 秒内出现商品主体与核心动作。',
      '画面内不得出现任何文字、字幕、logo、水印、品牌字样、价格、二维码、招牌或 UI；所有文案由后期文字层叠加。',
      '若画面需要价格牌/优惠券/招牌/包装文案，只保留干净无字卡片或留白色块作为占位。',
      '主体居中偏上，底部 20% 保持干净安全区留给字幕。',
      '不复刻任何公开视频，不表现夸大功效或绝对化承诺。',
    ].join(' '),
    // Seedance 文本指令：把镜头时长对齐到目标秒数，避免模型默认时长后再被 ffmpeg 大幅裁剪/变速。
    `--rt ${params.aspectRatio} --dur ${requestDuration}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// 整段「一镜到底」模式：把所有分镜写进同一条 prompt，用「镜头切换」连接，
// 让 Seedance 在单次调用里维持主体/风格/场景连续，原生输出一条多镜头视频。
export function buildSeedanceWholeVideoPrompt(params: {
  aspectRatio: string;
  totalDuration: number;
  narrative: string;
  visualStyle: string;
  bgm: string;
  shots: Array<{ visualDesc: string; camera: string; duration: number; transition?: string }>;
}): string {
  const transitionLabel = (transition?: string) =>
    transition === 'whip' ? '快速甩切' : transition === 'fade' ? '淡入淡出' : '硬切';

  const shotLines = params.shots.flatMap((shot, index) => {
    const lines = [
      `镜头${index + 1}（约 ${Math.max(1, Math.round(shot.duration))} 秒）：${compactLine(
        shot.visualDesc,
        220,
      )} 镜头运动：${compactLine(
        shot.camera || '稳定固定镜头',
        100,
      )}。${index > 0 ? '承接上一镜的同一空间、同一商品与同一光线，自然延续，不要重置场景。' : ''}`,
    ];
    if (index < params.shots.length - 1) {
      lines.push(`镜头切换（${transitionLabel(shot.transition)}）。`);
    }
    return lines;
  });

  return [
    `一条 ${params.aspectRatio} 电商带货短视频，总时长约 ${Math.max(1, Math.round(params.totalDuration))} 秒，由 ${params.shots.length} 个连续镜头组成。`,
    `整片叙事：${compactLine(params.narrative, 220)}。画面风格：${compactLine(
      params.visualStyle,
      160,
    )}，真实可发布的竖屏短视频原片质感，自然光影与真实材质。镜头节奏贴合「${compactLine(params.bgm, 80)}」。`,
    '全片保持同一个商品主体、同一条人物动线，跨镜头时商品外观、材质、颜色、比例始终一致，镜头之间用自然运动和转场衔接，像一条一镜到底拍下来的真实短视频。',
    ...shotLines,
    [
      `硬性要求：${params.aspectRatio} 竖屏满画幅，不要黑边、不要分屏拼贴。`,
      '画面内不得出现任何文字、字幕、logo、水印、品牌字样、价格、二维码、招牌或 UI；所有文案由后期文字层叠加。',
      '需要信息卡时只保留干净无字卡片或留白色块占位。',
      '主体居中偏上，底部 20% 留干净安全区给字幕。',
      '不复刻任何公开视频，不表现夸大功效或绝对化承诺。',
    ].join(' '),
    `--rt ${params.aspectRatio} --dur ${seedanceRequestDurationSeconds(params.totalDuration)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── 全局 Seedance 并发闸 ──────────────────────────────────────────────────────
// 共享 EP 并发有限（SEEDANCE_CONCURRENCY，默认 5）。多镜并行 + 多任务并发会自我造成
// 429；用进程内信号量把"同时在途的生成任务数"限制在该上限内，retry 也排队等空槽。
const SEEDANCE_GLOBAL_CONCURRENCY = Math.max(1, Number(envValue('SEEDANCE_CONCURRENCY')) || 5);
let seedanceInFlight = 0;
const seedanceSlotQueue: Array<() => void> = [];

async function acquireSeedanceSlot(onProgress?: (step: string, note: string) => void): Promise<void> {
  if (seedanceInFlight < SEEDANCE_GLOBAL_CONCURRENCY) {
    seedanceInFlight += 1;
    return;
  }
  onProgress?.('seedance_queued', `Seedance 并发已满（${SEEDANCE_GLOBAL_CONCURRENCY}），排队等待空槽。`);
  await new Promise<void>((resolve) => seedanceSlotQueue.push(resolve));
  // 槽位由 releaseSeedanceSlot 直接转交，这里不再自增，避免超发。
}

function releaseSeedanceSlot(): void {
  const next = seedanceSlotQueue.shift();
  if (next) {
    next();
  } else {
    seedanceInFlight = Math.max(0, seedanceInFlight - 1);
  }
}

// ── 共享熔断 / 冷却 ───────────────────────────────────────────────────────────
// 命中 429 时设置一个全局冷却窗口；期间所有调用统一等待，避免并行分镜/多任务各自
// 独立重试把已经限流的 EP 继续打满。任务成功即清除冷却，快速恢复。
const SEEDANCE_COOLDOWN_MS = Math.max(0, Number(envValue('SEEDANCE_COOLDOWN_MS')) || 15000);
let seedanceCooldownUntil = 0;

function noteSeedanceRateLimited(): void {
  if (SEEDANCE_COOLDOWN_MS > 0) seedanceCooldownUntil = Date.now() + SEEDANCE_COOLDOWN_MS;
}

async function awaitSeedanceCooldown(onProgress?: (step: string, note: string) => void): Promise<void> {
  const wait = seedanceCooldownUntil - Date.now();
  if (wait > 0) {
    onProgress?.('seedance_cooldown', `Seedance 近期限流，全局冷却 ${Math.ceil(wait / 1000)}s 后再提交。`);
    await new Promise((r) => setTimeout(r, Math.min(wait, SEEDANCE_COOLDOWN_MS)));
  }
}

export async function requestSeedanceVideo(
  prompt: string,
  options: { ratio: '9:16' | '16:9'; resolution: '720p' | '1080p'; generateAudio: boolean },
  imageUrl?: string,
  lastFrameImageUrl?: string,
  onProgress?: (step: string, note: string) => void,
): Promise<string> {
  await awaitSeedanceCooldown(onProgress);
  await acquireSeedanceSlot(onProgress);
  try {
    const url = await requestSeedanceVideoTask(prompt, options, imageUrl, lastFrameImageUrl, onProgress);
    seedanceCooldownUntil = 0; // 成功即恢复
    return url;
  } finally {
    releaseSeedanceSlot();
  }
}

async function requestSeedanceVideoTask(
  prompt: string,
  options: {
    ratio: '9:16' | '16:9';
    resolution: '720p' | '1080p';
    generateAudio: boolean;
  },
  imageUrl?: string,
  lastFrameImageUrl?: string,
  onProgress?: (step: string, note: string) => void,
): Promise<string> {
  const baseUrl = (envValue('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
  const model = envValue('ARK_VIDEO_MODEL_ID');
  if (!model) throw new Error('未配置 ARK_VIDEO_MODEL_ID');

  onProgress?.('seedance_submit', 'Seedance 视频任务提交中。');

  const content: Array<{ type: string; text?: string; image_url?: { url: string }; role?: string }> = [];
  if (imageUrl && lastFrameImageUrl) {
    content.push({ type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' });
    content.push({ type: 'image_url', image_url: { url: lastFrameImageUrl }, role: 'last_frame' });
  } else if (imageUrl) {
    content.push({ type: 'image_url', image_url: { url: imageUrl } });
  }
  content.push({ type: 'text', text: prompt });

  const payload = {
    model,
    content,
    ratio: options.ratio,
    resolution: options.resolution,
    generate_audio: options.generateAudio,
  };

  let createResponse;
  try {
    createResponse = await axios.post(`${baseUrl}/contents/generations/tasks`, payload, {
      headers: arkHeaders(),
      timeout: Number(process.env.ARK_TIMEOUT_MS || 90_000),
    });
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 400) throw error;
    const firstError = describeSeedanceError(error);
    onProgress?.('seedance_payload_retry', `Seedance 参数校验未通过，正在用兼容载荷重试：${firstError}`);
    try {
      createResponse = await axios.post(
        `${baseUrl}/contents/generations/tasks`,
        { model, content },
        { headers: arkHeaders(), timeout: Number(process.env.ARK_TIMEOUT_MS || 90_000) },
      );
    } catch (retryError) {
      throw new Error(`Seedance 提交失败：${describeSeedanceError(retryError)}；兼容重试前：${firstError}`);
    }
  }

  const remoteTaskId = readTaskId(createResponse.data);
  if (!remoteTaskId) throw new Error('Seedance 未返回任务编号');

  const startedAt = Date.now();
  const timeoutMs = Number(process.env.ARK_VIDEO_TIMEOUT_MS || 240_000);
  const pollMs = Number(process.env.ARK_VIDEO_POLL_MS || 4_000);

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    const pollResponse = await axios.get(`${baseUrl}/contents/generations/tasks/${encodeURIComponent(remoteTaskId)}`, {
      headers: arkHeaders(),
      timeout: Number(process.env.ARK_TIMEOUT_MS || 90_000),
    });
    const status = readTaskStatus(pollResponse.data);
    onProgress?.('seedance_polling', `Seedance 轮询中（status=${status}）。`);
    if (isTerminalFailureStatus(status)) {
      throw new Error(`Seedance 视频生成任务失败：${summarizeSeedanceData(pollResponse.data)}`);
    }
    if (isTerminalSuccessStatus(status)) {
      const videoUrl = readVideoUrl(pollResponse.data);
      if (!videoUrl) throw new Error('Seedance 任务完成但未返回可用视频 URL');
      return videoUrl;
    }
  }
  throw new Error('Seedance 视频生成超时');
}

function seedanceErrorStatus(err: unknown): number | undefined {
  return axios.isAxiosError(err) ? err.response?.status : undefined;
}

// 限流/瞬时错误可重试；明确的 4xx（如 400 参数错）不重试，避免空耗。
function isRetryableSeedanceError(err: unknown): boolean {
  const status = seedanceErrorStatus(err);
  if (status === undefined) return true; // 网络错误 / 超时
  return status === 429 || status === 408 || status === 425 || (status >= 500 && status <= 599);
}

// 优先遵循服务端 Retry-After（秒或 HTTP-date）。
function seedanceRetryAfterMs(err: unknown): number | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const header = err.response?.headers?.['retry-after'];
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(String(header));
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

export async function requestSeedanceVideoWithRetry(
  prompt: string,
  options: { ratio: '9:16' | '16:9'; resolution: '720p' | '1080p'; generateAudio: boolean },
  imageUrl?: string,
  lastFrameImageUrlOrProgress?: string | ((step: string, note: string) => void),
  onProgress?: (step: string, note: string) => void,
): Promise<string> {
  const lastFrameImageUrl = typeof lastFrameImageUrlOrProgress === 'string' ? lastFrameImageUrlOrProgress : undefined;
  const progress = typeof lastFrameImageUrlOrProgress === 'function' ? lastFrameImageUrlOrProgress : onProgress;
  const maxAttempts = Math.max(1, Number(envValue('SEEDANCE_MAX_ATTEMPTS')) || 5);
  const baseDelayMs = Math.max(1000, Number(envValue('SEEDANCE_RETRY_BASE_MS')) || 4000);
  const capDelayMs = Math.max(baseDelayMs, Number(envValue('SEEDANCE_RETRY_CAP_MS')) || 45000);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestSeedanceVideo(prompt, options, imageUrl, lastFrameImageUrl, progress);
    } catch (err) {
      lastError = err;
      const status = seedanceErrorStatus(err);
      if (status === 429) noteSeedanceRateLimited(); // 触发全局冷却，其他并行调用一起退避
      if (!isRetryableSeedanceError(err) || attempt === maxAttempts) break;
      const backoff =
        seedanceRetryAfterMs(err) ??
        Math.min(capDelayMs, baseDelayMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
      progress?.(
        'seedance_retry',
        `Seedance 第 ${attempt}/${maxAttempts} 次失败（${status === 429 ? '限流 429' : (status ?? '网络')}），${Math.round(backoff / 1000)}s 后重试。`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error(`Seedance 请求失败：${describeSeedanceError(lastError)}`);
}
