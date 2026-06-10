import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import {
  createScriptWithShots,
  getMaterial,
  getScript,
  listFactorWeights,
  listMaterials,
  refreshTrendDatabase,
  reindexQdrantRetrievalDatabase,
  replaceMaterialAngles,
  replaceMaterialSlices,
  searchSlices,
  updateShotAsset,
  updateTask,
  type ProductionFactor,
  type ProductionMaterialAngleInput,
  type ProductionScriptInput,
  type ProductionShotInput,
  type ProductionSliceInput,
} from '@aigc-video-hub/db';
import { createStorageClient } from '@aigc-video-hub/storage';
import { generateDoubaoScript, isDoubaoConfigured, type DoubaoMaterialSlice } from './doubao';
import {
  addSubtitleLayer,
  addVoiceoverLayer,
  commandOk,
  concatWithTransitions,
  extractLastFrame,
  trimVideoSegment,
  type TransitionPlan,
} from './ffmpeg';
import {
  buildLocalAngleSvg,
  generateQwenAngleImage,
  imageExtension,
  isQwenAngleProviderConfigured,
  MATERIAL_ANGLE_SPECS,
  normalizeCustomAngleSpecs,
  safeProviderError,
  sanitizeAngleKey,
  type MaterialAngleSpec,
} from './material-angles';
import {
  generateGptImage2ContinuousLastFrame,
  generateGptImage2ProductReference,
  isGptImage2Configured,
  safeGptImage2Error,
} from './gptimage2';
import {
  decideQwenSubtitlePlacement,
  isPublicVideoUrlForQwen,
  isQwenVlConfigured,
  isQwenVlMediaUploadConfigured,
  uploadQwenVlMedia,
} from './qwenvl';
import {
  buildSeedancePrompt,
  buildSeedanceWholeVideoPrompt,
  isSeedanceConfigured,
  requestSeedanceVideoWithRetry,
} from './seedance';
import {
  applyQwenSubtitleDecisions,
  buildSubtitleOverlayPlan,
  readSubtitleMode,
  readSubtitlePlacementProvider,
  summarizeSubtitlePlan,
  type ComposerSubtitlePlanItem,
  type SubtitleOverlayPlan,
} from './subtitles';

export type ProcessorToolTracer = <T>(
  toolName: string,
  input: Record<string, unknown>,
  run: () => Promise<T>,
  summarize: (result: T) => Record<string, unknown>,
) => Promise<T>;

type ScriptGenerateData = {
  taskId: string;
  productId: string;
  mode: 'imitate' | 'template' | 'auto';
  provider: 'auto' | 'local' | 'doubao';
  retrievalMode: 'rag' | 'none';
  generationProfile?: 'quick_preview' | 'trusted_publish';
  ref?: string;
  freePrompt?: string;
  referenceImageUrl?: string;
  approvedClaims?: GroundedClaim[];
  evidence?: GroundedEvidence[];
  hotVideoDna?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
  traceTool?: ProcessorToolTracer;
};

type GroundedClaim = {
  id: string;
  text: string;
  category?: string;
  evidenceIds: string[];
  confidence?: number;
};

type GroundedEvidence = {
  id: string;
  text?: string;
  sourceTitle?: string;
  sourceUrl?: string;
};

type MaterialSliceData = {
  taskId: string;
  materialId: string;
  seedText: string;
};

type MaterialAngleData = {
  taskId: string;
  materialId: string;
  force?: boolean;
  includePresets?: boolean;
  customAngles?: unknown;
};

type PublicMaterialAngle = Omit<ProductionMaterialAngleInput, 'createdAt' | 'pose'> & {
  pose?: Record<string, unknown>;
  createdAt: string;
};

type VideoTagsReindexData = {
  taskId: string;
  reason?: string;
};

type TrendRefreshData = {
  taskId: string;
  productId?: string;
  source?: string;
};

type RenderPlanInput = {
  shotId: string;
  action?: 'generate';
  score?: number;
  transition?: 'hard_cut' | 'fade' | 'whip';
  reason?: string;
  referenceSliceIds?: string[];
};

type RenderDecision = {
  shotId: string;
  order: number;
  requestedAction: 'generate';
  action: 'generate';
  score?: number;
  provider: string;
  assetObjectKey?: string;
  assetUrl?: string;
  referenceImageSource?: string;
  referenceImageUrl?: string;
  referenceObjectKey?: string;
  lastFrameImageSource?: string;
  lastFrameImageUrl?: string;
  lastFrameObjectKey?: string;
  fallbackReason?: string;
};

type RenderFullData = {
  taskId: string;
  scriptId: string;
  exportOptions: Record<string, unknown>;
  renderPlan?: RenderPlanInput[];
  subtitlePlan?: ComposerSubtitlePlanItem[];
  traceTool?: ProcessorToolTracer;
};

type RenderShotData = {
  taskId: string;
  scriptId: string;
  shotId: string;
  provider: 'auto' | 'local' | 'seedance';
  referenceImageUrl?: string;
  referenceAnglePrompt?: string;
  preview?: boolean;
  traceTool?: ProcessorToolTracer;
};

let storage: ReturnType<typeof createStorageClient> | undefined;

function getStorage() {
  if (!storage) storage = createStorageClient();
  return storage;
}

async function traceExternal<T>(
  tracer: ProcessorToolTracer | undefined,
  toolName: string,
  input: Record<string, unknown>,
  run: () => Promise<T>,
  summarize: (result: T) => Record<string, unknown>,
) {
  return tracer ? tracer(toolName, input, run, summarize) : run();
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function readText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envFlag(name: string) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env[name] || '')
      .trim()
      .toLowerCase(),
  );
}

function textWords(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
}

function flattenTagStrings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap((item) => flattenTagStrings(item));
  if (value && typeof value === 'object') return Object.values(value).flatMap((item) => flattenTagStrings(item));
  return [];
}

function escapeXml(value: unknown) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAspectRatio(value: unknown): '9:16' | '16:9' {
  return value === '16:9' ? '16:9' : '9:16';
}

function endingFor(productLabel: string) {
  return {
    visualDesc: `${productLabel} 回到完整商品与使用场景，画面清楚交代适用人群和查看页面信息`,
    narration: '最后还是看自己的场景是否匹配，规格和权益以页面实时信息为准。',
    subtitle: '按真实需求判断',
    factor: { type: 'cta', value: 'benefit', sourceStrategy: 'safe_cta' },
  };
}

// 兜底因子也走 mock-ctr 枚举（与 doubao.ts FACTOR_TAXONOMY 对齐），保证回流数据干净。
function defaultFactors(): Record<string, ProductionFactor> {
  return {
    hook: { type: 'hook', value: 'question', sourceStrategy: 'production_local' },
    cameraPush: { type: 'camera', value: 'push', sourceStrategy: 'production_local' },
    cameraStatic: { type: 'camera', value: 'static', sourceStrategy: 'production_local' },
    proof: { type: 'proof', value: 'demonstration', sourceStrategy: 'production_local' },
    bgm: { type: 'bgm', value: 'upbeat', sourceStrategy: 'production_local' },
    cta: { type: 'cta', value: 'benefit', sourceStrategy: 'safe_cta' },
  };
}

// 显示用文本（与上面的枚举因子分离，避免把 'question'/'upbeat' 写进展示字段）
const FALLBACK_VISUAL_STYLE = '清爽高质感';
const FALLBACK_BGM_TEXT = '轻快电子';
const FALLBACK_HOOK_LABEL = '问题式开场';

function safeMarketingText(value: string) {
  return value
    .replace(/第一|最强|永久|100%|治愈|保证|绝对/g, '真实场景')
    .replace(/\s+/g, ' ')
    .trim();
}

function appendUnique<T>(items: T[], ...nextItems: T[]) {
  return [...new Set([...items, ...nextItems])];
}

function formatFactorHint(row: { factorId: string; weight: number; sampleSize: number }): string {
  const lift = `${row.weight >= 0 ? '+' : ''}${(row.weight * 100).toFixed(1)}%`;
  return `${row.factorId} (lift ${lift}, n=${row.sampleSize})`;
}

// 归因因子双向引导：prefer=高转化因子（鼓励采用），avoid=低转化因子（提示规避）。
// 来源 FactorWeight（creator-disjoint 归因，详见 docs/architecture.md）。
async function loadFactorHints(preferLimit = 6, avoidLimit = 4): Promise<{ prefer: string[]; avoid: string[] }> {
  const rows = (await listFactorWeights().catch(() => [])).filter((row) => Number.isFinite(row.weight));
  const ranked = [...rows].sort((a, b) => b.weight - a.weight);
  return {
    prefer: ranked
      .filter((row) => row.weight > 0)
      .slice(0, preferLimit)
      .map(formatFactorHint),
    avoid: ranked
      .filter((row) => row.weight < 0)
      .slice(-avoidLimit)
      .reverse()
      .map(formatFactorHint),
  };
}

function groundingFactor(claim: GroundedClaim): ProductionFactor {
  return {
    type: '证据绑定',
    value: `${claim.id}:${claim.evidenceIds.slice(0, 2).join(',')}`,
    sourceStrategy: 'policy_grounding_agent',
  };
}

