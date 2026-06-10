import axios from 'axios';

export type MaterialAnglePose = {
  azimuthDeg: number;
  elevationDeg: number;
  distanceLevel: number;
  azimuth: string;
  elevation: string;
  distance: string;
  qwenPrompt: string;
};

export type MaterialAngleSpec = {
  key: string;
  view: 'front' | 'left_30' | 'right_30' | 'top_15' | 'detail' | 'custom';
  label: string;
  promptHint: string;
  pose?: MaterialAnglePose;
};

type CustomAngleInput = {
  label?: unknown;
  promptHint?: unknown;
  azimuthDeg?: unknown;
  elevationDeg?: unknown;
  distanceLevel?: unknown;
};

type QwenAngleImageInput = {
  sourceImageUrl: string;
  spec: MaterialAngleSpec;
  productName?: string | null;
  timeoutMs?: number;
};

const AZIMUTH_MAP = [
  { deg: 0, text: 'front view' },
  { deg: 45, text: 'front-right quarter view' },
  { deg: 90, text: 'right side view' },
  { deg: 135, text: 'back-right quarter view' },
  { deg: 180, text: 'back view' },
  { deg: 225, text: 'back-left quarter view' },
  { deg: 270, text: 'left side view' },
  { deg: 315, text: 'front-left quarter view' },
];

export const MATERIAL_ANGLE_SPECS: MaterialAngleSpec[] = [
  {
    key: 'front',
    view: 'front',
    label: '正面',
    promptHint: '保持商品身份、材质、Logo 与比例一致，生成干净的正面商品角度。',
  },
  {
    key: 'left_30',
    view: 'left_30',
    label: '左 30°',
    promptHint: '保持商品身份、材质、Logo 与比例一致，生成左侧约 30 度的商品角度。',
  },
  {
    key: 'right_30',
    view: 'right_30',
    label: '右 30°',
    promptHint: '保持商品身份、材质、Logo 与比例一致，生成右侧约 30 度的商品角度。',
  },
  {
    key: 'top_15',
    view: 'top_15',
    label: '俯视 15°',
    promptHint: '保持商品身份、材质、Logo 与比例一致，生成轻微俯视约 15 度的商品角度。',
  },
  {
    key: 'detail',
    view: 'detail',
    label: '细节特写',
    promptHint: '保持商品身份、材质、Logo 与比例一致，生成适合短视频开场的关键细节特写。',
  },
];

export function sanitizeAngleKey(value: string) {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 72) || 'angle'
  );
}

export function escapeXml(value: unknown) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function readText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envValue(name: string): string {
  return (process.env[name] || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function apiKey() {
  return envValue('QWEN_IMAGE_API_KEY') || envValue('DASHSCOPE_API_KEY');
}

function endpoint() {
  return (
    envValue('QWEN_IMAGE_BASE_URL') ||
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
  );
}

function modelId() {
  return envValue('QWEN_IMAGE_MODEL_ID') || 'qwen-image-2.0-pro';
}

function timeoutMs(value?: number) {
  return value ?? Number(process.env.QWEN_IMAGE_TIMEOUT_MS || 120_000);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function nearest(value: number, step: number) {
  return Math.round(value / step) * step;
}

function azimuthText(deg: number) {
  const normalized = ((nearest(deg, 45) % 360) + 360) % 360;
  return AZIMUTH_MAP.find((item) => item.deg === normalized)?.text || 'front view';
}

function elevationText(deg: number) {
  if (deg <= -20) return 'low-angle shot';
  if (deg >= 35) return 'high-angle shot';
  if (deg >= 15) return 'elevated shot';
  return 'eye-level shot';
}

function distanceText(level: number) {
  if (level <= 3) return 'wide shot';
  if (level >= 8) return 'close-up';
  return 'medium shot';
}

export function normalizeQwenMultiAnglePose(input: {
  azimuthDeg?: unknown;
  elevationDeg?: unknown;
  distanceLevel?: unknown;
}): MaterialAnglePose {
  const azimuthDeg = ((nearest(clampNumber(input.azimuthDeg, 0, 359, 45), 45) % 360) + 360) % 360;
  const elevationDeg = nearest(clampNumber(input.elevationDeg, -30, 60, 0), 15);
  const distanceLevel = nearest(clampNumber(input.distanceLevel, 0, 10, 5), 1);
  const azimuth = azimuthText(azimuthDeg);
  const elevation = elevationText(elevationDeg);
  const distance = distanceText(distanceLevel);
  return {
    azimuthDeg,
    elevationDeg,
    distanceLevel,
    azimuth,
    elevation,
    distance,
    qwenPrompt: `<sks> ${azimuth} ${elevation} ${distance}`,
  };
}

export function normalizeCustomAngleSpecs(value: unknown): MaterialAngleSpec[] {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row, index): MaterialAngleSpec | undefined => {
      const item = row && typeof row === 'object' ? (row as CustomAngleInput) : {};
      const label = readText(item.label).slice(0, 24);
      const promptHint = readText(item.promptHint).slice(0, 260);
      if (!label || !promptHint) return undefined;
      const pose =
        item.azimuthDeg !== undefined || item.elevationDeg !== undefined || item.distanceLevel !== undefined
          ? normalizeQwenMultiAnglePose(item)
          : undefined;
      const poseSlug = pose ? `_${pose.azimuthDeg}_${pose.elevationDeg}_${pose.distanceLevel}` : '';
      return {
        key: `custom_${sanitizeAngleKey(label) || index + 1}${poseSlug}`,
        view: 'custom',
        label,
        promptHint,
        pose,
      };
    })
    .filter((spec): spec is MaterialAngleSpec => Boolean(spec));
}

export function isQwenAngleProviderConfigured() {
  return Boolean(apiKey() && envValue('QWEN_IMAGE_PROVIDER').toLowerCase() !== 'local');
}

export function buildQwenAnglePrompt(input: QwenAngleImageInput) {
  const product = input.productName ? `商品名称：${input.productName}。` : '';
  const multiAnglePrompt = input.spec.pose?.qwenPrompt;
  return [
    multiAnglePrompt,
    product,
    input.spec.promptHint,
    input.spec.pose
      ? `相机姿态：水平 ${input.spec.pose.azimuthDeg}°，俯仰 ${input.spec.pose.elevationDeg}°，距离 ${input.spec.pose.distanceLevel}/10。`
      : '',
    '只改变观察角度和构图，不改变商品类别、品牌元素、文字、颜色和数量。',
    '背景保持简洁电商棚拍风格，画面主体完整，适合作为图生视频参考图。',
  ]
    .filter(Boolean)
    .join('\n');
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => deepStrings(item));
  if (value && typeof value === 'object') return Object.values(value).flatMap((item) => deepStrings(item));
  return [];
}

