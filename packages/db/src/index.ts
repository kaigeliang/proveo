import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;

export function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

export async function disconnectPrisma() {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = undefined;
}

export type ProductionTaskType = 'script' | 'video' | 'compose' | 'slice' | 'angle' | 'index' | 'trend' | 'agent';
export type ProductionTaskStatus = 'pending' | 'processing' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
export type AgentRunKind = 'one_click_video' | 'script_generate' | 'render_full' | 'repair_shot' | 'ab_test';
export type AgentRunStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
export type AgentStepStatus = 'queued' | 'running' | 'skipped' | 'completed' | 'failed';
export type AgentToolCallStatus = 'running' | 'completed' | 'failed';

export type CreateTaskInput = {
  id: string;
  type: ProductionTaskType;
  payload?: Record<string, unknown>;
  step?: string;
  status?: ProductionTaskStatus;
  progress?: number;
  message?: string;
};

export type UpdateTaskInput = {
  status?: ProductionTaskStatus;
  progress?: number;
  step?: string;
  error?: string | null;
  payload?: Record<string, unknown>;
  trace?: {
    step: string;
    progress: number;
    message: string;
    data?: Record<string, unknown>;
  };
};

export type CreateAgentRunInput = {
  id: string;
  taskId?: string;
  kind: AgentRunKind;
  status?: AgentRunStatus;
  graphVersion: string;
  productId?: string;
  scriptId?: string;
  videoId?: string;
  input: Record<string, unknown>;
};

export type UpdateAgentRunInput = {
  status?: AgentRunStatus;
  graphVersion?: string;
  productId?: string | null;
  scriptId?: string | null;
  videoId?: string | null;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: string | null;
};

export type CreateAgentStepInput = {
  id: string;
  runId: string;
  nodeId: string;
  agentName: string;
  status?: AgentStepStatus;
  attempt?: number;
  inputRefs?: string[];
  outputRefs?: string[];
  decision?: string;
  reason?: string;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
};

export type UpdateAgentStepInput = {
  status?: AgentStepStatus;
  attempt?: number;
  inputRefs?: string[];
  outputRefs?: string[];
  decision?: string | null;
  reason?: string | null;
  error?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

export type CreateAgentArtifactInput = {
  id: string;
  runId: string;
  stepId?: string;
  type: string;
  content?: Record<string, unknown>;
  objectKey?: string;
  contentHash?: string;
};

export type CreateAgentToolCallInput = {
  id: string;
  runId: string;
  stepId: string;
  toolName: string;
  status: AgentToolCallStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  latencyMs?: number;
  costEstimate?: number;
  error?: string;
};

export type ProductionMaterialInput = {
  id: string;
  productId?: string;
  name?: string;
  type: 'image' | 'video';
  sourceUrl: string;
  sourceObjectKey?: string;
  sourceDeclaration: string;
  uploadedAt?: Date;
};

export type ProductionSliceInput = {
  id: string;
  materialId: string;
  thumbnailUrl: string;
  thumbnailObjectKey?: string;
  clipUrl: string;
  clipObjectKey?: string;
  startTime: number;
  endTime: number;
  tags: Record<string, string[]>;
  summary: string;
  embedding?: number[];
};

export type ProductionMaterialAngleInput = {
  id: string;
  materialId: string;
  productId?: string;
  view: string;
  key: string;
  label: string;
  imageUrl: string;
  referenceImageUrl: string;
  previewUrl?: string;
  sourceImageUrl: string;
  promptHint: string;
  pose?: Record<string, unknown>;
  provider: string;
  status: string;
  note?: string;
  createdAt?: Date;
};

export type ProductionVideoAssetInput = {
  id: string;
  productId?: string;
  sourceUrl: string;
  sourceObjectKey?: string;
  sourceDeclaration: string;
  title?: string;
  platform?: string;
  durationMs?: number;
  contentHash?: string;
};

export type ProductionVideoSegmentInput = {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  transcript?: string;
  visualSummary: string;
  thumbnailUrl?: string;
  clipUrl?: string;
  contentHash?: string;
};

export type ProductionVideoTagInput = {
  namespace: string;
  name: string;
  normalizedName?: string;
  description?: string;
};

export type ProductionVideoTagAssignmentInput = {
  segmentId: string;
  tagId: string;
  confidence?: number;
  source: string;
  modelVersion?: string;
  evidence?: Record<string, unknown>;
};

export type ProductionEmbeddingVectorInput = {
  ownerType: string;
  ownerId: string;
  segmentId?: string;
  embeddingModel: string;
  dims: number;
  vector?: number[];
  quantizedObject?: string;
  vectorHash?: string;
  metadata?: Record<string, unknown>;
};

export type ProductionEmbeddingVersionInput = {
  id: string;
  modelId: string;
  dims: number;
  quantization: string;
  vectorStore: string;
  promptPolicy?: Record<string, unknown>;
  isActive?: boolean;
  lastRebuiltAt?: Date;
};

export type ProductionRetrievalJobInput = {
  id: string;
  source: string;
  status: string;
  cursor?: string;
  filters?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  error?: string | null;
  scheduledFor?: Date;
  startedAt?: Date;
  finishedAt?: Date;
};

export type ProductionTrendSourceInput = {
  id: string;
  platform: string;
  name: string;
  url?: string;
  enabled?: boolean;
  refreshCron?: string;
  config?: Record<string, unknown>;
};

export type ProductionTrendItemInput = {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  url?: string;
  tags: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  embeddingId?: string;
  fetchedAt: Date;
};

export type TrendItemListFilters = {
  platform?: string;
  sourceId?: string;
  category?: string;
  tag?: string;
  q?: string;
  limit?: number;
};

export type TrendRefreshInput = {
  taskId?: string;
  source?: string;
  productId?: string;
  maxItems?: number;
  now?: Date;
};

export type CompactRetrievalReindexInput = {
  taskId?: string;
  reason?: string;
  maxItems?: number;
  now?: Date;
};

export type PgVectorSearchInput = {
  query: string;
  limit?: number;
  ownerType?: string;
  productId?: string;
  platform?: string;
  category?: string;
  tag?: string;
  tags?: string[];
};

export type PgVectorSearchHit = {
  ownerType: string;
  ownerId: string;
  embeddingModel: string;
  score: number;
  metadata?: unknown;
  trend?: {
    id: string;
    title: string;
    sourceId: string;
    platform?: string;
    url?: string;
    tags: unknown;
    metrics?: unknown;
    fetchedAt: Date;
  };
};

export type ReferenceVectorSearchInput = {
  queryVector: number[];
  embeddingModel?: string;
  limit?: number;
  category?: string;
  dataset?: string;
  trafficType?: string;
  winnerType?: 'organic' | 'paid' | 'lowFollower';
  q?: string;
};

export type ReferenceVectorSearchHit = {
  id: string;
  sourceUrl: string;
  localVideoUrl?: string | null;
  sourceDeclaration: string;
  licenseType?: string | null;
  usageScope?: string | null;
  breakdownReport: unknown;
  embeddingModel: string;
  score: number;
  vectorScore: number;
  metadata: unknown;
};

export type ProductionFactor = {
  type: string;
  value: string;
  sourceStrategy: string;
};

export type ProductionShotInput = {
  id: string;
  order: number;
  duration: number;
  visualDesc: string;
  camera: string;
  narration: string;
  subtitle: string;
  materialRef?: string;
  transition?: 'hard_cut' | 'fade' | 'whip';
  factors: ProductionFactor[];
  status: 'draft' | 'generating' | 'done' | 'failed';
  assetUrl?: string;
  assetObjectKey?: string;
  claimIds?: string[];
  evidenceIds?: string[];
};

export type ProductionScriptInput = {
  id: string;
  productId: string;
  generationProfile?: 'quick_preview' | 'trusted_publish';
  productUrl?: string;
  referenceImageUrl?: string;
  materialIds?: string[];
  sourceMode: 'imitate' | 'template' | 'auto';
  sourceRef?: string;
  narrative: string;
  visualStyle: string;
  bgm: string;
  aspectRatio: '9:16' | '16:9';
  language: string;
  constraints: string[];
  shots: ProductionShotInput[];
};

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}

function normalizeTagName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

export const REFERENCE_TEXT_EMBEDDING_MODEL = 'jinaai/jina-clip-v2';
export const VECTOR_TEXT_EMBEDDING_MODEL = REFERENCE_TEXT_EMBEDDING_MODEL;
export const VECTOR_TEXT_EMBEDDING_DIMS = 1024;
const VECTOR_TEXT_EMBEDDING_VERSION_ID = 'qdrant-jina-clip-v2-v1';
const TEXT_MAX_TOKENS = Number(process.env.CLIP_TEXT_MAX_TOKENS || 512);

type TensorLike = { data: ArrayLike<number> };
type CallableEmbeddingModel = (inputs: Record<string, unknown>) => Promise<{ l2norm_text_embeddings?: TensorLike }>;
type EmbeddingProcessor = (
  text?: string[] | string | null,
  images?: unknown[] | unknown | null,
  options?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type TransformersRuntime = {
  AutoModel: {
    from_pretrained(modelId: string, options: Record<string, unknown>): Promise<CallableEmbeddingModel>;
  };
  AutoProcessor: { from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<EmbeddingProcessor> };
  env: { cacheDir?: string; allowRemoteModels?: boolean };
};
type OptionalImport = (specifier: string) => Promise<unknown>;
const optionalImport = new Function('specifier', 'return import(specifier)') as OptionalImport;

let embeddingRuntime: TransformersRuntime | null = null;
let embeddingModel: CallableEmbeddingModel | null = null;
let embeddingProcessor: EmbeddingProcessor | null = null;
let embeddingReady = false;
let embeddingLoadError: string | null = null;
let embeddingLoadPromise: Promise<boolean> | null = null;

type PgVectorEnsureResult = {
  enabled: boolean;
  reason?: string;
  dims: number;
  tableReady?: boolean;
  hnswReady?: boolean;
};

type QdrantEnsureResult = {
  enabled: boolean;
  reason?: string;
  url: string;
  collection: string;
  dims: number;
  ready?: boolean;
  points?: number;
};

type TrendSeedItem = {
  externalId: string;
  title: string;
  url?: string;
  sourceId?: string;
  platform?: string;
  category: string;
  product: string;
  tags: string[];
  metrics?: Record<string, unknown>;
};

type TrendEnrichmentDetails = {
  category?: string;
  product?: string;
  audience?: string[];
  painPoints?: string[];
  sellingPoints?: string[];
  videoAngles?: string[];
  searchTags?: string[];
  riskNotes?: string[];
};

type TrendPreparedSeed = {
  id: string;
  source: ReturnType<typeof trendSourceForSeed>;
  seed: TrendSeedItem;
  rank: number;
  baseTags: ReturnType<typeof trendTags>;
  baseMetrics: ReturnType<typeof trendMetrics>;
};

type TrendEnrichmentDecision = {
  provider: 'local' | 'doubao';
  status: 'disabled' | 'local' | 'skipped' | 'reused' | 'enriched' | 'failed';
  details?: TrendEnrichmentDetails;
  model?: string;
  enrichedAt?: string;
  reason?: string;
};

const DEFAULT_TREND_SOURCE = {
  id: 'local-hot-products',
  platform: 'local',
  name: '本地热门商品种子',
  url: 'local://trend-seeds',
  refreshCron: 'every_60m',
};

const DEFAULT_TREND_ITEMS: TrendSeedItem[] = [
  {
    externalId: 'portable-projector-creator-proof',
    title: '便携投影仪 露营/卧室场景实拍卖点',
    category: '数码电子',
    product: '便携投影仪',
    tags: ['露营', '卧室', '大屏', '开箱', '场景证明', '对比展示'],
    metrics: { baseHeat: 86, views: 420000, saves: 13200, velocity: 0.88 },
  },
  {
    externalId: 'open-ear-earbuds-commute',
    title: '开放式耳机 通勤佩戴与漏音对比',
    category: '数码电子',
    product: '开放式耳机',
    tags: ['通勤', '佩戴舒适', '防漏音', '测评', '真人出镜'],
    metrics: { baseHeat: 82, views: 360000, saves: 9800, velocity: 0.81 },
  },
  {
    externalId: 'magnetic-phone-stand-live',
    title: '磁吸手机支架 直播/做饭/桌面三场景',
    category: '数码电子',
    product: '手机支架',
    tags: ['直播', '厨房', '桌面', '多场景', '痛点解决'],
    metrics: { baseHeat: 78, views: 260000, saves: 7100, velocity: 0.76 },
  },
  {
    externalId: 'barrier-repair-serum-sensitive',
    title: '修护精华 敏感肌屏障修复前后对比',
    category: '美妆护肤',
    product: '修护精华',
    tags: ['敏感肌', '屏障修护', '前后对比', '成分讲解', '近景质地'],
    metrics: { baseHeat: 88, views: 510000, saves: 18400, velocity: 0.9 },
  },
  {
    externalId: 'sunscreen-cushion-outdoor',
    title: '防晒气垫 户外补妆与清爽肤感展示',
    category: '美妆护肤',
    product: '防晒气垫',
    tags: ['防晒', '补妆', '户外', '妆效', '真人试用'],
    metrics: { baseHeat: 79, views: 300000, saves: 8900, velocity: 0.72 },
  },
  {
    externalId: 'pet-auto-feeder-office',
    title: '宠物自动喂食器 上班族远程投喂场景',
    category: '家居家电',
    product: '宠物喂食器',
    tags: ['宠物', '远程控制', '上班族', '安全感', '场景演示'],
    metrics: { baseHeat: 85, views: 460000, saves: 15100, velocity: 0.84 },
  },
  {
    externalId: 'mini-humidifier-desk',
    title: '桌面加湿器 办公桌静音与氛围灯展示',
    category: '家居家电',
    product: '桌面加湿器',
    tags: ['办公桌', '静音', '氛围灯', '小空间', '功能演示'],
    metrics: { baseHeat: 74, views: 210000, saves: 6100, velocity: 0.67 },
  },
  {
    externalId: 'air-fryer-liner-cleaning',
    title: '空气炸锅纸 清洁前后强对比短视频',
    category: '食品饮料',
    product: '空气炸锅纸',
    tags: ['厨房清洁', '省事', '前后对比', '低客单', '强痛点'],
    metrics: { baseHeat: 83, views: 390000, saves: 12600, velocity: 0.86 },
  },
  {
    externalId: 'protein-snack-office',
    title: '高蛋白零食 办公室控卡代餐场景',
    category: '食品饮料',
    product: '高蛋白零食',
    tags: ['控卡', '办公室', '代餐', '成分表', '口感测评'],
    metrics: { baseHeat: 76, views: 240000, saves: 7400, velocity: 0.7 },
  },
  {
    externalId: 'sun-protection-jacket-commute',
    title: '防晒衣 通勤骑行与轻薄收纳展示',
    category: '服装服饰',
    product: '防晒衣',
    tags: ['通勤', '骑行', '轻薄', '防晒', '穿搭'],
    metrics: { baseHeat: 80, views: 330000, saves: 10200, velocity: 0.78 },
  },
  {
    externalId: 'storage-bag-travel',
    title: '旅行收纳包 行李箱空间压缩对比',
    category: '服装服饰',
    product: '旅行收纳包',
    tags: ['旅行', '收纳', '空间压缩', '对比展示', '低客单'],
    metrics: { baseHeat: 77, views: 280000, saves: 11700, velocity: 0.74 },
  },
  {
    externalId: 'mini-label-printer-study',
    title: '迷你标签打印机 学习/收纳/办公分类',
    category: '文具办公',
    product: '标签打印机',
    tags: ['学习', '收纳', '办公', '分类', '效率工具'],
    metrics: { baseHeat: 81, views: 350000, saves: 14100, velocity: 0.82 },
  },
];

const TREND_TAXONOMY_VERSION = 'trend-taxonomy.v2';

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function shortHash(value: string, length = 12) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function compactTextForEmbedding(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function embeddingTokens(text: string) {
  const normalized = compactTextForEmbedding(text).toLowerCase();
  const tokens = new Set<string>();
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2) tokens.add(token);
  }
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = [...match[0]];
    for (const char of chars) tokens.add(char);
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return [...tokens];
}

function repoRootFromCwd() {
  const cwd = process.cwd();
  if (path.basename(path.dirname(cwd)) === 'apps' || path.basename(path.dirname(cwd)) === 'packages') {
    return path.dirname(path.dirname(cwd));
  }
  return cwd;
}

function clipCacheCandidates() {
  const configured = process.env.CLIP_CACHE_DIR?.trim();
  const repoRoot = repoRootFromCwd();
  return [
    configured ? (path.isAbsolute(configured) ? configured : path.join(repoRoot, configured)) : undefined,
    path.join(repoRoot, 'apps/api/.cache/hf'),
    path.join(repoRoot, '.cache/hf'),
    path.join(process.cwd(), '.cache/hf'),
  ].filter((item): item is string => Boolean(item));
}

function hasCompleteClipCache(cacheDir: string) {
  const modelDir = path.join(cacheDir, VECTOR_TEXT_EMBEDDING_MODEL);
  return [
    'config.json',
    'preprocessor_config.json',
    'tokenizer_config.json',
    'tokenizer.json',
    'onnx/model_quantized.onnx',
  ].every((file) => fs.existsSync(path.join(modelDir, file)));
}