function applyPolicyGrounding(input: {
  script: ProductionScriptInput;
  approvedClaims?: GroundedClaim[];
  evidence?: GroundedEvidence[];
  hotVideoDna?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
}) {
  const approvedClaims = (input.approvedClaims || []).filter(
    (claim) => claim.id && claim.text && claim.evidenceIds.length > 0,
  );
  if (!approvedClaims.length) {
    return {
      ...input.script,
      constraints: appendUnique(
        input.script.constraints,
        '本次无 approved claim，剧本只能使用商品名、真实素材和保守场景表达。',
      ),
    };
  }

  const evidenceIds = new Set((input.evidence || []).map((item) => item.id));
  const shots = input.script.shots.map((shot, index) => {
    const currentClaim = approvedClaims.find((claim) => shot.claimIds?.includes(claim.id));
    const claim = currentClaim || approvedClaims[index % approvedClaims.length];
    const validEvidenceIds = claim.evidenceIds.filter((id) => !evidenceIds.size || evidenceIds.has(id));
    const boundEvidenceIds = validEvidenceIds.length ? validEvidenceIds : claim.evidenceIds;
    const claimText = safeMarketingText(claim.text).slice(0, 90);
    const shouldUseClaimText = index > 0 && index < input.script.shots.length - 1;

    return {
      ...shot,
      visualDesc: `${shot.visualDesc}；画面必须能支撑已审核卖点：${claimText}`,
      narration: shouldUseClaimText ? claimText : shot.narration,
      subtitle: shouldUseClaimText ? claimText.slice(0, 24) : shot.subtitle,
      claimIds: [claim.id],
      evidenceIds: boundEvidenceIds,
      factors: [...shot.factors, groundingFactor({ ...claim, evidenceIds: boundEvidenceIds })],
    };
  });

  const hook = typeof input.hotVideoDna?.hook === 'string' ? input.hotVideoDna.hook : '';
  const factorPolicy =
    typeof input.strategy?.factorPolicy === 'string' ? input.strategy.factorPolicy : 'evidence_first';

  return {
    ...input.script,
    narrative: `${input.script.narrative} 创作策略=${factorPolicy}${hook ? `，Hook=${hook}` : ''}。`,
    constraints: appendUnique(
      input.script.constraints,
      '所有卖点必须来自 Policy Agent approvedClaims。',
      '每个分镜必须绑定 claimIds 和 evidenceIds，QA 可反查。',
      `approvedClaims=${approvedClaims.length}`,
    ),
    shots,
  };
}

function buildProductionScript(input: {
  productId: string;
  mode: 'imitate' | 'template' | 'auto';
  ref?: string;
  freePrompt?: string;
  referenceImageUrl?: string;
  materialIds: string[];
  reusableSliceIds: string[];
  aspectRatio?: '9:16' | '16:9';
}): ProductionScriptInput {
  const factors = defaultFactors();
  const productLabel = readText(input.freePrompt, input.productId || '演示商品');
  const ending = endingFor(productLabel);
  const scriptId = makeId('script');
  const shots: ProductionShotInput[] = [
    {
      id: makeId('shot'),
      order: 1,
      duration: 3,
      visualDesc: `${productLabel} 真实使用顾虑开场，商品主体 1 秒内出现`,
      camera: '快速推进 + 轻微手持感',
      narration: `先看 ${productLabel} 在真实场景里能不能解决具体麻烦。`,
      subtitle: '先看真实场景',
      factors: [factors.hook, factors.cameraPush],
      status: 'draft',
    },
    {
      id: makeId('shot'),
      order: 2,
      duration: 3,
      visualDesc: `${productLabel} 细节证据特写，放大一个可验证细节`,
      camera: '微距平移',
      narration: '真正影响体验的，往往是这个容易被忽略的小细节。',
      subtitle: '细节决定体验',
      factors: [factors.proof, factors.cameraStatic],
      status: 'draft',
    },
    {
      id: makeId('shot'),
      order: 3,
      duration: 3,
      visualDesc: `${productLabel} 使用场景演示，手部操作、前后对比、生活化环境`,
      camera: '跟拍',
      narration: '放到真实使用场景里，才知道它是不是只好看、不好用。',
      subtitle: '场景里见真章',
      factors: [factors.proof, factors.cameraPush],
      status: 'draft',
    },
    {
      id: makeId('shot'),
      order: 4,
      duration: 3,
      visualDesc: `${productLabel} 与真实使用场景并列展示，用无字图标、留白卡片和人物动作暗示适用人群，不出现可读文字`,
      camera: '固定构图 + 轻微推近',
      narration: '适合谁、不适合谁，先讲清楚，比一句好用更有用。',
      subtitle: '先判断适不适合',
      factors: [factors.bgm, factors.cameraStatic],
      status: 'draft',
    },
    {
      id: makeId('shot'),
      order: 5,
      duration: 3,
      visualDesc: ending.visualDesc,
      camera: '轻微拉远',
      narration: ending.narration,
      subtitle: ending.subtitle,
      factors: [ending.factor, factors.bgm],
      status: 'draft',
    },
  ];

  return {
    id: scriptId,
    productId: input.productId,
    referenceImageUrl: input.referenceImageUrl,
    materialIds: input.materialIds,
    sourceMode: input.mode,
    sourceRef: input.ref,
    narrative: `${FALLBACK_HOOK_LABEL}切入，用真实素材证据把 ${productLabel} 的了解前顾虑讲清楚。`,
    visualStyle: FALLBACK_VISUAL_STYLE,
    bgm: FALLBACK_BGM_TEXT,
    aspectRatio: input.aspectRatio || '9:16',
    language: 'zh-CN',
    constraints: ['总时长不超过15秒', '素材必须有来源声明', '不得复刻公开视频', '不得使用绝对化功效承诺'],
    shots,
  };
}

function buildSlices(input: {
  material: NonNullable<Awaited<ReturnType<typeof getMaterial>>>;
  seedText: string;
}): ProductionSliceInput[] {
  const baseTags = ['商品', input.material.type === 'video' ? '视频素材' : '图片素材'];
  const specs = [
    { label: '开场主视觉', start: 0, end: 3, extra: ['开场', 'hook'] },
    { label: '细节证据', start: 3, end: 6, extra: ['细节', '证据'] },
    { label: '使用场景', start: 6, end: 9, extra: ['演示', '场景'] },
  ];

  return specs.map((spec) => ({
    id: makeId('slice'),
    materialId: input.material.id,
    thumbnailUrl: input.material.sourceUrl,
    clipUrl: input.material.sourceUrl,
    startTime: input.material.type === 'video' ? spec.start : 0,
    endTime: input.material.type === 'video' ? spec.end : 3,
    tags: {
      product: baseTags,
      video: spec.extra,
      slice: [spec.label, ...textWords(input.seedText).slice(0, 4)],
    },
    summary: `${input.material.sourceDeclaration || '商家素材'} · ${spec.label}，可用于${spec.extra.join('、')}分镜。`,
  }));
}

async function putTextObject(key: string, body: string, contentType: string, traceTool?: ProcessorToolTracer) {
  return traceExternal(
    traceTool,
    'storage.putObject',
    { key, contentType, byteLength: Buffer.byteLength(body, 'utf8') },
    async () => {
      const client = getStorage();
      const stored = await client.putObject({ key, body, contentType });
      return {
        key: stored.key,
        url: stored.url || (await client.getSignedUrl(stored.key)),
      };
    },
    (stored) => ({ key: stored.key, url: stored.url, contentType }),
  );
}

async function putFileObject(key: string, filePath: string, contentType: string, traceTool?: ProcessorToolTracer) {
  return traceExternal(
    traceTool,
    'storage.putObject',
    { key, contentType, fileName: path.basename(filePath), byteLength: fs.statSync(filePath).size },
    async () => {
      const client = getStorage();
      const stored = await client.putObject({ key, body: fs.createReadStream(filePath), contentType });
      return {
        key: stored.key,
        url: stored.url || (await client.getSignedUrl(stored.key)),
      };
    },
    (stored) => ({ key: stored.key, url: stored.url, contentType }),
  );
}

