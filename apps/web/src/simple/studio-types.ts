export const API_BASE = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE || '/api';

export type AppPage = 'chat' | 'clone' | 'script' | 'materials' | 'passport' | 'workflow' | 'analytics';

export type SearchScope = 'official' | 'commerce' | 'review' | 'social';

export interface EvidenceItem {
  id: string;
  sourceType: 'product' | 'material' | 'web' | 'review' | 'reference' | 'policy';
  sourceScope?: SearchScope | 'general';
  sourceUrl?: string;
  sourceTitle?: string;
  text: string;
  reliability: 'high' | 'medium' | 'low';
  fetchedAt: string;
}

export interface ClaimItem {
  id: string;
  text: string;
  category?: string;
  evidenceIds: string[];
  confidence: number;
  status: 'approved' | 'needs_evidence' | 'blocked';
}

export interface TraceItem {
  id: string;
  agent: string;
  step: string;
  decision?: string;
  reason?: string;
  status: 'ok' | 'fallback' | 'error';
  startedAt?: string;
}

export interface ResearchData {
  productId: string;
  productUrl?: string;
  evidence: EvidenceItem[];
  claims: ClaimItem[];
  traces: TraceItem[];
  fromCache?: boolean;
  searchPlan?: Array<{
    scope: SearchScope;
    label: string;
    query: string;
    sourceType: 'web' | 'review';
    maxItems: number;
  }>;
}

export interface ShotItem {
  id: string;
  order: number;
  duration: number;
  visualDesc: string;
  narration: string;
  subtitle: string;
  camera?: string;
  materialRef?: string;
  claimIds?: string[];
  evidenceIds?: string[];
  textLayers?: TextLayerItem[];
  status?: 'draft' | 'generating' | 'done' | 'failed';
  assetUrl?: string;
}

export type TextLayerType = 'subtitle' | 'selling_point' | 'price' | 'brand' | 'cta';

export interface TextLayerItem {
  id: string;
  type: TextLayerType;
  text: string;
  start: number;
  end: number;
  position: { x: number; y: number };
  style: {
    fontSize: number;
    color: string;
    stroke?: string;
    background?: string;
    align?: 'left' | 'center' | 'right';
  };
  editable: boolean;
}

export interface MaterialAngle {
  id: string;
  materialId: string;
  productId?: string;
  view: 'front' | 'left_30' | 'right_30' | 'top_15' | 'detail' | 'custom';
  key: string;
  label: string;
  imageUrl: string;
  referenceImageUrl: string;
  previewUrl?: string;
  sourceImageUrl: string;
  promptHint: string;
  pose?: {
    azimuthDeg: number;
    elevationDeg: number;
    distanceLevel: number;
    azimuth: string;
    elevation: string;
    distance: string;
    qwenPrompt: string;
  };
  provider: 'local' | 'qwen' | 'comfyui';
  status: 'ready' | 'fallback';
  note?: string;
  createdAt: string;
}

export interface ScriptData {
  id: string;
  productId: string;
  generationProfile?: 'quick_preview' | 'trusted_publish';
  narrative: string;
  visualStyle: string;
  bgm?: string;
  aspectRatio?: '9:16' | '16:9';
  language?: string;
  shots: ShotItem[];
}

export interface ScriptVersion {
  id: string;
  label: string;
  createdAt: number;
  script: ScriptData;
  sourceRunId?: string;
}

export interface PassportData {
  videoId: string;
  scriptId: string;
  trustScore: number;
  evidenceCoverage: number;
  realMaterialRatio: number;
  blockedClaims: number;
  needsEvidenceClaims?: number;
  policyRisk: 'low' | 'medium' | 'high';
}

export interface RenderResult {
  scriptId?: string;
  videoId?: string;
  videoUrl?: string;
  assetUrl?: string;
  previewUrl?: string;
  objectKey?: string;
  provider?: string;
  format?: 'mp4' | 'html';
  mediaNote?: string;
  fallbackReason?: string;
  passport?: PassportData;
  agentRunId?: string;
  agentOutput?: Record<string, unknown>;
}

export interface RenderVersion {
  id: string;
  label: string;
  createdAt: number;
  scriptVersionId?: string;
  taskId?: string;
  result: RenderResult;
}

export interface TaskStatus {
  id: string;
  status: 'queued' | 'pending' | 'processing' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  step?: string;
  elapsedMs?: number;
  elapsedText?: string;
  createdAt?: string;
  updatedAt?: string;
  payload?: RenderResult & { scriptId?: string };
  trace?: Array<{
    at?: string;
    step?: string;
    progress?: number;
    message?: string;
    data?: Record<string, unknown>;
  }>;
  error?: string;
}

