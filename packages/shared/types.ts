// 共享类型定义 - 前后端共同使用，严禁私自修改

export type AssetKind = 'image' | 'video' | 'reference';
export type MaterialAngleProvider = 'local' | 'qwen' | 'comfyui';
export type MaterialAngleView = 'front' | 'left_30' | 'right_30' | 'top_15' | 'detail' | 'custom';
export type ReviewStatus = 'approved' | 'needs_review' | 'blocked';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Factor {
  type: string; // 开场hook/退场/画面重点/旁白风格/BGM…
  value: string; // 如"轻柔音乐引入""黑屏品牌名""材料质感"
  sourceStrategy: string; // 来自哪个策略(归因可追溯)
}

export type TextLayerType = 'subtitle' | 'selling_point' | 'price' | 'brand' | 'cta';

export interface TextLayer {
  id: string;
  type: TextLayerType;
  text: string;
  start: number; // 相对当前 shot 的秒数
  end: number;
  position: {
    x: number; // 0-1 normalized canvas coordinate
    y: number;
  };
  style: {
    fontSize: number;
    color: string;
    stroke?: string;
    background?: string;
    align?: 'left' | 'center' | 'right';
  };
  editable: boolean;
}

export interface Shot {
  id: string; // 稳定不变 id —— 局部刷新靠它定位"第几镜"
  order: number; // 顺序(可拖拽,与 id 解耦)
  duration: number; // 秒;sum(shots.duration) ≤ 15

  visualDesc: string; // 画面描述(喂给文生图/图生视频的 prompt)
  camera: string; // 镜头运动:推/拉/摇/固定
  narration: string; // 台词/旁白文案(当前只作为分镜文本)
  subtitle: string; // 字幕(初期 = narration,保留分开余地做多语种)
  textLayers?: TextLayer[]; // Composer 后期可编辑文字层；Seedance 只生成无文字画面

  materialRef?: string; // 已废弃：素材切片只能做生成参考，最终成片禁止绑定/裁切 materialRef
  transition?: 'hard_cut' | 'fade' | 'whip'; // 与下一镜的剪辑转场
  factors: Factor[]; // 这一镜的创作因子

  status: 'draft' | 'generating' | 'done' | 'failed'; // 驱动前端分镜卡状态
  assetUrl?: string; // 这一镜生成好的片段地址(局部重渲染后更新)

  // TrustLoop：这一镜台词对应的 claim（QA 反查用），可选不破坏旧代码
  claimIds?: string[];
  evidenceIds?: string[]; // 直接引用的 evidence（如「页面显示售价 ¥299」）
}

export interface Script {
  id: string;
  productId: string;
  generationProfile?: 'quick_preview' | 'trusted_publish'; // 快速预览/可信发布，用于控制证据绑定和生成深度
  productUrl?: string; // 用户输入的商品页来源，用于证据回溯
  referenceImageUrl?: string; // 用户上传的商品主图，渲染时优先走 I2V 保持商品一致
  materialIds?: string[]; // 当前商品允许被剪辑 Agent 使用的素材
  sourceMode: 'imitate' | 'template' | 'auto'; // 爆款仿写/灵感模板/剧本自动化
  sourceRef?: string; // 仿写=参考视频id;模板=模板id(用于声明素材来源)

  narrative: string; // 叙事框架(一句话,人话)
  visualStyle: string; // 全局视觉风格,如"夏日度假风";因子局部替换主要动它
  bgm: string; // 全局配乐基调
  aspectRatio: '9:16' | '16:9';
  language: string; // 配音/字幕语种(多语种 dubbing)

  shots: Shot[]; // 分镜列表(核心)
  constraints: string[]; // 约束清单:禁止内容、合规要求
}

export interface VideoPerf {
  id: string;
  scriptId: string;
  videoId?: string; // 对应导出任务/成片 id
  source?: 'observed' | 'kalodata_seed' | 'simulated'; // 模拟数据只可展示，不可进入学习写权重
  factorSnapshot: Factor[];
  impressions: number;
  ctr: number;
  completionRate: number;
  conversionRate: number;
  gmv: number;
  createdAt: Date;
}