function objectPublicUrl(key: string) {
  const publicBaseUrl = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!publicBaseUrl) return '';
  return `${publicBaseUrl}/${key
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

async function resolveObjectUrl(key: string) {
  return objectPublicUrl(key) || (await getStorage().getSignedUrl(key, 86400 * 7));
}

async function putBufferObject(key: string, body: Buffer | string, contentType: string) {
  const client = getStorage();
  const stored = await client.putObject({ key, body, contentType });
  return {
    key: stored.key,
    url: stored.url || objectPublicUrl(stored.key) || (await client.getSignedUrl(stored.key, 86400 * 7)),
  };
}

async function resolveMaterialSourceUrl(material: NonNullable<Awaited<ReturnType<typeof getMaterial>>>) {
  if (material.sourceObjectKey) {
    try {
      return await resolveObjectUrl(material.sourceObjectKey);
    } catch {
      return material.sourceUrl;
    }
  }
  return material.sourceUrl;
}

async function cacheAngleImageToStorage(materialId: string, spec: MaterialAngleSpec, imageUrl: string) {
  const dataMatch = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataMatch) {
    const ext = imageExtension(dataMatch[1]);
    return putBufferObject(
      `material-angles/${sanitizeAngleKey(materialId)}_${sanitizeAngleKey(spec.key)}.${ext}`,
      Buffer.from(dataMatch[2], 'base64'),
      dataMatch[1],
    );
  }

  const response = await axios.get<ArrayBuffer>(imageUrl, {
    responseType: 'arraybuffer',
    timeout: Number(process.env.QWEN_IMAGE_FETCH_TIMEOUT_MS || 30_000),
  });
  const contentType = String(response.headers['content-type'] || 'image/jpeg').split(';')[0];
  const ext = imageExtension(contentType, imageUrl);
  return putBufferObject(
    `material-angles/${sanitizeAngleKey(materialId)}_${sanitizeAngleKey(spec.key)}.${ext}`,
    Buffer.from(response.data),
    contentType,
  );
}

async function cacheGeneratedImageToStorage(imageUrl: string, keyBase: string, traceTool?: ProcessorToolTracer) {
  const dataMatch = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataMatch) {
    const contentType = dataMatch[1];
    const ext = imageExtension(contentType);
    return traceExternal(
      traceTool,
      'storage.putObject',
      { key: `${keyBase}.${ext}`, contentType, sourceType: 'data_url' },
      () => putBufferObject(`${keyBase}.${ext}`, Buffer.from(dataMatch[2], 'base64'), contentType),
      (stored) => ({ key: stored.key, url: stored.url, contentType }),
    );
  }

  const response = await axios.get<ArrayBuffer>(imageUrl, {
    responseType: 'arraybuffer',
    timeout: Number(process.env.GPTIMAGE2_IMAGE_FETCH_TIMEOUT_MS || 45_000),
  });
  const contentType = String(response.headers['content-type'] || 'image/png').split(';')[0];
  const ext = imageExtension(contentType, imageUrl);
  return traceExternal(
    traceTool,
    'storage.putObject',
    { key: `${keyBase}.${ext}`, contentType, sourceType: 'remote_url' },
    () => putBufferObject(`${keyBase}.${ext}`, Buffer.from(response.data), contentType),
    (stored) => ({ key: stored.key, url: stored.url, contentType }),
  );
}

async function createLocalMaterialAngle(
  material: NonNullable<Awaited<ReturnType<typeof getMaterial>>>,
  spec: MaterialAngleSpec,
  sourceUrl: string,
  note: string,
): Promise<ProductionMaterialAngleInput> {
  const key = `material-angles/${sanitizeAngleKey(material.id)}_${sanitizeAngleKey(spec.key)}_preview.svg`;
  const stored = await putBufferObject(key, buildLocalAngleSvg({ sourceUrl, spec }), 'image/svg+xml');
  return {
    id: `angle_${material.id}_${sanitizeAngleKey(spec.key)}`,
    materialId: material.id,
    productId: material.productId || undefined,
    view: spec.view,
    key: spec.key,
    label: spec.label,
    imageUrl: stored.url,
    referenceImageUrl: sourceUrl,
    previewUrl: stored.url,
    sourceImageUrl: sourceUrl,
    promptHint: spec.promptHint,
    pose: spec.pose,
    provider: 'local',
    status: 'fallback',
    note,
    createdAt: new Date(),
  };
}

async function createQwenMaterialAngle(
  material: NonNullable<Awaited<ReturnType<typeof getMaterial>>>,
  spec: MaterialAngleSpec,
  sourceUrl: string,
): Promise<ProductionMaterialAngleInput> {
  const result = await generateQwenAngleImage({
    sourceImageUrl: sourceUrl,
    spec,
    productName: material.name,
  });
  const cached = await cacheAngleImageToStorage(material.id, spec, result.imageUrl);
  return {
    id: `angle_${material.id}_${sanitizeAngleKey(spec.key)}`,
    materialId: material.id,
    productId: material.productId || undefined,
    view: spec.view,
    key: spec.key,
    label: spec.label,
    imageUrl: cached.url,
    referenceImageUrl: cached.url,
    previewUrl: cached.url,
    sourceImageUrl: sourceUrl,
    promptHint: spec.promptHint,
    pose: spec.pose,
    provider: 'qwen',
    status: 'ready',
    createdAt: new Date(),
  };
}

function publicMaterialAngle(input: ProductionMaterialAngleInput): PublicMaterialAngle {
  return {
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
    pose: input.pose,
    provider: input.provider,
    status: input.status,
    note: input.note,
    createdAt: (input.createdAt || new Date()).toISOString(),
  };
}

function publicMaterialAngleRow(row: NonNullable<Awaited<ReturnType<typeof getMaterial>>>['angles'][number]) {
  return {
    id: row.id,
    materialId: row.materialId,
    productId: row.productId || undefined,
    view: row.view,
    key: row.key,
    label: row.label,
    imageUrl: row.imageUrl,
    referenceImageUrl: row.referenceImageUrl,
    previewUrl: row.previewUrl || undefined,
    sourceImageUrl: row.sourceImageUrl,
    promptHint: row.promptHint,
    pose: (row.pose as Record<string, unknown> | null) || undefined,
    provider: row.provider,
    status: row.status,
    note: row.note || undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function readAudioMode(value: unknown): 'original' | 'voiceover' | 'mute' {
  return value === 'voiceover' || value === 'mute' || value === 'original' ? value : 'voiceover';
}

function readRenderProvider(value: unknown): 'auto' | 'local' | 'seedance' {
  // 成片视频不再允许 local 或素材裁切结果进入最终输出；auto 也收敛为 Seedance。
  return value === 'seedance' || value === 'auto' || value === 'local' ? 'seedance' : 'seedance';
}

function readResolution(value: unknown) {
  return readText(value, '720x1280');
}

function isVideoAsset(value: unknown) {
  return typeof value === 'string' && /\.(mp4|mov|webm|m3u8)(\?|$)/i.test(value);
}

function mediaExtension(url: string) {
  const clean = url.split('?')[0].toLowerCase();
  const ext = path.extname(clean).replace('.', '');
  return ext === 'mov' || ext === 'webm' || ext === 'm3u8' ? ext : 'mp4';
}

function renderMetrics(decisions: RenderDecision[], subtitlePlan?: SubtitleOverlayPlan) {
  const totalShots = decisions.length;
  const reusedMaterialShots = 0;
  const generatedShots = decisions.filter((decision) => decision.action === 'generate').length;
  return {
    totalShots,
    reusedMaterialShots,
    generatedShots,
    materialReuseRatio: totalShots ? Number((reusedMaterialShots / totalShots).toFixed(4)) : 0,
    decisions,
    subtitlePlan: subtitlePlan ? summarizeSubtitlePlan(subtitlePlan) : undefined,
  };
}

function readSubtitleFontSize(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 24 && parsed <= 96 ? parsed : undefined;
}

async function decideSubtitlePlanWithQwen(input: {
  taskId: string;
  script: NonNullable<Awaited<ReturnType<typeof getScript>>>;
  rawOutput: string;
  aspectRatio: '9:16' | '16:9';
  candidatePlan: SubtitleOverlayPlan;
  localFallbackPlan: SubtitleOverlayPlan;
  traceTool?: ProcessorToolTracer;
}) {
  if (!input.candidatePlan.events.length) return input.candidatePlan;
  if (input.candidatePlan.provider === 'local') return input.candidatePlan;
  if (!isQwenVlConfigured()) {
    return { ...input.localFallbackPlan, qwenNote: '未配置 Qwen-VL，使用 Composer 本地保守字幕计划。' };
  }

  const key = `render/${input.script.id}/${input.taskId}/subtitle_advisor_source.mp4`;
  const uploaded = await putFileObject(key, input.rawOutput, 'video/mp4', input.traceTool);
  let videoUrl = [objectPublicUrl(key), uploaded.url].find((url) => url && isPublicVideoUrlForQwen(url));
  let mediaUploadProvider = '';
  if (!videoUrl && isQwenVlMediaUploadConfigured()) {
    const media = await traceExternal(
      input.traceTool,
      'media.qwenvlUpload',
      { fileName: path.basename(input.rawOutput), byteLength: fs.statSync(input.rawOutput).size },
      () =>
        uploadQwenVlMedia({
          filePath: input.rawOutput,
          contentType: 'video/mp4',
          fileName: `${input.script.id}_${input.taskId}_subtitle_advisor.mp4`,
        }),
      (result) => ({
        mediaId: result.mediaId,
        mediaType: result.mediaType,
        urlAccessible: isPublicVideoUrlForQwen(result.url),
      }),
    );
    if (isPublicVideoUrlForQwen(media.url)) {
      videoUrl = media.url;
      mediaUploadProvider = 'qingyun';
    }
  }
  if (!videoUrl) {
    return {
      ...input.localFallbackPlan,
      qwenNote: '对象存储和媒体上传均未提供 Qwen-VL 可访问的公网 URL，使用 Composer 本地保守字幕计划。',
    };
  }

  const advice = await traceExternal(
    input.traceTool,
    'model.qwenvlSubtitleDecision',
    {
      candidateCount: input.candidatePlan.events.length,
      videoUrlAccessible: isPublicVideoUrlForQwen(videoUrl),
      mediaUploadProvider: mediaUploadProvider || undefined,
    },
    () =>
      decideQwenSubtitlePlacement({
        videoUrl,
        productTitle: input.script.narrative,
        narrative: input.script.narrative,
        aspectRatio: input.aspectRatio,
        subtitles: input.candidatePlan.events,
      }),
    (result) => ({
      applied: result.applied,
      placementCount: result.placements.length,
      note: result.note,
      finishReason: result.finishReason,
    }),
  );

  if (!advice.applied) {
    return { ...input.localFallbackPlan, qwenNote: advice.note };
  }
  return applyQwenSubtitleDecisions(input.candidatePlan, advice.placements, advice.note);
}

async function cacheRemoteVideoToStorage(
  url: string,
  keyBase: string,
  workDir: string,
  traceTool?: ProcessorToolTracer,
) {
  if (/\.m3u8(\?|$)/i.test(url)) {
    return { key: '', url, localPath: '' };
  }
  const ext = mediaExtension(url);
  const localPath = path.join(workDir, `${path.basename(keyBase)}.${ext}`);
  const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 120_000 });
  const bytes = Buffer.from(response.data);
  if (!bytes.length) throw new Error('远程视频下载为空');
  fs.writeFileSync(localPath, bytes);
  const stored = await putFileObject(
    `${keyBase}.${ext}`,
    localPath,
    ext === 'webm' ? 'video/webm' : 'video/mp4',
    traceTool,
  );
  return { ...stored, localPath };
}

function scriptProductLabel(script: NonNullable<Awaited<ReturnType<typeof getScript>>>) {
  const sourceRef = readText(script.sourceRef);
  if (sourceRef && !/^https?:\/\//i.test(sourceRef)) return sourceRef.slice(0, 80);

  const productId = readText(script.productId);
  if (productId && !/^custom_[a-z0-9]+_/i.test(productId)) return productId.slice(0, 80);

  const narrative = readText(script.narrative);
  const narrativeMatch =
    narrative.match(/把\s+(.{2,60}?)\s+的/) ||
    narrative.match(/^(.{2,60}?)\s+带货/) ||
    narrative.match(/「(.{2,60}?)」/);
  const inferred = narrativeMatch?.[1]?.trim();
  if (inferred) return inferred.slice(0, 80);

  return productId || '电商商品';
}

async function prepareSeedanceReferenceImage(input: {
  taskId: string;
  script: NonNullable<Awaited<ReturnType<typeof getScript>>>;
  shot: NonNullable<Awaited<ReturnType<typeof getScript>>>['shots'][number];
  aspectRatio: '9:16' | '16:9';
  keyBase: string;
  referenceImageUrl?: string;
  referenceAnglePrompt?: string;
  preferT2vWhenNoReference?: boolean;
  progress?: (step: string, note: string) => void;
  traceTool?: ProcessorToolTracer;
}): Promise<{
  imageUrl: string;
  source: 'merchant_reference' | 'script_reference' | 'gptimage2_t2i' | 'seedance_t2v';
  objectKey?: string;
}> {
  // 允许在没有/不可用商品参考图时退到 Seedance 纯文生视频（T2V），而不是直接掉到本地 SVG。
  const allowT2v = process.env.SEEDANCE_ALLOW_T2V_FALLBACK === 'true';
  // 云端 Seedance 取不到 localhost / 相对路径的图，这类参考图直接退 T2V，避免 I2V 失败再掉 SVG。
  const cloudReachable = (url: string) => /^https?:\/\//i.test(url) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);

  const directReference = readText(input.referenceImageUrl);
  if (directReference) {
    if (cloudReachable(directReference) || !allowT2v) {
      input.progress?.('product_reference_ready', '已使用前端选择的商品主图/角度图作为 Seedance I2V 参考图。');
      return { imageUrl: directReference, source: 'merchant_reference' };
    }
    input.progress?.('seedance_t2v', '参考图为本地地址（云端不可达），本次改用 Seedance 纯文生视频(T2V)。');
    return { imageUrl: '', source: 'seedance_t2v' };
  }

  const scriptReference = readText(input.script.referenceImageUrl);
  if (scriptReference) {
    if (cloudReachable(scriptReference) || !allowT2v) {
      input.progress?.('product_reference_ready', '已使用商品主图作为 Seedance I2V 参考图。');
      return { imageUrl: scriptReference, source: 'script_reference' };
    }
    input.progress?.('seedance_t2v', '商品主图为本地地址（云端不可达），本次改用 Seedance 纯文生视频(T2V)。');
    return { imageUrl: '', source: 'seedance_t2v' };
  }

  // 没有真实商品图时，默认直接 T2V（更真实），不合成 GPTImage2 假参考图。
  if (input.preferT2vWhenNoReference) {
    input.progress?.('seedance_t2v', '无真实商品图，直接用 Seedance 纯文生视频(T2V) 以保留真实感。');
    return { imageUrl: '', source: 'seedance_t2v' };
  }

  if (!isGptImage2Configured()) {
    if (allowT2v) {
      input.progress?.('seedance_t2v', '无商品主图且 GPTImage2 未配置，改用 Seedance 纯文生视频(T2V)。');
      return { imageUrl: '', source: 'seedance_t2v' };
    }
    throw new Error('缺少商品参考图，且 GPTIMAGE2_API_KEY/OPENAI_API_KEY 未配置；已阻止 Seedance 纯文生视频。');
  }

  input.progress?.('product_reference_generating', '未找到商品主图，正在用 GPTImage2 生成商品参考图。');
  const productLabel = scriptProductLabel(input.script);
  try {
    const generated = await traceExternal(
      input.traceTool,
      'model.gptimage2ProductReference',
      {
        taskId: input.taskId,
        scriptId: input.script.id,
        shotId: input.shot.id,
        productLabel,
        aspectRatio: input.aspectRatio,
        visualDesc: input.shot.visualDesc,
        referenceAnglePrompt: input.referenceAnglePrompt,
      },
      () =>
        generateGptImage2ProductReference({
          productLabel,
          visualDesc: input.shot.visualDesc,
          camera: input.shot.camera,
          narration: input.shot.narration,
          subtitle: input.shot.subtitle,
          aspectRatio: input.aspectRatio,
          shotOrder: input.shot.order,
          referenceAnglePrompt: input.referenceAnglePrompt,
        }),
      (result) => ({
        provider: result.provider,
        imageKind: result.imageUrl.startsWith('data:image/') ? 'data_url' : 'remote_url',
      }),
    );
    const cached = await cacheGeneratedImageToStorage(
      generated.imageUrl,
      `${input.keyBase}_product_reference`,
      input.traceTool,
    );
    input.progress?.('product_reference_ready', 'GPTImage2 商品参考图已缓存，进入 Seedance I2V。');
    return { imageUrl: cached.url, source: 'gptimage2_t2i', objectKey: cached.key };
  } catch (error) {
    // GPTImage2 失败：能 T2V 就退到 T2V（真 Seedance 视频），否则才上抛 → 本地 SVG。
    if (allowT2v) {
      input.progress?.('seedance_t2v', `GPTImage2 失败(${safeGptImage2Error(error)})，改用 Seedance 纯文生视频(T2V)。`);
      return { imageUrl: '', source: 'seedance_t2v' };
    }
    throw new Error(safeGptImage2Error(error));
  }
}

async function prepareSeedanceLastFrameImage(input: {
  taskId: string;
  script: NonNullable<Awaited<ReturnType<typeof getScript>>>;
  shot: NonNullable<Awaited<ReturnType<typeof getScript>>>['shots'][number];
  aspectRatio: '9:16' | '16:9';
  firstFrameImageUrl: string;
  keyBase: string;
  progress?: (step: string, note: string) => void;
  traceTool?: ProcessorToolTracer;
}): Promise<{ imageUrl: string; source: 'gptimage2_continuous_last_frame'; objectKey?: string } | undefined> {
  if (!envFlag('SEEDANCE_FIRST_LAST_FRAME_ENABLED')) return undefined;
  if (!isGptImage2Configured()) return undefined;

  input.progress?.('product_last_frame_generating', '正在用 GPTImage2 读取首帧并生成连续尾帧。');
  const productLabel = scriptProductLabel(input.script);
  const generated = await traceExternal(
    input.traceTool,
    'model.gptimage2ContinuousLastFrame',
    {
      taskId: input.taskId,
      scriptId: input.script.id,
      shotId: input.shot.id,
      productLabel,
      aspectRatio: input.aspectRatio,
      firstFrameKind: input.firstFrameImageUrl.startsWith('data:image/') ? 'data_url' : 'url',
    },
    () =>
      generateGptImage2ContinuousLastFrame({
        firstFrameImageUrl: input.firstFrameImageUrl,
        productLabel,
        visualDesc: input.shot.visualDesc,
        camera: input.shot.camera,
        narration: input.shot.narration,
        subtitle: input.shot.subtitle,
        aspectRatio: input.aspectRatio,
        shotOrder: input.shot.order,
        motionGoal: '同一镜头 2-3 秒后的最后一帧，只允许手部动作和手机角度发生小幅连续变化。',
      }),
    (result) => ({
      provider: result.provider,
      imageKind: result.imageUrl.startsWith('data:image/') ? 'data_url' : 'remote_url',
    }),
  ).catch((error) => {
    input.progress?.('product_last_frame_skipped', `连续尾帧生成失败，改用单首帧 I2V：${safeGptImage2Error(error)}`);
    return undefined;
  });
  if (!generated) return undefined;

  const cached = await cacheGeneratedImageToStorage(
    generated.imageUrl,
    `${input.keyBase}_product_last_frame`,
    input.traceTool,
  );
  input.progress?.('product_last_frame_ready', 'GPTImage2 连续尾帧已生成，进入 Seedance 首尾帧 I2V。');
  return {
    imageUrl: generated.imageUrl.startsWith('data:image/') ? generated.imageUrl : cached.url,
    source: 'gptimage2_continuous_last_frame',
    objectKey: cached.key,
  };
}

async function renderShotVideo(input: {
  taskId: string;
  script: NonNullable<Awaited<ReturnType<typeof getScript>>>;
  shot: NonNullable<Awaited<ReturnType<typeof getScript>>>['shots'][number];
  provider: 'auto' | 'local' | 'seedance';
  referenceImageUrl?: string;
  referenceAnglePrompt?: string;
  // 帧接力：上一镜真实尾帧的可访问 URL，作为本镜 I2V 首帧，实现跨剪辑点连续。
  chainedFirstFrameUrl?: string;
  prevVisualDesc?: string;
  // 无真实参考图时直接 T2V（保留真实感），而不是用 GPTImage2 合成参考图。
  preferT2vWhenNoReference?: boolean;
  // 全片共享的一致性上下文（钉死商品外观 + 分镜清单），注入每个并发镜头的 prompt。
  filmContext?: string;
  resolution?: string;
  audioMode?: 'original' | 'voiceover' | 'mute';
  workDir: string;
  progress?: (step: string, note: string) => void;
  traceTool?: ProcessorToolTracer;
}) {
  const aspectRatio = normalizeAspectRatio(input.script.aspectRatio);
  const keyBase = `render/${input.script.id}/${input.taskId}/shot_${String(input.shot.order).padStart(2, '0')}_${input.shot.id}`;
  if (input.provider === 'local') {
    throw new Error('禁止使用 local 生成正式视频；最终视频分镜必须由 Seedance 生成。');
  }
  const useSeedance = isSeedanceConfigured() && process.env.WORKER_DISABLE_SEEDANCE !== 'true';
  if (!useSeedance) {
    throw new Error('Seedance 未配置或已禁用；最终视频不能降级为本地生成或素材切片裁切。');
  }

  try {
    // 帧接力：第2镜起优先用上一镜的真实尾帧作为本镜 I2V 首帧，跨剪辑点画面自然延续；
    // 首镜或拿不到尾帧时回退到原有的商品参考图 / GPTImage2 / T2V 逻辑。
    const chainedFirstFrameUrl = readText(input.chainedFirstFrameUrl);
    const reference = chainedFirstFrameUrl
      ? { imageUrl: chainedFirstFrameUrl, source: 'chained_prev_last_frame' as const, objectKey: undefined }
      : await prepareSeedanceReferenceImage({
          taskId: input.taskId,
          script: input.script,
          shot: input.shot,
          aspectRatio,
          keyBase,
          referenceImageUrl: input.referenceImageUrl,
          referenceAnglePrompt: input.referenceAnglePrompt,
          preferT2vWhenNoReference: input.preferT2vWhenNoReference,
          progress: input.progress,
          traceTool: input.traceTool,
        });
    if (chainedFirstFrameUrl) {
      input.progress?.('seedance_frame_chain', '已用上一镜真实尾帧作为本镜 I2V 首帧，保持跨镜连续。');
    }
    const lastFrame = reference.imageUrl
      ? await prepareSeedanceLastFrameImage({
          taskId: input.taskId,
          script: input.script,
          shot: input.shot,
          aspectRatio,
          firstFrameImageUrl: reference.imageUrl,
          keyBase,
          progress: input.progress,
          traceTool: input.traceTool,
        })
      : undefined;
    const orderedShots = [...input.script.shots].sort((a, b) => a.order - b.order);
    const shotIndex = Math.max(
      0,
      orderedShots.findIndex((item) => item.id === input.shot.id),
    );
    const basePrompt = buildSeedancePrompt({
      aspectRatio,
      duration: input.shot.duration,
      narrative: input.script.narrative,
      visualStyle: input.script.visualStyle,
      bgm: input.script.bgm,
      shotIndex,
      shotTotal: orderedShots.length,
      prevSubtitle: orderedShots[shotIndex - 1]?.subtitle,
      nextSubtitle: orderedShots[shotIndex + 1]?.subtitle,
      prevVisualDesc: input.prevVisualDesc || orderedShots[shotIndex - 1]?.visualDesc,
      visualDesc: input.shot.visualDesc,
      camera: input.shot.camera,
      subtitle: input.shot.subtitle,
      narration: input.shot.narration,
      transition: input.shot.transition || undefined,
      continuesFromPrevFrame: Boolean(chainedFirstFrameUrl),
      filmContext: input.filmContext,
    });
    const prompt = input.referenceAnglePrompt
      ? `${basePrompt}\n参考图角度要求：${input.referenceAnglePrompt}`
      : basePrompt;
    const seedanceOptions = {
      ratio: aspectRatio,
      resolution: input.resolution === '1080x1920' || input.resolution === '1920x1080' ? '1080p' : '720p',
      generateAudio: input.audioMode !== 'mute',
    } as const;
    const remoteUrl = await traceExternal(
      input.traceTool,
      'model.seedanceVideo',
      {
        shotId: input.shot.id,
        prompt,
        options: seedanceOptions,
        hasReferenceImage: Boolean(reference.imageUrl),
        referenceImageSource: reference.source,
        hasLastFrameImage: Boolean(lastFrame?.imageUrl),
      },
      () =>
        requestSeedanceVideoWithRetry(
          prompt,
          seedanceOptions,
          reference.imageUrl,
          lastFrame?.imageUrl || input.progress,
          lastFrame ? input.progress : undefined,
        ),
      (url) => ({ shotId: input.shot.id, remoteUrl: url }),
    );
    const cached = await cacheRemoteVideoToStorage(remoteUrl, keyBase, input.workDir, input.traceTool);
    if (cached.localPath) {
      return {
        ...cached,
        provider: 'seedance',
        referenceImageSource: reference.source,
        referenceImageUrl: reference.imageUrl,
        referenceObjectKey: reference.objectKey,
        lastFrameImageSource: lastFrame?.source,
        lastFrameImageUrl: lastFrame?.imageUrl,
        lastFrameObjectKey: lastFrame?.objectKey,
      };
    }
    const segmentPath = path.join(input.workDir, `seedance_${input.shot.id}.mp4`);
    await traceExternal(
      input.traceTool,
      'ffmpeg.trim',
      { shotId: input.shot.id, sourceType: 'seedance_stream', duration: input.shot.duration },
      () =>
        trimVideoSegment(cached.url, segmentPath, input.shot.duration, aspectRatio, input.resolution, input.audioMode),
      () => ({ outputFile: path.basename(segmentPath), duration: input.shot.duration }),
    );
    const stored = await putFileObject(`${keyBase}.mp4`, segmentPath, 'video/mp4', input.traceTool);
    return {
      ...stored,
      localPath: segmentPath,
      provider: 'seedance',
      referenceImageSource: reference.source,
      referenceImageUrl: reference.imageUrl,
      referenceObjectKey: reference.objectKey,
      lastFrameImageSource: lastFrame?.source,
      lastFrameImageUrl: lastFrame?.imageUrl,
      lastFrameObjectKey: lastFrame?.objectKey,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    input.progress?.('seedance_failed', `Seedance 生成失败，已停止：${reason}`);
    throw new Error(`Seedance 生成失败，禁止降级为本地视频或素材切片：${reason}`);
  }
}

function buildPreviewHtml(script: NonNullable<Awaited<ReturnType<typeof getScript>>>) {
  const rows = script.shots
    .sort((a, b) => a.order - b.order)
    .map((shot) => {
      const asset = shot.assetUrl
        ? isVideoAsset(shot.assetUrl)
          ? `<video src="${escapeXml(shot.assetUrl)}" controls playsinline muted loop></video>`
          : `<img src="${escapeXml(shot.assetUrl)}" alt="Shot ${shot.order}"/>`
        : '';
      return `<section>${asset}<small>Shot ${shot.order} · ${escapeXml(shot.camera)} · ${shot.duration}s</small><h2>${escapeXml(
        shot.subtitle,
      )}</h2><p>${escapeXml(shot.narration)}</p></section>`;
    })
    .join('');

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(
    script.narrative,
  )}</title><style>body{margin:0;background:#eef4fb;color:#172033;font-family:Arial,"PingFang SC",sans-serif}main{width:min(430px,100vw);margin:auto;background:#fff;min-height:100vh;box-shadow:0 18px 50px #cbd5e1}section{min-height:72vh;padding:28px 32px 36px;display:grid;align-content:end;gap:14px;border-bottom:1px solid #d8e0ea}video,img{width:100%;max-height:52vh;object-fit:cover;border-radius:10px;background:#0f172a}h2{font-size:34px;margin:0;color:#0f766e}p{font-size:20px;line-height:1.45;margin:0}small{color:#64748b}</style><main>${rows}</main></html>`;
}

