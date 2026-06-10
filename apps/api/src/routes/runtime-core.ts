import type { Express, Request, Response } from 'express';
import { embedText, embedImage, isEmbeddableImage, warmup } from '../lib/clip';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type {
  AgentTrace,
  Claim,
  Factor,
  FactorWeight,
  Material,
  MaterialAngle,
  Product,
  ReferenceVideo,
  Script,
  Shot,
  Slice,
  TaskStatus,
  TextLayer,
  TextLayerType,
  VideoPassport,
  VideoPerf,
} from '@aigc-video-hub/shared';
import { LEGACY_COMPLIANCE_RULES } from '../lib/trustloop/policy';
import { runResearchAgent, type ResearchOutput } from '../lib/trustloop/research';
import {
  auditScript,
  repairShot,
  type AuditIssue,
  type AuditResult,
  type RepairContext,
  type RepairExecutors,
} from '../lib/trustloop/qa';
import { computeVideoPassport } from '../lib/trustloop/passport';
import { POLICY_RULES_V2, validateClaim } from '../lib/trustloop/policy';
import {
  anchorEvidence,
  anchorClaim,
  anchorShot,
  anchorScript,
  anchorVideo,
  derivePassportFromDag,
} from '../lib/trust-dag';
import { registerTrustDagRoutes } from '../lib/routes/trust-dag';
import { registerCopilotRoutes } from '../lib/routes/copilot';
import { registerMaterialsRoutes } from '../lib/routes/materials';
import { registerRecipeRoutes } from '../lib/routes/recipes';
import { clipWarmupEnabled, vectorSearchEnabled } from '../lib/light-mode';
import { registerRenderRoutes } from '../lib/routes/render';
import { registerScriptsRoutes } from '../lib/routes/scripts';
import { registerVideoTagRoutes } from '../lib/video-tags/routes';
import { sendApiError } from '../lib/http/api-error';
import { RuntimeTaskService, type RuntimeTask } from '../lib/runtime/task-service';
import { describeProviderError, fetchPublicBinary } from '../lib/providers/doubao';
import { configuredSeedanceConcurrency, isSeedanceConfigured } from '../lib/providers/seedance';
import {
  generateQwenAngleImage,
  isQwenAngleProviderConfigured,
  MATERIAL_ANGLE_SPECS,
  normalizeQwenMultiAnglePose,
  type MaterialAngleSpec,
} from '../lib/providers/material-angles';
import {
  copyLocalFile,
  ensureLocalDir,
  listLocalDir,
  localFileSize,
  localPathExists,
  readLocalBinary,
  readLocalText,
  renameLocalPath,
  statLocalPath,
  writeLocalBinary,
  writeLocalText,
} from '../lib/providers/files';
import {
  createQueuedTask,
  getProductionRenderPreview,
  getProductionScript,
  getProductionSlice,
  getQueuedTaskResponse,
  listProductionMaterials,
  retryQueuedTask,
  saveProductionMaterial,
  saveProductionMaterialAngles,
  searchProductionMaterialSlices,
} from '../lib/production';
import { createStorageClient, storageConfigFromEnv } from '@aigc-video-hub/storage';
import {
  createComplianceCheck,
  createEvolutionPoint,
  createTrustLoopTrace,
  createVideoPerfRecord,
  deleteMessageFeedbackByMessageId,
  deleteReferenceVideo,
  getAuditResult,
  getComplianceCheck,
  getEvidenceRecord,
  getPassport,
  findLatestTrustScriptNode,
  VECTOR_TEXT_EMBEDDING_DIMS,
  VECTOR_TEXT_EMBEDDING_MODEL,
  listComplianceChecks,
  listEvolutionPoints,
  listFactorWeights,
  listMessageFeedbacks,
  listReferenceVideos,
  listTrustLoopTraces,
  listTrustNodes,
  listVideoPerfRecords,
  updateComplianceCheck,
  upsertAuditResult,
  upsertEvidenceRecord,
  upsertFactorWeight,
  upsertMessageFeedback,
  upsertPassport,
  upsertReferenceVideo,
} from '@aigc-video-hub/db';

type RuntimeDirs = {
  publicDir: string;
  uploadDir: string;
  generatedDir: string;
};

type RuntimeTemplate = {
  id: string;
  name: string;
  description: string;
  strategyIds: string[];
  factorIds: string[];
  sourceVideoIds: string[];
  factors: Factor[];
};

type RankedSlice = Slice & {
  score: number;
  match: {
    keyword: number;
    vector: number;
    tag: number;
    rrf: number;
    phrase: number;
  };
};

type ComplianceLevel = 'pass' | 'warn' | 'block';
type RenderProvider = 'auto' | 'local' | 'seedance';
type ScriptProvider = 'auto' | 'local' | 'doubao';
type AudioMode = 'original' | 'voiceover' | 'mute';
type RetrievalMode = 'rag' | 'none';

type StoredMaterial = Omit<Material, 'uploadedAt'> & { uploadedAt: string | Date };
type StoredVideoPerf = Omit<VideoPerf, 'createdAt'> & { createdAt: string | Date };
type StoredFactorWeight = Omit<FactorWeight, 'updatedAt'> & { updatedAt: string | Date };
type StoredRuntimeTask = Omit<RuntimeTask, 'createdAt' | 'updatedAt'> & {
  createdAt: string | Date;
  updatedAt: string | Date;
};

type MessageFeedback = {
  id: string;
  messageId: string;
  messageText: string;
  productId?: string;
  reaction: 'up' | 'down';
  createdAt: string;
};

type RuntimeStorePayload = {
  materials?: StoredMaterial[];
  materialAngles?: MaterialAngle[];
  slices?: Slice[];
  referenceVideos?: ReferenceVideo[];
  scripts?: Script[];
  videoPerfs?: StoredVideoPerf[];
  factorWeights?: StoredFactorWeight[];
  evolution?: EvolutionPoint[];
  complianceChecks?: ComplianceCheckRecord[];
  messageFeedbacks?: MessageFeedback[];
  tasks?: StoredRuntimeTask[];
  evidenceRecords?: Array<{ productId: string; output: ResearchOutput }>;
  passports?: VideoPassport[];
  trustloopTraces?: Array<{ taskId: string; traces: AgentTrace[] }>;
  auditResults?: Array<{ taskId: string; audit: AuditResult }>;
  scriptPreviewUrls?: Array<[string, string]>;
};

type ComplianceCheckRecord = {
  id: string;
  targetType: 'material' | 'script' | 'video';
  targetId: string;
  level: ComplianceLevel;
  hits: Array<{
    ruleId: string;
    rule: string;
    level: ComplianceLevel;
    reason: string;
    suggestion: string;
  }>;
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;
  createdAt: string;
};

type EvolutionPoint = {
  factorId: string;
  factorType: string;
  factorValue: string;
  weight: number;
  sampleSize: number;
  updatedAt: string;
};

type LearningSource = 'observed' | 'kalodata_seed';

const taskTerminalStatuses = new Set<TaskStatus['status']>(['completed', 'failed']);

const factorLibrary: Factor[] = [
  { type: '视角', value: '第一人称开箱', sourceStrategy: 'immersive_creator' },
  { type: '视角', value: '第三人称场景演示', sourceStrategy: 'scenario_proof' },
  { type: '视角', value: '买家视角实测', sourceStrategy: 'buyer_evidence' },
  { type: '节奏', value: '前三秒快节奏痛点', sourceStrategy: 'fast_hook' },
  { type: '节奏', value: '沉浸式慢展示', sourceStrategy: 'slow_premium' },
  { type: 'BGM情绪', value: '轻快电子', sourceStrategy: 'upbeat_conversion' },
  { type: 'BGM情绪', value: '温柔生活感', sourceStrategy: 'soft_lifestyle' },
  { type: '色调', value: '高饱和清爽', sourceStrategy: 'fresh_visual' },
  { type: '色调', value: '暖色居家', sourceStrategy: 'warm_home' },
  { type: 'hook类型', value: '问题式开场', sourceStrategy: 'question_hook' },
  { type: 'hook类型', value: '对比式开场', sourceStrategy: 'contrast_hook' },
  { type: 'hook类型', value: '评论答疑开场', sourceStrategy: 'comment_remix' },
];

const factorEffects = new Map<string, number>([
  ['视角|第一人称开箱', 0.006],
  ['视角|买家视角实测', 0.004],
  ['节奏|前三秒快节奏痛点', 0.007],
  ['BGM情绪|轻快电子', 0.003],
  ['色调|高饱和清爽', 0.003],
  ['hook类型|问题式开场', 0.008],
  ['hook类型|评论答疑开场', 0.005],
]);

// TrustLoop D1：升级为 trustloop/policy.ts 三层规则（block/warn/needs_evidence）
// 此处维持 spec-runtime 规则形状（needs_evidence 降级为 warn），避免下游处理新 level。
const complianceRules = LEGACY_COMPLIANCE_RULES;

function nowIso() {
  return new Date().toISOString();
}