function resolveClipCacheDir() {
  const candidates = [...new Set(clipCacheCandidates())];
  return candidates.find(hasCompleteClipCache) || candidates[0] || path.join(repoRootFromCwd(), '.cache/hf');
}

async function loadEmbeddingRuntime(): Promise<TransformersRuntime | null> {
  if (embeddingRuntime) return embeddingRuntime;
  try {
    embeddingRuntime = (await optionalImport('@huggingface/transformers')) as TransformersRuntime;
    embeddingRuntime.env.cacheDir = resolveClipCacheDir();
    embeddingRuntime.env.allowRemoteModels = !envBool(
      'CLIP_LOCAL_FILES_ONLY',
      hasCompleteClipCache(embeddingRuntime.env.cacheDir),
    );
    return embeddingRuntime;
  } catch (error) {
    embeddingLoadError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function loadEmbeddingModel() {
  if (embeddingReady) return true;
  if (embeddingLoadError) return false;
  const runtime = await loadEmbeddingRuntime();
  if (!runtime) return false;
  try {
    const cacheDir = resolveClipCacheDir();
    const localFilesOnly = envBool('CLIP_LOCAL_FILES_ONLY', hasCompleteClipCache(cacheDir));
    runtime.env.cacheDir = cacheDir;
    runtime.env.allowRemoteModels = !localFilesOnly;
    [embeddingModel, embeddingProcessor] = await Promise.all([
      runtime.AutoModel.from_pretrained(VECTOR_TEXT_EMBEDDING_MODEL, {
        dtype: 'q8',
        cache_dir: cacheDir,
        local_files_only: localFilesOnly,
      }),
      runtime.AutoProcessor.from_pretrained(VECTOR_TEXT_EMBEDDING_MODEL, {
        cache_dir: cacheDir,
        local_files_only: localFilesOnly,
      }),
    ]);
    embeddingReady = true;
    return true;
  } catch (error) {
    embeddingLoadError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function ensureEmbeddingModel() {
  if (!embeddingLoadPromise) embeddingLoadPromise = loadEmbeddingModel();
  return embeddingLoadPromise;
}

function l2normalize(data: ArrayLike<number>) {
  const values = Array.from(data);
  const norm = Math.sqrt(values.reduce((sum, item) => sum + item * item, 0));
  return norm > 0 ? values.map((item) => item / norm) : values;
}

async function embedTextForVectorStore(text: string) {
  if (!(await ensureEmbeddingModel())) {
    throw new Error(`${VECTOR_TEXT_EMBEDDING_MODEL} is unavailable: ${embeddingLoadError || 'model was not loaded'}`);
  }
  const normalized = compactTextForEmbedding(text);
  const inputs = await embeddingProcessor!([normalized], null, {
    padding: true,
    truncation: true,
    max_length: TEXT_MAX_TOKENS,
  });
  const output = await embeddingModel!(inputs);
  if (!output.l2norm_text_embeddings?.data?.length) {
    throw new Error(`${VECTOR_TEXT_EMBEDDING_MODEL} text embedding missing from model output`);
  }
  const vector = l2normalize(output.l2norm_text_embeddings.data);
  if (vector.length !== VECTOR_TEXT_EMBEDDING_DIMS) {
    throw new Error(
      `${VECTOR_TEXT_EMBEDDING_MODEL} returned ${vector.length} dims; expected ${VECTOR_TEXT_EMBEDDING_DIMS}`,
    );
  }
  return vector.map((item) => Number(item.toFixed(8)));
}

function uniqueStringValues(values: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function firstString(value: unknown) {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) return value.find((item) => typeof item === 'string' && item.trim()) as string | undefined;
  return undefined;
}

function flattenJsonStrings(value: unknown, limit = 80): string[] {
  const output: string[] = [];
  const visit = (input: unknown) => {
    if (output.length >= limit) return;
    if (typeof input === 'string') {
      output.push(input);
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }
    if (input && typeof input === 'object') {
      for (const item of Object.values(input as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return uniqueStringValues(output).slice(0, limit);
}

function envValue(name: string) {
  return (process.env[name] || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function envBool(name: string, fallback: boolean) {
  const value = envValue(name).toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function arkBaseUrl() {
  return (envValue('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
}

function arkTextModel() {
  return envValue('ARK_TEXT_MODEL_ID') || envValue('ARK_MODEL_ID');
}

function doubaoTrendConfigured() {
  return Boolean(envValue('ARK_API_KEY') && arkTextModel() && process.env.ARK_ENABLE_TEXT !== 'false');
}

function trendEnrichmentProvider() {
  const provider = envValue('TREND_ENRICH_PROVIDER').toLowerCase() || 'auto';
  return ['auto', 'local', 'doubao'].includes(provider) ? provider : 'auto';
}

function trendEnrichmentMaxItems() {
  const value = Number(process.env.TREND_ENRICH_MAX_ITEMS || 12);
  return Number.isFinite(value) ? clampNumber(Math.floor(value), 0, 100) : 12;
}

function trendEnrichmentTtlHours() {
  const value = Number(process.env.TREND_ENRICH_TTL_HOURS || 168);
  return Number.isFinite(value) ? clampNumber(Math.floor(value), 1, 24 * 30) : 168;
}

function trendEnrichmentTimeoutMs() {
  const value = Number(
    process.env.TREND_ENRICH_TIMEOUT_MS || Math.min(Number(process.env.ARK_TIMEOUT_MS || 90000), 45000),
  );
  return Number.isFinite(value) ? clampNumber(Math.floor(value), 3000, 60000) : 45000;
}

function trendEnrichmentBatchSize() {
  const value = Number(process.env.TREND_ENRICH_BATCH_SIZE || 4);
  return Number.isFinite(value) ? clampNumber(Math.floor(value), 1, 24) : 4;
}

function trendEnrichmentEnabled() {
  return (
    envBool('TREND_ENRICH_ENABLED', true) && trendEnrichmentProvider() !== 'local' && trendEnrichmentMaxItems() > 0
  );
}

export function getTrendEnrichmentStatus() {
  return {
    enabled: trendEnrichmentEnabled(),
    provider: trendEnrichmentProvider(),
    doubaoConfigured: doubaoTrendConfigured(),
    maxItems: trendEnrichmentMaxItems(),
    batchSize: trendEnrichmentBatchSize(),
    ttlHours: trendEnrichmentTtlHours(),
    timeoutMs: trendEnrichmentTimeoutMs(),
    taxonomyVersion: TREND_TAXONOMY_VERSION,
  };
}

function shortText(value: unknown, max = 48) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function shortStringArray(value: unknown, maxItems = 8, maxChars = 48) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[，,、\n]/u) : [];
  return uniqueStringValues(values.map((item) => shortText(item, maxChars))).slice(0, maxItems);
}

function sanitizeTrendEnrichmentDetails(value: unknown): TrendEnrichmentDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const details: TrendEnrichmentDetails = {
    category: shortText(row.category, 32),
    product: shortText(row.product, 40),
    audience: shortStringArray(row.audience, 6, 32),
    painPoints: shortStringArray(row.painPoints || row.painPoint, 8, 40),
    sellingPoints: shortStringArray(row.sellingPoints || row.sellingPoint, 8, 40),
    videoAngles: shortStringArray(row.videoAngles || row.videoAngle, 8, 48),
    searchTags: shortStringArray(row.searchTags || row.search || row.tags, 12, 32),
    riskNotes: shortStringArray(row.riskNotes || row.risk, 5, 48),
  };
  const hasAny = Object.values(details).some((item) => (Array.isArray(item) ? item.length > 0 : Boolean(item)));
  return hasAny ? details : undefined;
}

function parseJsonObjectText(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/u);
    if (!match) throw new Error('json_object_missing');
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function pgVectorProviderEnabled() {
  const provider = (process.env.VECTOR_STORE_PROVIDER || 'auto').trim().toLowerCase();
  const enabled = !['0', 'false', 'no', 'off'].includes((process.env.PGVECTOR_ENABLED || 'true').trim().toLowerCase());
  return enabled && (provider === 'auto' || provider === 'pgvector');
}

function pgVectorDims() {
  const value = Number(process.env.PGVECTOR_DIMS || VECTOR_TEXT_EMBEDDING_DIMS);
  return Number.isFinite(value) ? clampNumber(Math.floor(value), 16, 4096) : VECTOR_TEXT_EMBEDDING_DIMS;
}

function vectorSqlLiteral(vector: number[], dims = pgVectorDims()) {
  const padded = Array.from({ length: dims }, (_, index) => Number(vector[index] || 0));
  const norm = Math.sqrt(padded.reduce((sum, item) => sum + item * item, 0));
  return `[${padded.map((item) => Number(((norm > 0 ? item / norm : item) || 0).toFixed(6))).join(',')}]`;
}

function normalizedVector(value: number[]) {
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  return norm > 0 ? value.map((item) => item / norm) : value;
}

function cosineSimilarity(left: number[], right: number[]) {
  const len = Math.min(left.length, right.length);
  if (!len) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < len; index += 1) {
    const l = Number(left[index] || 0);
    const r = Number(right[index] || 0);
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

function numberArrayFromJson(value: unknown) {
  return Array.isArray(value) ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function jsonText(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function jsonNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseVectorMetadata(value: unknown) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

async function pgVectorExtensionAvailable() {
  if (!pgVectorProviderEnabled()) return { available: false, installed: false, reason: 'disabled' };
  const rows = await getPrisma().$queryRawUnsafe<Array<{ available: boolean; installed: boolean }>>(
    `SELECT
      EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed`,
  );
  const row = rows[0];
  if (!row?.available) return { available: false, installed: false, reason: 'extension_unavailable' };
  return { available: true, installed: Boolean(row.installed) };
}

export async function ensurePgVectorStore(): Promise<PgVectorEnsureResult> {
  const dims = pgVectorDims();
  const extension = await pgVectorExtensionAvailable();
  if (!extension.available) return { enabled: false, reason: extension.reason || 'extension_unavailable', dims };

  const client = getPrisma();
  await client.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EmbeddingVectorPgvector" (
      "id" TEXT PRIMARY KEY,
      "ownerType" TEXT NOT NULL,
      "ownerId" TEXT NOT NULL,
      "embeddingModel" TEXT NOT NULL,
      "dims" INTEGER NOT NULL,
      "vector" vector(${dims}) NOT NULL,
      "metadata" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "EmbeddingVectorPgvector_owner_unique" UNIQUE ("ownerType", "ownerId", "embeddingModel")
    )
  `);
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "EmbeddingVectorPgvector_owner_idx" ON "EmbeddingVectorPgvector"("ownerType", "ownerId")`,
  );
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "EmbeddingVectorPgvector_model_idx" ON "EmbeddingVectorPgvector"("embeddingModel")`,
  );
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "EmbeddingVectorPgvector_metadata_gin_idx" ON "EmbeddingVectorPgvector" USING GIN ("metadata")`,
  );

  let hnswReady = true;
  try {
    const m = clampNumber(Number(process.env.PGVECTOR_HNSW_M || 16), 4, 64);
    const efConstruction = clampNumber(Number(process.env.PGVECTOR_HNSW_EF_CONSTRUCTION || 64), 8, 512);
    await client.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "EmbeddingVectorPgvector_vector_hnsw_idx"
      ON "EmbeddingVectorPgvector"
      USING hnsw ("vector" vector_cosine_ops)
      WITH (m = ${m}, ef_construction = ${efConstruction})
    `);
  } catch {
    hnswReady = false;
  }

  return { enabled: true, dims, tableReady: true, hnswReady };
}

export async function getPgVectorStoreStatus() {
  const dims = pgVectorDims();
  const extension = await pgVectorExtensionAvailable();
  if (!extension.available) {
    return {
      enabled: false,
      available: false,
      installed: false,
      reason: extension.reason || 'extension_unavailable',
      dims,
      rows: 0,
    };
  }
  const tableRows = await getPrisma().$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public."EmbeddingVectorPgvector"') IS NOT NULL AS exists`,
  );
  const tableReady = Boolean(tableRows[0]?.exists);
  const countRows = tableReady
    ? await getPrisma().$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM "EmbeddingVectorPgvector"`,
      )
    : [{ count: BigInt(0) }];
  const hnswRows = tableReady
    ? await getPrisma().$queryRawUnsafe<Array<{ exists: boolean }>>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'EmbeddingVectorPgvector_vector_hnsw_idx'
        ) AS exists`,
      )
    : [{ exists: false }];
  return {
    enabled: pgVectorProviderEnabled(),
    available: true,
    installed: extension.installed,
    tableReady,
    hnswReady: Boolean(hnswRows[0]?.exists),
    dims,
    rows: Number(countRows[0]?.count || 0),
    distance: 'cosine',
    index: 'hnsw/vector_cosine_ops',
  };
}

export async function upsertPgVectorEmbedding(
  input: {
    ownerType: string;
    ownerId: string;
    embeddingModel?: string;
    vector: number[];
    metadata?: Record<string, unknown>;
  },
  store?: PgVectorEnsureResult,
) {
  const ensured = store || (await ensurePgVectorStore());
  if (!ensured.enabled) return { ok: false, ...ensured };
  const embeddingModel = input.embeddingModel || VECTOR_TEXT_EMBEDDING_MODEL;
  const id = `pgv_${shortHash(`${input.ownerType}:${input.ownerId}:${embeddingModel}`, 24)}`;
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "EmbeddingVectorPgvector"
      ("id", "ownerType", "ownerId", "embeddingModel", "dims", "vector", "metadata")
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
     ON CONFLICT ("ownerType", "ownerId", "embeddingModel")
     DO UPDATE SET
       "dims" = EXCLUDED."dims",
       "vector" = EXCLUDED."vector",
       "metadata" = EXCLUDED."metadata",
       "updatedAt" = CURRENT_TIMESTAMP`,
    id,
    input.ownerType,
    input.ownerId,
    embeddingModel,
    ensured.dims,
    vectorSqlLiteral(input.vector, ensured.dims),
    JSON.stringify(input.metadata || {}),
  );
  return { ok: true, enabled: true, id, dims: ensured.dims };
}

function qdrantProviderEnabled() {
  const provider = (process.env.VECTOR_STORE_PROVIDER || 'qdrant').trim().toLowerCase();
  const enabled = !['0', 'false', 'no', 'off'].includes((process.env.QDRANT_ENABLED || 'true').trim().toLowerCase());
  return enabled && (provider === 'auto' || provider === 'qdrant');
}

function qdrantUrl() {
  return (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
}

function qdrantCollection() {
  return (process.env.QDRANT_COLLECTION || 'aigc_video_clip_vectors').trim() || 'aigc_video_clip_vectors';
}

function qdrantDims() {
  const value = Number(process.env.QDRANT_DIMS || VECTOR_TEXT_EMBEDDING_DIMS);
  return Number.isFinite(value) ? clampNumber(Math.floor(value), 16, 4096) : VECTOR_TEXT_EMBEDDING_DIMS;
}

function qdrantDistance() {
  const value = (process.env.QDRANT_DISTANCE || 'Cosine').trim();
  return ['Cosine', 'Dot', 'Euclid', 'Manhattan'].includes(value) ? value : 'Cosine';
}

function qdrantHeaders() {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  if (apiKey) headers['api-key'] = apiKey;
  return headers;
}

async function qdrantRequest<T>(
  pathName: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data?: T }> {
  const timeoutMs = clampNumber(Number(process.env.QDRANT_TIMEOUT_MS || 5000), 1000, 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${qdrantUrl()}${pathName}`, {
      ...options,
      headers: { ...qdrantHeaders(), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : undefined;
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function qdrantPointId(ownerType: string, ownerId: string, embeddingModel = VECTOR_TEXT_EMBEDDING_MODEL) {
  const hex = createHash('sha256').update(`${ownerType}:${ownerId}:${embeddingModel}`).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeVectorForStore(vector: number[], dims: number) {
  const padded = Array.from({ length: dims }, (_, index) => Number(vector[index] || 0));
  const norm = Math.sqrt(padded.reduce((sum, item) => sum + item * item, 0));
  return padded.map((item) => Number((norm > 0 ? item / norm : item).toFixed(6)));
}

function qdrantPayload(input: {
  ownerType: string;
  ownerId: string;
  embeddingModel: string;
  metadata?: Record<string, unknown>;
}) {
  const metadata = input.metadata || {};
  const tags = flattenJsonStrings(metadata.tags || metadata);
  return {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    embeddingModel: input.embeddingModel,
    title: typeof metadata.title === 'string' ? metadata.title : undefined,
    sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : undefined,
    platform: typeof metadata.platform === 'string' ? metadata.platform : undefined,
    category: typeof metadata.category === 'string' ? metadata.category : undefined,
    tags,
    metadata,
  };
}

export async function ensureQdrantStore(): Promise<QdrantEnsureResult> {
  const url = qdrantUrl();
  const collection = qdrantCollection();
  const dims = qdrantDims();
  if (!qdrantProviderEnabled()) return { enabled: false, reason: 'disabled', url, collection, dims };

  const existing = await qdrantRequest<{
    result?: { points_count?: number; config?: { params?: { vectors?: { size?: number } } } };
  }>(`/collections/${encodeURIComponent(collection)}`);
  if (existing.ok) {
    const actualDims = Number(existing.data?.result?.config?.params?.vectors?.size || dims);
    if (actualDims !== dims) {
      return {
        enabled: false,
        reason: `dimension_mismatch_${actualDims}_expected_${dims}`,
        url,
        collection,
        dims,
        points: Number(existing.data?.result?.points_count || 0),
      };
    }
    return {
      enabled: true,
      url,
      collection,
      dims,
      ready: true,
      points: Number(existing.data?.result?.points_count || 0),
    };
  }
  if (existing.status !== 404) {
    return {
      enabled: false,
      reason: existing.status ? `http_${existing.status}` : 'unreachable',
      url,
      collection,
      dims,
    };
  }

  const created = await qdrantRequest(`/collections/${encodeURIComponent(collection)}`, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: { size: dims, distance: qdrantDistance() },
      hnsw_config: {
        m: clampNumber(Number(process.env.QDRANT_HNSW_M || 16), 4, 128),
        ef_construct: clampNumber(Number(process.env.QDRANT_HNSW_EF_CONSTRUCT || 100), 8, 1024),
      },
      optimizers_config: {
        default_segment_number: clampNumber(Number(process.env.QDRANT_DEFAULT_SEGMENTS || 2), 1, 32),
      },
    }),
  });
  if (!created.ok) {
    return {
      enabled: false,
      reason: created.status ? `create_http_${created.status}` : 'create_failed',
      url,
      collection,
      dims,
    };
  }
  return { enabled: true, url, collection, dims, ready: true, points: 0 };
}

export async function getQdrantStoreStatus() {
  const url = qdrantUrl();
  const collection = qdrantCollection();
  const dims = qdrantDims();
  if (!qdrantProviderEnabled()) {
    return { enabled: false, available: false, reason: 'disabled', url, collection, dims, points: 0 };
  }
  const response = await qdrantRequest<{
    result?: {
      points_count?: number;
      indexed_vectors_count?: number;
      status?: string;
      config?: { params?: { vectors?: { size?: number; distance?: string } } };
    };
  }>(`/collections/${encodeURIComponent(collection)}`);
  if (!response.ok) {
    return {
      enabled: true,
      available: false,
      reason:
        response.status === 404 ? 'collection_missing' : response.status ? `http_${response.status}` : 'unreachable',
      url,
      collection,
      dims,
      points: 0,
    };
  }
  const actualDims = Number(response.data?.result?.config?.params?.vectors?.size || dims);
  return {
    enabled: true,
    available: actualDims === dims,
    ready: actualDims === dims,
    reason: actualDims === dims ? undefined : `dimension_mismatch_${actualDims}_expected_${dims}`,
    url,
    collection,
    dims,
    actualDims,
    distance: response.data?.result?.config?.params?.vectors?.distance || qdrantDistance(),
    points: Number(response.data?.result?.points_count || 0),
    indexedVectors: Number(response.data?.result?.indexed_vectors_count || 0),
    status: response.data?.result?.status,
  };
}

export async function upsertQdrantEmbedding(
  input: {
    ownerType: string;
    ownerId: string;
    embeddingModel?: string;
    vector: number[];
    metadata?: Record<string, unknown>;
  },
  store?: QdrantEnsureResult,
) {
  const ensured = store || (await ensureQdrantStore());
  if (!ensured.enabled) return { ok: false, ...ensured };
  const embeddingModel = input.embeddingModel || VECTOR_TEXT_EMBEDDING_MODEL;
  const response = await qdrantRequest(`/collections/${encodeURIComponent(ensured.collection)}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({
      points: [
        {
          id: qdrantPointId(input.ownerType, input.ownerId, embeddingModel),
          vector: normalizeVectorForStore(input.vector, ensured.dims),
          payload: qdrantPayload({ ...input, embeddingModel }),
        },
      ],
    }),
  });
  if (!response.ok)
    return { ok: false, ...ensured, reason: response.status ? `http_${response.status}` : 'upsert_failed' };
  return { ok: true, enabled: true, collection: ensured.collection, dims: ensured.dims };
}

function trendSeedFilePath() {
  const configured = process.env.TREND_SEED_FILE?.trim();
  if (!configured) return undefined;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function readTrendSeedFile(): TrendSeedItem[] {
  const filePath = trendSeedFilePath();
  if (!filePath || !fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)
      ? (parsed as { items: unknown[] }).items
      : [];
  return rows
    .map((item, index) => {
      const row = item as Record<string, unknown>;
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      if (!title) return undefined;
      const tags = Array.isArray(row.tags) ? row.tags : [];
      return {
        externalId:
          typeof row.externalId === 'string' && row.externalId.trim()
            ? row.externalId.trim()
            : `manual-${shortHash(`${title}:${index}`)}`,
        title,
        url: typeof row.url === 'string' ? row.url : undefined,
        sourceId: typeof row.sourceId === 'string' ? row.sourceId : 'local-manual-seeds',
        platform: typeof row.platform === 'string' ? row.platform : 'local',
        category: typeof row.category === 'string' ? row.category : '未分类',
        product: typeof row.product === 'string' ? row.product : title,
        tags: uniqueStringValues(tags),
        metrics: row.metrics && typeof row.metrics === 'object' ? (row.metrics as Record<string, unknown>) : undefined,
      };
    })
    .filter(Boolean) as TrendSeedItem[];
}

function trendSourceForSeed(seed: TrendSeedItem) {
  if (seed.sourceId && seed.sourceId !== DEFAULT_TREND_SOURCE.id) {
    return {
      id: seed.sourceId,
      platform: seed.platform || 'local',
      name: seed.sourceId === 'local-manual-seeds' ? '本地手动热门商品种子' : seed.sourceId,
      url: seed.sourceId === 'local-manual-seeds' ? `file://${trendSeedFilePath() || 'TREND_SEED_FILE'}` : undefined,
      refreshCron: 'manual_or_worker',
    };
  }
  return DEFAULT_TREND_SOURCE;
}

function dailyHeatJitter(seed: string, now: Date) {
  const day = now.toISOString().slice(0, 10);
  return createHash('sha256').update(`${seed}:${day}`).digest().readUInt16BE(0) / 65535;
}

function metricNumber(metrics: Record<string, unknown> | undefined, key: string, fallback = 0) {
  const value = metrics?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function trendTags(seed: TrendSeedItem) {
  const flat = uniqueStringValues([seed.category, seed.product, ...seed.tags]);
  return {
    category: [seed.category],
    product: [seed.product],
    intent: seed.tags.filter((tag) => /开箱|测评|对比|演示|场景|痛点|真人|成分|穿搭/.test(tag)),
    source: [seed.platform || 'local'],
    flat,
    taxonomyVersion: 'trend-taxonomy.v1',
  };
}

function trendMetrics(seed: TrendSeedItem, rank: number, now: Date) {
  const views = metricNumber(seed.metrics, 'views', 0);
  const saves = metricNumber(seed.metrics, 'saves', 0);
  const velocity = metricNumber(seed.metrics, 'velocity', 0.5);
  const baseHeat = metricNumber(seed.metrics, 'baseHeat', 60);
  const heatScore = clampNumber(
    baseHeat +
      Math.log10(views + 10) * 2.4 +
      Math.log10(saves + 10) * 1.8 +
      velocity * 10 +
      dailyHeatJitter(seed.externalId, now) * 4,
    1,
    100,
  );
  return {
    ...seed.metrics,
    rank,
    heatScore: Number(heatScore.toFixed(2)),
    velocity: Number(velocity.toFixed(3)),
    compact: true,
    refreshedAt: now.toISOString(),
  };
}

function trendEnrichmentMeta(decision: TrendEnrichmentDecision, now: Date) {
  const meta: Record<string, unknown> = {
    enabled: decision.status !== 'disabled',
    provider: decision.provider,
    status: decision.status,
    taxonomyVersion: TREND_TAXONOMY_VERSION,
    enrichedAt: decision.enrichedAt || now.toISOString(),
  };
  if (decision.model) meta.model = decision.model;
  if (decision.reason) meta.reason = shortText(decision.reason, 120);
  return meta;
}

function localTrendEnrichmentDetails(seed: TrendSeedItem): TrendEnrichmentDetails {
  const text = `${seed.title} ${seed.category} ${seed.product} ${seed.tags.join(' ')}`;
  const matchers: Array<[RegExp, string[]]> = [
    [/露营|户外/u, ['露营爱好者', '户外人群']],
    [/卧室|租房/u, ['租房上班族', '家庭影音人群']],
    [/通勤|办公|办公室/u, ['通勤族', '办公人群']],
    [/学生|学习/u, ['学生党', '学习人群']],
    [/宠物|猫|狗/u, ['养宠家庭', '上班族宠物主人']],
    [/敏感肌|护肤|美妆/u, ['敏感肌人群', '精致护肤人群']],
    [/控卡|代餐|高蛋白/u, ['控卡人群', '健身人群']],
    [/旅行|行李/u, ['旅行人群', '出差人群']],
    [/骑行/u, ['骑行人群', '通勤族']],
    [/厨房|做饭|空气炸锅/u, ['做饭人群', '厨房清洁人群']],
    [/直播|真人/u, ['内容创作者', '直播人群']],
  ];
  const audience = uniqueStringValues(
    matchers.flatMap(([pattern, values]) => (pattern.test(text) ? values : [])),
  ).slice(0, 6);
  if (!audience.length) audience.push(`${seed.category}用户`);

  const painPoints = uniqueStringValues([
    /收纳|空间/u.test(text) ? '空间不够用' : undefined,
    /清洁|油污/u.test(text) ? '清理费时' : undefined,
    /通勤|佩戴|耳机/u.test(text) ? '久用不舒服' : undefined,
    /防晒|户外/u.test(text) ? '户外防护麻烦' : undefined,
    /敏感肌|修护/u.test(text) ? '上脸容易刺激' : undefined,
    /宠物|远程/u.test(text) ? '外出照看不便' : undefined,
    /办公|学习/u.test(text) ? '查找整理耗时' : undefined,
    /低客单|省事|痛点/u.test(text) ? '想省钱省事' : undefined,
  ]).slice(0, 6);
  if (!painPoints.length) painPoints.push('选择成本高', '使用场景不清楚');

  const sellingPoints = uniqueStringValues([
    ...seed.tags.filter((tag) => !/风险|注意/u.test(tag)).slice(0, 4),
    /多场景|场景/u.test(text) ? '多场景适用' : undefined,
    /便携|迷你|轻薄/u.test(text) ? '便携轻巧' : undefined,
    /对比|前后/u.test(text) ? '对比效果直观' : undefined,
    /静音|舒适/u.test(text) ? '使用体验友好' : undefined,
    /省事|效率/u.test(text) ? '提升效率' : undefined,
  ]).slice(0, 8);

  const videoAngles = uniqueStringValues([
    /开箱/u.test(text) ? '开箱上手' : undefined,
    /测评|对比/u.test(text) ? '实测对比' : undefined,
    /前后/u.test(text) ? '前后对比' : undefined,
    /场景|露营|卧室|通勤|厨房|办公|旅行/u.test(text) ? '场景演示' : undefined,
    /真人|穿搭|试用/u.test(text) ? '真人试用' : undefined,
    /功能|远程|控制/u.test(text) ? '功能演示' : undefined,
  ]).slice(0, 8);
  if (!videoAngles.length) videoAngles.push('痛点引入', '卖点演示');

  const searchTags = uniqueStringValues([
    seed.product,
    `${seed.category}${seed.product}`,
    ...seed.tags.map((tag) => `${tag}${seed.product}`).slice(0, 4),
  ]).slice(0, 12);

  const riskNotes = uniqueStringValues([
    seed.category === '美妆护肤' ? '效果因人而异' : undefined,
    seed.category === '美妆护肤' ? '敏感肌先试用' : undefined,
    seed.category === '食品饮料' ? '查看配料表' : undefined,
    seed.category === '食品饮料' ? '过敏者慎食' : undefined,
    seed.category === '数码电子' ? '效果受环境影响' : undefined,
    seed.category === '家居家电' ? '按说明使用' : undefined,
  ]).slice(0, 5);

  return {
    category: seed.category,
    product: seed.product,
    audience,
    painPoints,
    sellingPoints,
    videoAngles,
    searchTags,
    riskNotes,
  };
}

function mergeTrendTags(
  seed: TrendSeedItem,
  baseTags: ReturnType<typeof trendTags>,
  decision: TrendEnrichmentDecision,
) {
  const details = decision.details;
  if (!details) return baseTags;
  const category = uniqueStringValues([details.category, ...baseTags.category]).slice(0, 3);
  const product = uniqueStringValues([details.product, ...baseTags.product]).slice(0, 3);
  const audience = shortStringArray(details.audience, 6, 32);
  const painPoint = shortStringArray(details.painPoints, 8, 40);
  const sellingPoint = shortStringArray(details.sellingPoints, 8, 40);
  const videoAngle = shortStringArray(details.videoAngles, 8, 48);
  const search = shortStringArray(details.searchTags, 12, 32);
  const risk = shortStringArray(details.riskNotes, 5, 48);
  const flat = uniqueStringValues([
    ...category,
    ...product,
    ...baseTags.intent,
    ...baseTags.source,
    ...audience,
    ...painPoint,
    ...sellingPoint,
    ...videoAngle,
    ...search,
    ...risk,
    ...seed.tags,
  ]).slice(0, 64);

  return {
    category,
    product,
    intent: baseTags.intent,
    audience,
    painPoint,
    sellingPoint,
    videoAngle,
    search,
    risk,
    source: baseTags.source,
    flat,
    taxonomyVersion: TREND_TAXONOMY_VERSION,
  };
}

function trendEmbeddingText(seed: TrendSeedItem, tags: unknown) {
  return compactTextForEmbedding(
    `${seed.title} ${seed.category} ${seed.product} ${flattenJsonStrings(tags).join(' ')}`,
  );
}

function reusableTrendEnrichment(row: { tags: unknown; metrics: unknown } | undefined, now: Date) {
  if (!row?.metrics || typeof row.metrics !== 'object') return undefined;
  const enrichment = (row.metrics as Record<string, unknown>).enrichment;
  if (!enrichment || typeof enrichment !== 'object') return undefined;
  const meta = enrichment as Record<string, unknown>;
  if (meta.provider !== 'doubao' || !['enriched', 'reused'].includes(String(meta.status || ''))) return undefined;
  const enrichedAt = typeof meta.enrichedAt === 'string' ? Date.parse(meta.enrichedAt) : Number.NaN;
  if (!Number.isFinite(enrichedAt)) return undefined;
  const ageMs = now.getTime() - enrichedAt;
  if (ageMs < 0 || ageMs > trendEnrichmentTtlHours() * 60 * 60 * 1000) return undefined;
  const details = sanitizeTrendEnrichmentDetails({
    category: firstString((row.tags as Record<string, unknown>)?.category),
    product: firstString((row.tags as Record<string, unknown>)?.product),
    audience: (row.tags as Record<string, unknown>)?.audience,
    painPoints: (row.tags as Record<string, unknown>)?.painPoint,
    sellingPoints: (row.tags as Record<string, unknown>)?.sellingPoint,
    videoAngles: (row.tags as Record<string, unknown>)?.videoAngle,
    searchTags: (row.tags as Record<string, unknown>)?.search,
    riskNotes: (row.tags as Record<string, unknown>)?.risk,
  });
  if (!details) return undefined;
  return {
    provider: 'doubao',
    status: 'reused',
    details,
    model: typeof meta.model === 'string' ? meta.model : arkTextModel(),
    enrichedAt: new Date(enrichedAt).toISOString(),
    reason: 'cached',
  } satisfies TrendEnrichmentDecision;
}

async function requestDoubaoTrendEnrichment(batch: TrendPreparedSeed[]) {
  const model = arkTextModel();
  const payload = batch.map((item) => ({
    id: item.id,
    title: item.seed.title.slice(0, 120),
    category: item.seed.category.slice(0, 40),
    product: item.seed.product.slice(0, 60),
    tags: item.seed.tags.slice(0, 16),
    metrics: {
      views: metricNumber(item.seed.metrics, 'views', 0),
      saves: metricNumber(item.seed.metrics, 'saves', 0),
      velocity: metricNumber(item.seed.metrics, 'velocity', 0),
      baseHeat: metricNumber(item.seed.metrics, 'baseHeat', 0),
    },
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), trendEnrichmentTimeoutMs());
  try {
    const response = await fetch(`${arkBaseUrl()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${envValue('ARK_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是电商短视频趋势库分类器。只返回 JSON，不要解释。字段必须短、可检索、适合视频生成，不编造医疗功效或平台数据。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              instruction:
                '为每个商品补全 category、product、audience、painPoints、sellingPoints、videoAngles、searchTags、riskNotes。数组每项不超过 12 个中文字符，避免夸大承诺。',
              outputSchema: {
                items: [
                  {
                    id: '输入 id',
                    category: '一级类目',
                    product: '标准商品名',
                    audience: ['目标人群'],
                    painPoints: ['用户痛点'],
                    sellingPoints: ['可拍摄卖点'],
                    videoAngles: ['短视频角度'],
                    searchTags: ['检索词'],
                    riskNotes: ['风险提示'],
                  },
                ],
              },
              items: payload,
            }),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`doubao_http_${response.status}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('doubao_empty_content');
    const parsed = parseJsonObjectText(content);
    const rows = Array.isArray(parsed.items) ? parsed.items : [];
    const result = new Map<string, TrendEnrichmentDetails>();
    for (const row of rows) {
      const id = row && typeof row === 'object' ? shortText((row as Record<string, unknown>).id, 80) : undefined;
      const details = sanitizeTrendEnrichmentDetails(row);
      if (id && details) result.set(id, details);
    }
    return { model, items: result };
  } finally {
    clearTimeout(timer);
  }
}

async function enrichTrendSeeds(
  records: TrendPreparedSeed[],
  existingRowsById: Map<string, { tags: unknown; metrics: unknown }>,
  now: Date,
) {
  const decisions = new Map<string, TrendEnrichmentDecision>();
  const provider = trendEnrichmentProvider();
  const enabled = trendEnrichmentEnabled();
  const maxItems = trendEnrichmentMaxItems();
  for (const record of records) {
    decisions.set(record.id, {
      provider: 'local',
      status: enabled ? 'local' : 'disabled',
      details: localTrendEnrichmentDetails(record.seed),
      reason: enabled ? 'doubao_not_used' : 'disabled',
      enrichedAt: now.toISOString(),
    });
  }
  if (!enabled) return decisions;
  if (provider === 'doubao' && !doubaoTrendConfigured()) {
    for (const record of records.slice(0, maxItems)) {
      decisions.set(record.id, {
        provider: 'doubao',
        status: 'failed',
        details: localTrendEnrichmentDetails(record.seed),
        reason: 'doubao_not_configured',
        enrichedAt: now.toISOString(),
      });
    }
    return decisions;
  }
  if (!doubaoTrendConfigured()) return decisions;

  const candidates: TrendPreparedSeed[] = [];
  for (const record of records.slice(0, maxItems)) {
    const reused = reusableTrendEnrichment(existingRowsById.get(record.id), now);
    if (reused) {
      decisions.set(record.id, reused);
    } else {
      candidates.push(record);
      decisions.set(record.id, {
        provider: 'doubao',
        status: 'local',
        details: localTrendEnrichmentDetails(record.seed),
        model: arkTextModel(),
        reason: 'pending',
        enrichedAt: now.toISOString(),
      });
    }
  }
  for (const record of records.slice(maxItems)) {
    decisions.set(record.id, {
      provider: 'local',
      status: 'skipped',
      details: localTrendEnrichmentDetails(record.seed),
      reason: 'max_items',
      enrichedAt: now.toISOString(),
    });
  }

  const batchSize = trendEnrichmentBatchSize();
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    try {
      const response = await requestDoubaoTrendEnrichment(batch);
      for (const record of batch) {
        const details = response.items.get(record.id);
        decisions.set(record.id, {
          provider: 'doubao',
          status: details ? 'enriched' : 'failed',
          details: details || localTrendEnrichmentDetails(record.seed),
          model: response.model,
          enrichedAt: now.toISOString(),
          reason: details ? undefined : 'missing_item',
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'doubao_failed';
      for (const record of batch) {
        decisions.set(record.id, {
          provider: 'doubao',
          status: 'failed',
          details: localTrendEnrichmentDetails(record.seed),
          model: arkTextModel(),
          enrichedAt: now.toISOString(),
          reason,
        });
      }
    }
  }

  return decisions;
}

function trendSearchScore(row: { title: string; tags: unknown; metrics: unknown }, terms: string[]) {
  const haystack = `${row.title} ${flattenJsonStrings(row.tags).join(' ')}`.toLowerCase();
  const keywordScore = terms.length ? terms.filter((term) => haystack.includes(term)).length / terms.length : 1;
  const metrics = row.metrics && typeof row.metrics === 'object' ? (row.metrics as Record<string, unknown>) : {};
  const heat = metricNumber(metrics, 'heatScore', 0) / 100;
  return keywordScore * 0.68 + heat * 0.32;
}

function hybridVectorSearchScore(input: {
  query: string;
  vectorScore: number;
  title?: string;
  tags?: unknown;
  metadata?: unknown;
  metrics?: unknown;
}) {
  const queryTokens = embeddingTokens(input.query);
  const haystack = compactTextForEmbedding(
    `${input.title || ''} ${flattenJsonStrings(input.tags).join(' ')} ${flattenJsonStrings(input.metadata).join(' ')}`,
  ).toLowerCase();
  const keywordScore = queryTokens.length
    ? queryTokens.filter((token) => haystack.includes(token.toLowerCase())).length / queryTokens.length
    : 0;
  const metrics = input.metrics && typeof input.metrics === 'object' ? (input.metrics as Record<string, unknown>) : {};
  const heatScore = metricNumber(metrics, 'heatScore', 0) / 100;
  return Number((input.vectorScore * 0.52 + keywordScore * 0.4 + heatScore * 0.08).toFixed(4));
}

function matchesTrendFilters(row: { title: string; tags: unknown }, filters: TrendItemListFilters) {
  const tags = flattenJsonStrings(row.tags).map((tag) => tag.toLowerCase());
  if (filters.category && !tags.includes(filters.category.toLowerCase())) return false;
  if (filters.tag && !tags.some((tag) => tag.includes(filters.tag!.toLowerCase()))) return false;
  if (filters.q) {
    const terms = filters.q
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    const haystack = `${row.title} ${tags.join(' ')}`.toLowerCase();
    if (terms.length && !terms.some((term) => haystack.includes(term))) return false;
  }
  return true;
}

export async function createTask(input: CreateTaskInput) {
  const client = getPrisma();
  const step = input.step || 'queued';
  const progress = input.progress ?? 0;
  const message = input.message || '任务已进入生产队列。';

  return client.task.create({
    data: {
      id: input.id,
      type: input.type,
      status: input.status || 'pending',
      progress,
      step,
      payload: toJson(input.payload),
      traces: {
        create: {
          step,
          progress,
          message,
        },
      },
    },
    include: { traces: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function updateTask(id: string, input: UpdateTaskInput) {
  const client = getPrisma();
  const existing = await client.task.findUnique({ where: { id } });
  if (!existing) return null;

  const nextPayload =
    input.payload === undefined
      ? undefined
      : ({
          ...((existing.payload as Record<string, unknown> | null) || {}),
          ...input.payload,
        } as Prisma.InputJsonValue);

  return client.task.update({
    where: { id },
    data: {
      status: input.status,
      progress: input.progress,
      step: input.step,
      error: input.error === null ? null : input.error,
      payload: nextPayload,
      traces: input.trace
        ? {
            create: {
              step: input.trace.step,
              progress: input.trace.progress,
              message: input.trace.message,
              data: toJson(input.trace.data),
            },
          }
        : undefined,
    },
    include: { traces: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function getTask(id: string) {
  return getPrisma().task.findUnique({
    where: { id },
    include: { traces: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function listRecentTasks(limit = 20) {
  return getPrisma().task.findMany({
    take: limit,
    orderBy: { updatedAt: 'desc' },
    include: { traces: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function createAgentRun(input: CreateAgentRunInput) {
  return getPrisma().agentRun.create({
    data: {
      id: input.id,
      taskId: input.taskId,
      kind: input.kind,
      status: input.status || 'queued',
      graphVersion: input.graphVersion,
      productId: input.productId,
      scriptId: input.scriptId,
      videoId: input.videoId,
      input: toJson(input.input) || {},
    },
    include: {
      steps: { orderBy: { createdAt: 'asc' } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function updateAgentRun(id: string, input: UpdateAgentRunInput) {
  return getPrisma().agentRun.update({
    where: { id },
    data: {
      status: input.status,
      graphVersion: input.graphVersion,
      productId: input.productId === null ? null : input.productId,
      scriptId: input.scriptId === null ? null : input.scriptId,
      videoId: input.videoId === null ? null : input.videoId,
      input: input.input === undefined ? undefined : input.input === null ? Prisma.JsonNull : toJson(input.input),
      output: input.output === undefined ? undefined : input.output === null ? Prisma.JsonNull : toJson(input.output),
      error: input.error === null ? null : input.error,
    },
    include: {
      steps: { orderBy: { createdAt: 'asc' }, include: { toolCalls: { orderBy: { createdAt: 'asc' } } } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function getAgentRun(id: string) {
  return getPrisma().agentRun.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { createdAt: 'asc' }, include: { toolCalls: { orderBy: { createdAt: 'asc' } } } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function listAgentRuns(limit = 20) {
  return getPrisma().agentRun.findMany({
    take: limit,
    orderBy: { updatedAt: 'desc' },
    include: {
      steps: { orderBy: { createdAt: 'asc' }, include: { toolCalls: { orderBy: { createdAt: 'asc' } } } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function createAgentStep(input: CreateAgentStepInput) {
  return getPrisma().agentStep.create({
    data: {
      id: input.id,
      runId: input.runId,
      nodeId: input.nodeId,
      agentName: input.agentName,
      status: input.status || 'queued',
      attempt: input.attempt || 1,
      inputRefs: input.inputRefs || [],
      outputRefs: input.outputRefs || [],
      decision: input.decision,
      reason: input.reason,
      error: input.error,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    },
  });
}

export async function updateAgentStep(id: string, input: UpdateAgentStepInput) {
  return getPrisma().agentStep.update({
    where: { id },
    data: {
      status: input.status,
      attempt: input.attempt,
      inputRefs: input.inputRefs,
      outputRefs: input.outputRefs,
      decision: input.decision === null ? null : input.decision,
      reason: input.reason === null ? null : input.reason,
      error: input.error === null ? null : input.error,
      startedAt: input.startedAt === null ? null : input.startedAt,
      finishedAt: input.finishedAt === null ? null : input.finishedAt,
    },
  });
}

export async function createAgentArtifact(input: CreateAgentArtifactInput) {
  return getPrisma().agentArtifact.create({
    data: {
      id: input.id,
      runId: input.runId,
      stepId: input.stepId,
      type: input.type,
      content: input.content === undefined ? undefined : toJson(input.content),
      objectKey: input.objectKey,
      contentHash: input.contentHash,
    },
  });
}

export async function listAgentArtifacts(runId: string) {
  return getPrisma().agentArtifact.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createAgentToolCall(input: CreateAgentToolCallInput) {
  return getPrisma().agentToolCall.create({
    data: {
      id: input.id,
      runId: input.runId,
      stepId: input.stepId,
      toolName: input.toolName,
      status: input.status,
      input: input.input === undefined ? undefined : toJson(input.input),
      output: input.output === undefined ? undefined : toJson(input.output),
      latencyMs: input.latencyMs,
      costEstimate: input.costEstimate,
      error: input.error,
    },
  });
}

export async function upsertMaterial(input: ProductionMaterialInput) {
  return getPrisma().material.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      productId: input.productId,
      name: input.name,
      type: input.type,
      sourceUrl: input.sourceUrl,
      sourceObjectKey: input.sourceObjectKey,
      sourceDeclaration: input.sourceDeclaration,
      uploadedAt: input.uploadedAt,
    },
    update: {
      productId: input.productId,
      name: input.name,
      type: input.type,
      sourceUrl: input.sourceUrl,
      sourceObjectKey: input.sourceObjectKey,
      sourceDeclaration: input.sourceDeclaration,
      uploadedAt: input.uploadedAt,
    },
    include: { slices: { orderBy: { startTime: 'asc' } }, angles: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function getMaterial(id: string) {
  return getPrisma().material.findUnique({
    where: { id },
    include: { slices: { orderBy: { startTime: 'asc' } }, angles: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function listMaterials(filters: { type?: string; productId?: string } = {}) {
  return getPrisma().material.findMany({
    where: {
      type: filters.type || undefined,
      productId: filters.productId || undefined,
    },
    orderBy: { uploadedAt: 'desc' },
    include: { slices: { orderBy: { startTime: 'asc' } }, angles: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function deleteMaterial(id: string) {
  try {
    return await getPrisma().material.delete({
      where: { id },
      include: { slices: true, angles: true },
    });
  } catch {
    return null;
  }
}

export async function upsertMaterialAngle(input: ProductionMaterialAngleInput) {
  return getPrisma().materialAngle.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      materialId: input.materialId,
      productId: input.productId,
      view: input.view,
      key: input.key,
      label: input.label,
      imageUrl: input.imageUrl,
      referenceImageUrl: input.referenceImageUrl,
      previewUrl: input.previewUrl,
      sourceImageUrl: input.sourceImageUrl,
      promptHint: input.promptHint,
      pose: input.pose === undefined ? undefined : toJson(input.pose),
      provider: input.provider,
      status: input.status,
      note: input.note,
      createdAt: input.createdAt,
    },
    update: {
      productId: input.productId,
      view: input.view,
      key: input.key,
      label: input.label,
      imageUrl: input.imageUrl,
      referenceImageUrl: input.referenceImageUrl,
      previewUrl: input.previewUrl,
      sourceImageUrl: input.sourceImageUrl,
      promptHint: input.promptHint,
      pose: input.pose === undefined ? undefined : toJson(input.pose),
      provider: input.provider,
      status: input.status,
      note: input.note,
    },
  });
}

export async function replaceMaterialAngles(materialId: string, input: ProductionMaterialAngleInput[]) {
  const client = getPrisma();
  return client.$transaction(async (tx) => {
    await tx.materialAngle.deleteMany({ where: { materialId } });
    if (input.length) {
      await tx.materialAngle.createMany({
        data: input.map((angle) => ({
          id: angle.id,
          materialId: angle.materialId,
          productId: angle.productId,
          view: angle.view,
          key: angle.key,
          label: angle.label,
          imageUrl: angle.imageUrl,
          referenceImageUrl: angle.referenceImageUrl,
          previewUrl: angle.previewUrl,
          sourceImageUrl: angle.sourceImageUrl,
          promptHint: angle.promptHint,
          pose: angle.pose === undefined ? undefined : toJson(angle.pose),
          provider: angle.provider,
          status: angle.status,
          note: angle.note,
          createdAt: angle.createdAt,
        })),
      });
    }
    return tx.materialAngle.findMany({ where: { materialId }, orderBy: { createdAt: 'asc' } });
  });
}

export async function listMaterialAngles(materialId: string) {
  return getPrisma().materialAngle.findMany({
    where: { materialId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function upsertVideoAsset(input: ProductionVideoAssetInput) {
  return getPrisma().videoAsset.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      productId: input.productId,
      sourceUrl: input.sourceUrl,
      sourceObjectKey: input.sourceObjectKey,
      sourceDeclaration: input.sourceDeclaration,
      title: input.title,
      platform: input.platform,
      durationMs: input.durationMs,
      contentHash: input.contentHash,
    },
    update: {
      productId: input.productId,
      sourceUrl: input.sourceUrl,
      sourceObjectKey: input.sourceObjectKey,
      sourceDeclaration: input.sourceDeclaration,
      title: input.title,
      platform: input.platform,
      durationMs: input.durationMs,
      contentHash: input.contentHash,
    },
    include: { segments: { orderBy: { startMs: 'asc' } } },
  });
}

export async function replaceVideoSegments(videoId: string, input: ProductionVideoSegmentInput[]) {
  const client = getPrisma();
  return client.$transaction(async (tx) => {
    await tx.videoSegment.deleteMany({ where: { videoId } });
    if (input.length) {
      await tx.videoSegment.createMany({
        data: input.map((segment) => ({
          id: segment.id,
          videoId: segment.videoId,
          startMs: segment.startMs,
          endMs: segment.endMs,
          transcript: segment.transcript,
          visualSummary: segment.visualSummary,
          thumbnailUrl: segment.thumbnailUrl,
          clipUrl: segment.clipUrl,
          contentHash: segment.contentHash,
        })),
      });
    }
    return tx.videoSegment.findMany({ where: { videoId }, orderBy: { startMs: 'asc' } });
  });
}

export async function upsertVideoTag(input: ProductionVideoTagInput) {
  const normalizedName = input.normalizedName || normalizeTagName(input.name);
  return getPrisma().videoTag.upsert({
    where: { namespace_normalizedName: { namespace: input.namespace, normalizedName } },
    create: {
      namespace: input.namespace,
      name: input.name,
      normalizedName,
      description: input.description,
    },
    update: {
      name: input.name,
      description: input.description,
    },
  });
}

export async function upsertVideoTagAssignment(input: ProductionVideoTagAssignmentInput) {
  return getPrisma().videoTagAssignment.upsert({
    where: {
      segmentId_tagId_source: {
        segmentId: input.segmentId,
        tagId: input.tagId,
        source: input.source,
      },
    },
    create: {
      segmentId: input.segmentId,
      tagId: input.tagId,
      confidence: input.confidence ?? 1,
      source: input.source,
      modelVersion: input.modelVersion,
      evidence: toJson(input.evidence),
    },
    update: {
      confidence: input.confidence ?? 1,
      modelVersion: input.modelVersion,
      evidence: toJson(input.evidence),
    },
  });
}

export async function upsertEmbeddingVector(input: ProductionEmbeddingVectorInput) {
  return getPrisma().embeddingVector.upsert({
    where: {
      ownerType_ownerId_embeddingModel: {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        embeddingModel: input.embeddingModel,
      },
    },
    create: {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      segmentId: input.segmentId,
      embeddingModel: input.embeddingModel,
      dims: input.dims,
      vector: toJson(input.vector),
      quantizedObject: input.quantizedObject,
      vectorHash: input.vectorHash,
      metadata: toJson(input.metadata),
    },
    update: {
      segmentId: input.segmentId,
      dims: input.dims,
      vector: toJson(input.vector),
      quantizedObject: input.quantizedObject,
      vectorHash: input.vectorHash,
      metadata: toJson(input.metadata),
    },
  });
}

export async function upsertEmbeddingVersion(input: ProductionEmbeddingVersionInput) {
  return getPrisma().embeddingVersion.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      modelId: input.modelId,
      dims: input.dims,
      quantization: input.quantization,
      vectorStore: input.vectorStore,
      promptPolicy: toJson(input.promptPolicy),
      isActive: input.isActive ?? false,
      lastRebuiltAt: input.lastRebuiltAt,
    },
    update: {
      modelId: input.modelId,
      dims: input.dims,
      quantization: input.quantization,
      vectorStore: input.vectorStore,
      promptPolicy: toJson(input.promptPolicy),
      isActive: input.isActive,
      lastRebuiltAt: input.lastRebuiltAt,
    },
  });
}

export async function upsertRetrievalJob(input: ProductionRetrievalJobInput) {
  return getPrisma().retrievalJob.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      source: input.source,
      status: input.status,
      cursor: input.cursor,
      filters: toJson(input.filters),
      stats: toJson(input.stats),
      error: input.error,
      scheduledFor: input.scheduledFor,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    },
    update: {
      source: input.source,
      status: input.status,
      cursor: input.cursor,
      filters: toJson(input.filters),
      stats: toJson(input.stats),
      error: input.error,
      scheduledFor: input.scheduledFor,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    },
  });
}

export async function upsertTrendSource(input: ProductionTrendSourceInput) {
  return getPrisma().trendSource.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      platform: input.platform,
      name: input.name,
      url: input.url,
      enabled: input.enabled ?? true,
      refreshCron: input.refreshCron,
      config: toJson(input.config),
    },
    update: {
      platform: input.platform,
      name: input.name,
      url: input.url,
      enabled: input.enabled,
      refreshCron: input.refreshCron,
      config: toJson(input.config),
    },
  });
}

export async function upsertTrendItem(input: ProductionTrendItemInput) {
  return getPrisma().trendItem.upsert({
    where: { sourceId_externalId: { sourceId: input.sourceId, externalId: input.externalId } },
    create: {
      id: input.id,
      sourceId: input.sourceId,
      externalId: input.externalId,
      title: input.title,
      url: input.url,
      tags: toJson(input.tags) || {},
      metrics: toJson(input.metrics),
      embeddingId: input.embeddingId,
      fetchedAt: input.fetchedAt,
    },
    update: {
      title: input.title,
      url: input.url,
      tags: toJson(input.tags) || {},
      metrics: toJson(input.metrics),
      embeddingId: input.embeddingId,
      fetchedAt: input.fetchedAt,
    },
  });
}

export async function listTrendSources(filters: { platform?: string; enabled?: boolean } = {}) {
  return getPrisma().trendSource.findMany({
    where: {
      platform: filters.platform,
      enabled: filters.enabled,
    },
    orderBy: [{ enabled: 'desc' }, { updatedAt: 'desc' }],
    include: { _count: { select: { items: true } } },
  });
}

export async function listTrendItems(filters: TrendItemListFilters = {}) {
  const limit = clampNumber(Number(filters.limit || 24), 1, 100);
  const take = Math.min(500, Math.max(limit * 6, limit));
  const rows = await getPrisma().trendItem.findMany({
    take,
    where: {
      sourceId: filters.sourceId,
      source: filters.platform ? { platform: filters.platform } : undefined,
    },
    orderBy: [{ fetchedAt: 'desc' }, { updatedAt: 'desc' }],
    include: { source: true },
  });
  const terms = (filters.q || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return rows
    .filter((row) => matchesTrendFilters(row, filters))
    .map((row) => ({
      ...row,
      searchScore: Number(trendSearchScore(row, terms).toFixed(4)),
      flatTags: flattenJsonStrings(row.tags),
    }))
    .sort((a, b) => b.searchScore - a.searchScore || b.fetchedAt.getTime() - a.fetchedAt.getTime())
    .slice(0, limit);
}

export async function searchPgVectorEmbeddings(input: PgVectorSearchInput): Promise<PgVectorSearchHit[]> {
  const limit = clampNumber(Number(input.limit || 12), 1, 100);
  const ensured = await ensurePgVectorStore();
  if (!ensured.enabled) throw new Error(`pgvector is unavailable: ${ensured.reason || 'disabled'}`);
  const queryVector = await embedTextForVectorStore(input.query);
  const rows = await getPrisma().$queryRawUnsafe<
    Array<{
      ownerType: string;
      ownerId: string;
      embeddingModel: string;
      metadata: unknown;
      score: number;
      trendId: string | null;
      title: string | null;
      sourceId: string | null;
      platform: string | null;
      url: string | null;
      tags: unknown;
      metrics: unknown;
      fetchedAt: Date | null;
    }>
  >(
    `SELECT
      p."ownerType",
      p."ownerId",
      p."embeddingModel",
      p."metadata",
      (1 - (p."vector" <=> $1::vector))::double precision AS score,
      t."id" AS "trendId",
      t."title",
      t."sourceId",
      s."platform",
      t."url",
      t."tags",
      t."metrics",
      t."fetchedAt"
    FROM "EmbeddingVectorPgvector" p
    LEFT JOIN "TrendItem" t ON p."ownerType" = 'trend' AND p."ownerId" = t."id"
    LEFT JOIN "TrendSource" s ON t."sourceId" = s."id"
    WHERE ($2::text IS NULL OR p."ownerType" = $2::text)
      AND ($3::text IS NULL OR s."platform" = $3::text)
    ORDER BY p."vector" <=> $1::vector
    LIMIT $4`,
    vectorSqlLiteral(queryVector, ensured.dims),
    input.ownerType || null,
    input.platform || null,
    Math.min(limit * 8, 500),
  );

  return rows
    .map<PgVectorSearchHit | undefined>((row) => {
      const metadata = parseVectorMetadata(row.metadata);
      const tags = row.trendId ? flattenJsonStrings(row.tags) : flattenJsonStrings(metadata);
      if (input.category && !tags.some((tag) => tag.toLowerCase() === input.category!.toLowerCase())) return undefined;
      if (input.tag && !tags.some((tag) => tag.toLowerCase().includes(input.tag!.toLowerCase()))) return undefined;
      const vectorScore = Number(row.score || 0);
      const metadataMetrics =
        metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).metrics : undefined;
      const score = hybridVectorSearchScore({
        query: input.query,
        vectorScore,
        title:
          row.title ||
          (metadata && typeof metadata === 'object' ? String((metadata as Record<string, unknown>).title || '') : ''),
        tags,
        metadata,
        metrics: row.metrics || metadataMetrics,
      });
      return {
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        embeddingModel: row.embeddingModel,
        score,
        metadata:
          metadata && typeof metadata === 'object'
            ? { ...(metadata as Record<string, unknown>), vectorScore: Number(vectorScore.toFixed(4)) }
            : metadata,
        trend:
          row.trendId && row.title && row.sourceId && row.fetchedAt
            ? {
                id: row.trendId,
                title: row.title,
                sourceId: row.sourceId,
                platform: row.platform || undefined,
                url: row.url || undefined,
                tags: row.tags,
                metrics: row.metrics || undefined,
                fetchedAt: row.fetchedAt,
              }
            : undefined,
      };
    })
    .filter((item): item is PgVectorSearchHit => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function qdrantFilter(input: PgVectorSearchInput) {
  const must: Array<Record<string, unknown>> = [];
  if (input.ownerType) must.push({ key: 'ownerType', match: { value: input.ownerType } });
  if (input.platform) must.push({ key: 'platform', match: { value: input.platform } });
  if (input.category) must.push({ key: 'category', match: { value: input.category } });
  return must.length ? { must } : undefined;
}

export async function searchQdrantEmbeddings(input: PgVectorSearchInput): Promise<PgVectorSearchHit[]> {
  const limit = clampNumber(Number(input.limit || 12), 1, 100);
  const ensured = await ensureQdrantStore();
  if (!ensured.enabled) throw new Error(`Qdrant is unavailable: ${ensured.reason || 'disabled'}`);
  const queryVector = await embedTextForVectorStore(input.query);
  const response = await qdrantRequest<{
    result?: Array<{ score?: number; payload?: Record<string, unknown> }>;
  }>(`/collections/${encodeURIComponent(ensured.collection)}/points/search`, {
    method: 'POST',
    body: JSON.stringify({
      vector: normalizeVectorForStore(queryVector, ensured.dims),
      limit: Math.min(limit * 8, 500),
      with_payload: true,
      filter: qdrantFilter(input),
    }),
  });
  if (!response.ok) return [];

  return (response.data?.result || [])
    .map<PgVectorSearchHit | undefined>((point) => {
      const payload = point.payload || {};
      const tags = flattenJsonStrings(payload.tags || payload.metadata || payload);
      const requestedTags = [input.tag, ...(input.tags || [])].filter((item): item is string => Boolean(item));
      if (
        requestedTags.length &&
        !requestedTags.every((requested) => tags.some((tag) => tag.toLowerCase().includes(requested.toLowerCase())))
      )
        return undefined;
      const ownerType = typeof payload.ownerType === 'string' ? payload.ownerType : '';
      const ownerId = typeof payload.ownerId === 'string' ? payload.ownerId : '';
      const embeddingModel =
        typeof payload.embeddingModel === 'string' ? payload.embeddingModel : VECTOR_TEXT_EMBEDDING_MODEL;
      if (!ownerType || !ownerId) return undefined;
      const metadata = parseVectorMetadata(payload.metadata || payload);
      if (
        input.productId &&
        (!metadata ||
          typeof metadata !== 'object' ||
          (metadata as Record<string, unknown>).productId !== input.productId)
      )
        return undefined;
      const metadataMetrics =
        metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).metrics : undefined;
      const vectorScore = Number(point.score || 0);
      const score = hybridVectorSearchScore({
        query: input.query,
        vectorScore,
        title: typeof payload.title === 'string' ? payload.title : undefined,
        tags,
        metadata,
        metrics: metadataMetrics,
      });
      return {
        ownerType,
        ownerId,
        embeddingModel,
        score,
        metadata:
          metadata && typeof metadata === 'object'
            ? { ...(metadata as Record<string, unknown>), vectorScore: Number(vectorScore.toFixed(4)) }
            : metadata,
        trend:
          ownerType === 'trend' && typeof payload.title === 'string'
            ? {
                id: ownerId,
                title: payload.title,
                sourceId: typeof payload.sourceId === 'string' ? payload.sourceId : '',
                platform: typeof payload.platform === 'string' ? payload.platform : undefined,
                tags,
                metrics:
                  metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).metrics : undefined,
                fetchedAt: new Date(),
              }
            : undefined,
      };
    })
    .filter((item): item is PgVectorSearchHit => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function getTrendDatabaseStatus() {
  const client = getPrisma();
  const [sources, enabledSources, items, trendEmbeddings, totalEmbeddings, latestItem, latestJobs, pgvector, qdrant] =
    await Promise.all([
      client.trendSource.count(),
      client.trendSource.count({ where: { enabled: true } }),
      client.trendItem.count(),
      client.embeddingVector.count({ where: { ownerType: 'trend' } }),
      client.embeddingVector.count(),
      client.trendItem.findFirst({ orderBy: { fetchedAt: 'desc' }, include: { source: true } }),
      client.retrievalJob.findMany({
        take: 5,
        where: { source: { in: ['trend.refresh', 'video-tags.reindex'] } },
        orderBy: { updatedAt: 'desc' },
      }),
      getPgVectorStoreStatus(),
      getQdrantStoreStatus(),
    ]);
  return {
    ok: true,
    storage: {
      database: 'postgres',
      embeddingMode: VECTOR_TEXT_EMBEDDING_MODEL,
      dims: VECTOR_TEXT_EMBEDDING_DIMS,
      vectorFloatStored: true,
      onlineVectorStore: 'qdrant',
      pgvector,
      qdrant,
    },
    enrichment: getTrendEnrichmentStatus(),
    counts: {
      sources,
      enabledSources,
      items,
      trendEmbeddings,
      totalEmbeddings,
    },
    latestItem: latestItem
      ? {
          id: latestItem.id,
          title: latestItem.title,
          sourceId: latestItem.sourceId,
          platform: latestItem.source.platform,
          fetchedAt: latestItem.fetchedAt,
        }
      : undefined,
    latestJobs: latestJobs.map((job) => ({
      id: job.id,
      source: job.source,
      status: job.status,
      stats: job.stats,
      error: job.error || undefined,
      startedAt: job.startedAt || undefined,
      finishedAt: job.finishedAt || undefined,
      updatedAt: job.updatedAt,
    })),
  };
}

export async function refreshTrendDatabase(input: TrendRefreshInput = {}) {
  const now = input.now || new Date();
  const maxItems = clampNumber(Number(input.maxItems || process.env.TREND_MAX_ITEMS || 80), 1, 500);
  const jobId = `trend_refresh_${input.taskId || shortHash(now.toISOString())}`;
  const sourceFilter = input.source && input.source !== 'default' ? input.source : undefined;
  await upsertRetrievalJob({
    id: jobId,
    source: 'trend.refresh',
    status: 'processing',
    filters: { source: sourceFilter, productId: input.productId, maxItems },
    startedAt: now,
  });

  try {
    await upsertEmbeddingVersion({
      id: VECTOR_TEXT_EMBEDDING_VERSION_ID,
      modelId: VECTOR_TEXT_EMBEDDING_MODEL,
      dims: VECTOR_TEXT_EMBEDDING_DIMS,
      quantization: 'none',
      vectorStore: 'qdrant',
      promptPolicy: {
        source: 'title + category + product + tags + optional trend enrichment',
        floatVectorStored: true,
        enrichment: getTrendEnrichmentStatus(),
      },
      isActive: true,
      lastRebuiltAt: now,
    });

    const seeds = [...DEFAULT_TREND_ITEMS, ...readTrendSeedFile()]
      .filter((seed) => !sourceFilter || seed.sourceId === sourceFilter || seed.platform === sourceFilter)
      .slice(0, maxItems);
    const sourceMap = new Map<string, ReturnType<typeof trendSourceForSeed>>();
    for (const seed of seeds) {
      const source = trendSourceForSeed(seed);
      sourceMap.set(source.id, source);
    }
    if (!sourceFilter || DEFAULT_TREND_SOURCE.id === sourceFilter || DEFAULT_TREND_SOURCE.platform === sourceFilter) {
      sourceMap.set(DEFAULT_TREND_SOURCE.id, DEFAULT_TREND_SOURCE);
    }

    for (const source of sourceMap.values()) {
      await upsertTrendSource({
        id: source.id,
        platform: source.platform,
        name: source.name,
        url: source.url,
        enabled: true,
        refreshCron: source.refreshCron,
        config: {
          adapter: 'local-seed',
          compact: true,
          seedFile: source.id === 'local-manual-seeds' ? trendSeedFilePath() : undefined,
        },
      });
    }

    const preparedSeeds: TrendPreparedSeed[] = seeds.map((seed, index) => {
      const source = trendSourceForSeed(seed);
      return {
        id: `trend_${shortHash(`${source.id}:${seed.externalId}`, 16)}`,
        source,
        seed,
        rank: index + 1,
        baseTags: trendTags(seed),
        baseMetrics: trendMetrics(seed, index + 1, now),
      };
    });
    const existingRows = await getPrisma().trendItem.findMany({
      where: { id: { in: preparedSeeds.map((seed) => seed.id) } },
      select: { id: true, tags: true, metrics: true },
    });
    const existingRowsById = new Map(existingRows.map((row) => [row.id, { tags: row.tags, metrics: row.metrics }]));
    const enrichmentDecisions = await enrichTrendSeeds(preparedSeeds, existingRowsById, now);

    let itemCount = 0;
    let qdrantRows = 0;
    let doubaoEnrichedRows = 0;
    let doubaoReusedRows = 0;
    let enrichmentFailedRows = 0;
    let localFallbackRows = 0;
    const qdrantStore = await ensureQdrantStore();
    if (!qdrantStore.enabled) {
      throw new Error(`Qdrant is required for trend.refresh: ${qdrantStore.reason || 'unavailable'}`);
    }
    for (const record of preparedSeeds) {
      const { seed, source, id } = record;
      const decision =
        enrichmentDecisions.get(id) ||
        ({
          provider: 'local',
          status: 'disabled',
          reason: 'missing_decision',
          enrichedAt: now.toISOString(),
        } satisfies TrendEnrichmentDecision);
      if (decision.status === 'enriched') doubaoEnrichedRows += 1;
      if (decision.status === 'reused') doubaoReusedRows += 1;
      if (decision.status === 'failed') enrichmentFailedRows += 1;
      if (decision.provider === 'local' || decision.status === 'failed') localFallbackRows += 1;
      const tags = mergeTrendTags(seed, record.baseTags, decision);
      const metrics = {
        ...record.baseMetrics,
        enrichment: trendEnrichmentMeta(decision, now),
      };
      const flatTags = flattenJsonStrings(tags).slice(0, 48);
      const category = firstString(tags.category) || seed.category;
      const product = firstString(tags.product) || seed.product;
      const text = trendEmbeddingText(seed, tags);
      const vector = await embedTextForVectorStore(text);
      const embedding = await upsertEmbeddingVector({
        ownerType: 'trend',
        ownerId: id,
        embeddingModel: VECTOR_TEXT_EMBEDDING_MODEL,
        dims: VECTOR_TEXT_EMBEDDING_DIMS,
        vector,
        metadata: {
          title: seed.title,
          sourceId: source.id,
          platform: source.platform,
          category,
          product,
          tags: flatTags,
          enrichment: trendEnrichmentMeta(decision, now),
        },
      });
      const qdrant = await upsertQdrantEmbedding(
        {
          ownerType: 'trend',
          ownerId: id,
          embeddingModel: VECTOR_TEXT_EMBEDDING_MODEL,
          vector,
          metadata: {
            title: seed.title,
            sourceId: source.id,
            platform: source.platform,
            category,
            product,
            tags: flatTags,
            metrics,
            enrichment: trendEnrichmentMeta(decision, now),
          },
        },
        qdrantStore,
      );
      if (qdrant.ok) qdrantRows += 1;
      await upsertTrendItem({
        id,
        sourceId: source.id,
        externalId: seed.externalId,
        title: seed.title,
        url: seed.url || `local://trends/${seed.externalId}`,
        tags,
        metrics,
        embeddingId: embedding.id,
        fetchedAt: now,
      });
      itemCount += 1;
    }

    const result = {
      sources: sourceMap.size,
      items: itemCount,
      embeddings: itemCount,
      embeddingMode: VECTOR_TEXT_EMBEDDING_MODEL,
      vectorStore: 'qdrant',
      qdrantRows,
      qdrantCollection: qdrantStore.collection,
      enrichment: {
        ...getTrendEnrichmentStatus(),
        doubaoEnrichedRows,
        doubaoReusedRows,
        failedRows: enrichmentFailedRows,
        localFallbackRows,
      },
      dims: VECTOR_TEXT_EMBEDDING_DIMS,
      refreshedAt: now.toISOString(),
    };
    await upsertRetrievalJob({
      id: jobId,
      source: 'trend.refresh',
      status: 'completed',
      filters: { source: sourceFilter, productId: input.productId, maxItems },
      stats: result,
      startedAt: now,
      finishedAt: new Date(),
    });
    return result;
  } catch (error) {
    await upsertRetrievalJob({
      id: jobId,
      source: 'trend.refresh',
      status: 'failed',
      filters: { source: sourceFilter, productId: input.productId, maxItems },
      error: error instanceof Error ? error.message : 'trend refresh failed',
      startedAt: now,
      finishedAt: new Date(),
    });
    throw error;
  }
}

export async function reindexQdrantRetrievalDatabase(input: CompactRetrievalReindexInput = {}) {
  const now = input.now || new Date();
  const maxItems = clampNumber(Number(input.maxItems || process.env.VECTOR_REINDEX_MAX_ITEMS || 2000), 1, 10000);
  const jobId = `video_tags_reindex_${input.taskId || shortHash(now.toISOString())}`;
  await upsertRetrievalJob({
    id: jobId,
    source: 'video-tags.reindex',
    status: 'processing',
    filters: { reason: input.reason || 'manual', maxItems },
    startedAt: now,
  });

  try {
    await upsertEmbeddingVersion({
      id: VECTOR_TEXT_EMBEDDING_VERSION_ID,
      modelId: VECTOR_TEXT_EMBEDDING_MODEL,
      dims: VECTOR_TEXT_EMBEDDING_DIMS,
      quantization: 'none',
      vectorStore: 'qdrant',
      promptPolicy: { source: 'runtime slices + video segments + trends', floatVectorStored: true },
      isActive: true,
      lastRebuiltAt: now,
    });

    const client = getPrisma();
    const [slices, segments, trends] = await Promise.all([
      client.slice.findMany({
        take: maxItems,
        orderBy: { id: 'asc' },
        include: { material: true },
      }),
      client.videoSegment.findMany({
        take: maxItems,
        orderBy: { updatedAt: 'desc' },
        include: { video: true, tags: { include: { tag: true } } },
      }),
      client.trendItem.findMany({
        take: maxItems,
        orderBy: { fetchedAt: 'desc' },
        include: { source: true },
      }),
    ]);

    let count = 0;
    let qdrantRows = 0;
    const qdrantStore = await ensureQdrantStore();
    if (!qdrantStore.enabled) {
      throw new Error(`Qdrant is required for video-tags.reindex: ${qdrantStore.reason || 'unavailable'}`);
    }
    const upsertCompact = async (
      ownerType: string,
      ownerId: string,
      text: string,
      metadata: Record<string, unknown>,
    ) => {
      const vector = await embedTextForVectorStore(text);
      await upsertEmbeddingVector({
        ownerType,
        ownerId,
        embeddingModel: VECTOR_TEXT_EMBEDDING_MODEL,
        dims: VECTOR_TEXT_EMBEDDING_DIMS,
        vector,
        metadata,
      });
      const qdrant = await upsertQdrantEmbedding(
        {
          ownerType,
          ownerId,
          embeddingModel: VECTOR_TEXT_EMBEDDING_MODEL,
          vector,
          metadata,
        },
        qdrantStore,
      );
      if (qdrant.ok) qdrantRows += 1;
      count += 1;
    };

    for (const slice of slices) {
      await upsertCompact(
        'slice',
        slice.id,
        compactTextForEmbedding(`${slice.summary} ${JSON.stringify(slice.tags)} ${slice.material.name || ''}`),
        {
          title: slice.material.name || slice.summary,
          summary: slice.summary,
          materialId: slice.materialId,
          productId: slice.material.productId,
          tags: flattenJsonStrings(slice.tags).slice(0, 24),
        },
      );
    }

    for (const segment of segments) {
      const tags = segment.tags.map((assignment) => assignment.tag.name);
      await upsertCompact(
        'video_segment',
        segment.id,
        compactTextForEmbedding(`${segment.visualSummary} ${segment.transcript || ''} ${tags.join(' ')}`),
        {
          title: segment.visualSummary,
          summary: segment.visualSummary,
          segmentId: segment.id,
          videoId: segment.videoId,
          productId: segment.video.productId,
          platform: segment.video.platform,
          tags: tags.slice(0, 24),
        },
      );
    }

    for (const trend of trends) {
      const tags = flattenJsonStrings(trend.tags).slice(0, 48);
      await upsertCompact('trend', trend.id, compactTextForEmbedding(`${trend.title} ${JSON.stringify(trend.tags)}`), {
        title: trend.title,
        sourceId: trend.sourceId,
        platform: trend.source.platform,
        category: firstString((trend.tags as Record<string, unknown>)?.category) || tags[0],
        product: firstString((trend.tags as Record<string, unknown>)?.product),
        tags,
        metrics: trend.metrics,
      });
    }

    const result = {
      vectors: count,
      slices: slices.length,
      segments: segments.length,
      trends: trends.length,
      embeddingMode: VECTOR_TEXT_EMBEDDING_MODEL,
      vectorStore: 'qdrant',
      qdrantRows,
      qdrantCollection: qdrantStore.collection,
      dims: VECTOR_TEXT_EMBEDDING_DIMS,
      rebuiltAt: now.toISOString(),
    };
    await upsertRetrievalJob({
      id: jobId,
      source: 'video-tags.reindex',
      status: 'completed',
      filters: { reason: input.reason || 'manual', maxItems },
      stats: result,
      startedAt: now,
      finishedAt: new Date(),
    });
    return result;
  } catch (error) {
    await upsertRetrievalJob({
      id: jobId,
      source: 'video-tags.reindex',
      status: 'failed',
      filters: { reason: input.reason || 'manual', maxItems },
      error: error instanceof Error ? error.message : 'compact retrieval reindex failed',
      startedAt: now,
      finishedAt: new Date(),
    });
    throw error;
  }
}

export async function replaceMaterialSlices(materialId: string, input: ProductionSliceInput[]) {
  const client = getPrisma();
  return client.$transaction(async (tx) => {
    await tx.slice.deleteMany({ where: { materialId } });
    if (input.length) {
      await tx.slice.createMany({
        data: input.map((slice) => ({
          id: slice.id,
          materialId: slice.materialId,
          thumbnailUrl: slice.thumbnailUrl,
          thumbnailObjectKey: slice.thumbnailObjectKey,
          clipUrl: slice.clipUrl,
          clipObjectKey: slice.clipObjectKey,
          startTime: slice.startTime,
          endTime: slice.endTime,
          tags: toJson(slice.tags) || {},
          summary: slice.summary,
          embedding: toJson(slice.embedding),
        })),
      });
    }
    return tx.material.findUnique({
      where: { id: materialId },
      include: { slices: { orderBy: { startTime: 'asc' } }, angles: { orderBy: { createdAt: 'asc' } } },
    });
  });
}

export async function searchSlices(query: string, limit = 10, productId?: string) {
  const hits = await searchQdrantEmbeddings({
    query,
    limit,
    ownerType: 'slice',
    productId,
  });
  if (!hits.length) return [];
  const rows = await getPrisma().slice.findMany({
    where: { id: { in: hits.map((hit) => hit.ownerId) } },
    include: { material: true },
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return hits
    .map((hit) => {
      const row = rowsById.get(hit.ownerId);
      return row ? { ...row, score: hit.score } : undefined;
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export async function getSlice(id: string) {
  return getPrisma().slice.findUnique({
    where: { id },
    include: { material: true },
  });
}

export async function createScriptWithShots(input: ProductionScriptInput) {
  return getPrisma().script.create({
    data: {
      id: input.id,
      productId: input.productId,
      generationProfile: input.generationProfile || 'trusted_publish',
      productUrl: input.productUrl,
      referenceImageUrl: input.referenceImageUrl,
      materialIds: input.materialIds || [],
      sourceMode: input.sourceMode,
      sourceRef: input.sourceRef,
      narrative: input.narrative,
      visualStyle: input.visualStyle,
      bgm: input.bgm,
      aspectRatio: input.aspectRatio,
      language: input.language,
      constraints: input.constraints,
      shots: {
        create: input.shots.map((shot) => ({
          id: shot.id,
          order: shot.order,
          duration: shot.duration,
          visualDesc: shot.visualDesc,
          camera: shot.camera,
          narration: shot.narration,
          subtitle: shot.subtitle,
          materialRef: shot.materialRef,
          transition: shot.transition,
          factors: toJson(shot.factors) || [],
          status: shot.status,
          assetUrl: shot.assetUrl,
          assetObjectKey: shot.assetObjectKey,
          claimIds: shot.claimIds || [],
          evidenceIds: shot.evidenceIds || [],
        })),
      },
    },
    include: { shots: { orderBy: { order: 'asc' } } },
  });
}

export async function getScript(id: string) {
  return getPrisma().script.findUnique({
    where: { id },
    include: { shots: { orderBy: { order: 'asc' } } },
  });
}

export async function updateScriptContent(
  scriptId: string,
  input: {
    narrative?: string;
    visualStyle?: string;
    bgm?: string;
    language?: string;
    aspectRatio?: '9:16' | '16:9';
    shotOrder?: string[];
  },
) {
  return getPrisma().$transaction(async (tx) => {
    if (input.shotOrder?.length) {
      await Promise.all(
        input.shotOrder.map((shotId, index) =>
          tx.shot.updateMany({
            where: { id: shotId, scriptId },
            data: { order: index + 1 },
          }),
        ),
      );
    }
    return tx.script.update({
      where: { id: scriptId },
      data: {
        narrative: input.narrative,
        visualStyle: input.visualStyle,
        bgm: input.bgm,
        language: input.language,
        aspectRatio: input.aspectRatio,
      },
      include: { shots: { orderBy: { order: 'asc' } } },
    });
  });
}

export async function createShotForScript(scriptId: string, input: ProductionShotInput) {
  return getPrisma().shot.create({
    data: {
      id: input.id,
      scriptId,
      order: input.order,
      duration: input.duration,
      visualDesc: input.visualDesc,
      camera: input.camera,
      narration: input.narration,
      subtitle: input.subtitle,
      materialRef: input.materialRef,
      transition: input.transition,
      factors: toJson(input.factors) || [],
      status: input.status,
      assetUrl: input.assetUrl,
      assetObjectKey: input.assetObjectKey,
      claimIds: input.claimIds || [],
      evidenceIds: input.evidenceIds || [],
    },
  });
}

export async function updateShotAsset(
  shotId: string,
  input: { assetUrl: string; assetObjectKey?: string; status?: 'draft' | 'generating' | 'done' | 'failed' },
) {
  return getPrisma().shot.update({
    where: { id: shotId },
    data: {
      assetUrl: input.assetUrl,
      assetObjectKey: input.assetObjectKey,
      status: input.status || 'done',
    },
  });
}

export async function updateShotContent(
  shotId: string,
  input: {
    visualDesc?: string;
    camera?: string;
    narration?: string;
    subtitle?: string;
    materialRef?: string | null;
    transition?: 'hard_cut' | 'fade' | 'whip' | null;
    duration?: number;
    order?: number;
    factors?: ProductionFactor[];
    claimIds?: string[];
    evidenceIds?: string[];
    status?: 'draft' | 'generating' | 'done' | 'failed';
    clearAsset?: boolean;
  },
) {
  return getPrisma().shot.update({
    where: { id: shotId },
    data: {
      visualDesc: input.visualDesc,
      camera: input.camera,
      narration: input.narration,
      subtitle: input.subtitle,
      materialRef: input.materialRef === null ? null : input.materialRef,
      transition: input.transition === null ? null : input.transition,
      duration: input.duration,
      order: input.order,
      factors: input.factors === undefined ? undefined : toJson(input.factors),
      claimIds: input.claimIds,
      evidenceIds: input.evidenceIds,
      status: input.status,
      assetUrl: input.clearAsset ? null : undefined,
      assetObjectKey: input.clearAsset ? null : undefined,
    },
  });
}

export async function deleteShot(shotId: string) {
  return getPrisma().shot.delete({ where: { id: shotId } });
}

export async function latestRenderTaskForScript(scriptId: string) {
  return getPrisma().task.findFirst({
    where: {
      type: 'compose',
      status: 'completed',
      payload: {
        path: ['scriptId'],
        equals: scriptId,
      },
    },
    orderBy: { updatedAt: 'desc' },
    include: { traces: { orderBy: { createdAt: 'asc' } } },
  });
}

// ─── ReferenceVideo ────────────────────────────────────────────────────────

export type ReferenceVideoInput = {
  id: string;
  sourceUrl: string;
  localVideoUrl?: string;
  localObjectKey?: string;
  sourceDeclaration: string;
  licenseType?: string;
  usageScope?: string;
  breakdownReport: Record<string, unknown>;
};

export async function upsertReferenceVideo(input: ReferenceVideoInput) {
  return getPrisma().referenceVideo.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      sourceUrl: input.sourceUrl,
      localVideoUrl: input.localVideoUrl,
      localObjectKey: input.localObjectKey,
      sourceDeclaration: input.sourceDeclaration,
      licenseType: input.licenseType,
      usageScope: input.usageScope,
      breakdownReport: toJson(input.breakdownReport) as Prisma.InputJsonValue,
    },
    update: {
      localVideoUrl: input.localVideoUrl,
      localObjectKey: input.localObjectKey,
      breakdownReport: toJson(input.breakdownReport) as Prisma.InputJsonValue,
      licenseType: input.licenseType,
      usageScope: input.usageScope,
    },
  });
}

export async function listReferenceVideos() {
  return getPrisma().referenceVideo.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function getReferenceVideo(id: string) {
  return getPrisma().referenceVideo.findUnique({ where: { id } });
}

function referenceMetadataMatches(metadata: Record<string, unknown>, input: ReferenceVectorSearchInput) {
  if (input.category && jsonText(metadata.category).toLowerCase() !== input.category.toLowerCase()) return false;
  if (input.trafficType && jsonText(metadata.trafficType).toLowerCase() !== input.trafficType.toLowerCase())
    return false;
  if (input.dataset && !jsonStringArray(metadata.datasets).includes(input.dataset)) return false;
  if (input.winnerType) {
    const labels = jsonObject(metadata.labels);
    if (input.winnerType === 'organic' && labels.organicWinner !== true) return false;
    if (input.winnerType === 'paid' && labels.paidValidatedWinner !== true) return false;
    if (input.winnerType === 'lowFollower' && labels.lowFollowerWinner !== true) return false;
  }
  if (input.q) {
    const haystack = [
      metadata.title,
      metadata.description,
      metadata.category,
      metadata.referenceText,
      jsonStringArray(metadata.datasets).join(' '),
    ]
      .map((item) => String(item || '').toLowerCase())
      .join(' ');
    if (!haystack.includes(input.q.toLowerCase())) return false;
  }
  return true;
}

function referenceSearchScore(input: { vectorScore: number; metadata: Record<string, unknown>; queryText?: string }) {
  const heat = jsonNumber(input.metadata.benchmarkScore) ?? 0;
  const gmvPct = jsonNumber(input.metadata.gmvPercentile) ?? 0;
  const salesPct = jsonNumber(input.metadata.salesPercentile) ?? 0;
  return Number((input.vectorScore * 0.78 + heat * 0.12 + gmvPct * 0.06 + salesPct * 0.04).toFixed(4));
}

export async function searchReferenceQdrant(
  input: ReferenceVectorSearchInput & { collection?: string },
): Promise<ReferenceVectorSearchHit[]> {
  if (!qdrantProviderEnabled()) return [];
  const collection = input.collection || process.env.QDRANT_REFERENCE_COLLECTION || 'aigc_reference_vectors';
  const limit = clampNumber(Number(input.limit || 12), 1, 100);
  const queryVector = normalizedVector(input.queryVector || []);
  // Reference vectors are 1024-dim jina-clip-v2; a 64-dim hash fallback query must not hit this collection.
  if (queryVector.length !== 1024) return [];

  const filter = input.category ? { must: [{ key: 'category', match: { value: input.category } }] } : undefined;

  const response = await qdrantRequest<{
    result?: Array<{ score?: number; payload?: Record<string, unknown> }>;
  }>(`/collections/${encodeURIComponent(collection)}/points/search`, {
    method: 'POST',
    body: JSON.stringify({
      vector: queryVector,
      limit: Math.min(limit * 4, 200),
      with_payload: true,
      ...(filter ? { filter } : {}),
    }),
  });
  if (!response.ok || !response.data?.result?.length) return [];

  const scored = response.data.result
    .map((point) => {
      const payload = point.payload || {};
      const ownerId = typeof payload.ownerId === 'string' ? payload.ownerId : '';
      if (!ownerId) return undefined;
      const metadata = jsonObject(parseVectorMetadata(payload.metadata || payload));
      if (!referenceMetadataMatches(metadata, input)) return undefined;
      const vectorScore = Number(point.score || 0);
      return {
        ownerId,
        embeddingModel:
          typeof payload.embeddingModel === 'string' ? payload.embeddingModel : REFERENCE_TEXT_EMBEDDING_MODEL,
        vectorScore,
        score: referenceSearchScore({ vectorScore, metadata, queryText: input.q }),
        metadata,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return [];

  const references = await getPrisma().referenceVideo.findMany({
    where: { id: { in: scored.map((item) => item.ownerId) } },
  });
  const byId = new Map(references.map((item) => [item.id, item]));

  const hits: ReferenceVectorSearchHit[] = [];
  for (const item of scored) {
    const reference = byId.get(item.ownerId);
    if (!reference) continue;
    hits.push({
      id: reference.id,
      sourceUrl: reference.sourceUrl,
      localVideoUrl: reference.localVideoUrl,
      sourceDeclaration: reference.sourceDeclaration,
      licenseType: reference.licenseType,
      usageScope: reference.usageScope,
      breakdownReport: reference.breakdownReport,
      embeddingModel: item.embeddingModel,
      score: item.score,
      vectorScore: Number(item.vectorScore.toFixed(4)),
      metadata: item.metadata,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function searchReferenceVideoEmbeddings(
  input: ReferenceVectorSearchInput,
): Promise<ReferenceVectorSearchHit[]> {
  const limit = clampNumber(Number(input.limit || 12), 1, 100);
  const embeddingModel = input.embeddingModel || REFERENCE_TEXT_EMBEDDING_MODEL;
  const queryVector = normalizedVector(input.queryVector);
  if (!queryVector.length) return [];

  const rows = await getPrisma().embeddingVector.findMany({
    where: { ownerType: 'reference', embeddingModel },
    select: { ownerId: true, embeddingModel: true, vector: true, metadata: true },
    take: 10000,
  });
  if (!rows.length) return [];

  const scored = rows
    .map((row) => {
      const metadata = jsonObject(parseVectorMetadata(row.metadata));
      if (!referenceMetadataMatches(metadata, input)) return undefined;
      const vector = numberArrayFromJson(row.vector);
      if (!vector.length) return undefined;
      const vectorScore = cosineSimilarity(queryVector, vector);
      return {
        ownerId: row.ownerId,
        embeddingModel: row.embeddingModel,
        vectorScore,
        score: referenceSearchScore({ vectorScore, metadata, queryText: input.q }),
        metadata,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(limit * 4, 200));

  const references = await getPrisma().referenceVideo.findMany({
    where: { id: { in: scored.map((item) => item.ownerId) } },
  });
  const byId = new Map(references.map((item) => [item.id, item]));

  const hits: ReferenceVectorSearchHit[] = [];
  for (const item of scored) {
    const reference = byId.get(item.ownerId);
    if (!reference) continue;
    hits.push({
      id: reference.id,
      sourceUrl: reference.sourceUrl,
      localVideoUrl: reference.localVideoUrl,
      sourceDeclaration: reference.sourceDeclaration,
      licenseType: reference.licenseType,
      usageScope: reference.usageScope,
      breakdownReport: reference.breakdownReport,
      embeddingModel: item.embeddingModel,
      score: item.score,
      vectorScore: Number(item.vectorScore.toFixed(4)),
      metadata: item.metadata,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function deleteReferenceVideo(id: string) {
  return getPrisma().referenceVideo.delete({ where: { id } });
}

// ─── FastMoss / VOC Intelligence ───────────────────────────────────────────

export type ProductVocInsightInput = {
  id: string;
  source?: string;
  platform?: string;
  sourceUrl?: string;
  productExternalId?: string;
  productTitle: string;
  category?: string;
  analysisWindow?: string;
  analyzedCommentCount?: number;
  consumerProfile?: unknown;
  starImpact?: unknown;
  usageScenarios?: unknown;
  positiveExperience?: unknown;
  negativeExperience?: unknown;
  purchaseMotives?: unknown;
  unmetExpectations?: unknown;
  summaryAdvice?: string;
  raw?: unknown;
};

export type ProductReviewInsightInput = {
  id: string;
  vocInsightId?: string;
  source?: string;
  platform?: string;
  sourceUrl?: string;
  productTitle?: string;
  sku?: string;
  reviewedAt?: Date;
  rating?: number;
  language?: string;
  sentiment?: string;
  reviewText: string;
  tags?: unknown;
  motives?: unknown;
  expectations?: unknown;
  behaviors?: unknown;
  raw?: unknown;
};

export type CreativePerformanceInput = {
  id: string;
  source?: string;
  platform?: string;
  sourceUrl?: string;
  videoUrl?: string;
  videoId?: string;
  productTitle?: string;
  productUrl?: string;
  shopName?: string;
  creatorHandle?: string;
  advertiserName?: string;
  country?: string;
  category?: string;
  adCopy?: string;
  publishedAt?: Date;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  durationSeconds?: number;
  resolution?: string;
  priceText?: string;
  rankType?: string;
  rank?: number;
  views?: number;
  impressions?: number;
  interactions?: number;
  adSpend?: number;
  sales?: number;
  salesAmount?: number;
  roas?: number;
  ctr?: number;
  interactionRate?: number;
  adDays?: number;
  metrics?: unknown;
  raw?: unknown;
};

export type VideoSceneTruthInput = {
  id: string;
  referenceVideoId?: string;
  creativePerformanceId?: string;
  source?: string;
  videoUrl?: string;
  sceneIndex: number;
  startMs: number;
  endMs: number;
  summary: string;
  transcript?: string;
  labels?: unknown;
  ocrTexts?: unknown;
  subtitlePlan?: unknown;
  visual?: unknown;
  raw?: unknown;
};

export type ProductVocInsightListFilters = {
  source?: string;
  platform?: string;
  productTitle?: string;
  category?: string;
  limit?: number;
};

export type ProductReviewInsightListFilters = {
  source?: string;
  platform?: string;
  productTitle?: string;
  sentiment?: string;
  minRating?: number;
  limit?: number;
};

export type CreativePerformanceListFilters = {
  source?: string;
  platform?: string;
  productTitle?: string;
  country?: string;
  category?: string;
  rankType?: string;
  minRoas?: number;
  minSales?: number;
  limit?: number;
};

export type VideoSceneTruthListFilters = {
  source?: string;
  referenceVideoId?: string;
  creativePerformanceId?: string;
  videoUrl?: string;
  limit?: number;
};

function boundedListLimit(value: number | undefined, fallback = 50) {
  return clampNumber(Number(value || fallback), 1, 500);
}

function containsFilter(value: string | undefined) {
  return value ? { contains: value, mode: 'insensitive' as const } : undefined;
}

export async function upsertProductVocInsight(input: ProductVocInsightInput) {
  const data = {
    source: input.source || 'fastmoss',
    platform: input.platform || 'tiktok',
    sourceUrl: input.sourceUrl,
    productExternalId: input.productExternalId,
    productTitle: input.productTitle,
    category: input.category,
    analysisWindow: input.analysisWindow,
    analyzedCommentCount: input.analyzedCommentCount,
    consumerProfile: toJson(input.consumerProfile),
    starImpact: toJson(input.starImpact),
    usageScenarios: toJson(input.usageScenarios),
    positiveExperience: toJson(input.positiveExperience),
    negativeExperience: toJson(input.negativeExperience),
    purchaseMotives: toJson(input.purchaseMotives),
    unmetExpectations: toJson(input.unmetExpectations),
    summaryAdvice: input.summaryAdvice,
    raw: toJson(input.raw),
  };
  return getPrisma().productVocInsight.upsert({
    where: { id: input.id },
    create: { id: input.id, ...data },
    update: data,
  });
}

export async function listProductVocInsights(filters: ProductVocInsightListFilters = {}) {
  const where: Prisma.ProductVocInsightWhereInput = {
    source: filters.source || undefined,
    platform: filters.platform || undefined,
    productTitle: containsFilter(filters.productTitle),
    category: containsFilter(filters.category),
  };
  return getPrisma().productVocInsight.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: boundedListLimit(filters.limit),
    include: { reviews: { orderBy: { reviewedAt: 'desc' }, take: 5 } },
  });
}

export async function upsertProductReviewInsight(input: ProductReviewInsightInput) {
  const data = {
    vocInsightId: input.vocInsightId,
    source: input.source || 'fastmoss',
    platform: input.platform || 'tiktok',
    sourceUrl: input.sourceUrl,
    productTitle: input.productTitle,
    sku: input.sku,
    reviewedAt: input.reviewedAt,
    rating: input.rating,
    language: input.language,
    sentiment: input.sentiment,
    reviewText: input.reviewText,
    tags: toJson(input.tags),
    motives: toJson(input.motives),
    expectations: toJson(input.expectations),
    behaviors: toJson(input.behaviors),
    raw: toJson(input.raw),
  };
  return getPrisma().productReviewInsight.upsert({
    where: { id: input.id },
    create: { id: input.id, ...data },
    update: data,
  });
}

export async function listProductReviewInsights(filters: ProductReviewInsightListFilters = {}) {
  const where: Prisma.ProductReviewInsightWhereInput = {
    source: filters.source || undefined,
    platform: filters.platform || undefined,
    productTitle: containsFilter(filters.productTitle),
    sentiment: filters.sentiment || undefined,
    rating: filters.minRating === undefined ? undefined : { gte: filters.minRating },
  };
  return getPrisma().productReviewInsight.findMany({
    where,
    orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
    take: boundedListLimit(filters.limit, 100),
  });
}

export async function upsertCreativePerformance(input: CreativePerformanceInput) {
  const data = {
    source: input.source || 'fastmoss',
    platform: input.platform || 'tiktok',
    sourceUrl: input.sourceUrl,
    videoUrl: input.videoUrl,
    videoId: input.videoId,
    productTitle: input.productTitle,
    productUrl: input.productUrl,
    shopName: input.shopName,
    creatorHandle: input.creatorHandle,
    advertiserName: input.advertiserName,
    country: input.country,
    category: input.category,
    adCopy: input.adCopy,
    publishedAt: input.publishedAt,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    durationSeconds: input.durationSeconds,
    resolution: input.resolution,
    priceText: input.priceText,
    rankType: input.rankType,
    rank: input.rank,
    views: input.views,
    impressions: input.impressions,
    interactions: input.interactions,
    adSpend: input.adSpend,
    sales: input.sales,
    salesAmount: input.salesAmount,
    roas: input.roas,
    ctr: input.ctr,
    interactionRate: input.interactionRate,
    adDays: input.adDays,
    metrics: toJson(input.metrics),
    raw: toJson(input.raw),
  };
  return getPrisma().creativePerformance.upsert({
    where: { id: input.id },
    create: { id: input.id, ...data },
    update: data,
  });
}

export async function listCreativePerformances(filters: CreativePerformanceListFilters = {}) {
  const where: Prisma.CreativePerformanceWhereInput = {
    source: filters.source || undefined,
    platform: filters.platform || undefined,
    productTitle: containsFilter(filters.productTitle),
    country: filters.country || undefined,
    category: containsFilter(filters.category),
    rankType: filters.rankType || undefined,
    roas: filters.minRoas === undefined ? undefined : { gte: filters.minRoas },
    sales: filters.minSales === undefined ? undefined : { gte: filters.minSales },
  };
  return getPrisma().creativePerformance.findMany({
    where,
    orderBy: [
      { roas: { sort: 'desc', nulls: 'last' } },
      { sales: { sort: 'desc', nulls: 'last' } },
      { updatedAt: 'desc' },
    ],
    take: boundedListLimit(filters.limit, 100),
    include: { sceneTruths: { orderBy: { startMs: 'asc' }, take: 5 } },
  });
}

export async function upsertVideoSceneTruth(input: VideoSceneTruthInput) {
  const data = {
    referenceVideoId: input.referenceVideoId,
    creativePerformanceId: input.creativePerformanceId,
    source: input.source || 'fastmoss',
    videoUrl: input.videoUrl,
    sceneIndex: input.sceneIndex,
    startMs: input.startMs,
    endMs: input.endMs,
    summary: input.summary,
    transcript: input.transcript,
    labels: toJson(input.labels),
    ocrTexts: toJson(input.ocrTexts),
    subtitlePlan: toJson(input.subtitlePlan),
    visual: toJson(input.visual),
    raw: toJson(input.raw),
  };
  return getPrisma().videoSceneTruth.upsert({
    where: { id: input.id },
    create: { id: input.id, ...data },
    update: data,
  });
}

export async function listVideoSceneTruths(filters: VideoSceneTruthListFilters = {}) {
  const where: Prisma.VideoSceneTruthWhereInput = {
    source: filters.source || undefined,
    referenceVideoId: filters.referenceVideoId || undefined,
    creativePerformanceId: filters.creativePerformanceId || undefined,
    videoUrl: filters.videoUrl || undefined,
  };
  return getPrisma().videoSceneTruth.findMany({
    where,
    orderBy: [{ videoUrl: 'asc' }, { startMs: 'asc' }, { sceneIndex: 'asc' }],
    take: boundedListLimit(filters.limit, 100),
  });
}

export async function getFastMossIntelligenceStatus() {
  const [vocInsights, reviewInsights, creativePerformances, sceneTruths] = await getPrisma().$transaction([
    getPrisma().productVocInsight.count(),
    getPrisma().productReviewInsight.count(),
    getPrisma().creativePerformance.count(),
    getPrisma().videoSceneTruth.count(),
  ]);
  return {
    source: 'fastmoss',
    tables: {
      vocInsights,
      reviewInsights,
      creativePerformances,
      sceneTruths,
    },
  };
}

// ─── CloneCast Recipes ─────────────────────────────────────────────────────

export type RecipeInput = {
  id: string;
  sourceUrl?: string;
  sourceReferenceId?: string;
  sourceDeclaration: string;
  productId?: string;
  title: string;
  category?: string;
  durationSeconds?: number;
  pace?: string;
  segments: unknown[];
  factors: Record<string, unknown>;
  visual?: Record<string, unknown>;
  scoring?: Record<string, unknown>;
  status?: string;
};

export type RecipeCloneInput = {
  id: string;
  recipeId: string;
  productId: string;
  scriptId?: string;
  taskId?: string;
  status?: string;
  benchmarkScore?: number;
  missingFactors?: unknown[];
  scoreBreakdown?: Record<string, unknown>;
};

export async function upsertRecipe(input: RecipeInput) {
  return getPrisma().recipe.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      sourceUrl: input.sourceUrl,
      sourceReferenceId: input.sourceReferenceId,
      sourceDeclaration: input.sourceDeclaration,
      productId: input.productId,
      title: input.title,
      category: input.category,
      durationSeconds: input.durationSeconds,
      pace: input.pace,
      segments: toJson(input.segments) as Prisma.InputJsonValue,
      factors: toJson(input.factors) as Prisma.InputJsonValue,
      visual: toJson(input.visual),
      scoring: toJson(input.scoring),
      status: input.status || 'ready',
    },
    update: {
      sourceUrl: input.sourceUrl,
      sourceReferenceId: input.sourceReferenceId,
      sourceDeclaration: input.sourceDeclaration,
      productId: input.productId,
      title: input.title,
      category: input.category,
      durationSeconds: input.durationSeconds,
      pace: input.pace,
      segments: toJson(input.segments) as Prisma.InputJsonValue,
      factors: toJson(input.factors) as Prisma.InputJsonValue,
      visual: toJson(input.visual),
      scoring: toJson(input.scoring),
      status: input.status || 'ready',
    },
  });
}

export async function getRecipe(id: string) {
  return getPrisma().recipe.findUnique({ where: { id }, include: { clones: { orderBy: { createdAt: 'desc' } } } });
}

export async function listRecipes(input: { productId?: string; category?: string; limit?: number } = {}) {
  return getPrisma().recipe.findMany({
    where: {
      productId: input.productId || undefined,
      category: input.category || undefined,
    },
    orderBy: { createdAt: 'desc' },
    take: clampNumber(Number(input.limit || 50), 1, 200),
    include: { clones: { orderBy: { createdAt: 'desc' }, take: 5 } },
  });
}

export async function createRecipeClone(input: RecipeCloneInput) {
  return getPrisma().recipeClone.create({
    data: {
      id: input.id,
      recipeId: input.recipeId,
      productId: input.productId,
      scriptId: input.scriptId,
      taskId: input.taskId,
      status: input.status || 'queued',
      benchmarkScore: input.benchmarkScore,
      missingFactors: toJson(input.missingFactors),
      scoreBreakdown: toJson(input.scoreBreakdown),
    },
  });
}

export async function updateRecipeClone(
  id: string,
  input: {
    scriptId?: string | null;
    taskId?: string | null;
    status?: string;
    benchmarkScore?: number | null;
    missingFactors?: unknown[];
    scoreBreakdown?: Record<string, unknown>;
  },
) {
  return getPrisma().recipeClone.update({
    where: { id },
    data: {
      scriptId: input.scriptId,
      taskId: input.taskId,
      status: input.status,
      benchmarkScore: input.benchmarkScore,
      missingFactors: toJson(input.missingFactors),
      scoreBreakdown: toJson(input.scoreBreakdown),
    },
  });
}

// ─── EvidenceRecord ────────────────────────────────────────────────────────

export async function upsertEvidenceRecord(productId: string, output: Record<string, unknown>) {
  return getPrisma().evidenceRecord.upsert({
    where: { productId },
    create: { productId, output: toJson(output) as Prisma.InputJsonValue },
    update: { output: toJson(output) as Prisma.InputJsonValue },
  });
}

export async function getEvidenceRecord(productId: string) {
  return getPrisma().evidenceRecord.findUnique({ where: { productId } });
}

// ─── VideoPassportRecord ───────────────────────────────────────────────────

export type PassportInput = {
  videoId: string;
  scriptId: string;
  trustScore: number;
  evidenceCoverage: number;
  realMaterialRatio: number;
  approvedClaims: number;
  needsEvidenceClaims?: number;
  blockedClaims: number;
  repairedClaims: number;
  policyRisk: string;
  iterationCount: number;
  evidenceBreakdown: Record<string, unknown>;
  generatedAt: Date;
};

export async function upsertPassport(input: PassportInput) {
  return getPrisma().videoPassportRecord.upsert({
    where: { videoId: input.videoId },
    create: {
      ...input,
      evidenceBreakdown: toJson(input.evidenceBreakdown) as Prisma.InputJsonValue,
    },
    update: {
      trustScore: input.trustScore,
      evidenceCoverage: input.evidenceCoverage,
      realMaterialRatio: input.realMaterialRatio,
      approvedClaims: input.approvedClaims,
      needsEvidenceClaims: input.needsEvidenceClaims,
      blockedClaims: input.blockedClaims,
      repairedClaims: input.repairedClaims,
      policyRisk: input.policyRisk,
      iterationCount: input.iterationCount,
      evidenceBreakdown: toJson(input.evidenceBreakdown) as Prisma.InputJsonValue,
      generatedAt: input.generatedAt,
    },
  });
}

export async function getPassport(videoId: string) {
  return getPrisma().videoPassportRecord.findUnique({ where: { videoId } });
}

// ─── ComplianceCheckRecord ─────────────────────────────────────────────────

export type ComplianceCheckInput = {
  id: string;
  targetType: string;
  targetId: string;
  level: string;
  hits: unknown[];
};

export async function createComplianceCheck(input: ComplianceCheckInput) {
  return getPrisma().complianceCheckRecord.create({
    data: {
      id: input.id,
      targetType: input.targetType,
      targetId: input.targetId,
      level: input.level,
      hits: toJson(input.hits) as Prisma.InputJsonValue,
    },
  });
}

export async function updateComplianceCheck(
  id: string,
  input: { level?: string; resolvedBy?: string; resolution?: string },
) {
  return getPrisma().complianceCheckRecord.update({
    where: { id },
    data: input,
  });
}

export async function getComplianceCheck(id: string) {
  return getPrisma().complianceCheckRecord.findUnique({ where: { id } });
}

export async function listComplianceChecks(targetType?: string, targetId?: string) {
  return getPrisma().complianceCheckRecord.findMany({
    where: {
      targetType: targetType || undefined,
      targetId: targetId || undefined,
    },
    orderBy: { createdAt: 'desc' },
  });
}

// ─── VideoPerfRecord ───────────────────────────────────────────────────────

export type VideoPerfInput = {
  id: string;
  scriptId: string;
  videoId?: string;
  source?: string;
  factorSnapshot: unknown[];
  impressions: number;
  ctr: number;
  completionRate: number;
  conversionRate: number;
  gmv: number;
};

export async function createVideoPerfRecord(input: VideoPerfInput) {
  return getPrisma().videoPerfRecord.create({
    data: {
      id: input.id,
      scriptId: input.scriptId,
      videoId: input.videoId,
      source: input.source,
      factorSnapshot: toJson(input.factorSnapshot) as Prisma.InputJsonValue,
      impressions: input.impressions,
      ctr: input.ctr,
      completionRate: input.completionRate,
      conversionRate: input.conversionRate,
      gmv: input.gmv,
    },
  });
}

export async function listVideoPerfRecords(scriptId?: string, source?: string, limit = 10000) {
  return getPrisma().videoPerfRecord.findMany({
    where: {
      scriptId: scriptId || undefined,
      source: source || undefined,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function countVideoPerfRecords() {
  return getPrisma().videoPerfRecord.count();
}

// ─── MessageFeedbackRecord ─────────────────────────────────────────────────

export type MessageFeedbackInput = {
  id: string;
  messageId: string;
  productId?: string;
  reaction: string;
  note?: string;
};

export async function upsertMessageFeedback(input: MessageFeedbackInput) {
  return getPrisma().messageFeedbackRecord.upsert({
    where: { id: input.id },
    create: input,
    update: { reaction: input.reaction, note: input.note },
  });
}

export async function deleteMessageFeedbackByMessageId(messageId: string) {
  return getPrisma().messageFeedbackRecord.deleteMany({ where: { messageId } });
}

export async function listMessageFeedbacks(productId?: string) {
  return getPrisma().messageFeedbackRecord.findMany({
    where: { productId: productId || undefined },
    orderBy: { createdAt: 'desc' },
  });
}

// ─── FactorWeight ──────────────────────────────────────────────────────────

export async function upsertFactorWeight(factorId: string, weight: number, sampleSize: number) {
  return getPrisma().factorWeight.upsert({
    where: { factorId },
    create: { id: factorId, factorId, weight, sampleSize },
    update: { weight, sampleSize },
  });
}

export async function listFactorWeights() {
  return getPrisma().factorWeight.findMany({ orderBy: { updatedAt: 'desc' } });
}

// ─── EvolutionPoint ────────────────────────────────────────────────────────

export type EvolutionPointInput = {
  factorId: string;
  factorType: string;
  factorValue: string;
  weight: number;
  sampleSize: number;
};

export async function createEvolutionPoint(input: EvolutionPointInput) {
  return getPrisma().evolutionPoint.create({ data: input });
}

export async function listEvolutionPoints(factorId?: string, limit = 500) {
  return getPrisma().evolutionPoint.findMany({
    where: { factorId: factorId || undefined },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}

// ─── TrustLoopTrace ────────────────────────────────────────────────────────

export type TrustLoopTraceInput = {
  taskId: string;
  step: string;
  agentName?: string;
  message: string;
  data?: Record<string, unknown>;
};

export async function createTrustLoopTrace(input: TrustLoopTraceInput) {
  return getPrisma().trustLoopTrace.create({
    data: {
      taskId: input.taskId,
      step: input.step,
      agentName: input.agentName,
      message: input.message,
      data: toJson(input.data),
    },
  });
}

export async function listTrustLoopTraces(taskId: string) {
  return getPrisma().trustLoopTrace.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc' },
  });
}

// ─── AuditResultRecord ─────────────────────────────────────────────────────

export async function upsertAuditResult(
  taskId: string,
  scriptId: string,
  level: string,
  issues: unknown[],
  metrics: Record<string, unknown>,
) {
  return getPrisma().auditResultRecord.upsert({
    where: { taskId },
    create: {
      taskId,
      scriptId,
      level,
      issues: toJson(issues) as Prisma.InputJsonValue,
      metrics: toJson(metrics) as Prisma.InputJsonValue,
    },
    update: {
      level,
      issues: toJson(issues) as Prisma.InputJsonValue,
      metrics: toJson(metrics) as Prisma.InputJsonValue,
    },
  });
}

export async function getAuditResult(taskId: string) {
  return getPrisma().auditResultRecord.findUnique({ where: { taskId } });
}

// ─── TrustDAG ─────────────────────────────────────────────────────────────────

export type TrustNodeInput = {
  id: string; // = contentHash
  nodeType: 'evidence' | 'claim' | 'shot' | 'script' | 'video';
  parentIds: string[];
  contentHash: string;
  payload: Record<string, unknown>;
  runId?: string;
  taskId?: string;
  productId?: string;
  scriptId?: string;
};

export type TrustEdgeInput = {
  sourceId: string;
  targetId: string;
  edgeType: 'derives' | 'supports' | 'refutes' | 'uses';
  weight?: number;
  metadata?: Record<string, unknown>;
};

export async function upsertTrustNode(input: TrustNodeInput) {
  return getPrisma().trustNode.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      nodeType: input.nodeType,
      parentIds: input.parentIds,
      contentHash: input.contentHash,
      payload: toJson(input.payload) as Prisma.InputJsonValue,
      runId: input.runId,
      taskId: input.taskId,
      productId: input.productId,
      scriptId: input.scriptId,
    },
    update: {
      runId: input.runId,
      taskId: input.taskId,
      productId: input.productId,
      scriptId: input.scriptId,
    },
  });
}

export async function createTrustEdge(input: TrustEdgeInput) {
  return getPrisma().trustEdge.upsert({
    where: {
      sourceId_targetId_edgeType: {
        sourceId: input.sourceId,
        targetId: input.targetId,
        edgeType: input.edgeType,
      },
    },
    create: {
      sourceId: input.sourceId,
      targetId: input.targetId,
      edgeType: input.edgeType,
      weight: input.weight ?? 1.0,
      metadata: input.metadata ? (toJson(input.metadata) as Prisma.InputJsonValue) : undefined,
    },
    update: {
      weight: input.weight ?? 1.0,
      metadata: input.metadata ? (toJson(input.metadata) as Prisma.InputJsonValue) : undefined,
    },
  });
}

export type TrustTraversalDirection = 'dependencies' | 'dependents' | 'both';

export async function getTrustSubgraph(
  rootId: string,
  maxDepth = 5,
  direction: TrustTraversalDirection = 'dependencies',
) {
  type NodeRow = Awaited<ReturnType<ReturnType<typeof getPrisma>['trustNode']['findUnique']>>;
  type EdgeRow = Awaited<ReturnType<ReturnType<typeof getPrisma>['trustEdge']['findMany']>>[number];

  const visited = new Set<string>();
  const nodes: NonNullable<NodeRow>[] = [];
  const edgeMap = new Map<string, EdgeRow>();

  async function traverse(id: string, depth: number) {
    if (depth > maxDepth || visited.has(id)) return;
    visited.add(id);
    const node = await getPrisma().trustNode.findUnique({ where: { id } });
    if (node) nodes.push(node);
    if (depth === maxDepth) return;
    const edges = await getPrisma().trustEdge.findMany({
      where:
        direction === 'dependencies'
          ? { sourceId: id }
          : direction === 'dependents'
            ? { targetId: id }
            : { OR: [{ sourceId: id }, { targetId: id }] },
    });
    for (const edge of edges) {
      edgeMap.set(edge.id, edge);
      const nextId =
        direction === 'dependencies'
          ? edge.targetId
          : direction === 'dependents'
            ? edge.sourceId
            : edge.sourceId === id
              ? edge.targetId
              : edge.sourceId;
      await traverse(nextId, depth + 1);
    }
  }

  await traverse(rootId, 0);
  return { nodes, edges: [...edgeMap.values()] };
}

export async function listTrustNodes(filter: {
  productId?: string;
  scriptId?: string;
  nodeType?: string;
  status?: 'active' | 'stale';
}) {
  return getPrisma().trustNode.findMany({
    where: {
      ...(filter.productId ? { productId: filter.productId } : {}),
      ...(filter.scriptId ? { scriptId: filter.scriptId } : {}),
      ...(filter.nodeType ? { nodeType: filter.nodeType } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function findLatestTrustScriptNode(scriptId: string) {
  return getPrisma().trustNode.findFirst({
    where: { scriptId, nodeType: 'script' },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Edges point from a derived output to its dependency, for example
 * `shot -> claim -> evidence`. Invalidating evidence therefore follows inbound
 * edges to mark every derived output stale.
 */
export async function cascadeTrustNodeStale(rootId: string, reason: string, invalidatedById = rootId) {
  const visited = new Set<string>();
  const pending = [rootId];

  while (pending.length) {
    const nodeId = pending.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const dependentEdges = await getPrisma().trustEdge.findMany({ where: { targetId: nodeId } });
    for (const edge of dependentEdges) pending.push(edge.sourceId);
  }

  if (visited.size === 0) return [];
  const staleAt = new Date();
  await getPrisma().trustNode.updateMany({
    where: { id: { in: [...visited] } },
    data: { status: 'stale', staleAt, staleReason: reason, invalidatedById },
  });
  return getPrisma().trustNode.findMany({
    where: { id: { in: [...visited] } },
    orderBy: { createdAt: 'asc' },
  });
}

// ─── HTTP idempotency ─────────────────────────────────────────────────────────

export type ApiIdempotencyInput = {
  key: string;
  route: string;
  requestHash: string;
  expiresAt: Date;
};

export async function reserveApiIdempotency(input: ApiIdempotencyInput) {
  const client = getPrisma();
  const existing = await client.apiIdempotencyRecord.findUnique({ where: { key: input.key } });
  if (existing && existing.expiresAt <= new Date()) {
    await client.apiIdempotencyRecord.delete({ where: { key: input.key } });
  } else if (existing) {
    return { reserved: false, record: existing };
  }

  try {
    const record = await client.apiIdempotencyRecord.create({ data: input });
    return { reserved: true, record };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return {
        reserved: false,
        record: await client.apiIdempotencyRecord.findUniqueOrThrow({ where: { key: input.key } }),
      };
    }
    throw error;
  }
}

export async function completeApiIdempotency(key: string, statusCode: number, response: unknown) {
  return getPrisma().apiIdempotencyRecord.update({
    where: { key },
    data: {
      status: statusCode >= 500 ? 'failed' : 'completed',
      statusCode,
      response: toJson(response) as Prisma.InputJsonValue,
    },
  });
}

// ─── Tournament ────────────────────────────────────────────────────────────────

export type CreateTournamentRunInput = {
  productId: string;
  baseScriptId?: string;
  maxGens?: number;
  populationN?: number;
  config?: Record<string, unknown>;
};

export async function createTournamentRun(input: CreateTournamentRunInput) {
  return getPrisma().tournamentRun.create({
    data: {
      productId: input.productId,
      baseScriptId: input.baseScriptId,
      status: 'running',
      maxGens: input.maxGens ?? 5,
      populationN: input.populationN ?? 10,
      config: input.config ? (toJson(input.config) as Prisma.InputJsonValue) : undefined,
    },
  });
}

export async function updateTournamentRun(
  id: string,
  patch: { status?: string; generation?: number; winnerId?: string },
) {
  return getPrisma().tournamentRun.update({ where: { id }, data: patch });
}

export async function getTournamentRun(id: string) {
  return getPrisma().tournamentRun.findUnique({
    where: { id },
    include: { variants: { orderBy: [{ generation: 'asc' }, { compositeScore: 'desc' }] } },
  });
}

export async function listTournamentRuns(productId: string) {
  return getPrisma().tournamentRun.findMany({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    include: {
      variants: {
        where: { status: { in: ['survivor', 'scored'] } },
        orderBy: { compositeScore: 'desc' },
        take: 3,
      },
    },
  });
}

export type CreateTournamentVariantInput = {
  tournamentId: string;
  generation: number;
  parentIds: string[];
  genes: Record<string, unknown>[];
  scriptSnapshot: Record<string, unknown>;
};

export async function createTournamentVariant(input: CreateTournamentVariantInput) {
  return getPrisma().tournamentVariant.create({
    data: {
      tournamentId: input.tournamentId,
      generation: input.generation,
      parentIds: input.parentIds,
      genes: toJson(input.genes) as Prisma.InputJsonValue,
      scriptSnapshot: toJson(input.scriptSnapshot) as Prisma.InputJsonValue,
      status: 'pending',
    },
  });
}

export async function scoreTournamentVariant(
  id: string,
  scores: { llmScore: number; ctrScore: number; compositeScore: number; scoreBreakdown: Record<string, unknown> },
) {
  return getPrisma().tournamentVariant.update({
    where: { id },
    data: {
      llmScore: scores.llmScore,
      ctrScore: scores.ctrScore,
      compositeScore: scores.compositeScore,
      scoreBreakdown: toJson(scores.scoreBreakdown) as Prisma.InputJsonValue,
      status: 'scored',
    },
  });
}

export async function markTournamentSurvivors(tournamentId: string, survivorIds: string[]) {
  const survivorSet = new Set(survivorIds);
  const variants = await getPrisma().tournamentVariant.findMany({ where: { tournamentId, status: 'scored' } });
  await Promise.all(
    variants.map((v) =>
      getPrisma().tournamentVariant.update({
        where: { id: v.id },
        data: { status: survivorSet.has(v.id) ? 'survivor' : 'eliminated' },
      }),
    ),
  );
}
