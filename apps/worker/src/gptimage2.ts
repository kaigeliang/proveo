import axios from 'axios';

export type GptImage2ProductReferenceInput = {
  productLabel: string;
  visualDesc: string;
  camera?: string;
  narration?: string;
  subtitle?: string;
  aspectRatio: '9:16' | '16:9';
  shotOrder?: number;
  referenceAnglePrompt?: string;
  timeoutMs?: number;
};

export type GptImage2ProductReferenceResult = {
  imageUrl: string;
  provider: 'gptimage2';
  raw: unknown;
};

export type GptImage2ContinuousLastFrameInput = GptImage2ProductReferenceInput & {
  firstFrameImageUrl: string;
  motionGoal?: string;
};

function envValue(name: string): string {
  return (process.env[name] || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function apiKey() {
  return envValue('GPTIMAGE2_API_KEY') || envValue('OPENAI_API_KEY');
}

function apiStyle(): 'images' | 'responses' {
  return envValue('GPTIMAGE2_API_STYLE').toLowerCase() === 'responses' ? 'responses' : 'images';
}

function endpoint() {
  return endpointForStyle(apiStyle());
}

function endpointForStyle(style: 'images' | 'responses') {
  const configured = envValue('GPTIMAGE2_BASE_URL');
  const path = style === 'responses' ? '/responses' : '/images/generations';
  if (!configured) return `https://api.openai.com/v1${path}`;
  const base = configured.replace(/\/$/, '');
  if (/\/(responses|images\/generations)$/i.test(base)) return base;
  return `${base}${path}`;
}

function modelId() {
  return envValue('GPTIMAGE2_MODEL_ID') || 'gpt-image-2';
}

function timeoutMs(value?: number) {
  return value ?? Number(process.env.GPTIMAGE2_TIMEOUT_MS || 120_000);
}

function imageSize(aspectRatio: '9:16' | '16:9') {
  const configured = envValue('GPTIMAGE2_SIZE');
  if (configured) return configured;
  return aspectRatio === '16:9' ? '1536x1024' : '1024x1536';
}

function optionalImageParams() {
  return {
    ...(envValue('GPTIMAGE2_QUALITY') ? { quality: envValue('GPTIMAGE2_QUALITY') } : {}),
    ...(envValue('GPTIMAGE2_BACKGROUND') ? { background: envValue('GPTIMAGE2_BACKGROUND') } : {}),
    ...(envValue('GPTIMAGE2_OUTPUT_FORMAT') ? { output_format: envValue('GPTIMAGE2_OUTPUT_FORMAT') } : {}),
  };
}

export function isGptImage2Configured() {
  const mode = envValue('GPTIMAGE2_PROVIDER').toLowerCase();
  return Boolean(apiKey() && mode !== 'local' && mode !== 'off' && mode !== 'false');
}

export function buildGptImage2ProductPrompt(input: GptImage2ProductReferenceInput) {
  const product = input.productLabel || '电商商品';
  return [
    'Create one photorealistic product reference image for a short e-commerce video I2V pipeline.',
    `Product: ${product}`,
    input.shotOrder ? `Shot: ${input.shotOrder}` : '',
    `Aspect ratio: ${input.aspectRatio}.`,
    `Scene and action: ${input.visualDesc}`,
    input.camera ? `Camera cue: ${input.camera}` : '',
    input.referenceAnglePrompt ? `Required product angle: ${input.referenceAnglePrompt}` : '',
    input.subtitle ? `Post-production subtitle meaning, do not render as text: ${input.subtitle}` : '',
    input.narration ? `Voiceover meaning, do not render as text: ${input.narration}` : '',
    [
      'Composition: subject + action + scene. The product is the clear main subject, fully visible, centered slightly above the middle.',
      'Use a realistic commerce/lifestyle setting with natural lighting, real materials, and plausible scale — shot like a candid phone-camera keyframe, not an ad layout.',
      'If no merchant product photo is available, infer a credible product appearance from the product name and scene; never generate an empty scene, generic abstract object, poster, package mockup, or text card.',
      'Do not render readable text, subtitles, prices, coupons, UI screens, watermarks, QR codes, storefront signs, or fake brand logos.',
      'Keep the lower 20% clean for later subtitles.',
      'This image is the FIRST FRAME handed directly to a video model, so it must read as one clean, in-motion video keyframe.',
    ].join(' '),
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildGptImage2ContinuousLastFramePrompt(input: GptImage2ContinuousLastFrameInput) {
  const product = input.productLabel || '电商商品';
  return [
    'Use the input image as the FIRST FRAME of one single continuous e-commerce video shot.',
    'Generate the LAST FRAME only.',
    `Product: ${product}`,
    input.shotOrder ? `Shot: ${input.shotOrder}` : '',
    `Aspect ratio: ${input.aspectRatio}.`,
    `Current first-frame scene: ${input.visualDesc}`,
    input.camera ? `Camera cue: ${input.camera}` : '',
    input.motionGoal ? `Continuous motion goal: ${input.motionGoal}` : '',
    input.subtitle ? `Post-production subtitle meaning, do not render as text: ${input.subtitle}` : '',
    input.narration ? `Voiceover meaning, do not render as text: ${input.narration}` : '',
    [
      'Keep the exact same product identity, object count, scene, camera position, lens, scale, lighting, color palette, and composition.',
      'Only make a tiny plausible change that could happen 2-3 seconds later in the same shot, such as the hand finishing an adjustment or the product settling into place.',
      'Do not cut to a new angle, do not change the room, do not redesign the product, do not add new props, and do not make a poster or product-detail page.',
      'Do not render readable text, subtitles, prices, coupons, UI screens, watermarks, QR codes, storefront signs, or fake brand logos.',
      'Keep the lower 20% clean for later subtitles.',
    ].join(' '),
  ]
    .filter(Boolean)
    .join('\n');
}

function isLikelyBase64Image(value: string, key = '') {
  const normalized = value.trim();
  if (normalized.length < 160) return false;
  if (/\s/.test(normalized)) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(normalized)) return false;
  return /b64|base64|image|result|data/i.test(key) || normalized.length > 700;
}

function deepImageStrings(value: unknown, key = ''): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(text)) return [text];
    if (/^https?:\/\//i.test(text)) return [text];
    if (isLikelyBase64Image(text, key)) return [`data:image/png;base64,${text}`];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => deepImageStrings(item, key));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([childKey, item]) =>
      deepImageStrings(item, childKey),
    );
  }
  return [];
}

