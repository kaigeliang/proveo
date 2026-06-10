import axios from 'axios';

export type SeedanceStatus = 'running' | 'done' | 'failed';

export type SeedanceTaskRequest = {
  prompt: string;
  ratio: string;
  resolution: '720p' | '1080p';
  generateAudio: boolean;
  imageUrl?: string;
  timeoutMs?: number;
};

export type SeedanceSubmission = {
  taskId: string;
  usedPromptRatioFallback: boolean;
};

export type SeedanceTaskResult = {
  taskId: string;
  status: SeedanceStatus;
  videoUrl?: string;
  raw: unknown;
};

function envValue(name: string): string {
  return (process.env[name] || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function baseUrl(): string {
  return (envValue('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
}

function headers() {
  return {
    Authorization: `Bearer ${envValue('ARK_API_KEY')}`,
    'Content-Type': 'application/json',
  };
}

function timeoutMs(value?: number): number {
  return value ?? Number(process.env.ARK_TIMEOUT_MS || 90_000);
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => deepStrings(item));
  if (value && typeof value === 'object') return Object.values(value).flatMap((item) => deepStrings(item));
  return [];
}

export function isSeedanceConfigured() {
  return Boolean(
    envValue('ARK_API_KEY') &&
    envValue('ARK_VIDEO_MODEL_ID') &&
    process.env.ARK_ENABLE_VIDEO !== 'false' &&
    process.env.SPEC_ENABLE_SEEDANCE !== 'false',
  );
}

export function configuredSeedanceConcurrency() {
  const parsed = Number(process.env.SEEDANCE_CONCURRENCY || 5);
  const value = Number.isFinite(parsed) ? Math.floor(parsed) : 2;
  return Math.max(1, Math.min(5, value));
}

export function readSeedanceTaskId(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  const nested = data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {};
  return String(data.id || data.task_id || nested.id || nested.task_id || '').trim() || undefined;
}

export function readSeedanceTaskStatus(value: unknown): SeedanceStatus {
  const candidates = deepStrings(value).map((item) => item.toLowerCase());
  if (candidates.some((item) => ['succeeded', 'success', 'done', 'completed'].includes(item))) return 'done';
  if (candidates.some((item) => ['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(item))) {
    return 'failed';
  }
  return 'running';
}

export function readSeedanceVideoUrl(value: unknown) {
  return deepStrings(value).find((item) => /^https?:\/\/.+\.(mp4|mov|m3u8|webm)(\?|$)/i.test(item));
}

export async function submitSeedanceTask(request: SeedanceTaskRequest): Promise<SeedanceSubmission> {
  const model = envValue('ARK_VIDEO_MODEL_ID');
  if (!isSeedanceConfigured() || !model) throw new Error('Seedance provider is not configured');
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  if (request.imageUrl) content.push({ type: 'image_url', image_url: { url: request.imageUrl } });
  content.push({ type: 'text', text: request.prompt });

  let data: unknown;
  let usedPromptRatioFallback = false;
  try {
    const response = await axios.post(
      `${baseUrl()}/contents/generations/tasks`,
      {
        model,
        content,
        ratio: request.ratio,
        resolution: request.resolution,
        generate_audio: request.generateAudio,
      },
      { headers: headers(), timeout: timeoutMs(request.timeoutMs) },
    );
    data = response.data;
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 400) throw error;
    usedPromptRatioFallback = true;
    const response = await axios.post(
      `${baseUrl()}/contents/generations/tasks`,
      { model, content },
      { headers: headers(), timeout: timeoutMs(request.timeoutMs) },
    );
    data = response.data;
  }
  const taskId = readSeedanceTaskId(data);
  if (!taskId) throw new Error('Seedance provider returned no task id');
  return { taskId, usedPromptRatioFallback };
}

export async function pollSeedanceTask(taskId: string, requestTimeoutMs?: number): Promise<SeedanceTaskResult> {
  const response = await axios.get(`${baseUrl()}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
    headers: headers(),
    timeout: timeoutMs(requestTimeoutMs),
  });
  return {
    taskId,
    status: readSeedanceTaskStatus(response.data),
    videoUrl: readSeedanceVideoUrl(response.data),
    raw: response.data,
  };
}

export async function downloadSeedanceVideo(url: string, requestTimeoutMs?: number): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: requestTimeoutMs ?? Math.max(Number(process.env.ARK_TIMEOUT_MS || 90_000), 120_000),
  });
  const bytes = Buffer.from(response.data);
  if (bytes.length === 0) throw new Error('Seedance video download returned no data');
  return bytes;
}
