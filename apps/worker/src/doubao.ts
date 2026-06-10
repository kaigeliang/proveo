import axios from 'axios';
import { randomUUID } from 'crypto';
import type { ProductionFactor, ProductionScriptInput, ProductionShotInput } from '@aigc-video-hub/db';

export type DoubaoMaterialSlice = {
  id: string;
  materialId: string;
  summary: string;
  tags?: string[];
  startTime?: number;
  endTime?: number;
};

function envValue(name: string) {
  return process.env[name]?.replace(/[​-‍﻿]/g, '').trim();
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeDurationBudget(shots: ProductionShotInput[], maxDuration = 15) {
  const minShotDuration = 3;
  const maxShotDuration = 5;
  let remaining = maxDuration;
  return shots.map((shot, index) => {
    const shotsLeft = shots.length - index - 1;
    const maxAllowed = Math.max(minShotDuration, Math.min(maxShotDuration, remaining - shotsLeft * minShotDuration));
    const duration = clamp(Math.round(Number(shot.duration) || minShotDuration), minShotDuration, maxAllowed);
    remaining -= duration;
    return { ...shot, duration };
  });
}

export function isDoubaoConfigured(): boolean {
  return Boolean(
    envValue('ARK_API_KEY') &&
    (envValue('ARK_TEXT_MODEL_ID') || envValue('ARK_MODEL_ID')) &&
    process.env.ARK_ENABLE_TEXT !== 'false',
  );
}

// 因子枚举 —— 必须与打分引擎 (mock-ctr DEFAULT_FACTOR_EFFECTS) 的 id 对齐，
// 这样 LLM 标注的因子才能直接喂进归因/回流闭环。
export const FACTOR_TAXONOMY: Record<string, string[]> = {
  hook: ['question', 'shock', 'product_reveal', 'lifestyle'],
  camera: ['push', 'whip', 'static'],
  proof: ['demonstration'],
  cta: ['benefit', 'urgency'],
  bgm: ['upbeat', 'ambient', 'trending'],
};

function buildPrompt(params: {
  productId: string;
  mode: string;
  freePrompt?: string;
  materialSlices: DoubaoMaterialSlice[];
  topFactors: string[];
  avoidFactors?: string[];
  approvedClaims?: Array<{ id: string; text: string; evidenceIds: string[] }>;
  evidence?: Array<{ id: string; text?: string; sourceTitle?: string; sourceUrl?: string }>;
  hotVideoDna?: unknown;
  goal?: string;
}): string {
  const productLabel = params.freePrompt || params.productId;

  const materialContext =
    params.materialSlices.length > 0
      ? `生成参考素材切片（只用于理解当前商品外观、动作、构图和真实场景；禁止输出 materialRef，禁止裁切进成片）：\n${params.materialSlices
          .slice(0, 10)
          .map((slice, i) => {
            const tags = slice.tags?.length ? ` tags=${slice.tags.slice(0, 8).join('/')}` : '';
            const time =
              typeof slice.startTime === 'number' && typeof slice.endTime === 'number'
                ? ` time=${slice.startTime}-${slice.endTime}s`
                : '';
            return `${i + 1}. id=${slice.id} materialId=${slice.materialId}${time}${tags} summary=${slice.summary}`;
          })
          .join('\n')}`
      : '本次无素材参考切片，请生成原创场景描述。';

  const factorContext =
    params.topFactors.length > 0
      ? `历史高转化因子参考：${params.topFactors.slice(0, 5).join('、')}`
      : '暂无历史因子数据，使用通用电商短视频最佳实践。';

  const avoidFactorContext =
    params.avoidFactors && params.avoidFactors.length > 0
      ? `历史低转化因子（应规避，除非有强证据支撑）：${params.avoidFactors.slice(0, 4).join('、')}`
      : '无明确需规避的低转化因子。';

  const approvedClaimContext =
    params.approvedClaims && params.approvedClaims.length > 0
      ? params.approvedClaims
          .slice(0, 8)
          .map((claim) => `${claim.id}: ${claim.text} (evidence=${claim.evidenceIds.join(',')})`)
          .join('\n')
      : '无 approved claim，只能使用商品名、上传素材和保守场景表达。';

  const evidenceContext =
    params.evidence && params.evidence.length > 0
      ? params.evidence
          .slice(0, 8)
          .map((item) => `${item.id}: ${readText(item.text || item.sourceTitle, 'evidence')}`)
          .join('\n')
      : '无额外 evidence 摘要。';

  const dnaContext = params.hotVideoDna
    ? typeof params.hotVideoDna === 'string'
      ? params.hotVideoDna
      : JSON.stringify(params.hotVideoDna)
    : '无检索到的爆款 DNA；使用通用电商短视频最佳实践，并在 narrative 里点明所选策略。';

  return JSON.stringify(
    {
      task: '为电商 AIGC 带货视频生成一个 <=15 秒、恰好 3 个分镜的结构化 Script JSON。',
      goal: params.goal || '在前 3 秒抓住目标人群，并用可追溯卖点驱动转化。',
      product: { productId: params.productId, label: productLabel },
      mode: `${params.mode}（imitate=仿写爆款 / template=灵感模板 / auto=自动化）`,
      hotVideoDna: dnaContext,
      approvedClaims: approvedClaimContext,
      evidenceContext,
      materialContext,
      factorContext,
      avoidFactorContext,
      beatSkeleton: [
        '1. 钩子(黄金3秒): 制造停留理由, 禁止"大家好/今天介绍"。必带 hook 因子。',
        '2. 痛点/场景代入: 放大需求或第一人称代入使用场景。',
        '3. 卖点演示+证据: 演示核心卖点并绑定 approvedClaims 的 claimId。带 proof 因子。',
        '4. 信任/差异: 用对比/社会证明/资质降低决策风险(无 claim 支撑则弱化或省略)。',
        '5. 行动召唤 CTA: 给出明确下一步。必带 cta 因子。',
        '把以上节奏压成恰好 3 镜（钩子+痛点 / 卖点演示+证据 / CTA），每镜 5 秒，总和 15 秒；禁止输出短于 5 秒的镜头，因为 Seedance 单镜最低 5 秒，3×5=15 秒正好达标。',
      ],
      hookMenu: {
        'hook:question': '痛点提问 —— "还在被 X 困扰？"',
        'hook:shock': '高能/反差 —— 强视觉冲击或前后对比',
        'hook:product_reveal': '产品揭示 —— 直接亮出产品高光瞬间',
        'hook:lifestyle': '场景代入 —— 真实生活第一人称',
      },
      factorTaxonomy: {
        说明: 'factors 只能取以下 type:value，禁止自创；这是归因引擎的输入',
        ...FACTOR_TAXONOMY,
        约束: 'hook 仅第1镜；cta 仅最后一镜；proof 用在展示功能/效果的镜；bgm 全局基调可标注一次',
      },
      requiredSchema: {
        narrative: '一句话叙事框架，点明所用策略',
        visualStyle: '全局视觉风格',
        bgm: '配乐基调',
        aspectRatio: '9:16',
        language: 'zh-CN',
        shots: [
          {
            order: 1,
            duration: 3,
            visualDesc:
              '按「主体+动作+场景」写一句可直接拍摄的画面，适合视频生成模型；无任何文字/UI。各镜是同一商品、同一风格，但要换机位/景别展示商品的不同细节（特写质感→中景使用→第一人称代入等），不要每镜重复同一构图',
            camera: '镜头运动（中文，每镜尽量不同，如：缓慢推进特写/横移中景/环绕/第一人称跟随/手持轻晃）',
            narration: '口播旁白',
            subtitle: '字幕（<24字）',
            materialRef: '禁止填写；素材切片只做生成参考，最终视频只能由 Seedance 生成',
            transition: 'hard_cut | fade | whip（优先 hard_cut）',
            claimIds: ['使用到的 approvedClaims id'],
            factors: [{ type: 'hook', value: 'question', sourceStrategy: 'doubao' }],
          },
        ],
        constraints: ['总时长不超过15秒', '不得使用绝对化承诺', '素材必须有来源声明'],
      },
      fewShotExample: {
        order: 1,
        duration: 3,
        visualDesc: '清晨卧室，女生对着镜子皱眉揉搓泛红的脸颊，手部特写带到一支未露出文字的喷雾瓶',
        camera: '缓慢推进',
        narration: '一到夏天脸就晒得发烫发红？',
        subtitle: '夏天脸总是又烫又红',
        transition: 'hard_cut',
        claimIds: [],
        factors: [{ type: 'hook', value: 'question', sourceStrategy: 'doubao' }],
      },
      hardRules: [
        '只输出 JSON，不要 Markdown 包裹，不要解释性文字',
        'shots 数量恰好 3 个，每个 duration=5 秒，总和=15 秒；禁止 duration 小于 5',
        '第 1 镜必带一个 hook 因子；最后一镜必带一个 cta 因子',
        '每个 shot 的 factors 必须全部取自 factorTaxonomy 枚举，不得自创',
        '素材切片只能作为生成参考，禁止填写 materialRef，禁止要求裁切或混剪素材片段；每个分镜都必须写成 Seedance 可生成的原创画面',
        'visualDesc 按「主体+动作+场景」写，只描述可见画面和动作，不要写后期字幕、价格、优惠券、说明文字或电商详情页 UI',
        '所有 shot.materialRef 必须为空；最终成片不得直接使用任何素材库视频切片',
        '连贯性：整片是同一个商品、同一套视觉风格与光线，但分镜之间是干净切镜——每镜换一个机位/景别展示商品不同细节，既不要把相邻两镜画面焊在一起，也不要每镜另起一个互不相干的场景或重复同一构图',
        '需要信息卡时只描述无字卡片、无字图标或留白区域，禁止生成可读文字',
        'transition 只能是 hard_cut、fade、whip，优先用 hard_cut 保持短视频节奏',
        '表达必须合规，不写最/第一/唯一/100%/根治等绝对化承诺',
        params.approvedClaims && params.approvedClaims.length > 0
          ? '只能使用 approvedClaims 中列出的卖点；用到卖点的 shot 必须在 claimIds 写对应 id'
          : '没有 approved claim 时禁止编造参数、功效、排名、承诺类卖点',
      ],
      selfCheck: [
        '恰好 3 个 shot 且每镜 duration=5、Σduration=15',
        '第1镜有 hook 因子、最后一镜有 cta 因子',
        '用到的卖点都在 approvedClaims 内并写进了 claimIds',
        '所有 factors 取自枚举',
        'visualDesc 用「主体+动作+场景」结构、无任何文字/价格/UI',
        '没有任何 shot 使用 materialRef',
        '各镜同一商品/同一风格但机位景别各不相同，整体观感统一连贯',
        '仅输出 JSON',
      ],
    },
    null,
    2,
  );
}

function normalizeShots(raw: unknown, productLabel: string): ProductionShotInput[] {
  const arr = safeArray<Record<string, unknown>>(raw);
  if (!arr.length) return [];

  const normalized = arr.slice(0, 5).map((shot, index) => ({
    id: makeId('shot'),
    order: Number(shot.order) || index + 1,
    duration: clamp(Number(shot.duration) || 3, 3, 5),
    visualDesc: readText(shot.visualDesc, `${productLabel} 商品展示`),
    camera: readText(shot.camera, '固定'),
    narration: readText(shot.narration, '展示产品特点'),
    subtitle: readText(shot.subtitle, `${productLabel}`).slice(0, 24),
    materialRef: undefined,
    transition: (['hard_cut', 'fade', 'whip'] as const).includes(shot.transition as 'hard_cut' | 'fade' | 'whip')
      ? (shot.transition as 'hard_cut' | 'fade' | 'whip')
      : 'fade',
    factors: (() => {
      // 因子白名单：只保留落在 FACTOR_TAXONOMY 枚举内的因子，保证回流数据干净
      const valid = safeArray<ProductionFactor>(shot.factors).filter(
        (f) =>
          typeof f?.type === 'string' && typeof f?.value === 'string' && FACTOR_TAXONOMY[f.type]?.includes(f.value),
      );
      if (valid.length) {
        return valid.map((f) => ({ ...f, sourceStrategy: f.sourceStrategy || 'doubao' }));
      }
      // 兜底：首镜给 hook，其余给 camera:static，至少有一个合法因子供归因
      return index === 0
        ? [{ type: 'hook', value: 'product_reveal', sourceStrategy: 'doubao' }]
        : [{ type: 'camera', value: 'static', sourceStrategy: 'doubao' }];
    })(),
    status: 'draft' as const,
    claimIds: safeArray<string>(shot.claimIds),
    evidenceIds: [],
  }));
  return normalizeDurationBudget(normalized);
}

export async function generateDoubaoScript(params: {
  productId: string;
  mode: 'imitate' | 'template' | 'auto';
  freePrompt?: string;
  materialSlices: DoubaoMaterialSlice[];
  topFactors: string[];
  avoidFactors?: string[];
  materialIds: string[];
  referenceImageUrl?: string;
  approvedClaims?: Array<{ id: string; text: string; evidenceIds: string[] }>;
  evidence?: Array<{ id: string; text?: string; sourceTitle?: string; sourceUrl?: string }>;
  hotVideoDna?: unknown;
  goal?: string;
}): Promise<ProductionScriptInput> {
  const arkApiKey = envValue('ARK_API_KEY')!;
  const modelId = (envValue('ARK_TEXT_MODEL_ID') || envValue('ARK_MODEL_ID'))!;
  const baseUrl = (envValue('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');

  const prompt = buildPrompt({
    productId: params.productId,
    mode: params.mode,
    freePrompt: params.freePrompt,
    materialSlices: params.materialSlices,
    topFactors: params.topFactors,
    avoidFactors: params.avoidFactors,
    approvedClaims: params.approvedClaims,
    evidence: params.evidence,
    hotVideoDna: params.hotVideoDna,
    goal: params.goal,
  });

  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model: modelId,
      messages: [
        {
          role: 'system',
          content: [
            '你是「Proveo」的首席电商短视频编导，同时是 TikTok Shop / 抖音电商的爆款操盘手与增长分析师。',
            '你的片子必须同时满足两件事：前 3 秒抓住人，且每个卖点都有据可查。',
            '',
            '【工作方法 · 严格三步】',
            '1. 找参考：先读完检索到的同类目爆款 DNA，判断它们"为什么能火"。',
            '2. 提炼方法论：拆成「策略」（抽象打法，如"第一人称场景沉浸+痛点开场"）与「因子」（可量化手段，如 开场=痛点提问、镜头=推进、证据=功能演示、收尾=利益点CTA）。',
            '3. 生产剧本：用 策略 + 因子 + 商品信息 + 约束，组合出一条 ≤15 秒、可直接渲染的结构化分镜。',
            '',
            '【职业底线 · 不可违反】',
            '- 只说能被证实的话：仅可使用 approvedClaims 中的卖点；无 claim 支撑的功效、参数、排名、承诺一律不写。',
            '- 不写绝对化表达：最/第一/唯一/100%/根治/永久治愈 等一律禁止。',
            '- 画面描述只写"镜头里看得见的画面与动作"，绝不写屏幕文字、字幕、价格、优惠券、logo、详情页或任何 UI。',
            '- 每个分镜都必须标注结构化「因子」，且因子只能取用户给定的枚举值（用于回流归因，不可自创）。',
            '- 整片观感要连贯统一（同一商品、同一视觉风格与光线调色、同一节奏），但分镜之间是干净的切镜：刻意换机位、换景别去展示商品的不同细节，而不是把相邻两镜的画面焊在一起或重复同一构图。',
            '',
            '输出：严格 JSON，符合用户给定 schema；不要 Markdown 代码块，不要任何解释性文字。',
          ].join('\n'),
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.78,
      max_tokens: 2400,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${arkApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.ARK_TIMEOUT_MS || 90_000),
    },
  );

  const content = readText(response.data?.choices?.[0]?.message?.content);
  if (!content) throw new Error('Doubao 未返回内容');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Doubao 返回内容无法解析为 JSON');
    parsed = JSON.parse(match[0]);
  }

  const productLabel = params.freePrompt || params.productId;
  const shots = normalizeShots(parsed.shots, productLabel);
  if (!shots.length) throw new Error('Doubao 返回 shots 为空');

  return {
    id: makeId('script'),
    productId: params.productId,
    referenceImageUrl: params.referenceImageUrl,
    materialIds: params.materialIds,
    sourceMode: params.mode,
    narrative: readText(parsed.narrative, `${productLabel} 带货剧本`),
    visualStyle: readText(parsed.visualStyle, '清爽高质感'),
    bgm: readText(parsed.bgm, '轻快电子'),
    aspectRatio: parsed.aspectRatio === '16:9' ? '16:9' : '9:16',
    language: 'zh-CN',
    constraints: safeArray<string>(parsed.constraints).length
      ? safeArray<string>(parsed.constraints)
      : ['总时长不超过15秒', '素材必须有来源声明', '不得使用绝对化承诺'],
    shots,
  };
}
