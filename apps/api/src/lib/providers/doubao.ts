import axios from 'axios';

export type DoubaoCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      references?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
  }>;
};

export type DoubaoResponsesResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      content?: string;
      annotations?: DoubaoUrlCitation[];
    }>;
  }>;
  usage?: unknown;
};

export type DoubaoUrlCitation = {
  type?: string;
  title?: string;
  url?: string;
  summary?: string;
  site_name?: string;
  publish_time?: string;
};

function collectUrlCitations(value: unknown, citations: DoubaoUrlCitation[]) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectUrlCitations(item, citations);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'url_citation' && typeof record.url === 'string' && record.url) {
    citations.push(record as DoubaoUrlCitation);
  }
  for (const child of Object.values(record)) collectUrlCitations(child, citations);
}

export type ProviderError = {
  message: string;
  statusText?: string;
  timeout: boolean;
};

export type DoubaoImageRequest = {
  prompt: string;
  size: string;
  timeoutMs?: number;
};

function envValue(name: string): string {
  return (process.env[name] || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function baseUrl(): string {
  return (envValue('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
}

function apiKey(): string {
  return envValue('ARK_API_KEY');
}

function textModel(): string {
  return envValue('ARK_TEXT_MODEL_ID') || envValue('ARK_MODEL_ID');
}

export function isDoubaoTextConfigured() {
  return Boolean(apiKey() && textModel() && process.env.ARK_ENABLE_TEXT !== 'false');
}

export function isDoubaoImageConfigured() {
  return Boolean(apiKey() && envValue('ARK_IMAGE_MODEL_ID'));
}

export async function fetchPublicHtml(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    timeout: 6000,
    responseType: 'text',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15',
      Accept: 'text/html',
    },
    maxContentLength: 2_000_000,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  return response.data;
}

export async function fetchPublicBinary(
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ bytes: Buffer; contentType?: string }> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: options.timeoutMs ?? 8000,
    headers: options.headers,
  });
  return {
    bytes: Buffer.from(response.data),
    contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined,
  };
}

export async function completeWithDoubao(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<DoubaoCompletionResponse> {
  if (!isDoubaoTextConfigured()) throw new Error('Doubao text provider is not configured');
  const response = await axios.post<DoubaoCompletionResponse>(
    `${baseUrl()}/chat/completions`,
    { ...body, model: textModel() },
    {
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    },
  );
  return response.data;
}

export async function streamChatCompletionWithDoubao(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<NodeJS.ReadableStream> {
  if (!isDoubaoTextConfigured()) throw new Error('Doubao text provider is not configured');
  const response = await axios.post(
    `${baseUrl()}/chat/completions`,
    { ...body, model: textModel(), stream: true },
    {
      timeout: timeoutMs,
      responseType: 'stream',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    },
  );
  return response.data as NodeJS.ReadableStream;
}

export async function createResponseWithDoubao(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<DoubaoResponsesResponse> {
  if (!isDoubaoTextConfigured()) throw new Error('Doubao text provider is not configured');
  const response = await axios.post<DoubaoResponsesResponse>(
    `${baseUrl()}/responses`,
    { ...body, model: textModel() },
    {
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    },
  );
  return response.data;
}

export function readDoubaoResponseText(response: DoubaoResponsesResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text;

  const parts: string[] = [];
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (typeof content.text === 'string') parts.push(content.text);
      else if (typeof content.content === 'string') parts.push(content.content);
    }
  }
  return parts.join('\n').trim();
}

export function readDoubaoUrlCitations(response: DoubaoResponsesResponse): DoubaoUrlCitation[] {
  const citations: DoubaoUrlCitation[] = [];
  collectUrlCitations(response, citations);
  return citations;
}

export async function generateImageWithDoubao(request: DoubaoImageRequest): Promise<string> {
  const model = envValue('ARK_IMAGE_MODEL_ID');
  if (!isDoubaoImageConfigured() || !model) throw new Error('Doubao image provider is not configured');
  const response = await axios.post<{ data?: Array<{ url?: string; b64_json?: string }> }>(
    `${baseUrl()}/images/generations`,
    {
      model,
      prompt: request.prompt,
      size: request.size,
      n: 1,
    },
    {
      timeout: request.timeoutMs ?? Number(process.env.ARK_TIMEOUT_MS || 90_000),
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    },
  );
  const item = response.data?.data?.[0];
  if (item?.url) return item.url;
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  throw new Error('Doubao image provider returned no image data');
}

export function describeProviderError(error: unknown): ProviderError {
  if (axios.isAxiosError(error)) {
    return {
      message: error.message || 'provider request failed',
      statusText: error.response?.statusText,
      timeout: error.code === 'ECONNABORTED' || Boolean(error.message?.includes('timeout')),
    };
  }
  return {
    message: error instanceof Error ? error.message : 'provider request failed',
    timeout: false,
  };
}