export async function generateQwenAngleImage(input: QwenAngleImageInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = apiKey();
  if (!key) throw new Error('Qwen image provider is not configured');

  const response = await axios.post(
    endpoint(),
    {
      model: modelId(),
      input: {
        messages: [
          {
            role: 'user',
            content: [{ image: input.sourceImageUrl }, { text: buildQwenAnglePrompt(input) }],
          },
        ],
      },
      parameters: {
        n: 1,
        size: '1024*1024',
      },
    },
    {
      timeout: timeoutMs(input.timeoutMs),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const imageUrl = deepStrings(response.data)
    .filter((item) => /^(data:image\/|https?:\/\/)/i.test(item))
    .find((item) => item !== input.sourceImageUrl);
  if (!imageUrl) throw new Error('Qwen image provider returned no usable image URL');
  return { imageUrl, raw: response.data };
}

export function imageExtension(contentType = '', fallbackUrl = '') {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('svg')) return 'svg';
  try {
    const ext = new URL(fallbackUrl).pathname.split('.').pop()?.toLowerCase();
    if (ext && ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  } catch {
    // Fall through to jpg.
  }
  return 'jpg';
}

export function buildLocalAngleSvg(input: { sourceUrl: string; spec: MaterialAngleSpec }) {
  const tilt: Record<string, string> = {
    front: 'rotate(0 480 460)',
    left_30: 'translate(-28 0) skewY(-4) rotate(-3 480 460)',
    right_30: 'translate(28 0) skewY(4) rotate(3 480 460)',
    top_15: 'translate(0 -18) scale(1 .9)',
    detail: 'scale(1.16) translate(-66 -54)',
    custom: 'translate(0 -8) scale(1.04)',
  };
  const pose = input.spec.pose;
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
        return `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${zoom.toFixed(2)}) skewY(${skew.toFixed(
          1,
        )}) scale(${scaleX.toFixed(2)} 1)`;
      })()
    : tilt[input.spec.key] || tilt[input.spec.view] || tilt.custom;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960" viewBox="0 0 960 960">
    <rect width="960" height="960" fill="#fafaf9"/>
    <rect x="86" y="86" width="788" height="788" rx="42" fill="#fff" stroke="#e5e5e5"/>
    <g transform="${poseTransform}">
      <image href="${escapeXml(input.sourceUrl)}" x="170" y="150" width="620" height="620" preserveAspectRatio="xMidYMid meet"/>
    </g>
    <rect x="86" y="768" width="788" height="106" rx="0" fill="#0a0a0a" opacity=".82"/>
    <text x="130" y="832" font-family="Arial, PingFang SC, sans-serif" font-size="34" font-weight="700" fill="#fff">${escapeXml(
      input.spec.label,
    )}</text>
    <text x="130" y="864" font-family="Arial, PingFang SC, sans-serif" font-size="18" fill="#d4d4d4">local angle fallback</text>
  </svg>`;
}

export function safeProviderError(error: unknown) {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') return '外部服务请求超时';
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    return status ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : error.message || '外部服务失败';
  }
  return error instanceof Error ? error.message.slice(0, 160) : '外部服务失败';
}