function formatElapsedMs(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

function round(value: number, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function factorKey(factor: Pick<Factor, 'type' | 'value'>) {
  return `${factor.type}|${factor.value}`;
}

function factorId(factor: Pick<Factor, 'type' | 'value'>) {
  return `factor_${Buffer.from(factorKey(factor)).toString('base64url').slice(0, 20)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeFileBase(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 72) || 'asset';
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textWords(value: string) {
  return value
    .toLowerCase()
    .split(/[\s,，。.;；:：/\\|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function overlapScore(query: string, text: string) {
  const words = textWords(query);
  if (!words.length) return 1;
  const haystack = text.toLowerCase();
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits / words.length;
}

function cosineSimilarity(a: number[], b: number[]) {
  // 维度不同说明新旧 embedding 不兼容，跳过向量分
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeRate(value: unknown, fallback = 0) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return clamp(raw > 1 ? raw / 100 : raw, 0, 1);
}

function normalizeNumber(value: unknown, fallback = 0) {
  const raw = Number(value);
  return Number.isFinite(raw) ? raw : fallback;
}

function saveDataUrl(uploadDir: string, name: string, dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return undefined;
  const mime = match[1];
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : mime.includes('mp4') ? 'mp4' : 'bin';
  const file = `${Date.now()}_${uuid().slice(0, 8)}_${sanitizeFileBase(name).replace(/\.[^.]+$/, '')}.${ext}`;
  writeLocalBinary(path.join(uploadDir, file), Buffer.from(match[2], 'base64'));
  return `/uploads/${file}`;
}

function folderSizeBytes(folder: string): number {
  try {
    if (!localPathExists(folder)) return 0;
    return listLocalDir(folder).reduce((sum, item) => {
      const fullPath = path.join(folder, item);
      const stat = statLocalPath(fullPath);
      return sum + (stat.isDirectory() ? folderSizeBytes(fullPath) : stat.size);
    }, 0);
  } catch {
    return 0;
  }
}

function sendJsonError(res: Response, status: number, error: string) {
  sendApiError(res, status, error);
}

function envValue(name: string) {
  return process.env[name]?.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function safeExternalError(error: unknown) {
  const providerError = describeProviderError(error);
  if (providerError.statusText) return providerError.statusText.slice(0, 160);
  if (providerError.timeout) return '外部服务请求超时';
  return providerError.message.slice(0, 160);
}

function readText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readTextArray(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => readText(item)).filter(Boolean);
  return items.length ? items : fallback;
}

function readTextLayerType(value: unknown): TextLayerType {
  return value === 'selling_point' || value === 'price' || value === 'brand' || value === 'cta' ? value : 'subtitle';
}

function readLayerPosition(value: unknown, fallback: { x: number; y: number }) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    x: clamp(normalizeNumber(record.x, fallback.x), 0.04, 0.96),
    y: clamp(normalizeNumber(record.y, fallback.y), 0.08, 0.92),
  };
}

function defaultTextLayerStyle(type: TextLayerType): TextLayer['style'] {
  if (type === 'subtitle') {
    return {
      fontSize: 36,
      color: '#ffffff',
      stroke: '',
      background: 'rgba(15, 23, 42, 0.32)',
      align: 'center',
    };
  }
  return {
    fontSize: 44,
    color: '#111827',
    stroke: '',
    background: 'rgba(255, 255, 255, 0.76)',
    align: 'center',
  };
}

function readLayerStyle(value: unknown, type: TextLayerType): TextLayer['style'] {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const align =
    record.align === 'left' || record.align === 'right' || record.align === 'center' ? record.align : 'center';
  const defaults = defaultTextLayerStyle(type);
  return {
    fontSize: clamp(Math.round(normalizeNumber(record.fontSize, defaults.fontSize)), 20, 96),
    color: readText(record.color, defaults.color),
    stroke: readText(record.stroke, defaults.stroke || ''),
    background: readText(record.background, defaults.background || ''),
    align,
  };
}

function defaultTextLayerForShot(shot: Pick<Shot, 'id' | 'duration' | 'subtitle' | 'narration'>): TextLayer {
  const text = readText(shot.subtitle, readText(shot.narration, ''));
  return {
    id: `text_${shot.id}_subtitle`,
    type: 'subtitle',
    text,
    start: 0,
    end: Math.max(1, normalizeNumber(shot.duration, 3)),
    position: { x: 0.5, y: 0.82 },
    style: defaultTextLayerStyle('subtitle'),
    editable: true,
  };
}

function normalizeTextLayers(
  value: unknown,
  shot: Pick<Shot, 'id' | 'duration' | 'subtitle' | 'narration'>,
): TextLayer[] {
  const rawLayers = Array.isArray(value) ? value : [];
  const normalized = rawLayers
    .map((item, index) => {
      const record = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      const text = safeMarketingText(readText(record.text));
      if (!text) return undefined;
      const start = clamp(normalizeNumber(record.start, 0), 0, Math.max(1, shot.duration));
      const end = clamp(normalizeNumber(record.end, shot.duration), start + 0.1, Math.max(1, shot.duration));
      const type = readTextLayerType(record.type);
      return {
        id: readText(record.id, `text_${shot.id}_${index + 1}`),
        type,
        text,
        start,
        end,
        position: readLayerPosition(record.position, { x: 0.5, y: 0.82 }),
        style: readLayerStyle(record.style, type),
        editable: record.editable !== false,
      };
    })
    .filter((layer): layer is TextLayer => Boolean(layer));
  return normalized.length ? normalized : [defaultTextLayerForShot(shot)];
}

function ensureShotTextLayers<T extends Shot>(shot: T): T {
  return { ...shot, textLayers: normalizeTextLayers(shot.textLayers, shot) };
}

function compactText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function safeMarketingText(value: string) {
  return value
    .replace(/根治|包治/gi, '帮助改善体验')
    .replace(/永久/gi, '长期使用时')
    .replace(/100%/g, '尽量')
    .replace(/无副作用/gi, '使用前留意适用说明')
    .replace(/销量第一|全网第一|最有效|最强|最好/gi, '表现稳定')
    .replace(/最低价/gi, '页面实时权益')
    .replace(/错过后悔|马上抢光|只剩最后/gi, '以页面实时库存与权益为准');
}

function normalizeAudioMode(value: unknown): AudioMode {
  if (value === 'voiceover' || value === 'mute' || value === 'original') return value;
  const configured = process.env.SPEC_AUDIO_MODE;
  if (configured === 'voiceover' || configured === 'mute' || configured === 'original') return configured;
  return 'voiceover';
}

function normalizeRetrievalMode(value: unknown): RetrievalMode {
  return value === 'none' ? 'none' : 'rag';
}

function normalizeAspectRatio(value: unknown): Script['aspectRatio'] {
  return value === '16:9' ? '16:9' : '9:16';
}

function tagExactScore(query: string, tags: string[]) {
  const words = textWords(query);
  if (!words.length || !tags.length) return 0;
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  const hits = words.filter((word) => normalizedTags.some((tag) => tag === word || tag.includes(word))).length;
  return hits / words.length;
}

function restoreDate(value: string | Date | undefined) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => deepStrings(item));
  if (value && typeof value === 'object') return Object.values(value).flatMap((item) => deepStrings(item));
  return [];
}

function readTaskId(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  const nested = data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {};
  return readText(data.id) || readText(data.task_id) || readText(nested.id) || readText(nested.task_id);
}

function readTaskStatus(value: unknown) {
  const candidates = deepStrings(value).map((item) => item.toLowerCase());
  if (candidates.some((item) => ['succeeded', 'success', 'done', 'completed'].includes(item))) return 'done';
  if (candidates.some((item) => ['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(item)))
    return 'failed';
  return 'running';
}

export function registerSpecRuntimeRoutes(app: Express, dirs: RuntimeDirs) {
  const storageClient = createStorageClient(storageConfigFromEnv());
  const materials = new Map<string, Material>();
  const materialAngles = new Map<string, MaterialAngle>();
  const slices = new Map<string, Slice>();
  const referenceVideos = new Map<string, ReferenceVideo>();
  const scripts = new Map<string, Script>();
  const tasks = new Map<string, RuntimeTask>();
  const taskService = new RuntimeTaskService(tasks, () => persistRuntimeStore());
  const videoPerfs: VideoPerf[] = [];
  const factorWeights = new Map<string, FactorWeight>();
  const evolution: EvolutionPoint[] = [];
  const complianceChecks = new Map<string, ComplianceCheckRecord>();
  const messageFeedbacks: MessageFeedback[] = [];
  const scriptPreviewUrls = new Map<string, string>();
  // TrustLoop stores
  const evidenceStore = new Map<string, ResearchOutput>(); // key: productId
  const passportStore = new Map<string, VideoPassport>(); // key: videoId (jobId)
  const trustloopTraces = new Map<string, AgentTrace[]>(); // key: taskId
  const auditResults = new Map<string, AuditResult>(); // key: taskId
  const dataDir = path.join(path.dirname(dirs.publicDir), 'data');
  const runtimeStoreFile = path.join(dataDir, 'spec-runtime.json');
  const referenceStoreFile = path.join(dataDir, 'reference-videos.json');

  function materialPosterSpec(material: Material) {
    const text = `${material.sourceDeclaration} ${material.sourceUrl}`;
    if (/投影/.test(text)) return { key: 'projector', bg: '#0f172a', accent: '#38bdf8' };
    if (/耳机/.test(text)) return { key: 'earbuds', bg: '#111827', accent: '#a7f3d0' };
    if (/护肤|乳|套装/.test(text)) return { key: 'skincare', bg: '#f5f3ff', accent: '#8b5cf6' };
    if (/口红/.test(text)) return { key: 'lipstick', bg: '#fff1f2', accent: '#e11d48' };
    if (/咖啡/.test(text)) return { key: 'coffee', bg: '#f7fee7', accent: '#65a30d' };
    if (/榨汁|果昔/.test(text)) return { key: 'blender', bg: '#ecfeff', accent: '#0891b2' };
    if (/背包|收纳/.test(text)) return { key: 'bag', bg: '#f8fafc', accent: '#475569' };
    if (/鞋|跑步/.test(text)) return { key: 'shoe', bg: '#f0fdf4', accent: '#16a34a' };
    if (/加湿/.test(text)) return { key: 'humidifier', bg: '#eff6ff', accent: '#2563eb' };
    if (/宠物|猫咪|喂食/.test(text)) return { key: 'pet', bg: '#fff7ed', accent: '#ea580c' };
    if (/手机支架|直播|菜谱/.test(text)) return { key: 'stand', bg: '#fdf2f8', accent: '#db2777' };
    return { key: 'product', bg: '#f8fafc', accent: '#0f766e' };
  }

  function materialPosterSvg(material: Material) {
    const spec = materialPosterSpec(material);
    const accent = spec.accent;
    const common = `<rect width="720" height="960" rx="44" fill="${spec.bg}"/><circle cx="595" cy="150" r="118" fill="${accent}" opacity=".16"/><circle cx="118" cy="790" r="144" fill="${accent}" opacity=".14"/>`;
    const shadow = `<ellipse cx="360" cy="748" rx="190" ry="32" fill="#000" opacity=".13"/>`;
    const shapes: Record<string, string> = {
      projector: `${common}<path d="M172 612h376v94H172z" fill="#e5e7eb"/><path d="M214 460h292c44 0 80 35 80 79v70H134v-70c0-44 36-79 80-79z" fill="#f8fafc"/><circle cx="260" cy="560" r="50" fill="#0f172a"/><circle cx="260" cy="560" r="25" fill="${accent}"/><path d="M332 530l214-96v214L332 588z" fill="${accent}" opacity=".34"/>${shadow}`,
      earbuds: `${common}<path d="M230 316c66 0 112 50 112 116v118c0 40-32 72-72 72s-72-32-72-72V426h54v124c0 10 8 18 18 18s18-8 18-18V432c0-36-23-62-58-62v-54z" fill="#f8fafc"/><path d="M490 316c-66 0-112 50-112 116v118c0 40 32 72 72 72s72-32 72-72V426h-54v124c0 10-8 18-18 18s-18-8-18-18V432c0-36 23-62 58-62v-54z" fill="${accent}"/>${shadow}`,
      skincare: `${common}<rect x="272" y="250" width="176" height="410" rx="46" fill="#fff"/><rect x="302" y="186" width="116" height="82" rx="24" fill="${accent}"/><path d="M250 710c74-44 149-44 224 0 28 17 18 60-18 60H268c-36 0-46-43-18-60z" fill="${accent}" opacity=".44"/>${shadow}`,
      lipstick: `${common}<path d="M312 250l72-54 72 54v146H312z" fill="${accent}"/><rect x="290" y="396" width="188" height="286" rx="34" fill="#111827"/><rect x="318" y="430" width="132" height="214" rx="22" fill="#f8fafc" opacity=".92"/>${shadow}`,
      coffee: `${common}<path d="M232 426h234v154c0 86-54 142-117 142S232 666 232 580V426z" fill="#fff"/><path d="M466 472h46c40 0 70 30 70 70s-30 70-70 70h-46v-48h40c16 0 28-12 28-28s-12-28-28-28h-40v-36z" fill="#fff"/><path d="M285 360c-28-44 38-62 10-110M364 360c-28-44 38-62 10-110M443 360c-28-44 38-62 10-110" stroke="${accent}" stroke-width="24" stroke-linecap="round" fill="none"/>${shadow}`,
      blender: `${common}<path d="M244 230h232l-32 404H276z" fill="#e0f2fe"/><path d="M276 634h168v82H276z" fill="${accent}"/><circle cx="306" cy="430" r="34" fill="#f97316"/><circle cx="386" cy="372" r="42" fill="#84cc16"/><circle cx="408" cy="486" r="30" fill="#facc15"/>${shadow}`,
      bag: `${common}<path d="M232 330c0-70 56-126 126-126h4c70 0 126 56 126 126" stroke="${accent}" stroke-width="44" fill="none"/><rect x="198" y="324" width="324" height="392" rx="54" fill="#fff"/><rect x="248" y="472" width="224" height="138" rx="30" fill="${accent}" opacity=".72"/>${shadow}`,
      shoe: `${common}<path d="M136 602c86 0 130-76 192-76 78 0 114 90 236 96 34 2 58 29 58 62v18H124v-38c0-34 12-62 12-62z" fill="#fff"/><path d="M196 598c120 30 262 48 418 44" stroke="${accent}" stroke-width="20" stroke-linecap="round" fill="none"/>${shadow}`,
      humidifier: `${common}<rect x="244" y="424" width="232" height="276" rx="52" fill="#fff"/><path d="M294 424h132l-18-96H312z" fill="${accent}" opacity=".52"/><path d="M300 318c-30-52 38-72 8-126M372 318c-30-52 38-72 8-126M444 318c-30-52 38-72 8-126" stroke="${accent}" stroke-width="18" stroke-linecap="round" fill="none" opacity=".72"/>${shadow}`,
      pet: `${common}<path d="M264 302l52 54h88l52-54v168H264z" fill="#fff"/><circle cx="316" cy="420" r="13" fill="#111827"/><circle cx="404" cy="420" r="13" fill="#111827"/><path d="M234 580h252c40 0 72 32 72 72v18H162v-18c0-40 32-72 72-72z" fill="${accent}" opacity=".72"/>${shadow}`,
      stand: `${common}<rect x="284" y="198" width="184" height="358" rx="36" fill="#111827"/><rect x="304" y="232" width="144" height="286" rx="20" fill="#f8fafc"/><path d="M370 556v118M260 674h220" stroke="${accent}" stroke-width="34" stroke-linecap="round"/>${shadow}`,
      product: `${common}<rect x="232" y="306" width="256" height="330" rx="40" fill="#fff"/><path d="M232 392h256" stroke="${accent}" stroke-width="34"/><circle cx="360" cy="514" r="70" fill="${accent}" opacity=".32"/>${shadow}`,
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960">${shapes[spec.key]}</svg>`;
  }

  function materialPosterUrl(material: Material) {
    const posterDir = path.join(dirs.generatedDir, 'material-posters');
    ensureLocalDir(posterDir);
    const file = `${sanitizeFileBase(material.id)}.svg`;
    const fullPath = path.join(posterDir, file);
    if (!localPathExists(fullPath)) {
      writeLocalText(fullPath, materialPosterSvg(material));
    }
    return `/generated/material-posters/${file}`;
  }

  function materialAnglePreviewUrl(material: Material, spec: MaterialAngleSpec) {
    const folder = path.join(dirs.generatedDir, 'material-angles');
    ensureLocalDir(folder);
    const file = `${sanitizeFileBase(material.id)}_${sanitizeFileBase(spec.key)}_preview.svg`;
    const fullPath = path.join(folder, file);
    const tilt: Record<string, string> = {
      front: 'rotate(0 480 460)',
      left_30: 'translate(-28 0) skewY(-4) rotate(-3 480 460)',
      right_30: 'translate(28 0) skewY(4) rotate(3 480 460)',
      top_15: 'translate(0 -18) scale(1 .9)',
      detail: 'scale(1.16) translate(-66 -54)',
      custom: 'translate(0 -8) scale(1.04)',
    };
    const pose = spec.pose;
    const poseTransform = pose
      ? (() => {
          const azimuth = (pose.azimuthDeg * Math.PI) / 180;
          const side = Math.sin(azimuth);
          const face = Math.abs(Math.cos(azimuth));
          const scaleX = 0.56 + face * 0.44;
          const zoom = 1 + pose.distanceLevel * 0.018;
          const x = side * 70;
          const y = -pose.elevationDeg * 0.9;
          const skew = side * 11;
          return `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${zoom.toFixed(2)}) skewY(${skew.toFixed(1)}) scale(${scaleX.toFixed(2)} 1)`;
        })()
      : tilt[spec.key] || tilt[spec.view] || tilt.custom;
    writeLocalText(
      fullPath,
      `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960" viewBox="0 0 960 960">
        <rect width="960" height="960" fill="#fafaf9"/>
        <rect x="86" y="86" width="788" height="788" rx="42" fill="#fff" stroke="#e5e5e5"/>
        <g transform="${poseTransform}">
          <image href="${escapeXml(material.sourceUrl)}" x="170" y="150" width="620" height="620" preserveAspectRatio="xMidYMid meet"/>
        </g>
        <rect x="86" y="768" width="788" height="106" rx="0" fill="#0a0a0a" opacity=".82"/>
        <text x="130" y="832" font-family="Arial, PingFang SC, sans-serif" font-size="34" font-weight="700" fill="#fff">${escapeXml(
          spec.label,
        )}</text>
        <text x="130" y="864" font-family="Arial, PingFang SC, sans-serif" font-size="18" fill="#d4d4d4">local angle fallback</text>
      </svg>`,
    );
    return `/generated/material-angles/${file}`;
  }

  function mimeExtension(contentType = '', fallbackUrl = '') {
    const normalized = contentType.toLowerCase();
    if (normalized.includes('png')) return 'png';
    if (normalized.includes('webp')) return 'webp';
    if (normalized.includes('gif')) return 'gif';
    if (normalized.includes('svg')) return 'svg';
    try {
      const ext = path.extname(new URL(fallbackUrl).pathname).replace(/^\./, '').toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    } catch {
      // Fall through to jpg.
    }
    return 'jpg';
  }

  async function cacheAngleImage(material: Material, spec: MaterialAngleSpec, imageUrl: string) {
    if (imageUrl.startsWith('/uploads/') || imageUrl.startsWith('/generated/')) return imageUrl;
    const folder = path.join(dirs.generatedDir, 'material-angles');
    ensureLocalDir(folder);

    let bytes: Buffer;
    let ext = 'jpg';
    const dataMatch = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (dataMatch) {
      ext = mimeExtension(dataMatch[1]);
      bytes = Buffer.from(dataMatch[2], 'base64');
    } else {
      const fetched = await fetchPublicBinary(imageUrl, { timeoutMs: 30_000 });
      ext = mimeExtension(fetched.contentType, imageUrl);
      bytes = fetched.bytes;
    }

    const file = `${sanitizeFileBase(material.id)}_${sanitizeFileBase(spec.key)}.${ext}`;
    writeLocalBinary(path.join(folder, file), bytes);
    return `/generated/material-angles/${file}`;
  }

  function localMaterialAngle(material: Material, spec: MaterialAngleSpec, note: string): MaterialAngle {
    const previewUrl = materialAnglePreviewUrl(material, spec);
    return {
      id: `angle_${material.id}_${sanitizeFileBase(spec.key)}`,
      materialId: material.id,
      productId: material.productId,
      view: spec.view,
      key: spec.key,
      label: spec.label,
      imageUrl: previewUrl,
      referenceImageUrl: material.sourceUrl,
      previewUrl,
      sourceImageUrl: material.sourceUrl,
      promptHint: spec.promptHint,
      pose: spec.pose,
      provider: 'local',
      status: 'fallback',
      note,
      createdAt: nowIso(),
    };
  }

  async function qwenMaterialAngle(material: Material, spec: MaterialAngleSpec): Promise<MaterialAngle> {
    const sourceImageUrl = resolveReferenceImageUrl(material.sourceUrl) || material.sourceUrl;
    const result = await generateQwenAngleImage({
      sourceImageUrl,
      spec,
      productName: material.name,
    });
    const cachedUrl = await cacheAngleImage(material, spec, result.imageUrl);
    return {
      id: `angle_${material.id}_${sanitizeFileBase(spec.key)}`,
      materialId: material.id,
      productId: material.productId,
      view: spec.view,
      key: spec.key,
      label: spec.label,
      imageUrl: cachedUrl,
      referenceImageUrl: cachedUrl,
      previewUrl: cachedUrl,
      sourceImageUrl: material.sourceUrl,
      promptHint: spec.promptHint,
      pose: spec.pose,
      provider: 'qwen',
      status: 'ready',
      createdAt: nowIso(),
    };
  }

  function mediaLooksEmpty(url = '') {
    if (url.endsWith('/demo_product.svg')) return true;
    if (!url.startsWith('/uploads/') || !/\.(mp4|mov|webm|m3u8)(\?|$)/i.test(url)) return false;
    const filePath = path.join(dirs.publicDir, url.replace(/^\//, ''));
    try {
      return localPathExists(filePath) && localFileSize(filePath) < 1024;
    } catch {
      return true;
    }
  }

  function publicMaterial(material: Material) {
    const posterUrl = materialPosterUrl(material);
    return {
      ...material,
      posterUrl,
      hasPlayableSource: !mediaLooksEmpty(material.sourceUrl),
      angles: [...materialAngles.values()].filter((angle) => angle.materialId === material.id),
      slices: [...slices.values()]
        .filter((slice) => slice.materialId === material.id)
        .map((slice) => publicSlice(slice, material)),
    };
  }

  function publicSlice<T extends Slice>(slice: T, material = materials.get(slice.materialId)) {
    const publicFields = { ...slice };
    delete (publicFields as { embedding?: unknown }).embedding;
    if (material) {
      const posterUrl = materialPosterUrl(material);
      if (!publicFields.thumbnailUrl || mediaLooksEmpty(publicFields.thumbnailUrl))
        publicFields.thumbnailUrl = posterUrl;
      if (!publicFields.clipUrl || mediaLooksEmpty(publicFields.clipUrl)) publicFields.clipUrl = posterUrl;
    }
    return publicFields;
  }

  function productMaterials(productId: string) {
    return [...materials.values()].filter((material) => material.productId === productId);
  }

  function productMaterialIds(productId: string) {
    return new Set(productMaterials(productId).map((material) => material.id));
  }

  function productReferenceImageUrl(productId: string) {
    return productMaterials(productId).find(
      (material) => material.type === 'image' && !mediaLooksEmpty(material.sourceUrl),
    )?.sourceUrl;
  }

  function normalizeReferenceProvenance(reference: ReferenceVideo) {
    if (reference.sourceUrl.includes('douyin.com') && reference.sourceDeclaration.includes('哔哩哔哩')) {
      reference.sourceDeclaration = reference.sourceDeclaration.replace('哔哩哔哩', '抖音');
      if (reference.breakdownReport && typeof reference.breakdownReport === 'object') {
        reference.breakdownReport = { ...reference.breakdownReport, sourceName: '抖音' };
      }
    }
    if (reference.sourceUrl.includes('example.com')) {
      reference.sourceDeclaration = '示例方法论占位，不作为公开视频来源证据，不流入创作。';
      reference.usageScope = 'analysis';
    }
    return reference;
  }

  function applyProductGrounding(script: Script) {
    const materialIds = productMaterials(script.productId).map((material) => material.id);
    const productEvidence = evidenceStore
      .get(script.productId)
      ?.evidence.find((evidence) => evidence.sourceType === 'product' && evidence.sourceUrl);
    script.materialIds = materialIds;
    script.referenceImageUrl = productReferenceImageUrl(script.productId);
    script.productUrl = evidenceStore.get(script.productId)?.productUrl || productEvidence?.sourceUrl;
    return script;
  }

  const templates: RuntimeTemplate[] = [
    {
      id: 'tpl_problem_solution',
      name: '痛点解决转化模板',
      description: '前三秒痛点、细节证据、场景演示、决策收束。',
      strategyIds: ['strategy_problem_solution'],
      factorIds: ['factor_hook_question', 'factor_visual_proof', 'factor_decision_wrap'],
      sourceVideoIds: ['ref_mock_001', 'ref_mock_002'],
      factors: [
        { type: 'hook类型', value: '问题式开场', sourceStrategy: 'question_hook' },
        { type: '节奏', value: '前三秒快节奏痛点', sourceStrategy: 'fast_hook' },
        { type: '画面重点', value: '细节证据特写', sourceStrategy: 'visual_proof' },
      ],
    },
    {
      id: 'tpl_comment_remix',
      name: '评论答疑二创模板',
      description: '把高频顾虑转成回复评论式带货短视频。',
      strategyIds: ['strategy_comment_remix'],
      factorIds: ['factor_comment_hook', 'factor_buyer_evidence'],
      sourceVideoIds: ['ref_mock_003'],
      factors: [
        { type: 'hook类型', value: '评论答疑开场', sourceStrategy: 'comment_remix' },
        { type: '视角', value: '买家视角实测', sourceStrategy: 'buyer_evidence' },
      ],
    },
    {
      id: 'tpl_auto_flywheel',
      name: '增长飞轮自动模板',
      description: '按 FactorWeight 加权选择因子，让下一批生成偏向高转化打法。',
      strategyIds: ['strategy_auto_flywheel'],
      factorIds: ['factor_weighted_auto'],
      sourceVideoIds: ['ref_mock_004'],
      factors: [
        { type: '视角', value: '第一人称开箱', sourceStrategy: 'immersive_creator' },
        { type: 'hook类型', value: '问题式开场', sourceStrategy: 'question_hook' },
        { type: '色调', value: '高饱和清爽', sourceStrategy: 'fresh_visual' },
      ],
    },
  ];

  const upload = multer({
    storage: multer.diskStorage({
      destination: dirs.uploadDir,
      filename: (_req, file, callback) => {
        const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video/') ? '.mp4' : '.png');
        callback(null, `${Date.now()}_${uuid().slice(0, 8)}_${sanitizeFileBase(file.originalname || `upload${ext}`)}`);
      },
    }),
    limits: { fileSize: 80 * 1024 * 1024 },
  });

  function taskElapsedMs(task: RuntimeTask) {
    const endTime = taskTerminalStatuses.has(task.status) ? task.updatedAt.getTime() : Date.now();
    return Math.max(0, endTime - task.createdAt.getTime());
  }

  function updateTaskElapsed(task: RuntimeTask) {
    const elapsedMs = taskElapsedMs(task);
    task.elapsedMs = elapsedMs;
    task.elapsedText = formatElapsedMs(elapsedMs);
    return { elapsedMs, elapsedText: task.elapsedText };
  }

  function updateTask(
    taskId: string,
    status: TaskStatus['status'],
    progress: number,
    step: string,
    message: string,
    patch: { error?: string; payload?: Record<string, unknown>; data?: Record<string, unknown> } = {},
  ) {
    taskService.update(taskId, status, progress, step, message, patch);
  }

  function loadRuntimeStore() {
    try {
      if (!localPathExists(runtimeStoreFile)) return;
      const store = JSON.parse(readLocalText(runtimeStoreFile)) as RuntimeStorePayload;

      for (const item of store.materials || []) {
        if (!item?.id || !item.sourceUrl) continue;
        materials.set(item.id, { ...item, uploadedAt: restoreDate(item.uploadedAt) });
      }
      for (const item of store.materialAngles || []) {
        if (!item?.id || !item.materialId || !item.referenceImageUrl) continue;
        materialAngles.set(item.id, item);
      }
      for (const item of store.slices || []) {
        if (!item?.id || !item.materialId) continue;
        slices.set(item.id, item);
      }
      for (const item of store.referenceVideos || []) {
        if (!item?.id || !item.sourceUrl) continue;
        referenceVideos.set(item.id, normalizeReferenceProvenance(item));
      }
      for (const item of store.scripts || []) {
        if (!item?.id || !Array.isArray(item.shots)) continue;
        scripts.set(item.id, item);
      }
      for (const item of store.videoPerfs || []) {
        if (!item?.id || !item.scriptId) continue;
        videoPerfs.push({
          ...item,
          source: item.source || 'observed',
          createdAt: restoreDate(item.createdAt),
        });
      }
      for (const item of store.factorWeights || []) {
        if (!item?.factorId) continue;
        const factor = factorLibrary.find((candidate) => factorId(candidate) === item.factorId);
        if (!factor) continue;
        factorWeights.set(factorKey(factor), { ...item, updatedAt: restoreDate(item.updatedAt) });
      }
      evolution.push(...(store.evolution || []).filter((item) => item.factorId && item.updatedAt));
      for (const item of store.complianceChecks || []) {
        if (!item?.id || !item.targetId) continue;
        complianceChecks.set(item.id, item);
      }
      for (const item of store.messageFeedbacks || []) {
        if (!item?.id || !item.messageId || !item.reaction) continue;
        messageFeedbacks.push(item);
      }
      for (const item of store.tasks || []) {
        if (!item?.id || !item.type || !item.status) continue;
        const task: RuntimeTask = {
          ...item,
          createdAt: restoreDate(item.createdAt),
          updatedAt: restoreDate(item.updatedAt),
          trace: Array.isArray(item.trace) ? item.trace : [],
        };
        if (!taskTerminalStatuses.has(task.status)) {
          task.status = 'failed';
          task.step = 'interrupted';
          task.error = '服务曾重启，原任务已中断，可点击重试恢复。';
          task.updatedAt = new Date();
          const elapsed = updateTaskElapsed(task);
          task.trace.push({
            at: nowIso(),
            step: 'interrupted',
            progress: task.progress,
            message: task.error,
            elapsedMs: elapsed.elapsedMs,
            elapsedText: elapsed.elapsedText,
          });
        }
        tasks.set(task.id, task);
      }
      for (const record of store.evidenceRecords || []) {
        if (record?.productId && record.output) evidenceStore.set(record.productId, record.output);
      }
      for (const passport of store.passports || []) {
        if (passport?.videoId) passportStore.set(passport.videoId, passport);
      }
      for (const record of store.trustloopTraces || []) {
        if (record?.taskId && Array.isArray(record.traces)) trustloopTraces.set(record.taskId, record.traces);
      }
      for (const record of store.auditResults || []) {
        if (record?.taskId && record.audit) auditResults.set(record.taskId, record.audit);
      }
      for (const row of store.scriptPreviewUrls || []) {
        if (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string') {
          scriptPreviewUrls.set(row[0], row[1]);
        }
      }
    } catch (error) {
      console.warn(`规格运行时数据恢复失败，已继续使用空状态：${safeExternalError(error)}`);
    }
  }

  function loadReferenceVideoStore() {
    try {
      if (!localPathExists(referenceStoreFile)) return;
      const rows = JSON.parse(readLocalText(referenceStoreFile)) as ReferenceVideo[];
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!row || typeof row !== 'object' || !row.id || !row.sourceUrl) continue;
        referenceVideos.set(row.id, normalizeReferenceProvenance(row));
      }
    } catch {
      // Legacy reference-video store is best effort. The unified runtime store remains authoritative.
    }
  }

  function persistRuntimeStore() {
    ensureLocalDir(dataDir);
    const store: RuntimeStorePayload = {
      materials: [...materials.values()],
      materialAngles: [...materialAngles.values()],
      slices: [...slices.values()],
      referenceVideos: [...referenceVideos.values()],
      scripts: [...scripts.values()],
      videoPerfs,
      factorWeights: [...factorWeights.values()],
      evolution,
      complianceChecks: [...complianceChecks.values()],
      messageFeedbacks,
      tasks: [...tasks.values()],
      evidenceRecords: [...evidenceStore.entries()].map(([productId, output]) => ({ productId, output })),
      passports: [...passportStore.values()],
      trustloopTraces: [...trustloopTraces.entries()].map(([taskId, traces]) => ({ taskId, traces })),
      auditResults: [...auditResults.entries()].map(([taskId, audit]) => ({ taskId, audit })),
      scriptPreviewUrls: [...scriptPreviewUrls.entries()],
    };
    writeLocalText(runtimeStoreFile, `${JSON.stringify(store, null, 2)}\n`);
    writeLocalText(referenceStoreFile, `${JSON.stringify([...referenceVideos.values()], null, 2)}\n`);
  }

  function initializeWeights() {
    if (factorWeights.size > 0) return;
    for (const factor of factorLibrary) {
      const id = factorId(factor);
      factorWeights.set(factorKey(factor), {
        id: `weight_${uuid().slice(0, 8)}`,
        factorId: id,
        weight: 1,
        updatedAt: new Date(),
        sampleSize: 0,
      });
      evolution.push({
        factorId: id,
        factorType: factor.type,
        factorValue: factor.value,
        weight: 1,
        sampleSize: 0,
        updatedAt: nowIso(),
      });
    }
  }

  function sliceSearchText(slice: Slice) {
    return `${slice.summary} ${Object.values(slice.tags).flat().join(' ')}`;
  }

  function normalizedRrfScores(rankedIds: string[][]) {
    const scores = new Map<string, number>();
    for (const ids of rankedIds) {
      ids.forEach((id, index) => {
        scores.set(id, (scores.get(id) || 0) + 1 / (60 + index + 1));
      });
    }
    const maxScore = Math.max(0, ...scores.values());
    return {
      get(id: string) {
        return maxScore > 0 ? (scores.get(id) || 0) / maxScore : 0;
      },
    };
  }

  async function rankSlicesForQuery(query: string, k = 12, productId?: string): Promise<RankedSlice[]> {
    const permittedMaterialIds = productId ? productMaterialIds(productId) : undefined;
    const allSlices = [...slices.values()].filter(
      (slice) => !permittedMaterialIds || permittedMaterialIds.has(slice.materialId),
    );
    if (!allSlices.length) return [];

    const queryText = query.trim();
    const hasQuery = textWords(queryText).length > 0;
    const queryVec = hasQuery && vectorSearchEnabled() ? await embedText(queryText) : undefined;
    const queryLower = queryText.toLowerCase();

    const scored = allSlices.map((slice) => {
      const text = sliceSearchText(slice);
      const tags = Object.values(slice.tags).flat();
      const keyword = hasQuery ? overlapScore(queryText, text) : 1;
      const rawVector = queryVec && slice.embedding ? cosineSimilarity(queryVec, slice.embedding) : 0;
      const vector = queryVec && slice.embedding ? clamp((rawVector + 1) / 2, 0, 1) : 0;
      const tag = hasQuery ? tagExactScore(queryText, tags) : 0;
      const phrase = hasQuery && queryLower.length > 1 && text.toLowerCase().includes(queryLower) ? 1 : 0;
      return { slice, keyword, vector, tag, phrase };
    });

    const rrf = normalizedRrfScores([
      [...scored].sort((a, b) => b.keyword - a.keyword).map((item) => item.slice.id),
      [...scored].sort((a, b) => b.vector - a.vector).map((item) => item.slice.id),
      [...scored].sort((a, b) => b.tag - a.tag).map((item) => item.slice.id),
    ]);

    return scored
      .map((item) => {
        const rrfScore = rrf.get(item.slice.id);
        const score = hasQuery
          ? round(
              clamp(
                item.keyword * 0.34 + item.vector * 0.32 + item.tag * 0.18 + rrfScore * 0.12 + item.phrase * 0.04,
                0,
                1,
              ),
              3,
            )
          : 1;
        return {
          ...item.slice,
          score,
          match: {
            keyword: round(item.keyword, 3),
            vector: round(item.vector, 3),
            tag: round(item.tag, 3),
            rrf: round(rrfScore, 3),
            phrase: round(item.phrase, 3),
          },
        };
      })
      .filter((slice) => !hasQuery || slice.score > 0.04)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  function normalizeRenderProvider(value: unknown): RenderProvider {
    const provider = readText(value, 'auto').toLowerCase();
    if (provider === 'seedance' || provider === 'auto' || provider === 'local') return 'seedance';
    return 'seedance';
  }

  function normalizeScriptProvider(value: unknown): ScriptProvider {
    const provider = readText(value, 'auto').toLowerCase();
    if (provider === 'local' || provider === 'doubao' || provider === 'auto') return provider;
    return 'auto';
  }

  function resolveReferenceImageUrl(sourceUrl: string): string | undefined {
    if (!sourceUrl) return undefined;
    if (sourceUrl.startsWith('data:') || /^https?:\/\//i.test(sourceUrl)) return sourceUrl;
    if (sourceUrl.startsWith('/uploads/') || sourceUrl.startsWith('/generated/')) {
      const filePath = sourceUrl.startsWith('/generated/')
        ? path.join(dirs.generatedDir, decodeURIComponent(sourceUrl.replace('/generated/', '')))
        : path.join(dirs.publicDir, sourceUrl.replace(/^\//, ''));
      if (!localPathExists(filePath)) return undefined;
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
      };
      const mime = mimeMap[ext] || 'image/jpeg';
      const data = readLocalBinary(filePath).toString('base64');
      return `data:${mime};base64,${data}`;
    }
    return undefined;
  }

  function buildSlices(material: Material, seedText: string) {
    const baseTags = ['商品', material.type === 'video' ? '视频素材' : '图片素材'];
    const sliceSpecs = [
      { label: '开场主视觉', start: 0, end: 3, extra: ['开场', 'hook'] },
      { label: '细节证据', start: 3, end: 6, extra: ['细节', '证据'] },
      { label: '使用场景', start: 6, end: 9, extra: ['演示', '场景'] },
    ];
    return sliceSpecs.map((spec) => {
      const id = `slice_${uuid().slice(0, 8)}`;
      const summary = `${material.sourceDeclaration || '商家素材'} · ${spec.label}，可用于${spec.extra.join('、')}分镜。`;
      const slice: Slice = {
        id,
        materialId: material.id,
        thumbnailUrl: material.sourceUrl,
        clipUrl: material.sourceUrl,
        startTime: material.type === 'video' ? spec.start : 0,
        endTime: material.type === 'video' ? spec.end : 3,
        tags: {
          product: baseTags,
          video: spec.extra,
          slice: [spec.label, ...textWords(seedText).slice(0, 4)],
        },
        summary,
      };
      slices.set(slice.id, slice);
      return slice;
    });
  }

  async function updateSliceEmbeddings(created: Slice[], material: Material) {
    if (!vectorSearchEnabled()) {
      persistRuntimeStore();
      return;
    }
    for (const slice of created) {
      try {
        let embedding: number[];
        if (material.type === 'image' && isEmbeddableImage(material.sourceUrl)) {
          embedding = await embedImage(material.sourceUrl, dirs.publicDir);
        } else {
          embedding = await embedText(slice.summary);
        }
        slice.embedding = embedding;
        slices.set(slice.id, slice);
      } catch (error) {
        console.warn('[materials] slice embedding skipped:', error instanceof Error ? error.message : error);
      }
    }
    persistRuntimeStore();
  }

  function seedDemoMaterial() {
    if (materials.size > 0) return;
    const material: Material = {
      id: 'mat_demo_product',
      type: 'image',
      sourceUrl: '/uploads/demo_product.svg',
      sourceDeclaration: '系统生成素材',
      uploadedAt: new Date(),
    };
    const demoSvg = path.join(dirs.uploadDir, 'demo_product.svg');
    if (!localPathExists(demoSvg)) {
      writeLocalText(
        demoSvg,
        `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960" viewBox="0 0 960 960">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0f766e"/><stop offset="1" stop-color="#38bdf8"/></linearGradient>
            <radialGradient id="shine" cx="0.45" cy="0.35" r="0.42"><stop stop-color="#ffffff" stop-opacity="0.72"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
          </defs>
          <rect width="960" height="960" fill="url(#bg)"/>
          <rect width="960" height="960" fill="url(#shine)"/>
          <rect x="246" y="282" width="468" height="360" rx="80" fill="#f8fafc" fill-opacity="0.88"/>
          <rect x="310" y="360" width="340" height="118" rx="58" fill="#0f172a" fill-opacity="0.13"/>
          <circle cx="594" cy="546" r="42" fill="#0f766e" fill-opacity="0.22"/>
        </svg>`,
      );
    }
    materials.set(material.id, material);
    const demoSlices = buildSlices(material, 'demo product 开场 细节 使用场景');
    void updateSliceEmbeddings(demoSlices, material);
  }

  function addSyntheticPerformanceRows(count: number, trendSeed = '') {
    initializeWeights();
    const cappedCount = clamp(Math.round(count), 1, 20_000);
    const createdAtBase = Date.now() - cappedCount * 18_000;
    const trendBoost = textWords(trendSeed).length % 5;

    for (let i = 0; i < cappedCount; i += 1) {
      const factors = [
        factorLibrary[(i + trendBoost) % 3],
        factorLibrary[3 + ((i + trendBoost) % 2)],
        factorLibrary[5 + ((i * 3 + trendBoost) % 2)],
        factorLibrary[7 + ((i * 5 + trendBoost) % 2)],
        factorLibrary[9 + ((i * 7 + trendBoost) % 3)],
      ].filter(Boolean);
      const effect = factors.reduce((sum, factor) => sum + (factorEffects.get(factorKey(factor)) || -0.0015), 0);
      const longTail = Math.exp(((i * 48271) % 1000) / 1000) * 420;
      const weekend = i % 7 >= 5 ? 0.002 : 0;
      const noise = (((i * 9301) % 31) - 15) / 10_000;
      const anomaly = i % 997 === 0 ? 0.012 : 0;
      const conversionRate = clamp(0.018 + effect + weekend + noise + anomaly, 0.004, 0.072);
      const impressions = Math.round(350 + longTail + ((i * 1597) % 9000));
      const dirtyDrop = i % 683 === 0;
      videoPerfs.push({
        id: `perf_sim_${Date.now()}_${i}`,
        scriptId: `sim_script_${i % 180}`,
        source: 'simulated',
        factorSnapshot: factors,
        impressions: dirtyDrop ? 0 : impressions,
        ctr: dirtyDrop ? 0 : clamp(0.018 + conversionRate * 1.35 + (((i * 17) % 9) - 4) / 1000, 0.004, 0.14),
        completionRate: dirtyDrop ? 0 : clamp(0.29 + conversionRate * 4.8 + ((i % 5) - 2) / 100, 0.16, 0.78),
        conversionRate,
        gmv: Math.round(impressions * conversionRate * (76 + (i % 11) * 18)),
        createdAt: new Date(createdAtBase + i * 18_000),
      });
    }

    return cappedCount;
  }

  function kalodataFactorSnapshot(row: Record<string, unknown>) {
    const labels = row.labels && typeof row.labels === 'object' ? (row.labels as Record<string, unknown>) : {};
    const datasets = Array.isArray(row.datasets) ? row.datasets.map(String) : [];
    const trafficTypes = Array.isArray(row.trafficTypes) ? row.trafficTypes.map(String) : [];
    const text = `${row.referenceText || ''} ${datasets.join(' ')} ${trafficTypes.join(' ')}`.toLowerCase();
    const factors = new Map<string, Factor>();
    const add = (factor: Factor | undefined) => {
      if (factor) factors.set(factorKey(factor), factor);
    };

    if (/question|how|why|痛点|问题|评论|答疑/.test(text)) add(factorLibrary[9]);
    if (/compare|对比|before|after/.test(text)) add(factorLibrary[10]);
    if (/review|real|test|实测|测评|体验|买家/.test(text)) add(factorLibrary[2]);
    if (/opening|unbox|开箱|第一人称/.test(text)) add(factorLibrary[0]);
    if (/scene|home|travel|camping|场景|居家|通勤|旅行/.test(text)) add(factorLibrary[1]);
    if (/fast|3s|前三秒|节奏|quick/.test(text)) add(factorLibrary[3]);
    if (/premium|slow|质感|沉浸/.test(text)) add(factorLibrary[4]);
    if (/music|bgm|电子|upbeat/.test(text)) add(factorLibrary[5]);
    if (/warm|home|居家|生活/.test(text)) add(factorLibrary[8]);
    if (/fresh|clear|summer|清爽|高饱和/.test(text)) add(factorLibrary[7]);
    if (labels.lowFollowerWinner === true) add(factorLibrary[2]);
    if (labels.organicWinner === true) add(factorLibrary[9]);
    if (labels.paidValidatedWinner === true || Number(labels.adRoasPercentile) >= 0.75) add(factorLibrary[3]);
    if (factors.size === 0) add(factorLibrary[1]);
    add(factorLibrary[11]);
    return [...factors.values()].slice(0, 6);
  }

  function kalodataPerfMetrics(row: Record<string, unknown>) {
    const labels = row.labels && typeof row.labels === 'object' ? (row.labels as Record<string, unknown>) : {};
    const features = row.features && typeof row.features === 'object' ? (row.features as Record<string, unknown>) : {};
    const gmvPercentile = clamp(normalizeNumber(labels.gmvPercentile, 0.5), 0, 1);
    const salesPercentile = clamp(normalizeNumber(labels.salesPercentile, 0.5), 0, 1);
    const viewsPercentile = clamp(normalizeNumber(labels.viewsPercentile, 0.5), 0, 1);
    const gmvPerMille = clamp(normalizeNumber(labels.gmvPerMilleViewsPercentile, 0.5), 0, 1);
    const roasPercentile = clamp(normalizeNumber(labels.adRoasPercentile, 0.5), 0, 1);
    const benchmarkScore = clamp(normalizeNumber(labels.benchmarkScore, gmvPercentile), 0, 1);
    const impressions = Math.max(500, Math.round(1_000 + viewsPercentile * 90_000));
    const conversionRate = clamp(
      0.006 + gmvPercentile * 0.028 + salesPercentile * 0.018 + gmvPerMille * 0.012,
      0.002,
      0.095,
    );
    const ctr = clamp(0.012 + benchmarkScore * 0.055 + roasPercentile * 0.015, 0.004, 0.16);
    const completionRate = clamp(0.28 + benchmarkScore * 0.48, 0.18, 0.92);
    const observedGmvPerMille = normalizeNumber(features.gmvPerMilleViewsCny, 0);
    const gmv =
      observedGmvPerMille > 0 ? (impressions / 1000) * observedGmvPerMille : impressions * conversionRate * 110;
    return { impressions, ctr, completionRate, conversionRate, gmv: Math.round(gmv) };
  }

  function loadKalodataSeedRows(
    inputPath = path.resolve(process.cwd(), 'tmp/kalodata-test/benchmark-training.jsonl'),
    limit = 500,
  ) {
    if (!fs.existsSync(inputPath)) return { rowsCreated: 0, sourcePath: inputPath, skippedReason: 'file_not_found' };
    const existing = new Set(videoPerfs.filter((row) => row.source === 'kalodata_seed').map((row) => row.scriptId));
    const lines = fs.readFileSync(inputPath, 'utf-8').split('\n').filter(Boolean);
    let rowsCreated = 0;
    for (const line of lines) {
      if (rowsCreated >= limit) break;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = readText(row.id);
      if (!id || existing.has(id)) continue;
      const factorSnapshot = kalodataFactorSnapshot(row);
      const metrics = kalodataPerfMetrics(row);
      const perf: VideoPerf = {
        id: `perf_kalodata_${id.replace(/^kalodata_/, '').slice(0, 24)}`,
        scriptId: id,
        videoId: readText(row.videoId) || undefined,
        source: 'kalodata_seed',
        factorSnapshot,
        ...metrics,
        createdAt: new Date(Date.now() - (limit - rowsCreated) * 60_000),
      };
      videoPerfs.push(perf);
      createVideoPerfRecord({
        id: perf.id,
        scriptId: perf.scriptId,
        videoId: perf.videoId,
        source: perf.source,
        factorSnapshot: perf.factorSnapshot,
        impressions: perf.impressions,
        ctr: perf.ctr,
        completionRate: perf.completionRate,
        conversionRate: perf.conversionRate,
        gmv: perf.gmv,
      }).catch(() => undefined);
      rowsCreated += 1;
      existing.add(id);
    }
    return { rowsCreated, sourcePath: inputPath, skippedReason: rowsCreated ? undefined : 'already_loaded_or_empty' };
  }

  function weightedRate(rows: VideoPerf[], field: 'ctr' | 'completionRate' | 'conversionRate') {
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    if (!impressions) return 0;
    return rows.reduce((sum, row) => sum + row[field] * row.impressions, 0) / impressions;
  }

  function isLearningSource(source: unknown): source is LearningSource {
    return source === 'observed' || source === 'kalodata_seed';
  }

  function learningRows(scriptId?: string) {
    return videoPerfs.filter((row) => isLearningSource(row.source) && (!scriptId || row.scriptId === scriptId));
  }

  function performanceRowsForScope(scriptId?: string, includeSimulated = false) {
    const learning = learningRows(scriptId);
    if (learning.length || scriptId || !includeSimulated) return learning;
    return videoPerfs.filter((row) => row.source === 'simulated');
  }

  function sourceBreakdown(rows: VideoPerf[]) {
    return rows.reduce<Record<string, number>>((acc, row) => {
      const source = row.source || 'observed';
      acc[source] = (acc[source] || 0) + 1;
      return acc;
    }, {});
  }

  function computeAttribution(factorType?: string, scriptId?: string, includeSimulated = false) {
    const rows = performanceRowsForScope(scriptId, includeSimulated);
    const baseline = weightedRate(rows, 'conversionRate');
    const groups = new Map<
      string,
      { factor: Factor; weightedConversions: number; count: number; impressions: number }
    >();

    for (const perf of rows) {
      for (const factor of perf.factorSnapshot) {
        if (factorType && factor.type !== factorType) continue;
        const key = factorKey(factor);
        const current = groups.get(key) || { factor, weightedConversions: 0, count: 0, impressions: 0 };
        current.weightedConversions += perf.conversionRate * perf.impressions;
        current.count += 1;
        current.impressions += perf.impressions;
        groups.set(key, current);
      }
    }

    return [...groups.values()]
      .map((group) => {
        const avgConversion = group.impressions ? group.weightedConversions / group.impressions : 0;
        const lift = round(baseline > 0 ? ((avgConversion - baseline) / baseline) * 100 : 0, 1);
        return {
          factor: `${group.factor.type}:${group.factor.value}`,
          factorType: group.factor.type,
          factorValue: group.factor.value,
          avgConversion: round(avgConversion),
          lift,
          sampleSize: group.count,
          impressions: group.impressions,
          confidenceScore: round(Math.abs(lift) * Math.log10(group.impressions + 1), 2),
          sources: sourceBreakdown(
            rows.filter((row) => row.factorSnapshot.some((factor) => factorKey(factor) === factorKey(group.factor))),
          ),
        };
      })
      .sort((a, b) => b.confidenceScore - a.confidenceScore);
  }

  function observedVariant(scriptId: string | undefined, label: 'A' | 'B') {
    if (!scriptId) return undefined;
    const script = scripts.get(scriptId);
    const rows = performanceRowsForScope(scriptId);
    if (!script || !rows.length) return undefined;
    return {
      label,
      scriptId,
      narrative: script.narrative,
      ctr: round(weightedRate(rows, 'ctr')),
      completionRate: round(weightedRate(rows, 'completionRate')),
      conversionRate: round(weightedRate(rows, 'conversionRate')),
      gmv: round(
        rows.reduce((sum, row) => sum + row.gmv, 2),
        2,
      ),
      impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
      factors: script.shots.flatMap((shot) => shot.factors || []).slice(0, 8),
    };
  }

  function buildAbCompare(scriptAId?: string, scriptBId?: string) {
    const variants = [observedVariant(scriptAId, 'A'), observedVariant(scriptBId, 'B')].filter(
      (row): row is NonNullable<typeof row> => Boolean(row),
    );
    const winner = variants.length > 1 ? [...variants].sort((a, b) => b.conversionRate - a.conversionRate)[0] : null;
    const baseline = variants[0];
    return {
      mode: 'observed' as const,
      hypothesis: '仅基于已录入的单视频表现对比，不自动制造实验提升。',
      methodNote: '需要为 A、B 两条导出视频分别录入真实曝光与转化数据后才能判断胜出。',
      metric: 'conversionRate',
      variants,
      winner,
      liftVsControl:
        winner && baseline && winner.scriptId !== baseline.scriptId
          ? round(
              ((winner.conversionRate - baseline.conversionRate) / Math.max(0.0001, baseline.conversionRate)) * 100,
              1,
            )
          : null,
      confidence: null,
      sampleSize: variants.reduce((sum, variant) => sum + variant.impressions, 0),
      generatedAt: nowIso(),
    };
  }

  function recomputeWeights() {
    const rows = learningRows();
    if (!rows.length) return [];
    const attribution = computeAttribution();
    for (const item of attribution) {
      const confidence = Math.min(1, item.sampleSize / 50);
      const factor = { type: item.factorType, value: item.factorValue, sourceStrategy: 'attribution_recompute' };
      const key = factorKey(factor);
      const weight: FactorWeight = {
        id: factorWeights.get(key)?.id || `weight_${uuid().slice(0, 8)}`,
        factorId: factorId(factor),
        weight: clamp(1 + (item.lift / 100) * confidence, 0.45, 2.4),
        updatedAt: new Date(),
        sampleSize: item.sampleSize,
      };
      factorWeights.set(key, weight);
      const evPoint = {
        factorId: weight.factorId,
        factorType: item.factorType,
        factorValue: item.factorValue,
        weight: round(weight.weight, 3),
        sampleSize: item.sampleSize,
        sources: item.sources,
        updatedAt: weight.updatedAt.toISOString(),
      };
      evolution.push(evPoint);
      upsertFactorWeight(weight.factorId, evPoint.weight, item.sampleSize).catch(() => undefined);
      createEvolutionPoint({
        factorId: weight.factorId,
        factorType: item.factorType,
        factorValue: item.factorValue,
        weight: evPoint.weight,
        sampleSize: item.sampleSize,
      }).catch(() => undefined);
    }
    return attribution;
  }

  function complianceTextFor(targetType: ComplianceCheckRecord['targetType'], targetId: string) {
    if (targetType === 'material') {
      const material = materials.get(targetId);
      if (!material) return undefined;
      return `${material.sourceDeclaration || ''} ${material.sourceUrl || ''}`;
    }
    const script = scripts.get(targetId);
    if (!script) return undefined;
    return [
      script.narrative,
      script.visualStyle,
      script.constraints.join(' '),
      ...script.shots.flatMap((shot) => [
        shot.visualDesc,
        shot.narration,
        shot.subtitle,
        ...(shot.textLayers || []).map((layer) => layer.text),
      ]),
    ].join(' ');
  }

  function runComplianceCheck(targetType: ComplianceCheckRecord['targetType'], targetId: string) {
    const text = complianceTextFor(targetType, targetId);
    if (text === undefined) return undefined;

    const hits: ComplianceCheckRecord['hits'] = [];
    if (targetType === 'material') {
      const material = materials.get(targetId);
      if (!material?.sourceDeclaration?.trim()) {
        const missingSourceRule = complianceRules.find((r) => r.id === 'missing-source');
        hits.push({
          ruleId: 'missing-source',
          rule: missingSourceRule?.rule || '素材必须保留来源声明。',
          level: 'warn',
          reason: '素材来源声明为空。',
          suggestion: missingSourceRule?.suggestion || '补充来源声明。',
        });
      }
    }

    for (const rule of complianceRules.filter((item) => item.id !== 'missing-source')) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      hits.push({
        ruleId: rule.id,
        rule: rule.rule,
        level: rule.level,
        reason: `命中「${match[0]}」。`,
        suggestion: rule.suggestion,
      });
    }

    const level: ComplianceLevel = hits.some((hit) => hit.level === 'block')
      ? 'block'
      : hits.some((hit) => hit.level === 'warn')
        ? 'warn'
        : 'pass';
    const record: ComplianceCheckRecord = {
      id: `check_${uuid().slice(0, 10)}`,
      targetType,
      targetId,
      level,
      hits,
      createdAt: nowIso(),
    };
    complianceChecks.set(record.id, record);
    persistRuntimeStore();
    createComplianceCheck({ id: record.id, targetType, targetId, level, hits }).catch(() => undefined);
    return record;
  }

  loadRuntimeStore();
  loadReferenceVideoStore();
  seedDemoMaterial();
  initializeWeights();
  persistRuntimeStore();
  if (clipWarmupEnabled()) {
    warmup(); // 后台预加载 CLIP 模型，不阻塞启动
  } else {
    console.warn('[clip] 轻量部署已关闭 CLIP 预热；向量检索将使用降级路径。');
  }

  registerCopilotRoutes(app, { sendJsonError, safeExternalError });

  registerMaterialsRoutes(app, {
    dirs,
    upload,
    storageClient,
    referenceVideos,
    readText,
    clamp,
    saveDataUrl,
    sendJsonError,
    safeExternalError,
    persistRuntimeStore,
    normalizeReferenceProvenance,
  });

  registerRecipeRoutes(app, {
    readText,
    clamp,
    sendJsonError,
    safeExternalError,
    normalizeScriptProvider,
    normalizeRetrievalMode,
  });

  registerVideoTagRoutes(app, {
    sendJsonError,
    safeExternalError,
  });

  registerScriptsRoutes(app, {
    templates,
    readText,
    readTextArray,
    clamp,
    safeMarketingText,
    sendJsonError,
    safeExternalError,
    normalizeScriptProvider,
    normalizeRetrievalMode,
    normalizeAspectRatio,
    ensureShotTextLayers,
  });

  registerRenderRoutes(app, {
    sendJsonError,
    safeExternalError,
    readText,
    normalizeRenderProvider,
    normalizeAspectRatio,
    normalizeAudioMode,
    normalizeRetrievalMode,
  });

  app.post('/api/feedback/ingest', (req, res) => {
    const scriptId = String(req.body?.scriptId || '').trim();
    const script = scripts.get(scriptId);
    if (!script) return sendJsonError(res, 404, '剧本不存在');
    const perfInput = req.body?.perf && typeof req.body.perf === 'object' ? req.body.perf : req.body || {};
    const factorSnapshot = script.shots.flatMap((shot) => shot.factors || []);
    const perf: VideoPerf = {
      id: `perf_${uuid().slice(0, 10)}`,
      scriptId,
      videoId: String(perfInput.videoId || req.body?.videoId || '').trim() || undefined,
      source: 'observed',
      factorSnapshot,
      impressions: Math.max(0, Math.round(normalizeNumber(perfInput.impressions, 1200))),
      ctr: normalizeRate(perfInput.ctr, 0.032),
      completionRate: normalizeRate(perfInput.completionRate, 0.48),
      conversionRate: normalizeRate(perfInput.conversionRate, 0.028),
      gmv: Math.max(0, normalizeNumber(perfInput.gmv, 0)),
      createdAt: new Date(),
    };
    videoPerfs.push(perf);
    persistRuntimeStore();
    createVideoPerfRecord({
      id: perf.id,
      scriptId: perf.scriptId,
      videoId: perf.videoId,
      source: perf.source,
      factorSnapshot: perf.factorSnapshot,
      impressions: perf.impressions,
      ctr: perf.ctr,
      completionRate: perf.completionRate,
      conversionRate: perf.conversionRate,
      gmv: perf.gmv,
    }).catch(() => undefined);
    res.status(201).json({ id: perf.id, factorSnapshot: perf.factorSnapshot });
  });

  app.post('/api/feedback/recompute', (_req, res) => {
    const attribution = recomputeWeights();
    persistRuntimeStore();
    const rows = learningRows();
    res.json({
      ok: true,
      baselineConversion: round(rows.reduce((sum, perf) => sum + perf.conversionRate, 0) / Math.max(1, rows.length)),
      factorsUpdated: attribution.length,
      learningSources: sourceBreakdown(rows),
      disclosure: attribution.length
        ? 'factor_weights 仅由 observed / kalodata_seed 行重算；simulated 行不会写入权重。'
        : '没有 observed 或 kalodata_seed 表现行，本次未更新 factor_weights。',
      topFactors: attribution.slice(0, 5),
    });
  });

  app.post('/api/feedback/simulate', (req, res) => {
    const rowsCreated = addSyntheticPerformanceRows(Number(req.body?.count || 5000), String(req.body?.trendSeed || ''));
    persistRuntimeStore();
    res.status(201).json({
      rowsCreated,
      totalRows: videoPerfs.length,
      source: 'simulated',
      factorsUpdated: 0,
      disclosure: '模拟表现行只用于展示和压测，不会触发 factor_weights 重算。',
      topFactors: computeAttribution(undefined, undefined, true).slice(0, 5),
    });
  });

  app.post('/api/feedback/seed-kalodata', (req, res) => {
    const sourcePath =
      readText(req.body?.path) || path.resolve(process.cwd(), 'tmp/kalodata-test/benchmark-training.jsonl');
    const limit = Math.max(1, Math.min(5000, Math.round(normalizeNumber(req.body?.limit, 500))));
    const seedResult = loadKalodataSeedRows(sourcePath, limit);
    const attribution = recomputeWeights();
    persistRuntimeStore();
    res.status(201).json({
      ...seedResult,
      source: 'kalodata_seed',
      totalRows: videoPerfs.length,
      factorsUpdated: attribution.length,
      learningSources: sourceBreakdown(learningRows()),
      disclosure:
        'Kalodata seed rows are third-party real outcome labels tagged source=kalodata_seed; simulated rows remain display-only.',
      topFactors: attribution.slice(0, 5),
    });
  });

  app.get('/api/feedback/evolution', async (_req, res) => {
    if (evolution.length) return res.json(evolution);
    const dbPoints = await listEvolutionPoints(undefined, 500).catch(() => []);
    res.json(
      dbPoints.map((p) => ({
        factorId: p.factorId,
        factorType: p.factorType,
        factorValue: p.factorValue,
        weight: p.weight,
        sampleSize: p.sampleSize,
        updatedAt: p.updatedAt.toISOString(),
      })),
    );
  });

  // 消息点赞/踩回流 — upsert by messageId
  app.post('/api/feedback/message', async (req, res) => {
    const messageId = String(req.body?.messageId || '').trim();
    const reaction = req.body?.reaction;
    if (!messageId) return sendJsonError(res, 400, 'messageId 必填');
    if (reaction !== 'up' && reaction !== 'down' && reaction !== null) {
      return sendJsonError(res, 400, 'reaction 只能是 up / down / null');
    }
    const prevIdx = messageFeedbacks.findIndex((f) => f.messageId === messageId);
    if (prevIdx !== -1) messageFeedbacks.splice(prevIdx, 1);
    await deleteMessageFeedbackByMessageId(messageId).catch(() => undefined);
    if (reaction !== null) {
      const mfb = {
        id: `mfb_${uuid().slice(0, 10)}`,
        messageId,
        messageText: String(req.body?.messageText || '').slice(0, 500),
        productId: String(req.body?.productId || '').trim() || undefined,
        reaction,
        createdAt: new Date().toISOString(),
      };
      messageFeedbacks.push(mfb);
      await upsertMessageFeedback({
        id: mfb.id,
        messageId: mfb.messageId,
        productId: mfb.productId,
        reaction: mfb.reaction,
        note: mfb.messageText,
      }).catch(() => undefined);
    }
    persistRuntimeStore();
    res.status(201).json({ ok: true, total: messageFeedbacks.length });
  });

  // 查询消息反馈统计（可按 productId 过滤）
  app.get('/api/feedback/messages', async (req, res) => {
    const pid = req.query.productId ? String(req.query.productId) : undefined;
    let rows = pid ? messageFeedbacks.filter((f) => f.productId === pid) : messageFeedbacks;
    if (rows.length === 0) {
      const dbRows = await listMessageFeedbacks(pid).catch(() => []);
      if (dbRows.length) {
        rows = dbRows.map((r) => ({
          id: r.id,
          messageId: r.messageId,
          messageText: r.note || '',
          productId: r.productId || undefined,
          reaction: r.reaction as 'up' | 'down',
          createdAt: r.createdAt.toISOString(),
        }));
      }
    }
    const ups = rows.filter((f) => f.reaction === 'up').length;
    const downs = rows.filter((f) => f.reaction === 'down').length;
    res.json({ total: rows.length, ups, downs, items: rows.slice(-50) });
  });

  app.get('/api/analytics/attribution', (req, res) => {
    const factorType = req.query.factorType ? String(req.query.factorType) : undefined;
    const scriptId = req.query.scriptId ? String(req.query.scriptId) : undefined;
    const allowSimulation = !scriptId && req.query.includeSimulated === 'true';
    res.json(computeAttribution(factorType, scriptId, allowSimulation));
  });

  app.get('/api/analytics/overview', (req, res) => {
    const scriptId = req.query.scriptId ? String(req.query.scriptId) : undefined;
    const learning = learningRows(scriptId);
    const allowSimulation = !scriptId && req.query.includeSimulated === 'true';
    const rows = learning.length ? learning : performanceRowsForScope(scriptId, allowSimulation);
    const attribution = computeAttribution(undefined, scriptId, allowSimulation);
    // headline/推荐要的是「该用哪些打法」——取正向 lift、且样本量够（>=10）的高增益因子；
    // attribution 本身按 |lift| 排（含强负向），不能直接拿来做推荐。
    const MIN_SAMPLE = 10;
    const positiveFactors = attribution
      .filter((item) => item.lift > 0 && item.sampleSize >= MIN_SAMPLE)
      .sort((a, b) => b.lift - a.lift);
    const best = positiveFactors[0] || attribution.find((item) => item.lift > 0) || attribution[0];
    const totalImpressions = rows.reduce((sum, perf) => sum + perf.impressions, 0);
    const avgConversion = weightedRate(rows, 'conversionRate');
    const dataMode = rows.length
      ? rows.some((row) => row.source === 'kalodata_seed') && !rows.some((row) => row.source === 'observed')
        ? 'kalodata_seed'
        : rows.some((row) => row.source === 'simulated')
          ? 'simulated'
          : 'observed'
      : 'empty';
    res.json({
      scriptId: scriptId || null,
      dataMode,
      sourceBreakdown: sourceBreakdown(rows),
      disclosure:
        dataMode === 'observed'
          ? '以下指标来自该视频已录入的投放表现。'
          : dataMode === 'kalodata_seed'
            ? '以下指标来自 Kalodata 真实 outcome seed，用于演示因子学习；不是当前视频投放回流。'
            : dataMode === 'simulated'
              ? '以下指标为模拟数据，仅用于演示归因结构，不代表真实投放效果。'
              : '该视频尚未录入投放表现，请在出片后录入真实数据。',
      headline: best ? `${best.factorValue} 当前转化 lift ${best.lift}%` : '暂无可计算的归因数据。',
      totalVideos: new Set(rows.map((row) => row.scriptId)).size,
      totalImpressions,
      avgConversion: round(avgConversion),
      bestFactor: best || null,
      recommendations: positiveFactors.slice(0, 3).map((item) => ({
        title: `下一批 auto 模式优先使用「${item.factorValue}」（lift +${item.lift}%，${item.sampleSize} 样本）`,
        factor: item.factor,
        lift: item.lift,
      })),
    });
  });

  app.get('/api/analytics/ab-compare', (req, res) => {
    res.json(
      buildAbCompare(
        req.query.scriptA ? String(req.query.scriptA) : undefined,
        req.query.scriptB ? String(req.query.scriptB) : undefined,
      ),
    );
  });

  app.get('/api/analytics/videos', (_req, res) => {
    const completedTasks = [...tasks.values()].filter(
      (task) => task.type === 'compose' && task.status === 'completed' && typeof task.payload?.scriptId === 'string',
    );
    res.json(
      [...scripts.values()].map((script) => {
        const renders = completedTasks.filter((task) => task.payload?.scriptId === script.id);
        const latestRender = renders[renders.length - 1];
        const rows = performanceRowsForScope(script.id);
        const hasObserved = rows.some((row) => row.source === 'observed');
        const hasKalodataSeed = rows.some((row) => row.source === 'kalodata_seed');
        return {
          scriptId: script.id,
          productId: script.productId,
          narrative: script.narrative,
          videoId: latestRender?.id || null,
          videoUrl: latestRender?.payload?.videoUrl || null,
          dataMode: hasObserved ? 'observed' : hasKalodataSeed ? 'kalodata_seed' : 'empty',
          sourceBreakdown: sourceBreakdown(rows),
          performanceRows: rows.length,
          impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
          conversionRate: round(weightedRate(rows, 'conversionRate')),
        };
      }),
    );
  });

  app.get('/api/observability', (_req, res) => {
    const taskRows = [...tasks.values()];
    const terminal = taskRows.filter((task) => taskTerminalStatuses.has(task.status));
    const failed = taskRows.filter((task) => task.status === 'failed');
    res.json({
      ok: true,
      generatedAt: nowIso(),
      uptimeSeconds: round(process.uptime(), 1),
      providers: {
        doubaoText: Boolean(envValue('ARK_API_KEY') && (envValue('ARK_TEXT_MODEL_ID') || envValue('ARK_MODEL_ID'))),
        doubaoImage: Boolean(envValue('ARK_API_KEY') && envValue('ARK_IMAGE_MODEL_ID')),
        seedanceVideo: isSeedanceConfigured(),
        renderPipeline:
          Boolean(envValue('ARK_API_KEY') && envValue('ARK_IMAGE_MODEL_ID')) && isSeedanceConfigured()
            ? 'T2I→I2V'
            : isSeedanceConfigured()
              ? 'T2V'
              : 'local',
        clip: 'jina-clip-v2 (multilingual, 1024d)',
        localTts: localPathExists('/usr/bin/say') || localPathExists('/bin/say'),
        scriptGeneration: {
          modes: ['auto', 'doubao', 'local'],
          default: 'auto',
        },
      },
      queue: {
        runtime: 'bullmq',
        seedanceConcurrency: configuredSeedanceConcurrency(),
        terminalTasks: terminal.length,
        activeTasks: taskRows.filter((task) => !taskTerminalStatuses.has(task.status)).length,
        failedTasks: failed.length,
      },
      productionPipeline: {
        enabled: true,
        postgresConfigured: Boolean(envValue('DATABASE_URL')),
        redisConfigured: Boolean(envValue('REDIS_URL')),
        objectStorageDriver: envValue('OBJECT_STORAGE_DRIVER') || 'local',
        note: 'API 将新任务写入 Postgres 并投递 BullMQ；Worker 负责脚本、素材、角度和视频渲染任务。',
      },
      store: {
        file: runtimeStoreFile,
        bytes: localPathExists(runtimeStoreFile) ? localFileSize(runtimeStoreFile) : 0,
        materials: materials.size,
        slices: slices.size,
        referenceVideos: referenceVideos.size,
        scripts: scripts.size,
        performanceRows: videoPerfs.length,
        complianceChecks: complianceChecks.size,
      },
      vectorIndex: {
        provider: 'qdrant',
        mode: 'qdrant-only',
        embeddingModel: VECTOR_TEXT_EMBEDDING_MODEL,
        dims: VECTOR_TEXT_EMBEDDING_DIMS,
        localCompressedIndex: false,
      },
      media: {
        generatedBytes: folderSizeBytes(dirs.generatedDir),
        uploadBytes: folderSizeBytes(dirs.uploadDir),
        referenceBytes: folderSizeBytes(path.join(dirs.publicDir, 'reference-videos')),
      },
      recentTasks: taskRows
        .slice(-8)
        .reverse()
        .map((task) => ({
          id: task.id,
          type: task.type,
          status: task.status,
          progress: task.progress,
          step: task.step,
          updatedAt: task.updatedAt,
          error: task.error,
        })),
    });
  });

  app.post('/api/compliance/check', (req, res) => {
    const targetType = req.body?.targetType;
    const targetId = String(req.body?.targetId || '').trim();
    if (targetType !== 'material' && targetType !== 'script' && targetType !== 'video') {
      return sendJsonError(res, 400, 'targetType 必须是 material、script 或 video');
    }
    if (!targetId) return sendJsonError(res, 400, '需要 targetId');
    const record = runComplianceCheck(targetType, targetId);
    if (!record) return sendJsonError(res, 404, '目标不存在');
    res.status(201).json(record);
  });

  app.post('/api/compliance/:id/resolve', async (req, res) => {
    const record = complianceChecks.get(req.params.id);
    if (!record) {
      const dbRecord = await getComplianceCheck(req.params.id).catch(() => null);
      if (!dbRecord) return sendJsonError(res, 404, '合规记录不存在');
    }
    const action = req.body?.action === 'approve' ? 'approve' : req.body?.action === 'reject' ? 'reject' : undefined;
    if (!action) return sendJsonError(res, 400, 'action 必须是 approve 或 reject');
    const reviewedBy = String(req.body?.reviewedBy || 'manual_reviewer');
    const note = String(req.body?.note || '');
    const newLevel = action === 'approve' ? 'pass' : 'block';
    if (record) {
      record.reviewedBy = reviewedBy;
      record.reviewedAt = nowIso();
      record.note = note;
      record.level = newLevel;
    }
    persistRuntimeStore();
    await updateComplianceCheck(req.params.id, { level: newLevel, resolvedBy: reviewedBy, resolution: note }).catch(
      () => undefined,
    );
    res.json(record || { id: req.params.id, level: newLevel, reviewedBy, note });
  });

  app.get('/api/compliance/rules', (_req, res) => {
    res.json(
      complianceRules.map((rule) => ({
        id: rule.id,
        level: rule.level,
        rule: rule.rule,
        suggestion: rule.suggestion,
      })),
    );
  });

  // ========== TrustLoop D4 端点 ==========

  // 1) POST /api/research/run —— 启动 Research & Evidence Agent
  app.post('/api/research/run', async (req, res) => {
    const body = (req.body || {}) as {
      productId?: string;
      productUrl?: string;
      product?: Partial<Product>;
      uploadedSliceIds?: string[];
      taskId?: string;
      noCache?: boolean;
      localOnly?: boolean;
      strictEvidence?: boolean;
      webSearch?: boolean;
      searchScopes?: Array<'official' | 'commerce' | 'review' | 'social'>;
    };
    if (!body.productId) {
      res.status(400).json({ error: 'productId 必填' });
      return;
    }
    const productInput: Product = {
      id: body.productId,
      title: body.product?.title || body.productId,
      category: body.product?.category || '未知品类',
      price: body.product?.price || '',
      audience: body.product?.audience || '',
      description: body.product?.description || '',
      sellingPoints: body.product?.sellingPoints || [],
      assets: body.product?.assets || [],
      reviewStatus: body.product?.reviewStatus || 'approved',
    };
    const uploadedSlices = (body.uploadedSliceIds || [])
      .map((id) => slices.get(id))
      .filter((s): s is Slice => Boolean(s));
    try {
      const output = await runResearchAgent({
        productId: body.productId,
        productUrl: body.productUrl,
        product: productInput,
        uploadedSlices,
        taskId: body.taskId,
        noCache: body.noCache,
        localOnly: body.localOnly,
        strictEvidence: body.strictEvidence,
        webSearch: body.webSearch,
        searchScopes: body.searchScopes,
      });
      // 用 D1 Policy 重新过滤 claim 状态（Research Agent 只产 needs_evidence）
      // fromCache / fixture 数据已手工标好状态，跳过重过滤
      const evidenceMap = new Map(output.evidence.map((e) => [e.id, e]));
      const filteredClaims = output.fromCache
        ? output.claims
        : output.claims.map((claim) => {
            const result = validateClaim(claim, evidenceMap);
            return { ...claim, status: result.status, policyHits: result.hits };
          });
      const updated: ResearchOutput = { ...output, claims: filteredClaims };
      evidenceStore.set(body.productId, updated);
      await upsertEvidenceRecord(body.productId, updated as unknown as Record<string, unknown>).catch(() => undefined);
      if (body.taskId) {
        const existing = trustloopTraces.get(body.taskId) || [];
        trustloopTraces.set(body.taskId, [...existing, ...updated.traces]);
        for (const trace of updated.traces) {
          createTrustLoopTrace({
            taskId: body.taskId,
            step: trace.step,
            agentName: trace.agent,
            message: `${trace.decision} ${trace.reason}`.trim(),
            data: { decision: trace.decision, reason: trace.reason, status: trace.status },
          }).catch(() => undefined);
        }
      }
      persistRuntimeStore();

      // 异步锚定 TrustDAG（不阻塞响应）
      void (async () => {
        try {
          const dagCtx = { taskId: body.taskId, productId: body.productId };
          // 1. 锚定 evidence 节点
          const evidenceHashMap = new Map<string, string>();
          for (const ev of updated.evidence) {
            const h = await anchorEvidence(ev, dagCtx);
            evidenceHashMap.set(ev.id, h);
          }
          // 2. 锚定 claim 节点（关联 evidence hashes）
          for (const cl of filteredClaims) {
            const parentHashes = cl.evidenceIds
              .map((eid) => evidenceHashMap.get(eid))
              .filter((h): h is string => Boolean(h));
            await anchorClaim(cl, parentHashes, dagCtx);
          }
        } catch {
          // TrustDAG 写入失败不影响主流程
        }
      })();

      res.json({
        productId: body.productId,
        productUrl: updated.productUrl,
        evidence: updated.evidence,
        claims: updated.claims,
        traces: updated.traces,
        fromCache: updated.fromCache,
        summary: {
          evidenceCount: updated.evidence.length,
          claimsApproved: filteredClaims.filter((c) => c.status === 'approved').length,
          claimsBlocked: filteredClaims.filter((c) => c.status === 'blocked').length,
          claimsNeedsEvidence: filteredClaims.filter((c) => c.status === 'needs_evidence').length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      const status = message.startsWith('严格证据模式') ? 422 : 500;
      res.status(status).json({ error: message });
    }
  });

  // 2) GET /api/research/:productId —— 读取该商品的 evidence/claims/traces
  app.get('/api/research/:productId', async (req, res) => {
    const data = evidenceStore.get(req.params.productId);
    if (data) return res.json({ productId: req.params.productId, ...data });
    const dbRecord = await getEvidenceRecord(req.params.productId).catch(() => null);
    if (!dbRecord) {
      res.status(404).json({ error: 'no research data for this productId' });
      return;
    }
    res.json({ productId: req.params.productId, ...(dbRecord.output as object) });
  });

  // 3) POST /api/policy/check —— 对一个 script 跑 Policy 验证（不调 Research Agent）
  app.post('/api/policy/check', (req, res) => {
    const { scriptId } = req.body || {};
    const script = scripts.get(scriptId);
    if (!script) {
      res.status(404).json({ error: 'script not found' });
      return;
    }
    const research = evidenceStore.get(script.productId);
    const evidence = research?.evidence || [];
    const claims = research?.claims || [];
    const audit = auditScript({
      taskId: `policy_check_${Date.now()}`,
      script,
      claims,
      evidence,
    });
    res.json({
      scriptId,
      productId: script.productId,
      ruleCount: POLICY_RULES_V2.length,
      issues: audit.issues,
      metrics: audit.metrics,
    });
  });

  // 4) GET /api/passport/:videoId —— 获取视频护照
  app.get('/api/passport/:videoId', async (req, res) => {
    const dagDerived = await derivePassportFromDag(req.params.videoId).catch(() => null);
    if (dagDerived) {
      return res.json({
        ...dagDerived.passport,
        dagRootId: dagDerived.rootId,
        staleNodeIds: dagDerived.staleNodeIds,
      });
    }
    const passport = passportStore.get(req.params.videoId);
    if (passport) return res.json(passport);
    const dbRecord = await getPassport(req.params.videoId).catch(() => null);
    if (!dbRecord) {
      res.status(404).json({ error: 'no passport for this videoId' });
      return;
    }
    res.json({
      videoId: dbRecord.videoId,
      scriptId: dbRecord.scriptId,
      trustScore: dbRecord.trustScore,
      evidenceCoverage: dbRecord.evidenceCoverage,
      realMaterialRatio: dbRecord.realMaterialRatio,
      approvedClaims: dbRecord.approvedClaims,
      needsEvidenceClaims: dbRecord.needsEvidenceClaims,
      blockedClaims: dbRecord.blockedClaims,
      repairedClaims: dbRecord.repairedClaims,
      policyRisk: dbRecord.policyRisk,
      iterationCount: dbRecord.iterationCount,
      evidenceBreakdown: dbRecord.evidenceBreakdown,
      generatedAt: dbRecord.generatedAt,
    });
  });

  // 5) POST /api/qa/repair —— 触发局部修复
  app.post('/api/qa/repair', async (req, res) => {
    const { taskId, scriptId, issueId } = req.body || {};
    const script = scripts.get(scriptId);
    const audit = auditResults.get(taskId);
    if (!script || !audit) {
      res.status(404).json({ error: 'script or audit not found' });
      return;
    }
    const issue: AuditIssue | undefined = audit.issues.find((i) => i.id === issueId);
    if (!issue) {
      res.status(404).json({ error: 'issue not found' });
      return;
    }
    const research = evidenceStore.get(script.productId);
    const claims = research?.claims || [];
    const evidence = research?.evidence || [];

    const ctx: RepairContext = { taskId, script, issue, claims, evidence };

    const executors: RepairExecutors = {
      rewriteNarration: async (shot) => {
        // 简化版：把命中片段替换为 suggestedFix
        const safeText = issue.matched
          ? shot.narration.replace(issue.matched, '（已合规化表达）')
          : `${shot.narration}（已重写）`;
        return { narration: safeText, subtitle: safeText };
      },
      replaceClaim: async (shot) => {
        const approved = claims.filter((c) => c.status === 'approved');
        if (approved.length === 0) return { claimIds: [] };
        // 选 evidence 最多的 claim
        const best = [...approved].sort((a, b) => b.evidenceIds.length - a.evidenceIds.length)[0];
        return { claimIds: [best.id] };
      },
      trimDuration: async (shot) => ({
        duration: Math.min(shot.duration, 6),
      }),
      removeShot: async (shot) => {
        script.shots = script.shots.filter((s) => s.id !== shot.id);
      },
    };

    const result = await repairShot(ctx, executors);
    const existing = trustloopTraces.get(taskId) || [];
    trustloopTraces.set(taskId, [...existing, result.trace]);
    createTrustLoopTrace({
      taskId,
      step: result.trace.step,
      agentName: result.trace.agent,
      message: `${result.trace.decision} ${result.trace.reason}`.trim(),
      data: { decision: result.trace.decision, reason: result.trace.reason, status: result.trace.status },
    }).catch(() => undefined);
    const newAudit = auditScript({ taskId, script, claims, evidence });
    auditResults.set(taskId, newAudit);
    const auditLevel = newAudit.issues.some((i) => i.risk === 'block')
      ? 'block'
      : newAudit.issues.some((i) => i.risk === 'warn')
        ? 'warn'
        : 'pass';
    upsertAuditResult(
      taskId,
      scriptId,
      auditLevel,
      newAudit.issues,
      newAudit.metrics as unknown as Record<string, unknown>,
    ).catch(() => undefined);
    persistRuntimeStore();
    res.json({
      issueId,
      repaired: !result.trace.errorMessage,
      removed: result.removed,
      shotId: result.shot?.id,
      trace: result.trace,
      newMetrics: newAudit.metrics,
    });
  });

  // 6) GET /api/trace/:taskId —— 返回任务的全部 TrustLoop trace 时间轴
  app.get('/api/trace/:taskId', async (req, res) => {
    const memTraces = trustloopTraces.get(req.params.taskId) || [];
    if (memTraces.length) return res.json({ taskId: req.params.taskId, count: memTraces.length, traces: memTraces });
    const dbTraces = await listTrustLoopTraces(req.params.taskId).catch(() => []);
    const traces = dbTraces.map((t) => ({
      step: t.step,
      agentName: t.agentName,
      message: t.message,
      data: t.data,
      createdAt: t.createdAt,
    }));
    res.json({ taskId: req.params.taskId, count: traces.length, traces });
  });

  registerTrustDagRoutes(app);
}
