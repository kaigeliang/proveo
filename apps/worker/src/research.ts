import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import {
  runResearchAgent as runSharedResearchAgent,
  type ResearchInput,
  type ResearchOutput,
  type ResearchSearchScope,
} from '@aigc-video-hub/trustloop';

export type { ResearchSearchScope };

type DoubaoCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      references?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
  }>;
};

type DoubaoResponsesResponse = {
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

type DoubaoUrlCitation = {
  type?: string;
  title?: string;
  url?: string;
  summary?: string;
  site_name?: string;
  publish_time?: string;
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

function isDoubaoTextConfigured() {
  return Boolean(apiKey() && textModel() && process.env.ARK_ENABLE_TEXT !== 'false');
}

export async function fetchPublicHtml(url: string, options: { timeoutMs?: number } = {}): Promise<string> {
  const response = await axios.get<string>(url, {
    timeout: Math.min(Math.max(options.timeoutMs || 6000, 1000), 8000),
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

async function completeWithDoubao(body: Record<string, unknown>, timeoutMs: number): Promise<DoubaoCompletionResponse> {
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

async function createResponseWithDoubao(
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

function readDoubaoResponseText(response: DoubaoResponsesResponse): string {
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

function readDoubaoUrlCitations(response: DoubaoResponsesResponse): DoubaoUrlCitation[] {
  const citations: DoubaoUrlCitation[] = [];
  collectUrlCitations(response, citations);
  return citations;
}

function describeProviderError(error: unknown) {
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

function webSearchEnabled(): boolean {
  const value = (process.env.TRUSTLOOP_WEB_SEARCH || 'true').trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}

export async function runResearchAgent(input: ResearchInput & { noCache?: boolean }): Promise<ResearchOutput> {
  return runSharedResearchAgent(input, {
    fetchPublicHtml,
    completeText: completeWithDoubao,
    createResponse: createResponseWithDoubao,
    isTextConfigured: isDoubaoTextConfigured,
    describeProviderError,
    readResponseText: readDoubaoResponseText,
    readUrlCitations: readDoubaoUrlCitations,
    ensureLocalDir: (folder) => fs.mkdirSync(folder, { recursive: true }),
    localPathExists: (filePath) => fs.existsSync(filePath),
    readLocalText: (filePath) => fs.readFileSync(filePath, 'utf-8'),
    statLocalPath: (filePath) => fs.statSync(filePath),
    writeLocalText: (filePath, data) => fs.writeFileSync(filePath, data, 'utf-8'),
    cacheRoot: path.resolve(process.cwd(), 'apps/api/var/research-cache'),
    fixtureRoot: path.resolve(process.cwd(), 'scripts/fixtures'),
    webSearchEnabled,
    createId: () => randomUUID(),
  });
}
