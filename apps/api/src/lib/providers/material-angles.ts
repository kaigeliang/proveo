import axios from 'axios';
import type { MaterialAngle, MaterialAngleView } from '@aigc-video-hub/shared';

export type MaterialAnglePose = NonNullable<MaterialAngle['pose']>;

export type MaterialAngleSpec = {
  key: string;
  view: MaterialAngleView;
  label: string;
  promptHint: string;
  pose?: MaterialAnglePose;
};

export type QwenAngleImageInput = {
  sourceImageUrl: string;
  spec: MaterialAngleSpec;
  productName?: string;
  timeoutMs?: number;
};

export type QwenAngleImageResult = {
  imageUrl: string;
  raw: unknown;
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

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => deepStrings(item));
  if (value && typeof value === 'object') return Object.values(value).flatMap((item) => deepStrings(item));
  return [];
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

export async function generateQwenAngleImage(input: QwenAngleImageInput): Promise<QwenAngleImageResult> {
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