export interface FactorWeight {
  id: string;
  factorId: string;
  weight: number; // 默认1.0
  updatedAt: Date;
  sampleSize: number;
}

export interface TaskStatus {
  id: string;
  type: 'script' | 'video' | 'compose' | 'slice' | 'angle' | 'index' | 'trend';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  step: string;
  error?: string;
  elapsedMs?: number; // 从任务创建到当前/完成的耗时
  elapsedText?: string;
  createdAt: Date;
  updatedAt: Date;
}

// 素材相关类型
export interface Material {
  id: string;
  productId?: string; // 商家素材只参与对应商品的检索和出片
  name?: string;
  type: 'image' | 'video';
  sourceUrl: string;
  sourceDeclaration: string; // 来源声明
  uploadedAt: Date;
}

export interface MaterialAngle {
  id: string;
  materialId: string;
  productId?: string;
  view: MaterialAngleView;
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
  provider: MaterialAngleProvider;
  status: 'ready' | 'fallback';
  note?: string;
  createdAt: string;
}

export interface Slice {
  id: string;
  materialId: string;
  thumbnailUrl: string;
  clipUrl: string;
  startTime: number;
  endTime: number;
  tags: Record<string, string[]>; // 商品/视频/slice 三层文字标签
  summary: string;
  embedding?: number[]; // jina-clip-v2 多语言图文向量
}

export interface ReferenceVideo {
  id: string;
  sourceUrl: string;
  localVideoUrl?: string;
  sourceDeclaration: string;
  licenseType?: string;
  usageScope?: 'analysis' | 'creative' | 'analysis_and_creative';
  breakdownReport: Record<string, unknown>; // hook/卖点/分镜/风格等拆解报告
}

export interface CloneRecipeSegment {
  t: string;
  role: 'hook' | 'proof' | 'demo' | 'offer' | 'cta';
  tactic: string;
  shot: string;
  bgm?: string;
}

export interface CloneRecipe {
  id: string;
  sourceUrl?: string;
  sourceReferenceId?: string;
  sourceDeclaration: string;
  productId?: string;
  title: string;
  category?: string;
  durationSeconds?: number;
  pace?: string;
  segments: CloneRecipeSegment[];
  factors: {
    canonical: string[];
    byType: Record<string, string>;
    raw: string[];
  };
  visual?: Record<string, unknown>;
  scoring?: Record<string, unknown>;
  status: 'ready' | 'draft' | 'failed';
  createdAt?: string;
  updatedAt?: string;
}