export async function processMaterialSlice(data: MaterialSliceData) {
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 20,
    step: 'slicing',
    trace: { step: 'slicing', progress: 20, message: 'Worker 正在生成生产素材切片。' },
  });
  const material = await getMaterial(data.materialId);
  if (!material) throw new Error(`素材不存在：${data.materialId}`);
  const created = buildSlices({ material, seedText: data.seedText });
  await replaceMaterialSlices(material.id, created);
  await updateTask(data.taskId, {
    status: 'completed',
    progress: 100,
    step: 'done',
    payload: { materialId: material.id, sliceIds: created.map((slice) => slice.id) },
    trace: {
      step: 'done',
      progress: 100,
      message: '生产素材切片已写入 Postgres。',
      data: { sliceIds: created.map((slice) => slice.id) },
    },
  });
}

export async function processMaterialAngle(data: MaterialAngleData) {
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 10,
    step: 'angle_planning',
    trace: {
      step: 'angle_planning',
      progress: 10,
      message: 'Worker 正在规划生产多角度参考图。',
      data: {
        materialId: data.materialId,
        provider: isQwenAngleProviderConfigured() ? 'qwen' : 'local',
        includePresets: data.includePresets !== false,
        customAngleCount: Array.isArray(data.customAngles) ? data.customAngles.length : 0,
      },
    },
  });

  const material = await getMaterial(data.materialId);
  if (!material) throw new Error(`素材不存在：${data.materialId}`);
  if (material.type !== 'image') throw new Error('只有图片素材可以生成商品角度参考图');

  const includePresets = data.includePresets !== false;
  const customSpecs = normalizeCustomAngleSpecs(data.customAngles);
  const specs = [...(includePresets ? MATERIAL_ANGLE_SPECS : []), ...customSpecs];
  if (!specs.length) throw new Error('需要至少一个预设角度或自定义角度');

  const existing = material.angles.map(publicMaterialAngleRow);
  if (existing.length && data.force !== true && customSpecs.length === 0) {
    await updateTask(data.taskId, {
      status: 'completed',
      progress: 100,
      step: 'done',
      payload: {
        materialId: material.id,
        angles: existing,
        provider: existing[0]?.provider || 'local',
        reused: true,
      },
      trace: {
        step: 'done',
        progress: 100,
        message: '生产角度参考图已存在，本次直接复用。',
        data: { angleIds: existing.map((angle) => angle.id) },
      },
    });
    return;
  }

  const sourceUrl = await resolveMaterialSourceUrl(material);
  const created: ProductionMaterialAngleInput[] = [];
  let provider: 'local' | 'qwen' = 'local';
  let fallbackReason = isQwenAngleProviderConfigured() ? '' : '未配置 QWEN_IMAGE_API_KEY/DASHSCOPE_API_KEY。';
  let canUseQwen = isQwenAngleProviderConfigured();

  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    const progress = Math.round(18 + (index / specs.length) * 68);
    await updateTask(data.taskId, {
      status: 'processing',
      progress,
      step: 'angle_generating',
      trace: {
        step: 'angle_generating',
        progress,
        message: `生成 ${spec.label} 参考图。`,
        data: { view: spec.view, key: spec.key, provider: canUseQwen ? 'qwen' : 'local' },
      },
    });

    let angle: ProductionMaterialAngleInput;
    if (canUseQwen) {
      try {
        angle = await createQwenMaterialAngle(material, spec, sourceUrl);
        provider = 'qwen';
      } catch (error) {
        canUseQwen = false;
        provider = 'local';
        fallbackReason = safeProviderError(error);
        await updateTask(data.taskId, {
          status: 'processing',
          progress,
          step: 'angle_fallback',
          trace: {
            step: 'angle_fallback',
            progress,
            message: `Qwen 角度图生成失败，切换本地占位角度：${fallbackReason}`,
            data: { view: spec.view, key: spec.key },
          },
        });
        angle = await createLocalMaterialAngle(
          material,
          spec,
          sourceUrl,
          `Qwen 不可用，使用本地角度占位：${fallbackReason}`,
        );
      }
    } else {
      angle = await createLocalMaterialAngle(material, spec, sourceUrl, fallbackReason || '本地角度占位。');
    }

    created.push(angle);
  }

  await replaceMaterialAngles(material.id, created);
  const publicAngles = created.map(publicMaterialAngle);
  await updateTask(data.taskId, {
    status: 'completed',
    progress: 100,
    step: 'done',
    payload: {
      materialId: material.id,
      angles: publicAngles,
      provider,
      fallbackReason,
    },
    trace: {
      step: 'done',
      progress: 100,
      message: '生产角度参考图已写入 Postgres 和对象存储。',
      data: { angleIds: publicAngles.map((angle) => angle.id), provider },
    },
  });
}