export function formatElapsedMs(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

export function taskElapsedText(
  task: Pick<TaskStatus, 'elapsedMs' | 'elapsedText' | 'createdAt' | 'updatedAt'> | null,
) {
  if (!task) return '';
  if (task.elapsedText) return task.elapsedText;
  if (Number.isFinite(task.elapsedMs)) return formatElapsedMs(Number(task.elapsedMs));
  if (!task.createdAt) return '';
  const startedAt = new Date(task.createdAt).getTime();
  const endedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return '';
  return formatElapsedMs(endedAt - startedAt);
}

export function normalizeResearch(data: Partial<ResearchData> | null, productId: string): ResearchData {
  return {
    productId: data?.productId || productId,
    productUrl: data?.productUrl,
    evidence: Array.isArray(data?.evidence) ? data.evidence : [],
    claims: Array.isArray(data?.claims) ? data.claims : [],
    traces: Array.isArray(data?.traces) ? data.traces : [],
    searchPlan: Array.isArray(data?.searchPlan) ? data.searchPlan : [],
    fromCache: data?.fromCache,
  };
}

function defaultTextLayerStyle(type: TextLayerType): TextLayerItem['style'] {
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

function defaultTextLayer(shot: Partial<ShotItem>, index: number): TextLayerItem {
  return {
    id: `text_${shot.id || index + 1}_subtitle`,
    type: 'subtitle',
    text: shot.subtitle || shot.narration || '',
    start: 0,
    end: Math.max(1, Number(shot.duration || 3)),
    position: { x: 0.5, y: 0.82 },
    style: defaultTextLayerStyle('subtitle'),
    editable: true,
  };
}

function normalizeTextLayers(shot: Partial<ShotItem>, index: number): TextLayerItem[] {
  const layers = Array.isArray(shot.textLayers) ? shot.textLayers : [];
  const normalized = layers
    .map((layer, layerIndex) => {
      const type = layer.type || 'subtitle';
      const defaults = defaultTextLayerStyle(type);
      return {
        id: layer.id || `text_${shot.id || index + 1}_${layerIndex + 1}`,
        type,
        text: layer.text || '',
        start: Number.isFinite(Number(layer.start)) ? Number(layer.start) : 0,
        end: Number.isFinite(Number(layer.end)) ? Number(layer.end) : Math.max(1, Number(shot.duration || 3)),
        position: {
          x: Number.isFinite(Number(layer.position?.x)) ? Number(layer.position?.x) : 0.5,
          y: Number.isFinite(Number(layer.position?.y)) ? Number(layer.position?.y) : 0.82,
        },
        style: {
          fontSize: Number.isFinite(Number(layer.style?.fontSize)) ? Number(layer.style?.fontSize) : defaults.fontSize,
          color: layer.style?.color || defaults.color,
          stroke: layer.style?.stroke || defaults.stroke,
          background: layer.style?.background || defaults.background,
          align: layer.style?.align || defaults.align,
        },
        editable: layer.editable !== false,
      };
    })
    .filter((layer) => layer.text.trim());
  return normalized.length ? normalized : [defaultTextLayer(shot, index)];
}

export function normalizeScript(data: Partial<ScriptData>, productId: string): ScriptData {
  return {
    id: data.id || `script_${Date.now()}`,
    productId: data.productId || productId,
    generationProfile: data.generationProfile,
    narrative: data.narrative || '以证据建立信任的短视频叙事',
    visualStyle: data.visualStyle || '写实商品摄影',
    bgm: data.bgm,
    aspectRatio: data.aspectRatio || '9:16',
    language: data.language || 'zh-CN',
    shots: Array.isArray(data.shots)
      ? data.shots.map((shot, index) => {
          const normalizedShot = {
            id: shot.id || `shot_${index + 1}`,
            order: shot.order ?? index + 1,
            duration: shot.duration ?? 3,
            visualDesc: shot.visualDesc || '',
            narration: shot.narration || '',
            subtitle: shot.subtitle || shot.narration || '',
            camera: shot.camera,
            materialRef: shot.materialRef,
            claimIds: shot.claimIds,
            evidenceIds: shot.evidenceIds,
            status: shot.status,
            assetUrl: shot.assetUrl,
          };
          return { ...normalizedShot, textLayers: normalizeTextLayers({ ...shot, ...normalizedShot }, index) };
        })
      : [],
  };
}