export interface CloneRecipeClone {
  id: string;
  recipeId: string;
  productId: string;
  scriptId?: string;
  taskId?: string;
  status: 'queued' | 'completed' | 'failed' | 'scored';
  benchmarkScore?: number;
  missingFactors?: string[];
  scoreBreakdown?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductAsset {
  id: string;
  productId: string;
  name: string;
  kind: AssetKind;
  source: string;
  url: string;
  tags: string[];
  summary: string;
  slices: Array<{
    id: string;
    label: string;
    cue: string;
    tags: string[];
    start?: number;
    end?: number;
    score: number;
  }>;
}

export interface Product {
  id: string;
  title: string;
  category: string;
  price: string;
  audience: string;
  description: string;
  sellingPoints: string[];
  assets: ProductAsset[];
  reviewStatus: ReviewStatus;
}

export interface CreativeTemplate {
  id: string;
  level: 'P1' | 'P2' | 'P3';
  name: string;
  strategy: string;
  factors: string[];
  promptSeed: string;
}

export interface StoryFrame {
  id: string;
  order: number;
  role: 'hook' | 'proof' | 'demo' | 'offer' | 'cta';
  duration: number;
  visual: string;
  narration: string;
  subtitle: string;
  assetId?: string;
}

export interface ScriptPlan {
  id: string;
  productId: string;
  templateId: string;
  title: string;
  language: string;
  goal: string;
  strategy: string;
  constraints: string[];
  frames: StoryFrame[];
  createdAt: string;
  provider?: 'local' | 'ark';
}

export interface ExportPreset {
  id: 'vertical' | 'wide' | 'square';
  label: string;
  width: number;
  height: number;
  channel: string;
}

export interface RenderJob {
  id: string;
  scriptId: string;
  status: JobStatus;
  preset: ExportPreset;
  attempt: number;
  progress: number;
  logs: string[];
  url?: string;
  format?: 'mp4' | 'html';
  provider?: 'local' | 'ark';
  error?: string;
  updatedAt: string;
}

export interface ComplianceReport {
  status: ReviewStatus;
  score: number;
  checks: Array<{
    name: string;
    result: 'pass' | 'warn' | 'fail';
    detail: string;
  }>;
}

export interface AnalyticsSummary {
  id: string;
  scriptTitle: string;
  productId: string;
  variant: 'A' | 'B' | 'Control';
  views: number;
  ctr: number;
  cvr: number;
  gmv: number;
  attribution: Array<{ factor: string; lift: number }>;
  retention: Array<{ second: number; value: number }>;
}

export interface AgentRecommendation {
  id: string;
  title: string;
  priority: 'high' | 'medium' | 'low';
  rationale: string;
  action: string;
}

export interface FrameworkAssistantResult {
  id: string;
  provider: 'local' | 'ark';
  title: string;
  value: string;
  language: string;
  goal: string;
  templateId: string;
  productDraft: {
    title: string;
    category: string;
    price: string;
    audience: string;
    description: string;
    sellingPoints: string[];
  };
  framework: string[];
  demoSteps: string[];
  riskControls: string[];
  promptSummary: string;
}

export interface AigcTrend {
  id: string;
  title: string;
  source: string;
  url: string;
  category: 'hot' | 'recommended';
  tag: string;
  heat: number;
  summary: string;
  prompt: string;
  updatedAt: string;
}

export type PageAgentAction =
  | { type: 'open_page'; page: 'home' | 'studio' | 'edit' | 'growth' }
  | { type: 'generate_framework'; brief?: string }
  | { type: 'generate_script' }
  | { type: 'render_video' }
  | { type: 'optimize_growth' }
  | { type: 'refresh_trends' }
  | { type: 'search_assets'; query?: string }
  | { type: 'review_compliance' }
  | { type: 'qwen_image_edit' }
  | { type: 'apply_recent_history' }
  | { type: 'open_history' };

export interface PageAgentResponse {
  provider: 'local' | 'ark';
  reply: string;
  actions: PageAgentAction[];
  reasoning?: string;
  skills?: string[];
  promptProfile?: string;
}

// === TrustLoop 类型：证据 / 卖点 / Agent 轨迹 / 视频护照 ===

export type PolicyLevel = 'block' | 'warn' | 'needs_evidence';

export interface Evidence {
  id: string;
  sourceType: 'product' | 'material' | 'web' | 'review' | 'reference' | 'policy';
  sourceScope?: 'official' | 'commerce' | 'review' | 'social' | 'general';
  sourceUrl?: string;
  sourceTitle?: string;
  text: string;
  reliability: 'high' | 'medium' | 'low';
  fetchedAt: string;
}

export interface Claim {
  id: string;
  productId: string;
  text: string;
  category: 'feature' | 'benefit' | 'scenario' | 'spec' | 'price' | 'social_proof';
  evidenceIds: string[];
  confidence: number;
  status: 'approved' | 'needs_evidence' | 'blocked';
  policyHits?: Array<{ ruleId: string; level: PolicyLevel; reason: string }>;
  createdAt: string;
}

export interface AgentTrace {
  id: string;
  taskId: string;
  agent: 'research' | 'policy' | 'creative' | 'production' | 'qa';
  step: string;
  inputRefs: string[];
  outputRefs: string[];
  decision: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'fallback' | 'error';
  errorMessage?: string;
}

export type AgentUiPhase =
  | 'preparing'
  | 'needs_input'
  | 'researching_product'
  | 'generating_script'
  | 'awaiting_storyboard_confirmation'
  | 'generating_video'
  | 'checking_status'
  | 'editing_storyboard'
  | 'completed'
  | 'failed_need_materials'
  | 'failed';

export type AgentUiVisibleStatus = 'running' | 'done' | 'failed' | 'waiting';

export interface AgentUiVisiblePayload {
  phase: AgentUiPhase;
  status: AgentUiVisibleStatus;
  title: string;
  summary?: string;
  detailLines?: string[];
}

export interface AgentUiHiddenHandles {
  runId?: string;
  taskId?: string;
  productId?: string;
  scriptId?: string;
  videoId?: string;
  kind?: string;
}

export interface AgentUiState {
  phase: AgentUiPhase;
  status: AgentUiVisibleStatus;
  title: string;
  summary?: string;
  activeRun?: AgentUiHiddenHandles;
}

export type AgentUiCustomEventName = 'agent.ui.visible' | 'agent.run.started' | 'agent.script.updated';

export type AgentUiStreamEvent =
  | {
      type: 'RUN_STARTED';
      eventId: string;
      timestamp: number;
      threadId: string;
      runId: string;
      state: AgentUiState;
    }
  | {
      type: 'STATE_SNAPSHOT';
      eventId: string;
      timestamp: number;
      snapshot: AgentUiState;
      state: AgentUiState;
    }
  | {
      type: 'TOOL_CALL_START';
      eventId: string;
      timestamp: number;
      toolCallId: string;
      toolCallName: string;
      toolName: string;
      step?: number;
      ui: AgentUiVisiblePayload;
    }
  | {
      type: 'TOOL_CALL_RESULT';
      eventId: string;
      timestamp: number;
      toolCallId: string;
      messageId: string;
      content: string;
      role?: 'tool';
      toolName: string;
      step?: number;
      ui: AgentUiVisiblePayload;
      handles?: AgentUiHiddenHandles;
    }
  | {
      type: 'TEXT_MESSAGE_CONTENT';
      eventId: string;
      timestamp: number;
      messageId: string;
      delta: string;
    }
  | {
      type: 'TEXT_MESSAGE_END';
      eventId: string;
      timestamp: number;
      messageId: string;
    }
  | {
      type: 'RUN_FINISHED';
      eventId: string;
      timestamp: number;
      threadId: string;
      runId: string;
      outcome: { type: 'success' } | { type: 'interrupt'; interrupts: Array<{ id: string; reason: string }> };
      state: AgentUiState;
    }
  | {
      type: 'RUN_ERROR';
      eventId: string;
      timestamp: number;
      runId: string;
      message: string;
      state: AgentUiState;
    }
  | {
      type: 'CUSTOM';
      eventId: string;
      timestamp: number;
      name: AgentUiCustomEventName;
      value: {
        ui: AgentUiVisiblePayload;
        handles?: AgentUiHiddenHandles;
        payload?: unknown;
      };
      ui: AgentUiVisiblePayload;
      handles?: AgentUiHiddenHandles;
    };

export interface VideoPassport {
  videoId: string;
  scriptId: string;
  trustScore: number;
  evidenceCoverage: number;
  realMaterialRatio: number; // 兼容旧字段；新链路正常应为 0，非 0 代表直接素材切片风险
  approvedClaims: number;
  needsEvidenceClaims?: number;
  blockedClaims: number;
  repairedClaims: number;
  policyRisk: 'low' | 'medium' | 'high';
  iterationCount: number;
  evidenceBreakdown: Array<{ sourceType: Evidence['sourceType']; count: number }>;
  generatedAt: string;
}

export interface QwenImageEditResult {
  id: string;
  provider: 'local' | 'qwen';
  model: string;
  prompt: string;
  source: string;
  angles: Array<{
    id: string;
    label: string;
    prompt: string;
    url: string;
  }>;
  warnings: string[];
  createdAt: string;
}

// === TrustDAG / Tournament visualization read models ===
// These mirror the API payloads consumed by the web demo without requiring the
// UI to import persistence-layer types.

export type TrustNodeType = 'evidence' | 'claim' | 'shot' | 'script' | 'video';
export type TrustEdgeType = 'derives' | 'supports' | 'refutes' | 'uses';

export interface TrustDagNode {
  id: string;
  nodeType: TrustNodeType;
  payload: Record<string, unknown>;
  status?: 'active' | 'stale';
  staleAt?: string | null;
  staleReason?: string | null;
  parentIds?: string[];
  productId?: string;
  scriptId?: string;
  createdAt: string;
}

export interface TrustDagEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: TrustEdgeType;
  weight?: number;
  createdAt?: string;
}