export async function processVideoTagsReindex(data: VideoTagsReindexData) {
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 20,
    step: 'qdrant_reindex',
    trace: {
      step: 'qdrant_reindex',
      progress: 20,
      message: 'Worker 正在用真实 CLIP embedding 重建 Qdrant 检索向量。',
    },
  });
  const result = await reindexQdrantRetrievalDatabase({ taskId: data.taskId, reason: data.reason || 'manual' });
  await updateTask(data.taskId, {
    status: 'completed',
    progress: 100,
    step: 'qdrant_reindex_done',
    payload: result,
    trace: {
      step: 'qdrant_reindex_done',
      progress: 100,
      message: `检索向量库已重建：${result.vectors} 条向量，向量库 ${result.vectorStore}。`,
      data: result,
    },
  });
}

export async function processTrendRefresh(data: TrendRefreshData) {
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 15,
    step: 'trend_refresh',
    trace: {
      step: 'trend_refresh',
      progress: 15,
      message: 'Worker 正在刷新本地热门商品趋势库，并写入 Qdrant 真实向量。',
    },
  });
  const result = await refreshTrendDatabase({
    taskId: data.taskId,
    productId: data.productId,
    source: data.source || 'default',
  });
  await updateTask(data.taskId, {
    status: 'completed',
    progress: 100,
    step: 'trend_refresh_done',
    payload: result,
    trace: {
      step: 'trend_refresh_done',
      progress: 100,
      message: `趋势库已刷新：${result.items} 条热门商品，向量库 ${result.vectorStore}。`,
      data: result,
    },
  });
}