function requestBody(prompt: string, aspectRatio: '9:16' | '16:9', includeResponseFormat = true) {
  const size = imageSize(aspectRatio);
  if (apiStyle() === 'responses') {
    return {
      model: modelId(),
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
      tools: [{ type: 'image_generation', size }],
      ...optionalImageParams(),
    };
  }

  return {
    model: modelId(),
    prompt,
    n: 1,
    size,
    ...optionalImageParams(),
    ...(includeResponseFormat && envValue('GPTIMAGE2_RESPONSE_FORMAT')
      ? { response_format: envValue('GPTIMAGE2_RESPONSE_FORMAT') }
      : {}),
  };
}

function responsesImageInputBody(input: GptImage2ContinuousLastFrameInput) {
  return {
    model: modelId(),
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: buildGptImage2ContinuousLastFramePrompt(input) },
          { type: 'input_image', image_url: input.firstFrameImageUrl },
        ],
      },
    ],
    tools: [{ type: 'image_generation', size: imageSize(input.aspectRatio) }],
    ...optionalImageParams(),
  };
}

export async function generateGptImage2ProductReference(
  input: GptImage2ProductReferenceInput,
): Promise<GptImage2ProductReferenceResult> {
  const key = apiKey();
  if (!key) throw new Error('GPTImage2 provider is not configured');

  const prompt = buildGptImage2ProductPrompt(input);
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  const requestOptions = { timeout: timeoutMs(input.timeoutMs), headers };

  let response;
  try {
    response = await axios.post(endpoint(), requestBody(prompt, input.aspectRatio), requestOptions);
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const shouldRetryWithoutOptionalParams =
      apiStyle() === 'images' && (status === 400 || status === 415 || status === 422);
    if (!shouldRetryWithoutOptionalParams) throw error;
    response = await axios.post(
      endpoint(),
      {
        model: modelId(),
        prompt,
        n: 1,
        size: imageSize(input.aspectRatio),
      },
      requestOptions,
    );
  }

  const imageUrl = deepImageStrings(response.data)[0];
  if (!imageUrl) throw new Error('GPTImage2 returned no usable image URL or base64 image');
  return { imageUrl, provider: 'gptimage2', raw: response.data };
}

export async function generateGptImage2ContinuousLastFrame(
  input: GptImage2ContinuousLastFrameInput,
): Promise<GptImage2ProductReferenceResult> {
  const key = apiKey();
  if (!key) throw new Error('GPTImage2 provider is not configured');
  if (!input.firstFrameImageUrl) throw new Error('firstFrameImageUrl is required');

  const response = await axios.post(endpointForStyle('responses'), responsesImageInputBody(input), {
    timeout: timeoutMs(input.timeoutMs),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });

  const imageUrl = deepImageStrings(response.data)[0];
  if (!imageUrl) throw new Error('GPTImage2 returned no usable continuous last-frame image');
  return { imageUrl, provider: 'gptimage2', raw: response.data };
}

export function safeGptImage2Error(error: unknown) {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') return 'GPTImage2 请求超时';
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    return status ? `GPTImage2 HTTP ${status}${statusText ? ` ${statusText}` : ''}` : error.message;
  }
  return error instanceof Error ? error.message.slice(0, 180) : 'GPTImage2 调用失败';
}