export interface TrustDagGraph {
  nodes: TrustDagNode[];
  edges: TrustDagEdge[];
}

export interface TournamentCohortSimilarities {
  organicWinner?: number;
  paidRoasWinner?: number;
  lowFollowerWinner?: number;
}

export interface TournamentBenchmarkMatch {
  id: string;
  category: string;
  distance?: number;
  profileDistance?: number;
  similarity?: number;
  benchmarkScore: number;
  referenceText: string;
}

export interface TournamentQwenAttributionFactor {
  factorId: string;
  factorType: string;
  factorValue: string;
  lift: number;
  coefficient: number;
  sampleSize: number;
  confidence: string;
  organicOnlyLift?: number | null;
  lowFollowerLift?: number | null;
  gmvPerMilleLift?: number | null;
  evidenceVideoIds: string[];
  supportingMockFactors: string[];
}

export interface TournamentQwenAttribution {
  source: 'qwen_factor_attribution';
  modelVersion: string;
  qwenModel: string;
  videoCount: number;
  matchedFactorCount: number;
  calibrationLift: number;
  calibratedBenchmarkScore: number;
  policy: string;
  matchedFactors: TournamentQwenAttributionFactor[];
}

export interface TournamentScoreBreakdown {
  hookStrength: number;
  emotionalResonance: number;
  sceneDiversity: number;
  salesClarity: number;
  brandSafety: number;
  composite: number;
  normalized: number;
  ctr: number;
  completionRate: number;
  conversionRate: number;
  gmv: number;
  impressions?: number;
  benchmarkScore?: number;
  cohortSimilarities?: TournamentCohortSimilarities;
  topKMatches?: TournamentBenchmarkMatch[];
  qwenAttribution?: TournamentQwenAttribution;
  qwenCalibrationLift?: number;
  qwenCalibratedBenchmarkScore?: number;
  metricSource?: 'simulated';
  simulatedMetricsSource?: 'simulated';
  mockCtrModelVersion?: string;
  mockCtrSeed?: string;
  mockCtrNoiseMultiplier?: number;
  factorContributions?: Array<{ factorId: string; coefficient: number; contribution: number }>;
  timeDecay?: number;
}

export interface TournamentGene {
  type: string;
  value: string;
  shotIndex: number;
}

export interface TournamentVariantView {
  id: string;
  generation: number;
  parentIds: string[];
  genes: TournamentGene[];
  llmScore: number | null;
  ctrScore: number | null;
  compositeScore: number | null;
  scoreBreakdown: TournamentScoreBreakdown | null;
  status: 'pending' | 'scored' | 'survivor' | 'eliminated';
  scriptSnapshot?: Record<string, unknown>;
}

export interface TournamentRunView {
  id: string;
  productId: string;
  status: 'running' | 'completed' | 'failed';
  generation: number;
  maxGens: number;
  populationN: number;
  winnerId: string | null;
  variants: TournamentVariantView[];
  createdAt: string;
  isFallback?: boolean;
}