export async function processScriptGenerate(data: ScriptGenerateData) {
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 30,
    step: 'script_planning',
    trace: { step: 'script_planning', progress: 30, message: 'Worker 正在规划剧本生成方案。' },
  });

  const materials = await listMaterials({ productId: data.productId });
  const referenceMaterial = materials.find((m) => m.type === 'image');
  const referenceImageUrl =
    readText(data.referenceImageUrl) ||
    (referenceMaterial ? await resolveMaterialSourceUrl(referenceMaterial) : undefined);
  const referenceSliceIds = materials.flatMap((m) => m.slices.map((s) => s.id));
  const materialIds = materials.map((m) => m.id);

  // 自动素材检索只作为 Seedance 生成参考。
  // 任何素材切片都不能作为 materialRef 或 FFmpeg 裁切片段进入成片。
  const sliceQuery = [data.freePrompt, referenceMaterial?.name, data.productId].filter(Boolean).join(' ').trim();
  const retrieveLimit = 12;
  const retrievedSlices = await searchSlices(sliceQuery || data.productId, retrieveLimit, data.productId);
  const materialSlices: DoubaoMaterialSlice[] = retrievedSlices.map((slice) => ({
    id: slice.id,
    materialId: slice.materialId,
    summary: slice.summary,
    tags: flattenTagStrings(slice.tags).slice(0, 12),
    startTime: slice.startTime ?? undefined,
    endTime: slice.endTime ?? undefined,
  }));
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 34,
    step: 'material_retrieval',
    trace: {
      step: 'material_retrieval',
      progress: 34,
      message: materialSlices.length
        ? `自动召回 ${materialSlices.length} 条当前商品素材切片，仅作为 Seedance 生成参考。`
        : '素材库暂无参考切片，本次分镜仍全部由 Seedance 生成。',
      data: { referenceSliceIds: materialSlices.map((slice) => slice.id), scope: 'generation_reference_only' },
    },
  });
  const { prefer: topFactors, avoid: avoidFactors } = await loadFactorHints();
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 36,
    step: 'script_planning',
    trace: {
      step: 'script_planning',
      progress: 36,
      message: topFactors.length
        ? `Worker 注入归因因子：高转化 ${topFactors.join('、')}${avoidFactors.length ? `；规避 ${avoidFactors.join('、')}` : ''}`
        : 'Worker 未找到 factor_weights，使用默认创作因子。',
      data: { topFactors, avoidFactors },
    },
  });

  const useDoubao = (data.provider === 'doubao' || data.provider === 'auto') && isDoubaoConfigured();

  let script: ProductionScriptInput;
  let providerUsed = 'production_local';

  if (useDoubao) {
    await updateTask(data.taskId, {
      status: 'processing',
      progress: 45,
      step: 'doubao_generating',
      trace: { step: 'doubao_generating', progress: 45, message: 'Worker 调用 Doubao 生成结构化剧本。' },
    });
    try {
      script = await traceExternal(
        data.traceTool,
        'model.doubaoText',
        { productId: data.productId, mode: data.mode, materialCount: materialIds.length },
        () =>
          generateDoubaoScript({
            productId: data.productId,
            mode: data.mode,
            freePrompt: data.freePrompt,
            materialSlices,
            topFactors,
            avoidFactors,
            materialIds,
            referenceImageUrl,
            approvedClaims: data.approvedClaims,
            evidence: data.evidence,
            hotVideoDna: data.hotVideoDna,
          }),
        () => ({ provider: 'doubao', generated: true }),
      );
      providerUsed = 'doubao';
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Doubao 调用失败';
      await updateTask(data.taskId, {
        status: 'processing',
        progress: 45,
        step: 'doubao_fallback',
        trace: { step: 'doubao_fallback', progress: 45, message: `Doubao 不可用，切换本地生成：${reason}` },
      });
      script = buildProductionScript({
        productId: data.productId,
        mode: data.mode,
        ref: data.ref,
        freePrompt: data.freePrompt,
        referenceImageUrl,
        materialIds,
        reusableSliceIds: referenceSliceIds,
      });
    }
  } else {
    script = buildProductionScript({
      productId: data.productId,
      mode: data.mode,
      ref: data.ref,
      freePrompt: data.freePrompt,
      referenceImageUrl,
      materialIds,
      reusableSliceIds: referenceSliceIds,
    });
  }

  script = applyPolicyGrounding({
    script,
    approvedClaims: data.approvedClaims,
    evidence: data.evidence,
    hotVideoDna: data.hotVideoDna,
    strategy: data.strategy,
  });
  script.generationProfile = data.generationProfile || 'trusted_publish';

  const created = await createScriptWithShots(script);
  await updateTask(data.taskId, {
    status: 'completed',
    progress: 100,
    step: 'done',
    payload: {
      scriptId: created.id,
      provider: providerUsed,
      retrievalMode: data.retrievalMode,
      generationProfile: script.generationProfile,
    },
    trace: {
      step: 'done',
      progress: 100,
      message: `生产剧本已写入 Postgres（provider=${providerUsed}）。`,
      data: {
        scriptId: created.id,
        shots: created.shots.length,
        provider: providerUsed,
        generationProfile: script.generationProfile,
      },
    },
  });
}

export async function processRenderShot(data: RenderShotData) {
  const script = await getScript(data.scriptId);
  if (!script) throw new Error(`剧本不存在：${data.scriptId}`);
  const shot = script.shots.find((item) => item.id === data.shotId);
  if (!shot) throw new Error(`分镜不存在：${data.shotId}`);
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 40,
    step: 'rendering',
    trace: { step: 'rendering', progress: 40, message: `Worker 正在渲染分镜 ${shot.order}。` },
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `aigc-shot-${data.taskId}-`));
  const asset = await renderShotVideo({
    taskId: data.taskId,
    script,
    shot,
    provider: data.provider,
    referenceImageUrl: data.referenceImageUrl,
    referenceAnglePrompt: data.referenceAnglePrompt,
    resolution: script.aspectRatio === '16:9' ? '1280x720' : '720x1280',
    audioMode: data.preview ? 'mute' : 'original',
    workDir,
    traceTool: data.traceTool,
    progress: (step, note) => {
      void updateTask(data.taskId, {
        status: 'processing',
        progress: 55,
        step,
        trace: { step, progress: 55, message: note },
      });
    },
  });
  await updateShotAsset(shot.id, { assetUrl: asset.url, assetObjectKey: asset.key, status: 'done' });
  await updateTask(data.taskId, {
    status: 'completed',
    progress: 100,
    step: 'done',
    payload: {
      scriptId: script.id,
      shotId: shot.id,
      assetUrl: asset.url,
      objectKey: asset.key,
      provider: asset.provider,
      referenceImageSource: 'referenceImageSource' in asset ? asset.referenceImageSource : undefined,
      referenceImageUrl: 'referenceImageUrl' in asset ? asset.referenceImageUrl : undefined,
      referenceObjectKey: 'referenceObjectKey' in asset ? asset.referenceObjectKey : undefined,
      format: 'mp4',
    },
    trace: { step: 'done', progress: 100, message: '生产单镜已渲染。', data: { assetObjectKey: asset.key } },
  });
  fs.rmSync(workDir, { recursive: true, force: true });
}

