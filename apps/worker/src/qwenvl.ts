import fs from 'fs';
import path from 'path';
import type { SubtitleOverlayEvent, SubtitlePlacementAdvice } from './subtitles';

type QwenSubtitlePlacementInput = {
  videoUrl: string;
  productTitle?: string;
  narrative?: string;
  aspectRatio: '9:16' | '16:9';
  subtitles: SubtitleOverlayEvent[];
};

type QwenSubtitlePlacementResult = {
  applied: boolean;
  note: string;
  placements: SubtitlePlacementAdvice[];
  usage?: Record<string, unknown>;
  finishReason?: string;
};

type QwenMediaUploadResult = {
  url: string;
  mediaId?: string | number;
  mediaType?: string;
  raw?: unknown;
};

function envValue(name: string) {
  return String(process.env[name] || '').trim();
}

function numberEnv(name: string, fallback: number) {
  const value = Number(envValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isQwenVlConfigured() {
  return Boolean(envValue('QWEN_VL_BASE_URL') && envValue('QWEN_VL_API_KEY'));
}

export function isQwenVlMediaUploadConfigured() {
  return Boolean(envValue('QWEN_VL_MEDIA_UPLOAD_URL') && envValue('QWEN_VL_API_KEY'));
}

export function isPublicVideoUrlForQwen(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '0.0.0.0' || host === '127.0.0.1' || host === '::1') return false;
    if (host.endsWith('.local')) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d{1,2})\./);
    if (private172) {
      const block = Number(private172[1]);
      if (block >= 16 && block <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function mediaUploadUrl() {
  return envValue('QWEN_VL_MEDIA_UPLOAD_URL');
}

function extractQwenMediaUploadResult(payload: unknown): QwenMediaUploadResult {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const resp = record.Resp && typeof record.Resp === 'object' ? (record.Resp as Record<string, unknown>) : {};
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {};
  const url = String(resp.url || data.url || record.url || '');
  if (!url) throw new Error('Qwen-VL 媒体上传成功但未返回 url。');
  return {
    url,
    mediaId: (resp.media_id || data.media_id || record.media_id) as string | number | undefined,
    mediaType:
      typeof resp.media_type === 'string'
        ? resp.media_type
        : typeof data.media_type === 'string'
          ? data.media_type
          : undefined,
    raw: payload,
  };
}

export async function uploadQwenVlMedia(input: {
  filePath: string;
  contentType?: string;
  fileName?: string;
  timeoutMs?: number;
}): Promise<QwenMediaUploadResult> {
  if (!isQwenVlMediaUploadConfigured()) throw new Error('未配置 QWEN_VL_MEDIA_UPLOAD_URL。');
  const bytes = fs.readFileSync(input.filePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs || 120_000);
  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], { type: input.contentType || 'video/mp4' }),
      input.fileName || path.basename(input.filePath),
    );
    const key = envValue('QWEN_VL_API_KEY');
    const response = await fetch(mediaUploadUrl(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'API-KEY': key,
      },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Qwen-VL 媒体上传 HTTP ${response.status}: ${text.slice(0, 500)}`);
    return extractQwenMediaUploadResult(JSON.parse(text));
  } finally {
    clearTimeout(timer);
  }
}

function stripCodeFence(value: string) {
  return value
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function readJsonObject(value: string) {
  const stripped = stripCodeFence(value);
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
    throw new Error('Qwen-VL 返回内容不是 JSON 对象。');
  }
}

function normalizePlacement(item: unknown): SubtitlePlacementAdvice | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  const order = Number(record.order);
  if (!Number.isFinite(order) || order <= 0) return undefined;
  const position = String(record.position || '');
  const normalizedPosition =
    position === 'bottom' || position === 'middle_lower' || position === 'top' || position === 'none'
      ? position
      : undefined;
  return {
    order,
    show: typeof record.show === 'boolean' ? record.show : undefined,
    position: normalizedPosition,
    reason: typeof record.reason === 'string' ? record.reason.slice(0, 60) : undefined,
  };
}

function promptFor(input: QwenSubtitlePlacementInput) {
  const subtitles = input.subtitles.map((item) => ({
    order: item.shotOrder,
    start: item.start,
    end: item.end,
    text: item.text.replace(/\n/g, ' / '),
  }));

  return `你是 Composer Agent 的视觉决策核心，擅长视频定位、主体识别和 OCR。只基于视频可见画面和候选字幕输出严格 JSON，不要 Markdown，不要解释。

任务：直接决定每条候选字幕是否应该显示，以及应该放在 bottom、middle_lower、top 还是 none。FFmpeg 会完全按你的结果叠加字幕。

判断规则：
- 不改写字幕文字，不新增候选外的字幕。
- 先用 OCR 判断画面是否已有清晰字幕、价格牌、包装文字、平台 UI 或 CTA 文案；已有可读文字时谨慎叠加。
- 用主体定位判断商品、人脸、手部动作和演示区域所在位置，字幕不能遮挡这些区域。
- 如果画面已有清晰字幕、底部被商品/手部/价格卡/平台 UI 占据，避免 bottom。
- 如果商品主体在下半区，优先 top；如果顶部有重要商品或人脸，优先 bottom 或 middle_lower。
- 字幕不要遮挡商品、手部动作、成分/规格文字、CTA 按钮和可读包装。
- 如果三个位置都可能遮挡主体或已有文字，position 设为 none，show 设为 false。
- 必须为每条候选字幕输出一条 placements 决策。

输出格式：
{
  "placements":[
    {"order":1,"show":true,"position":"bottom|middle_lower|top|none","reason":"<=20字"}
  ],
  "note":"<=30字"
}

商品：${input.productTitle || ''}
叙事：${input.narrative || ''}
画幅：${input.aspectRatio}
候选字幕：${JSON.stringify(subtitles)}`;
}

export async function decideQwenSubtitlePlacement(
  input: QwenSubtitlePlacementInput,
): Promise<QwenSubtitlePlacementResult> {
  if (!isQwenVlConfigured()) {
    return { applied: false, note: '未配置 Qwen-VL，使用 Composer 本地保守字幕计划。', placements: [] };
  }
  if (!isPublicVideoUrlForQwen(input.videoUrl)) {
    return { applied: false, note: '成片暂未提供 Qwen-VL 可访问的公网 URL，使用本地保守字幕计划。', placements: [] };
  }
  if (!input.subtitles.length) {
    return { applied: false, note: '没有候选字幕，不调用 Qwen-VL。', placements: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), numberEnv('QWEN_VL_SUBTITLE_TIMEOUT_MS', 45_000));
  const baseUrl = envValue('QWEN_VL_BASE_URL').replace(/\/$/, '');
  const model = envValue('QWEN_VL_MODEL_ID') || 'qwen3-vl-plus';

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${envValue('QWEN_VL_API_KEY')}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'video_url',
                video_url: { url: input.videoUrl },
                fps: numberEnv('QWEN_VL_SUBTITLE_FPS', 1),
              },
              { type: 'text', text: promptFor(input) },
            ],
          },
        ],
        temperature: 0,
        max_tokens: numberEnv('QWEN_VL_SUBTITLE_MAX_TOKENS', 900),
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Qwen-VL HTTP ${response.status}: ${text.slice(0, 500)}`);
    const json = JSON.parse(text);
    const content = String(json.choices?.[0]?.message?.content || '{}');
    const parsed = readJsonObject(content) as Record<string, unknown>;
    const placements = Array.isArray(parsed.placements)
      ? parsed.placements
          .map((item) => normalizePlacement(item))
          .filter((item): item is SubtitlePlacementAdvice => Boolean(item))
      : [];
    if (!placements.length) {
      return {
        applied: false,
        note: 'Qwen-VL 未返回有效字幕决策，使用本地保守字幕计划。',
        placements: [],
        usage: json.usage,
        finishReason: json.choices?.[0]?.finish_reason,
      };
    }
    return {
      applied: true,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 80) : 'Qwen-VL 已返回字幕显示和位置决策。',
      placements,
      usage: json.usage,
      finishReason: json.choices?.[0]?.finish_reason,
    };
  } catch (error) {
    return {
      applied: false,
      note: `Qwen-VL 字幕建议失败：${error instanceof Error ? error.message : '未知错误'}`,
      placements: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
