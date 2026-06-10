/**
 * CLIP 向量化（jina-clip-v2，多语言 + 图片，1024 维）
 *
 * 文字和图片共享同一向量空间，可直接做跨模态余弦相似度比较。
 * 若可选依赖 @huggingface/transformers 可用，首次调用时会从 HuggingFace Hub 下载模型。
 * 依赖或模型不可用时直接抛错，避免生产检索静默退化为伪向量。
 */
import path from 'path';
import { localPathExists } from './providers/files';

export const CLIP_MODEL_ID = 'jinaai/jina-clip-v2';
export const EMBEDDING_DIMS = 1024;
const TEXT_MAX_TOKENS = Number(process.env.CLIP_TEXT_MAX_TOKENS || 512);

type TensorLike = { data: ArrayLike<number> };
type CallableModel = (inputs: Record<string, unknown>) => Promise<{
  l2norm_text_embeddings?: TensorLike;
  l2norm_image_embeddings?: TensorLike;
}>;
type Processor = (
  text?: string[] | string | null,
  images?: unknown[] | unknown | null,
  options?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type RawImageRuntime = {
  read?(input: string): Promise<unknown>;
  fromURL(url: string): Promise<unknown>;
};
type TransformersRuntime = {
  AutoModel: {
    from_pretrained(modelId: string, options: Record<string, unknown>): Promise<CallableModel>;
  };
  AutoProcessor: { from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<Processor> };
  RawImage: RawImageRuntime;
  env: { cacheDir?: string; allowRemoteModels?: boolean };
};
type OptionalImport = (specifier: string) => Promise<unknown>;
const optionalImport = new Function('specifier', 'return import(specifier)') as OptionalImport;

let runtime: TransformersRuntime | null = null;
let model: CallableModel | null = null;
let processor: Processor | null = null;
let modelReady = false;
let loadError: string | null = null;
let loadPromise: Promise<boolean> | null = null;

function envBool(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function repoRootFromCwd() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'api' && path.basename(path.dirname(cwd)) === 'apps'
    ? path.dirname(path.dirname(cwd))
    : cwd;
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
  const modelDir = path.join(cacheDir, CLIP_MODEL_ID);
  return [
    'config.json',
    'preprocessor_config.json',
    'tokenizer_config.json',
    'tokenizer.json',
    'onnx/model_quantized.onnx',
  ].every((file) => localPathExists(path.join(modelDir, file)));
}

function resolveClipCacheDir() {
  const candidates = [...new Set(clipCacheCandidates())];
  return candidates.find(hasCompleteClipCache) || candidates[0] || path.join(repoRootFromCwd(), '.cache/hf');
}

async function loadRuntime(): Promise<TransformersRuntime | null> {
  if (runtime) return runtime;
  try {
    runtime = (await optionalImport('@huggingface/transformers')) as TransformersRuntime;
    runtime.env.cacheDir = resolveClipCacheDir();
    runtime.env.allowRemoteModels = !envBool('CLIP_LOCAL_FILES_ONLY', hasCompleteClipCache(runtime.env.cacheDir));
    return runtime;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

async function loadModels(): Promise<boolean> {
  if (modelReady) return true;
  if (loadError) return false;
  const transformers = await loadRuntime();
  if (!transformers) return false;
  try {
    console.log(`[clip] 加载 ${CLIP_MODEL_ID}（首次需下载模型文件）...`);
    const cacheDir = resolveClipCacheDir();
    const localFilesOnly = envBool('CLIP_LOCAL_FILES_ONLY', hasCompleteClipCache(cacheDir));
    if (runtime) {
      runtime.env.cacheDir = cacheDir;
      runtime.env.allowRemoteModels = !localFilesOnly;
    }
    [model, processor] = await Promise.all([
      transformers.AutoModel.from_pretrained(CLIP_MODEL_ID, {
        dtype: 'q8',
        cache_dir: cacheDir,
        local_files_only: localFilesOnly,
      }),
      transformers.AutoProcessor.from_pretrained(CLIP_MODEL_ID, {
        cache_dir: cacheDir,
        local_files_only: localFilesOnly,
      }),
    ]);
    modelReady = true;
    console.log(`[clip] 模型就绪，支持多语言 + 图片，${EMBEDDING_DIMS} 维。`);
    return true;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

function ensureLoaded(): Promise<boolean> {
  if (!loadPromise) loadPromise = loadModels();
  return loadPromise;
}

function l2normalize(data: ArrayLike<number>): number[] {
  const arr = Array.from(data);
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? arr : arr.map((x) => x / norm);
}

function tensorToVector(tensor: TensorLike | undefined, label: string): number[] {
  if (!tensor?.data?.length) throw new Error(`${label} embedding missing from ${CLIP_MODEL_ID} output`);
  return l2normalize(tensor.data);
}

const SUPPORTED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

export function isEmbeddableImage(filePath: string): boolean {
  return SUPPORTED_IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

/** 文字 → 1024 维真实向量（多语言）。模型不可用时抛错。 */
export async function embedText(text: string): Promise<number[]> {
  return embedTextStrict(text);
}

/** 文字 → 1024 维真实向量；模型不可用时抛错。 */
export async function embedTextStrict(text: string): Promise<number[]> {
  if (!(await ensureLoaded())) {
    throw new Error(`${CLIP_MODEL_ID} is unavailable: ${loadError || 'model was not loaded'}`);
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  const inputs = await processor!([normalized], null, {
    padding: true,
    truncation: true,
    max_length: TEXT_MAX_TOKENS,
  });
  const output = await model!(inputs);
  return tensorToVector(output.l2norm_text_embeddings, 'text');
}

/**
 * 图片 → 1024 维向量（与 embedText 同一向量空间，可直接比余弦相似度）
 * imageSource: 本地绝对路径 | /uploads/... 服务器相对路径 | data:... | https://...
 * publicDir: 服务器静态根，用于解析 /uploads/... 路径
 */
export async function embedImage(imageSource: string, publicDir?: string): Promise<number[]> {
  if (!(await ensureLoaded())) {
    throw new Error(`${CLIP_MODEL_ID} is unavailable: ${loadError || 'model was not loaded'}`);
  }
  let image: unknown;
  if (imageSource.startsWith('data:')) {
    image = runtime!.RawImage.read
      ? await runtime!.RawImage.read(imageSource)
      : await runtime!.RawImage.fromURL(imageSource);
  } else if (/^https?:\/\//i.test(imageSource)) {
    image = runtime!.RawImage.read
      ? await runtime!.RawImage.read(imageSource)
      : await runtime!.RawImage.fromURL(imageSource);
  } else {
    // 本地路径：/uploads/... 或绝对路径
    let absPath = imageSource;
    if (imageSource.startsWith('/uploads/') && publicDir) {
      absPath = path.join(publicDir, imageSource.replace(/^\//, ''));
    }
    if (!localPathExists(absPath)) {
      throw new Error(`Image source does not exist: ${imageSource}`);
    }
    if (!isEmbeddableImage(absPath)) {
      throw new Error(`Image source is not embeddable by ${CLIP_MODEL_ID}: ${imageSource}`);
    }
    const fileUrl = `file://${absPath}`;
    image = runtime!.RawImage.read ? await runtime!.RawImage.read(fileUrl) : await runtime!.RawImage.fromURL(fileUrl);
  }
  const inputs = await processor!(null, [image]);
  const output = await model!(inputs);
  return tensorToVector(output.l2norm_image_embeddings, 'image');
}

/** 非阻塞预加载（服务启动后在后台拉取模型，不影响冷启动速度） */
export function warmup(): void {
  void ensureLoaded();
}