export async function processRenderFull(data: RenderFullData) {
  let script = await getScript(data.scriptId);
  if (!script) throw new Error(`剧本不存在：${data.scriptId}`);
  const aspectRatio = normalizeAspectRatio(data.exportOptions.aspectRatio || script.aspectRatio);
  const resolution = readResolution(
    data.exportOptions.resolution || (aspectRatio === '16:9' ? '1280x720' : '720x1280'),
  );
  const audioMode = readAudioMode(data.exportOptions.audioMode);
  const segmentAudioMode = audioMode === 'voiceover' ? 'mute' : audioMode;
  const provider = readRenderProvider(data.exportOptions.provider);
  const subtitleMode = readSubtitleMode(data.exportOptions.subtitleMode);
  const subtitlePlacementProvider = readSubtitlePlacementProvider(
    data.exportOptions.subtitlePlacementProvider || data.exportOptions.subtitleProvider,
  );
  const renderPlanByShot = new Map(
    (data.renderPlan || []).filter((item) => item && item.shotId).map((item) => [item.shotId, item]),
  );
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 20,
    step: 'rendering',
    trace: { step: 'rendering', progress: 20, message: 'Worker 正在渲染生产视频。' },
  });

  const ffmpegAvailable = await commandOk('ffmpeg', ['-version']);
  if (!ffmpegAvailable) {
    throw new Error('最终成片必须由 Seedance 生成并经 FFmpeg 合成 MP4；当前缺少 ffmpeg，禁止降级 HTML。');
  }
  if (!isSeedanceConfigured() || process.env.WORKER_DISABLE_SEEDANCE === 'true') {
    throw new Error('Seedance 未配置或已禁用；最终成片禁止使用素材切片、本地视频或 HTML 降级产物。');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `aigc-render-${data.taskId}-`));
  try {
    const plans: TransitionPlan[] = [];
    const decisions: RenderDecision[] = [];
    const orderedShots = [...script.shots].sort((a, b) => a.order - b.order);
    // 默认「多角度连贯」：各镜并发独立生成，可从不同机位/景别展示商品，靠共享商品锚图 + 一致性圣经 + 统一风格保持观感连贯。
    // 帧接力（上一镜真实尾帧 → 下一镜 I2V 首帧）是单镜内连续动作场景的可选项，需显式 SEEDANCE_FRAME_CHAIN_ENABLED=true 开启（且必须串行）。
    const frameChainEnabled = process.env.SEEDANCE_FRAME_CHAIN_ENABLED === 'true';

    // 商品身份锚定：只有「真实商品图」才当全片复用的锚点——真图 I2V 又真又一致又能多角度。
    // 没有真图时绝不自动合成一张 AI 锚图（那会让所有镜头都带上渲染假味），而是直接 T2V，保留真实感。
    const sharedAnchorUrl = readText(data.exportOptions.referenceImageUrl) || undefined;
    const referenceAnglePrompt =
      readText(data.exportOptions.referenceAnglePrompt || data.exportOptions.referenceAngleLabel) || undefined;

    // 自动路由（解决「商品会变」）：
    // - 有真实商品图当锚点 → 多角度 I2V（并发，真实+一致+可分镜编辑）；
    // - 没真图 → 默认仍走逐镜 Seedance 生成，再由 FFmpeg 裁切/拼接。整片一镜到底只在显式开启时使用，
    //   避免把 12-15s 整片时长直接传给当前 Seedance 模型造成 duration 400。
    const cloudReachable = (url: string) =>
      url.startsWith('data:image/') || (/^https?:\/\//i.test(url) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url));
    const hasRealAnchor = Boolean(sharedAnchorUrl && cloudReachable(sharedAnchorUrl));
    const seedanceUsable = isSeedanceConfigured() && process.env.WORKER_DISABLE_SEEDANCE !== 'true';
    const useWholeVideo =
      !frameChainEnabled &&
      seedanceUsable &&
      !hasRealAnchor &&
      orderedShots.length > 1 &&
      process.env.SEEDANCE_WHOLE_VIDEO_AUTO === 'true';

    // 一致性圣经：所有镜头注入同一份（钉死商品外观 + 全片分镜清单），这是跨镜连贯的关键上下文。
    const productLabel = scriptProductLabel(script);
    const storyboard = orderedShots.map((item) => `${item.order}. ${item.visualDesc}`).join('  /  ');
    const filmContext = [
      `【全片一致性·所有镜头共享】商品：${productLabel}。全片自始至终是同一个商品，严格保持同一外观、材质、颜色、比例与细节，不同镜头只换机位、景别与动作，绝不换成另一个商品。`,
      `统一视觉基调：${script.visualStyle}；BGM：${script.bgm}；整片叙事：${script.narrative}。`,
      `全片分镜清单（仅供你理解整片、保持连贯；本次只渲染下面指定的这一镜，不要把别的镜头画进来）：${storyboard}。`,
    ].join('\n');

    // 并发上限（受 SEEDANCE_CONCURRENCY 约束，1..5）；帧接力必须串行。
    const seedanceConcurrency = Math.max(1, Math.min(5, Number(process.env.SEEDANCE_CONCURRENCY || 5) || 5));
    const renderConcurrency = frameChainEnabled ? 1 : seedanceConcurrency;

    const shotProgress = (index: number) => (step: string, note: string) => {
      const pct = 30 + Math.round((index / Math.max(1, orderedShots.length)) * 35);
      void updateTask(data.taskId, {
        status: 'processing',
        progress: pct,
        step,
        trace: { step, progress: pct, message: note },
      });
    };

    // 捕获非空 script（函数末尾会重新赋值 script，闭包内会丢失非空收窄，故先固定一份）。
    const renderScript = script;
    // 单镜资产生成（不改共享状态），串行/并发两条路复用。
    const generateShotAsset = async (
      shot: (typeof orderedShots)[number],
      index: number,
      chainFirstFrameUrl: string | undefined,
    ) => {
      const planItem = renderPlanByShot.get(shot.id);
      const ignoredMaterialRef = (planItem as { materialRef?: string } | undefined)?.materialRef || shot.materialRef;
      const fallbackReason = ignoredMaterialRef ? '素材切片只作为生成参考，已禁止进入成片。' : '';
      const asset = await renderShotVideo({
        taskId: data.taskId,
        script: renderScript,
        shot,
        provider,
        referenceImageUrl: sharedAnchorUrl,
        // 没有真实商品图时直接 T2V（更真实），不要合成 AI 参考图。帧接力模式除外（它需要逐镜锚点）。
        preferT2vWhenNoReference: !frameChainEnabled,
        referenceAnglePrompt,
        chainedFirstFrameUrl: frameChainEnabled ? chainFirstFrameUrl : undefined,
        prevVisualDesc: orderedShots[index - 1]?.visualDesc,
        filmContext,
        resolution,
        audioMode: segmentAudioMode,
        workDir,
        traceTool: data.traceTool,
        progress: shotProgress(index),
      });
      return { shot, index, planItem, requestedAction: 'generate' as const, asset, fallbackReason };
    };

    type GeneratedShot = Awaited<ReturnType<typeof generateShotAsset>>;
    const generated: GeneratedShot[] = [];
    // 一镜到底（无真图自动路由）：整片由单次 Seedance 调用生成，商品天然一致。
    let wholeVideoSegment: string | undefined;

    const runParallel = async () => {
      const results: GeneratedShot[] = new Array(orderedShots.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(renderConcurrency, orderedShots.length) }, async () => {
        while (cursor < orderedShots.length) {
          const index = cursor++;
          results[index] = await generateShotAsset(orderedShots[index], index, undefined);
        }
      });
      await Promise.all(workers);
      generated.push(...results);
    };

    if (frameChainEnabled) {
      // 串行：每镜真实尾帧 → 下一镜 I2V 首帧。
      let chainedFirstFrameUrl: string | undefined;
      for (let index = 0; index < orderedShots.length; index++) {
        const shot = orderedShots[index];
        const result = await generateShotAsset(shot, index, chainedFirstFrameUrl);
        generated.push(result);
        chainedFirstFrameUrl = undefined;
        if (result.asset.localPath && index < orderedShots.length - 1) {
          const segmentLocalPath = result.asset.localPath;
          try {
            const framePath = path.join(workDir, `chain_frame_${shot.id}.jpg`);
            const frameKeyBase = `render/${script.id}/${data.taskId}/chain_${String(shot.order).padStart(2, '0')}_lastframe`;
            const ok = await traceExternal(
              data.traceTool,
              'ffmpeg.extractLastFrame',
              { shotId: shot.id, source: path.basename(segmentLocalPath) },
              () => extractLastFrame(segmentLocalPath, framePath),
              (extracted) => ({ extracted }),
            );
            if (ok) {
              const storedFrame = await putFileObject(`${frameKeyBase}.jpg`, framePath, 'image/jpeg', data.traceTool);
              const reachable =
                /^https?:\/\//i.test(storedFrame.url) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(storedFrame.url);
              chainedFirstFrameUrl = reachable ? storedFrame.url : undefined;
            }
          } catch {
            chainedFirstFrameUrl = undefined;
          }
        }
      }
    } else if (useWholeVideo) {
      // 无真图：一镜到底，单次生成保证商品一致；失败则回退多角度并发。
      try {
        const totalDur = orderedShots.reduce((sum, item) => sum + Math.max(1, item.duration), 0);
        const seedanceRes = resolution === '1080x1920' || resolution === '1920x1080' ? '1080p' : '720p';
        const wholePrompt = buildSeedanceWholeVideoPrompt({
          aspectRatio,
          totalDuration: totalDur,
          narrative: renderScript.narrative,
          visualStyle: renderScript.visualStyle,
          bgm: renderScript.bgm,
          shots: orderedShots.map((item) => ({
            visualDesc: item.visualDesc,
            camera: item.camera,
            duration: item.duration,
            transition: item.transition || undefined,
          })),
        });
        const remoteUrl = await traceExternal(
          data.traceTool,
          'model.seedanceWholeVideo',
          { totalDuration: totalDur, shotCount: orderedShots.length, prompt: wholePrompt },
          () =>
            requestSeedanceVideoWithRetry(
              wholePrompt,
              { ratio: aspectRatio, resolution: seedanceRes, generateAudio: segmentAudioMode !== 'mute' },
              undefined,
              shotProgress(0),
            ),
          (url) => ({ remoteUrl: url }),
        );
        const cached = await cacheRemoteVideoToStorage(
          remoteUrl,
          `render/${renderScript.id}/${data.taskId}/whole`,
          workDir,
          data.traceTool,
        );
        const wholeSeg = path.join(workDir, 'whole_norm.mp4');
        await traceExternal(
          data.traceTool,
          'ffmpeg.trim',
          { sourceType: 'seedance_whole', duration: totalDur },
          () =>
            trimVideoSegment(
              cached.localPath || cached.url,
              wholeSeg,
              totalDur,
              aspectRatio,
              resolution,
              segmentAudioMode,
            ),
          () => ({ outputFile: path.basename(wholeSeg) }),
        );
        const wholeStored = await putFileObject(
          `render/${renderScript.id}/${data.taskId}/whole.mp4`,
          wholeSeg,
          'video/mp4',
          data.traceTool,
        );
        // 一镜到底没有逐镜 segment：每个分镜的资产都指向整片，plans 仅用于字幕分段计时。
        for (const item of orderedShots) {
          await updateShotAsset(item.id, {
            assetUrl: wholeStored.url,
            assetObjectKey: wholeStored.key,
            status: 'done',
          });
          decisions.push({
            shotId: item.id,
            order: item.order,
            requestedAction: 'generate',
            action: 'generate',
            provider: 'seedance_whole',
            assetObjectKey: wholeStored.key,
            assetUrl: wholeStored.url,
          });
          plans.push({
            segment: wholeSeg,
            transition: 'hard_cut',
            duration: Math.max(1, item.duration),
            shotOrder: item.order,
          });
        }
        wholeVideoSegment = wholeSeg;
      } catch (error) {
        plans.length = 0;
        decisions.length = 0;
        await updateTask(data.taskId, {
          status: 'processing',
          progress: 40,
          step: 'whole_video_fallback',
          trace: {
            step: 'whole_video_fallback',
            progress: 40,
            message: `一镜到底失败，回退多角度并发：${error instanceof Error ? error.message : 'unknown'}`,
          },
        });
        await runParallel();
      }
    } else {
      await runParallel();
    }

    // 有序装配：写资产、决策、拼接计划（顺序与分镜一致）。
    for (const { shot, index, planItem, requestedAction, asset, fallbackReason } of generated) {
      await updateShotAsset(shot.id, { assetUrl: asset.url, assetObjectKey: asset.key, status: 'done' });
      if (!asset.localPath) throw new Error(`分镜 ${shot.order} 未生成可合成的本地 MP4 segment`);
      decisions.push({
        shotId: shot.id,
        order: shot.order,
        requestedAction,
        action: 'generate',
        score: planItem?.score,
        provider: asset.provider,
        assetObjectKey: asset.key,
        assetUrl: asset.url,
        referenceImageSource: 'referenceImageSource' in asset ? asset.referenceImageSource : undefined,
        referenceImageUrl: 'referenceImageUrl' in asset ? asset.referenceImageUrl : undefined,
        referenceObjectKey: 'referenceObjectKey' in asset ? asset.referenceObjectKey : undefined,
        lastFrameImageSource: 'lastFrameImageSource' in asset ? asset.lastFrameImageSource : undefined,
        lastFrameImageUrl: 'lastFrameImageUrl' in asset ? asset.lastFrameImageUrl : undefined,
        lastFrameObjectKey: 'lastFrameObjectKey' in asset ? asset.lastFrameObjectKey : undefined,
        fallbackReason: fallbackReason || undefined,
      });
      plans.push({
        segment: asset.localPath,
        transition:
          index < orderedShots.length - 1 ? planItem?.transition || shot.transition || 'hard_cut' : 'hard_cut',
        duration: Math.max(1, shot.duration),
        shotOrder: shot.order,
      });
    }

    await updateTask(data.taskId, {
      status: 'processing',
      progress: 66,
      step: 'rendering',
      trace: {
        step: 'rendering',
        progress: 66,
        message: wholeVideoSegment
          ? '一镜到底单次生成完成（无真图自动路由）。'
          : `全部 ${generated.length} 个分镜 segment 已完成（并发上限 ${renderConcurrency}）。`,
      },
    });

    const rawOutput = path.join(workDir, 'composed_raw.mp4');
    const subtitleOutput = path.join(workDir, 'composed_subtitled.mp4');
    const finalOutput = path.join(workDir, 'final.mp4');
    await updateTask(data.taskId, {
      status: 'processing',
      progress: 78,
      step: 'ffmpeg_compose',
      trace: { step: 'ffmpeg_compose', progress: 78, message: 'FFmpeg 正在合成最终 MP4。' },
    });
    const transitions = wholeVideoSegment
      ? (() => {
          // 一镜到底已是一条连续片，无需拼接，直接作为合成基底。
          fs.copyFileSync(wholeVideoSegment, rawOutput);
          return { softTransitions: 0 };
        })()
      : await traceExternal(
          data.traceTool,
          'ffmpeg.concat',
          { shotCount: plans.length, outputFile: path.basename(rawOutput) },
          () => concatWithTransitions(plans, rawOutput, workDir),
          (result) => ({ outputFile: path.basename(rawOutput), softTransitions: result.softTransitions }),
        );
    await updateTask(data.taskId, {
      status: 'processing',
      progress: 84,
      step: 'subtitles_planning',
      trace: {
        step: 'subtitles_planning',
        progress: 84,
        message:
          subtitleMode === 'off'
            ? '导出设置关闭字幕层。'
            : subtitlePlacementProvider === 'local'
              ? 'Composer 正在生成本地字幕计划。'
              : 'Composer 正在生成字幕候选，并请求 Qwen-VL 基于 OCR 和主体定位直接决定显示位置。',
      },
    });
    const localSubtitlePlan = buildSubtitleOverlayPlan({
      shots: orderedShots,
      transitionPlan: plans,
      decisions,
      composerPlan: data.subtitlePlan,
      audioMode,
      mode: subtitleMode,
      provider: 'local',
    });
    const candidateSubtitlePlan = buildSubtitleOverlayPlan({
      shots: orderedShots,
      transitionPlan: plans,
      decisions,
      composerPlan: data.subtitlePlan,
      audioMode,
      mode: subtitleMode,
      provider: subtitlePlacementProvider,
    });
    // Qwen-VL 字幕排版是「锦上添花」：它挂了（fetch failed / 超时 / 第三方中转不可达）绝不能让整条出片失败，
    // 直接降级用本地保守字幕计划。
    let subtitlePlan: SubtitleOverlayPlan;
    try {
      subtitlePlan = await decideSubtitlePlanWithQwen({
        taskId: data.taskId,
        script,
        rawOutput,
        aspectRatio,
        candidatePlan: subtitlePlacementProvider === 'local' ? localSubtitlePlan : candidateSubtitlePlan,
        localFallbackPlan: localSubtitlePlan,
        traceTool: data.traceTool,
      });
    } catch (error) {
      subtitlePlan = {
        ...localSubtitlePlan,
        qwenNote: `Qwen-VL 字幕排版失败，已降级本地保守字幕计划：${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
    const subtitleLayer =
      subtitlePlan.events.length > 0
        ? await traceExternal(
            data.traceTool,
            'ffmpeg.subtitles',
            {
              outputFile: path.basename(subtitleOutput),
              eventCount: subtitlePlan.events.length,
              placementSource: subtitlePlan.placementSource,
            },
            () =>
              addSubtitleLayer(rawOutput, subtitleOutput, subtitlePlan.events, {
                aspectRatio,
                resolution,
                fontFamily: readText(data.exportOptions.subtitleFontFamily, 'PingFang SC'),
                fontSize: readSubtitleFontSize(data.exportOptions.subtitleFontSize),
              }),
            (result) => ({ applied: result.applied, note: result.note }),
          )
        : {
            applied: false,
            note: subtitleMode === 'off' ? '导出设置关闭字幕层。' : '没有满足自动策略的字幕事件。',
          };
    const videoBeforeVoiceover = subtitleLayer.applied ? subtitleOutput : rawOutput;
    const narrationText = orderedShots.map((shot) => `第${shot.order}镜。${shot.narration}`).join('\n');
    const voiceover =
      audioMode === 'voiceover'
        ? await traceExternal(
            data.traceTool,
            'tts.generate',
            { outputFile: path.basename(finalOutput), narrationLength: narrationText.length },
            () => addVoiceoverLayer(videoBeforeVoiceover, finalOutput, narrationText),
            (result) => ({ mixed: result.mixed, note: result.note }),
          )
        : { mixed: false, note: audioMode === 'mute' ? '按导出设置静音。' : '保留 segment 原始音轨。' };
    if (audioMode !== 'voiceover') {
      fs.copyFileSync(videoBeforeVoiceover, finalOutput);
    }

    script = await getScript(data.scriptId);
    if (!script) throw new Error(`剧本不存在：${data.scriptId}`);
    const video = await putFileObject(
      `render/${script.id}/${data.taskId}/final.mp4`,
      finalOutput,
      'video/mp4',
      data.traceTool,
    );
    const preview = await putTextObject(
      `render/${script.id}/${data.taskId}/preview.html`,
      buildPreviewHtml(script),
      'text/html; charset=utf-8',
      data.traceTool,
    );
    await updateTask(data.taskId, {
      status: 'completed',
      progress: 100,
      step: 'done',
      payload: {
        scriptId: script.id,
        videoUrl: video.url,
        objectKey: video.key,
        previewUrl: preview.url,
        previewObjectKey: preview.key,
        exportOptions: data.exportOptions,
        provider,
        format: 'mp4',
        composed: true,
        transitions,
        subtitleLayer: {
          ...summarizeSubtitlePlan(subtitlePlan),
          applied: subtitleLayer.applied,
          note: subtitleLayer.note,
        },
        renderMetrics: renderMetrics(decisions, subtitlePlan),
        mediaNote: `${subtitleLayer.note} ${voiceover.note} ${
          transitions.softTransitions ? `已应用 ${transitions.softTransitions} 个转场。` : '当前剪辑计划以硬切为主。'
        }`,
      },
      trace: { step: 'done', progress: 100, message: '生产 MP4 已生成。', data: { objectKey: video.key } },
    });
    return;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    await updateTask(data.taskId, {
      status: 'failed',
      progress: 0,
      step: 'seedance_render_failed',
      error: reason,
      trace: {
        step: 'seedance_render_failed',
        progress: 0,
        message: `Seedance 成片生成失败，已停止且不会降级使用素材切片或本地产物：${reason}`,
      },
    });
    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
