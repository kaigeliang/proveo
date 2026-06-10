import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import {
  createAgentArtifact,
  createAgentStep,
  getAgentRun,
  getScript,
  getTask,
  updateAgentRun,
  updateAgentStep,
  updateTask,
  upsertMaterial,
  type AgentRunKind,
} from '@aigc-video-hub/db';
import { createStorageClient } from '@aigc-video-hub/storage';
import {
  createAgentRegistry,
  executeAgentGraph,
  planMastraAgentRunDispatch,
  type AgentGraph,
  type AgentNode,
  type AgentNodeResultStatus,
  type AgentNodeContext,
  type AgentRunRecord,
  type AgentLogger,
  type JsonMap,
} from '@aigc-video-hub/agent-runtime';
import { createWorkerTools, runRegisteredTool } from './agent-tools';
import { runResearchAgent, type ResearchSearchScope } from './research';
import { fetchProductPageAssets } from './product-page';
import { buildComposerSubtitlePlan } from './subtitles';

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function asRecord(value: unknown): JsonMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonMap) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readMode(value: unknown): 'imitate' | 'template' | 'auto' {
  return value === 'imitate' || value === 'template' || value === 'auto' ? value : 'auto';
}

function readScriptProvider(value: unknown): 'auto' | 'local' | 'doubao' {
  return value === 'local' || value === 'doubao' || value === 'auto' ? value : 'auto';
}

function readRetrievalMode(value: unknown): 'rag' | 'none' {
  return value === 'none' ? 'none' : 'rag';
}

function readRenderProvider(value: unknown): 'auto' | 'local' | 'seedance' {
  return value === 'local' || value === 'seedance' || value === 'auto' ? value : 'auto';
}

function readNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function textTokens(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function overlapScore(a: string, b: string) {
  const left = new Set(textTokens(a));
  const right = new Set(textTokens(b));
  if (!left.size || !right.size) return 0;
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) hits++;
  }
  return Number((hits / Math.max(1, left.size)).toFixed(4));
}

function stringArray(value: unknown) {
  return asArray(value)
    .map((item) => readString(item))
    .filter(Boolean);
}

function readBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function readSearchScopes(value: unknown): ResearchSearchScope[] | undefined {
  const scopes = stringArray(value).filter((scope): scope is ResearchSearchScope =>
    ['official', 'commerce', 'review', 'social'].includes(scope),
  );
  return scopes.length ? [...new Set(scopes)] : undefined;
}

const PRODUCT_LINK_SOURCE_DECLARATION = '商品链接自动抓取';
const PRODUCT_INGEST_MAX_IMAGES = 4;
const PRODUCT_INGEST_TOTAL_BUDGET_MS = 20_000;
const PRODUCT_INGEST_IMAGE_TIMEOUT_MS = 8_000;

let productIngestStorage: ReturnType<typeof createStorageClient> | undefined;

function getProductIngestStorage() {
  if (!productIngestStorage) productIngestStorage = createStorageClient();
  return productIngestStorage;
}

function stableProductMaterialId(productId: string, productUrl: string, imageUrl: string) {
  const hash = createHash('sha256').update(`${productId}\n${productUrl}\n${imageUrl}`).digest('hex').slice(0, 16);
  return `mat_link_${hash}`;
}

function contentTypeExtension(contentType: string, imageUrl: string) {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('avif')) return 'avif';
  const pathExt = new URL(imageUrl).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return pathExt && ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(pathExt) ? pathExt : 'jpg';
}

function safeExternalReason(error: unknown) {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') return '请求超时';
    return error.response?.status ? `HTTP ${error.response.status}` : error.message || '请求失败';
  }
  return error instanceof Error ? error.message : '未知错误';
}

async function traceProductIngest(taskId: string, message: string, data?: JsonMap) {
  if (!taskId) return;
  await updateTask(taskId, {
    trace: {
      step: 'product.ingest',
      progress: 24,
      message,
      data,
    },
  }).catch(() => undefined);
}

async function storeProductImageMaterial(input: {
  productId: string;
  productUrl: string;
  imageUrl: string;
  index: number;
  isPrimary: boolean;
  title?: string;
  deadlineMs: number;
  uploadedAt: Date;
}) {
  const remainingMs = input.deadlineMs - Date.now();
  if (remainingMs < 500) throw new Error('商品链接抓取预算已耗尽');
  const timeoutMs = Math.min(PRODUCT_INGEST_IMAGE_TIMEOUT_MS, Math.max(500, remainingMs));
  const response = await axios.get<ArrayBuffer>(input.imageUrl, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    maxContentLength: 10_000_000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: input.productUrl,
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const contentType = String(response.headers['content-type'] || 'image/jpeg')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`商品图响应不是图片：${contentType || 'unknown'}`);
  const body = Buffer.from(response.data);
  if (!body.length) throw new Error('商品图为空');

  const materialId = stableProductMaterialId(input.productId, input.productUrl, input.imageUrl);
  const extension = contentTypeExtension(contentType, input.imageUrl);
  const stored = await getProductIngestStorage().putObject({
    key: `materials/${materialId}.${extension}`,
    body,
    contentType,
  });
  const objectUrl = stored.url || (await getProductIngestStorage().getSignedUrl(stored.key, 86400 * 7));
  await upsertMaterial({
    id: materialId,
    productId: input.productId,
    name: `${input.title || input.productId} 商品链接${input.isPrimary ? '主图' : `图片 ${input.index + 1}`}`.slice(
      0,
      120,
    ),
    type: 'image',
    sourceUrl: input.productUrl,
    sourceObjectKey: stored.key,
    sourceDeclaration: PRODUCT_LINK_SOURCE_DECLARATION,
    uploadedAt: input.uploadedAt,
  });
  return {
    materialId,
    objectKey: stored.key,
    objectUrl,
    sourceImageUrl: input.imageUrl,
    contentType,
    byteLength: body.length,
  };
}

function signalIsCovered(signal: string, text: string) {
  const candidates = signal
    .split(/[\s、，,;/+|]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return candidates.some((candidate) => text.includes(candidate)) || overlapScore(signal, text) > 0;
}

function dnaCoverage(hotVideoDna: JsonMap, storyboard: JsonMap) {
  const shots = asArray(storyboard.shots).map((item) => asRecord(item));
  const scriptText = shots.map((shot) => `${readString(shot.renderPrompt)} ${readString(shot.narration)}`).join(' ');
  const concerns = asArray(hotVideoDna.commentInsights).map((item) => asRecord(item));
  const signals = [
    ...stringArray(hotVideoDna.structure),
    ...concerns.map((concern) => readString(concern.expectedShot)).filter(Boolean),
  ];
  const uniqueSignals = [...new Set(signals)];
  const coveredSignals = uniqueSignals.filter((signal) => signalIsCovered(signal, scriptText));
  const missingSignals = uniqueSignals.filter((signal) => !coveredSignals.includes(signal));
  const coverage = uniqueSignals.length ? coveredSignals.length / uniqueSignals.length : 1;
  return {
    sourceMode: readString(hotVideoDna.sourceMode, 'fallback_template'),
    signalCount: uniqueSignals.length,
    coveredSignals,
    missingSignals,
    coverage: Number(coverage.toFixed(4)),
  };
}

// Qwen-VL 拆解数据落在 breakdownReport.creativeFeature / qwenTruthSlice 里，
// 字段名和旧的 shots/hook/sellingPoints 不一样，这里统一抽取，优先用 Qwen 的真实拆解。
function qwenHookLabel(value: string): string {
  const map: Record<string, string> = {
    pain_point: '前三秒痛点式开场',
    product_demo: '产品演示式开场',
    before_after: '前后对比式开场',
    unboxing: '开箱揭示式开场',
    social_proof: '社交证明式开场',
    offer: '优惠利益式开场',
    lifestyle: '生活场景式开场',
  };
  return map[value] || '';
}
function extractQwenBreakdown(report: JsonMap) {
  const creative = asRecord(report.creativeFeature);
  const truth = asRecord(report.qwenTruthSlice);
  const stable = asRecord(truth.stableFactors);
  const hookType = readString(asRecord(stable.hook_type).value);
  const shots = [...stringArray(creative.shotStructure), ...stringArray(truth.shotStructure)];
  const sellingPoints = stringArray(creative.sellingPoints);
  const visualStyle = readString(asRecord(stable.visual_style).value);
  return {
    hook: hookType && hookType !== 'unknown' ? qwenHookLabel(hookType) : '',
    shots,
    sellingPoints,
    style: visualStyle && visualStyle !== 'unknown' ? visualStyle : '',
  };
}

function makeHotVideoDna(input: JsonMap, referenceContext: JsonMap) {
  const prompt = readString(input.freePrompt || input.ref || input.productId, '商品短视频');
  const tokens = textTokens(prompt);
  const references = asArray(referenceContext.references).map((item) => asRecord(item));
  const reports = references.map((reference) => asRecord(reference.breakdownReport));
  const selectedReport = reports[0] || {};
  const qwen = reports.map((report) => extractQwenBreakdown(report));
  const selectedQwen = qwen[0] || { hook: '', shots: [], sellingPoints: [], style: '' };
  const fallbackHook =
    tokens.some((token) => /痛点|问题|担心|顾虑/.test(token)) || prompt.includes('评论')
      ? '评论顾虑式开场'
      : '前三秒问题式开场';
  const referenceShots =
    selectedQwen.shots.length > 0
      ? selectedQwen.shots
      : asArray(selectedReport.shots)
          .map((item) => {
            const shot = asRecord(item);
            return readString(shot.description, readString(shot.role));
          })
          .filter(Boolean);
  const reportConcerns = asArray(selectedReport.commentInsights).map((item) => asRecord(item));
  const commentInsights = reportConcerns.length
    ? reportConcerns
    : [
        { concern: '是否适合真实场景', expectedShot: '使用场景演示' },
        { concern: '细节是否可信', expectedShot: '细节证据特写' },
        { concern: '是否适合自己', expectedShot: '适用人群说明' },
      ];
  const structure = referenceShots.length
    ? referenceShots
    : ['3 秒痛点/场景', '核心细节证据', '真实使用演示', '适用人群说明', '理性决策收束'];
  const hook = selectedQwen.hook || readString(selectedReport.hook, fallbackHook);
  const sellingPoints = [
    ...qwen.flatMap((item) => item.sellingPoints),
    ...reports.flatMap((report) => stringArray(report.sellingPoints)),
  ].slice(0, 8);
  const qwenStyle = qwen.find((item) => item.style)?.style;
  const hasQwenBreakdown = qwen.some((item) => item.hook || item.shots.length || item.sellingPoints.length);
  return {
    sourceMode: hasQwenBreakdown ? 'qwen_breakdown' : references.length ? 'reference_breakdown' : 'fallback_template',
    source: readString(input.ref, references.length ? readString(references[0].id) : 'auto_local_dna'),
    referenceIds: references.map((reference) => readString(reference.id)).filter(Boolean),
    sourceDeclarations: references.map((reference) => readString(reference.sourceDeclaration)).filter(Boolean),
    hook,
    style: qwenStyle || readString(selectedReport.style, '真实场景优先'),
    sellingPoints,
    structure,
    factors: [
      { type: 'hook', value: hook, weight: 0.24 },
      { type: 'visual_proof', value: sellingPoints[0] || '商品细节和真实素材优先', weight: 0.22 },
      { type: 'rhythm', value: readString(selectedReport.paceRhythm, '前快后稳，15 秒内完成'), weight: 0.18 },
      { type: 'comment_insight', value: prompt.includes('评论') ? '回应评论高频顾虑' : '补齐购买前疑问', weight: 0.2 },
      { type: 'safe_cta', value: '避免绝对化承诺，规格以页面为准', weight: 0.16 },
    ],
    commentInsights,
  };
}

function policyCheckClaims(claims: Array<{ id: string; text: string; evidenceIds: string[] }>) {
  const blockedPatterns = [/第一|最强|永久|100%|治愈|保证|绝对/];
  return claims.map((claim) => {
    const blocked = blockedPatterns.some((pattern) => pattern.test(claim.text));
    return {
      ...claim,
      status: blocked ? 'blocked' : claim.evidenceIds.length ? 'approved' : 'needs_evidence',
      policyHits: blocked ? [{ ruleId: 'absolute_claim', level: 'block', reason: '避免绝对化或功效承诺' }] : [],
    };
  });
}

async function ingestProductForScript(previous: JsonMap, taskId: string) {
  const productId = readString(previous.productId);
  const productUrl = readString(previous.productUrl);
  const existingReferenceImageUrl = readString(previous.referenceImageUrl);

  if (!productUrl) {
    const reason = '未提供商品链接，跳过链接抓取。';
    await traceProductIngest(taskId, reason, { productId, imageCount: 0 });
    return {
      output: {
        referenceImageUrl: existingReferenceImageUrl || undefined,
        productIngest: { status: 'skipped', imageCount: 0, reason },
      },
      decision: 'ingest_skipped',
      reason,
    };
  }

  if (!productId) {
    const reason = '缺少 productId，跳过链接素材入库。';
    await traceProductIngest(taskId, reason, { productUrl, imageCount: 0 });
    return {
      output: {
        referenceImageUrl: existingReferenceImageUrl || undefined,
        productIngest: { status: 'skipped', imageCount: 0, reason },
      },
      decision: 'ingest_skipped',
      reason,
    };
  }

  const deadlineMs = Date.now() + PRODUCT_INGEST_TOTAL_BUDGET_MS;
  try {
    const assets = await fetchProductPageAssets(productUrl);
    const images = assets.images.slice(0, PRODUCT_INGEST_MAX_IMAGES);
    if (!images.length) {
      const reason = '商品链接未解析到可用图片，跳过链接素材入库。';
      await traceProductIngest(taskId, reason, {
        productId,
        productUrl,
        title: assets.title,
        imageCount: 0,
      });
      return {
        output: {
          title: readString(previous.title) || assets.title,
          description: readString(previous.description) || assets.description,
          price: readString(previous.price) || assets.price,
          referenceImageUrl: existingReferenceImageUrl || undefined,
          productIngest: { status: 'skipped', imageCount: 0, reason, title: assets.title },
        },
        decision: 'ingest_skipped',
        reason,
      };
    }

    const startedAt = Date.now();
    const storedMaterials: Array<Awaited<ReturnType<typeof storeProductImageMaterial>>> = [];
    const failures: Array<{ imageUrl: string; reason: string }> = [];
    for (let index = 0; index < images.length; index++) {
      if (Date.now() >= deadlineMs) {
        failures.push({ imageUrl: images[index], reason: '商品链接抓取预算已耗尽' });
        break;
      }
      try {
        storedMaterials.push(
          await storeProductImageMaterial({
            productId,
            productUrl,
            imageUrl: images[index],
            index,
            isPrimary: index === 0,
            title: assets.title,
            deadlineMs,
            uploadedAt: new Date(startedAt + (index === 0 ? PRODUCT_INGEST_MAX_IMAGES : index)),
          }),
        );
      } catch (error) {
        failures.push({ imageUrl: images[index], reason: safeExternalReason(error) });
      }
    }

    if (!storedMaterials.length) {
      const reason = '商品链接图片下载或入库失败，已跳过并保留现有兜底路径。';
      await traceProductIngest(taskId, reason, {
        productId,
        productUrl,
        candidateCount: images.length,
        failures: failures.slice(0, 4),
      });
      return {
        output: {
          title: readString(previous.title) || assets.title,
          description: readString(previous.description) || assets.description,
          price: readString(previous.price) || assets.price,
          referenceImageUrl: existingReferenceImageUrl || undefined,
          productIngest: { status: 'skipped', imageCount: 0, reason, failures },
        },
        decision: 'ingest_skipped',
        reason,
      };
    }

    const primary = storedMaterials[0];
    const referenceImageUrl = existingReferenceImageUrl || primary.objectUrl;
    const message = `已从商品链接抓取 ${storedMaterials.length} 张商品图并入库（主图已设为渲染参考）。`;
    await traceProductIngest(taskId, message, {
      productId,
      productUrl,
      materialIds: storedMaterials.map((item) => item.materialId),
      primaryMaterialId: primary.materialId,
      title: assets.title,
      description: assets.description,
      price: assets.price,
      failedImageCount: failures.length,
    });

    return {
      output: {
        title: readString(previous.title) || assets.title,
        description: readString(previous.description) || assets.description,
        price: readString(previous.price) || assets.price,
        referenceImageUrl,
        ingestedPrimaryImageUrl: primary.objectUrl,
        ingestedMaterialIds: storedMaterials.map((item) => item.materialId),
        productIngest: {
          status: 'completed',
          imageCount: storedMaterials.length,
          materialIds: storedMaterials.map((item) => item.materialId),
          sourceDeclaration: PRODUCT_LINK_SOURCE_DECLARATION,
          failures,
        },
      },
      decision: 'product_ingested',
      reason: message,
    };
  } catch (error) {
    const reason = `商品链接抓取失败，已跳过并保留现有兜底路径：${safeExternalReason(error)}`;
    await traceProductIngest(taskId, reason, { productId, productUrl, imageCount: 0 });
    return {
      output: {
        referenceImageUrl: existingReferenceImageUrl || undefined,
        productIngest: { status: 'skipped', imageCount: 0, reason },
      },
      decision: 'ingest_skipped',
      reason,
    };
  }
}

function productIngestNode(): AgentNode {
  return {
    id: 'product.ingest',
    agentName: 'material',
    blocking: false,
    retry: { attempts: 1, backoffMs: 0 },
    async run(ctx) {
      const previous = asRecord(ctx.input.previous);
      const taskId = readString(ctx.run.taskId, ctx.run.id);
      const result = await ingestProductForScript(previous, taskId);
      return { status: 'completed', ...result };
    },
  };
}

function materialIndexNode(): AgentNode {
  return {
    id: 'material.index',
    agentName: 'material',
    blocking: false,
    retry: { attempts: 1, backoffMs: 0 },
    async run(ctx) {
      const previous = asRecord(ctx.input.previous);
      const productId = readString(previous.productId);
      const toolOutput = await runRegisteredTool(ctx, 'db.list_materials', { productId, limit: 20 });
      return {
        status: 'completed',
        output: { materialInventory: toolOutput },
        decision: 'material_indexed',
        reason: `已索引 ${readNumber(toolOutput.materialCount, 0)} 个素材、${readNumber(toolOutput.sliceCount, 0)} 个切片。`,
      };
    },
  };
}

// 素材审核：合规(无违禁词) + 真实性(必须声明来源)，未通过的不进证据、不可用于生成。
const MATERIAL_PROHIBITED_WORDS = ['最', '第一', '唯一', '100%', '根治', '永久', '治愈', '假货', '盗版', '高仿'];
function reviewMaterial(material: JsonMap): { ok: boolean; reason: string } {
  const declaration = readString(material.sourceDeclaration).trim();
  if (!declaration) return { ok: false, reason: '缺少素材来源声明，真实性校验未通过' };
  const text = `${readString(material.name)} ${declaration}`;
  const hit = MATERIAL_PROHIBITED_WORDS.find((word) => text.includes(word));
  if (hit) return { ok: false, reason: `命中违规词「${hit}」，合规校验未通过` };
  return { ok: true, reason: '合规 + 来源校验通过' };
}

function buildEvidenceLedger(productId: string, inventory: JsonMap) {
  const allMaterials = asArray(inventory.materials).map((item) => asRecord(item));
  const flaggedMaterials = allMaterials
    .map((material) => ({ material, review: reviewMaterial(material) }))
    .filter((entry) => !entry.review.ok)
    .map((entry) => ({
      id: readString(entry.material.id),
      name: readString(entry.material.name),
      reason: entry.review.reason,
    }));
  // 只有过审素材才能作为证据 / 生成参考
  const materials = allMaterials.filter((material) => reviewMaterial(material).ok);
  const evidence = materials.flatMap((material) =>
    asArray(material.slices).length
      ? asArray(material.slices).map((item) => {
          const slice = asRecord(item);
          return {
            id: `ev_${readString(slice.id)}`,
            sourceType: 'material',
            sourceUrl: material.sourceUrl,
            sourceTitle: material.name || material.id,
            text: `${slice.summary} 来源：${material.sourceDeclaration}`,
            reliability: 'high',
          };
        })
      : [
          {
            id: `ev_${material.id}`,
            sourceType: 'material',
            sourceUrl: material.sourceUrl,
            sourceTitle: material.name || material.id,
            text: `${material.name || material.id} 来源：${material.sourceDeclaration}`,
            reliability: 'high',
          },
        ],
  );
  const claims = evidence.slice(0, 5).map((item, index) => ({
    id: `claim_${productId}_${index + 1}`,
    text: index === 0 ? '商品真实外观和细节可通过上传素材展示。' : `可用素材证明：${item.text.slice(0, 48)}`,
    category: index === 0 ? 'feature' : 'scenario',
    evidenceIds: [item.id],
    confidence: 0.76,
  }));
  return {
    evidence,
    claims,
    materialCount: readNumber(inventory.materialCount, allMaterials.length),
    reviewedMaterialCount: materials.length,
    flaggedMaterials,
  };
}

function productForResearch(previous: JsonMap) {
  const productId = readString(previous.productId);
  const title = readString(previous.title, readString(previous.freePrompt, productId || '商品短视频'));
  return {
    id: productId,
    title,
    category: readString(previous.category),
    price: readString(previous.price),
    audience: readString(previous.audience, '电商短视频目标用户'),
    description: readString(previous.description, title),
    sellingPoints: stringArray(previous.sellingPoints),
    assets: [],
    reviewStatus: 'approved' as const,
  };
}

function mergeEvidenceLedgers(
  localLedger: ReturnType<typeof buildEvidenceLedger>,
  webOutput: Awaited<ReturnType<typeof runResearchAgent>>,
) {
  type MergedEvidence = (typeof localLedger.evidence)[number] | (typeof webOutput.evidence)[number];
  const evidenceByKey = new Map<string, MergedEvidence>();
  for (const item of localLedger.evidence) {
    evidenceByKey.set(`${readString(item.sourceUrl)}|${readString(item.text)}`, item);
  }
  for (const item of webOutput.evidence) {
    const key = `${readString(item.sourceUrl)}|${readString(item.text)}`;
    if (!evidenceByKey.has(key)) evidenceByKey.set(key, item);
  }
  const evidence = [...evidenceByKey.values()];
  const validEvidenceIds = new Set(evidence.map((item) => item.id));
  const localClaims = localLedger.claims.filter((claim) => claim.evidenceIds.some((id) => validEvidenceIds.has(id)));
  const webClaims = webOutput.claims
    .map((claim) => ({
      ...claim,
      evidenceIds: claim.evidenceIds.filter((id) => validEvidenceIds.has(id)),
    }))
    .filter((claim) => claim.evidenceIds.length > 0);
  return {
    evidence,
    claims: [...localClaims, ...webClaims].slice(0, 8),
    materialCount: localLedger.materialCount,
    webEvidenceCount: webOutput.evidence.filter((item) => item.sourceType === 'web' || item.sourceType === 'review')
      .length,
    webClaimCount: webClaims.length,
    traces: webOutput.traces,
    searchPlan: webOutput.searchPlan,
  };
}

async function buildStoryboard(scriptId: string) {
  const script = await getScript(scriptId);
  if (!script) throw new Error(`剧本不存在：${scriptId}`);
  return {
    scriptId,
    aspectRatio: script.aspectRatio,
    totalDuration: script.shots.reduce((sum, shot) => sum + shot.duration, 0),
    shots: script.shots.map((shot) => ({
      shotId: shot.id,
      order: shot.order,
      duration: shot.duration,
      renderPrompt: `${shot.visualDesc}；镜头：${shot.camera}；字幕语义：${shot.subtitle}`,
      narration: shot.narration,
      evidenceIds: shot.evidenceIds,
      claimIds: shot.claimIds,
      requiredSemantics: textTokens(`${shot.visualDesc} ${shot.subtitle}`).slice(0, 8),
    })),
  };
}

async function buildEditingPlan(ctx: AgentNodeContext, scriptId: string) {
  const script = await getScript(scriptId);
  if (!script) throw new Error(`剧本不存在：${scriptId}`);
  const plan = [];
  for (const shot of script.shots) {
    const searchOutput = await runRegisteredTool(ctx, 'db.search_slices', {
      query: shot.visualDesc,
      limit: 3,
      productId: script.productId,
    });
    const referenceSlices = searchSlicesFromToolOutput(searchOutput).slice(0, 3);
    const searchBest = referenceSlices[0];
    const searchBestScore = readNumber(searchBest?.score, 0);
    const score = searchBestScore || overlapScore(shot.visualDesc, `${shot.subtitle} ${shot.narration}`);
    const factors = asArray(shot.factors);
    plan.push({
      shotId: shot.id,
      order: shot.order,
      action: 'generate',
      referenceSliceIds: referenceSlices.map((slice) => readString(slice.id)).filter(Boolean),
      score,
      transition:
        shot.transition ||
        (factors.some((factor) => String(asRecord(factor).value || '').includes('快')) ? 'whip' : 'hard_cut'),
      reason: referenceSlices.length
        ? '素材切片仅作为 Seedance 生成参考，最终视频不复用、不裁切任何切片。'
        : '无参考切片，交给 Seedance 生成链路。',
    });
  }
  return {
    scriptId,
    totalShots: script.shots.length,
    reuseCount: 0,
    generateCount: plan.filter((item) => item.action === 'generate').length,
    subtitlePlan: buildComposerSubtitlePlan(script.shots),
    plan,
  };
}

function searchSlicesFromToolOutput(output: JsonMap) {
  return asArray(output.slices).map((item) => asRecord(item));
}

function scoreScript(input: {
  hotVideoDna?: JsonMap;
  storyboard: JsonMap;
  approvedClaims?: unknown[];
  blockedClaims?: unknown[];
}) {
  const shots = Array.isArray(input.storyboard.shots) ? input.storyboard.shots : [];
  const totalDuration = readNumber(input.storyboard.totalDuration, 0);
  const approved = input.approvedClaims?.length || 0;
  const blocked = input.blockedClaims?.length || 0;
  const dnaAssessment = dnaCoverage(input.hotVideoDna || {}, input.storyboard);
  const boundShots = shots.filter((item) => {
    const shot = asRecord(item);
    return asArray(shot.claimIds).length > 0 && asArray(shot.evidenceIds).length > 0;
  }).length;
  const unboundShots = approved > 0 ? Math.max(0, shots.length - boundShots) : 0;
  const hookScore = shots.length > 0 ? 18 : 0;
  const evidenceScore = clamp(approved * 5 + boundShots * 2 - blocked * 12 - unboundShots * 8, 0, 24);
  const rhythmScore = totalDuration > 0 && totalDuration <= 15 ? 16 : 8;
  const coverageScore = shots.length >= 4 ? 14 : shots.length * 3;
  const safetyScore = blocked === 0 && unboundShots === 0 ? 12 : 3;
  const dnaScore = Math.round(dnaAssessment.coverage * 16);
  const viralScore = clamp(hookScore + evidenceScore + rhythmScore + coverageScore + safetyScore + dnaScore, 0, 100);
  return {
    viralScore,
    conversionFit: clamp(viralScore - 6 + approved * 2, 0, 100),
    dimensions: {
      hookScore,
      evidenceScore,
      rhythmScore,
      coverageScore,
      safetyScore,
      dnaScore,
      dnaCoverage: dnaAssessment,
      boundShots,
      unboundShots,
    },
    issues:
      blocked > 0
        ? [{ level: 'block', message: '存在被 Policy 拒绝的 claim，需要重写。' }]
        : unboundShots > 0
          ? [{ level: 'block', message: `${unboundShots} 个分镜未绑定 approved claim/evidence。` }]
          : totalDuration > 15
            ? [{ level: 'warn', message: '视频时长超过 15 秒，建议压缩。' }]
            : [],
  };
}

async function detectRepairIssue(input: { scriptId: string; shotId?: string; requestedIssue?: JsonMap }) {
  const script = await getScript(input.scriptId);
  if (!script) throw new Error(`剧本不存在：${input.scriptId}`);
  const requestedIssue = input.requestedIssue || {};
  const shot =
    input.shotId && script.shots.some((item) => item.id === input.shotId)
      ? script.shots.find((item) => item.id === input.shotId)
      : script.shots.find((item) => item.duration > 6) || script.shots[0];
  if (!shot) throw new Error(`剧本 ${input.scriptId} 没有可修复分镜。`);

  const requestedKind = readString(requestedIssue.kind);
  const kind =
    requestedKind ||
    (shot.materialRef ? 'forbidden_material_ref' : shot.duration > 6 ? 'duration_overflow' : 'rewrite');
  const action =
    kind === 'duration_overflow'
      ? 'trim_duration'
      : kind === 'unsupported_claim'
        ? 'replace_claim'
        : 'rewrite_narration';

  return {
    scriptId: script.id,
    shotId: shot.id,
    issue: {
      id: readString(requestedIssue.id, makeId('issue')),
      kind,
      action,
      level: kind === 'unsupported_claim' ? 'block' : 'warn',
      message: readString(requestedIssue.message, `分镜 ${shot.order} 需要局部修复。`),
      before: {
        visualDesc: shot.visualDesc,
        narration: shot.narration,
        subtitle: shot.subtitle,
        duration: shot.duration,
      },
    },
  };
}

async function summarizeScriptForVariant(scriptId: string, label: string) {
  const storyboard = await buildStoryboard(scriptId);
  const score = scoreScript({ storyboard });
  return {
    label,
    scriptId,
    storyboard,
    score,
  };
}

const store = {
  updateRun: updateAgentRun,
  createStep: createAgentStep,
  updateStep: updateAgentStep,
  createArtifact: createAgentArtifact,
};

const workerTools = createWorkerTools();

type MastraAuditStepResult = {
  status: AgentNodeResultStatus;
  output?: JsonMap;
  artifactRefs?: string[];
  decision: string;
  reason: string;
};

type MastraScriptGenerateOutput = {
  graphVersion: string;
  executed: string[];
  artifactRefs: string[];
  result: JsonMap;
  mastraWorkflow: JsonMap;
};

function stableProductIdFromScriptInput(input: JsonMap) {
  const seed = [
    readString(input.productUrl),
    readString(input.title),
    readString(input.productTitle),
    readString(input.referenceImageUrl),
  ]
    .filter(Boolean)
    .join('\n');
  if (!seed) return '';
  return `prod_${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

function normalizeScriptGenerateRunInput(input: JsonMap) {
  const productId = readString(input.productId) || stableProductIdFromScriptInput(input);
  const title = readString(input.title, readString(input.productTitle, readString(input.productName)));
  const productUrl = readString(input.productUrl) || undefined;
  const referenceImageUrl = readString(input.referenceImageUrl) || undefined;
  const hasProductSignal = Boolean(productId || title || productUrl || referenceImageUrl);
  if (!hasProductSignal) {
    return {
      status: 'waiting_input' as const,
      output: {
        waitingFor: {
          fields: ['product'],
          message: '需要商品链接、主图、商品名或核心卖点才能生成剧本。',
        },
      },
      decision: 'missing_product',
      reason: 'script_generate 缺少商品信号，等待用户补充。',
    };
  }

  return {
    status: 'completed' as const,
    output: {
      productId,
      title: title || undefined,
      productUrl,
      referenceImageUrl,
      description: readString(input.description) || undefined,
      price: readString(input.price) || undefined,
      webSearch: readBoolean(input.webSearch, true),
      searchScopes: readSearchScopes(input.searchScopes),
      mode: readMode(input.mode),
      provider: readScriptProvider(input.provider),
      retrievalMode: readRetrievalMode(input.retrievalMode),
      generationProfile:
        input.generationProfile === 'quick_preview' || input.generationProfile === 'trusted_publish'
          ? input.generationProfile
          : 'trusted_publish',
      ref: readString(input.ref) || undefined,
      freePrompt: readString(input.freePrompt, title || productUrl || productId) || undefined,
      allowLowEvidence: readBoolean(input.allowLowEvidence, false),
    },
    decision: 'requirements_confirmed',
    reason: title ? `已确认「${title}」的剧本生成需求。` : '已确认剧本生成需求。',
  };
}

function defaultAgentLogger(): AgentLogger {
  return {
    info(message, payload) {
      console.log(`[agent] ${message}`, payload || '');
    },
    warn(message, payload) {
      console.warn(`[agent] ${message}`, payload || '');
    },
    error(message, payload) {
      console.error(`[agent] ${message}`, payload || '');
    },
  };
}

async function runMastraAuditStep(input: {
  run: AgentRunRecord;
  nodeId: string;
  agentName: ThreeAgentOwner;
  previous: JsonMap;
  artifactRefs: string[];
  signal: AbortSignal;
  logger: AgentLogger;
  blocking?: boolean;
  runStep(ctx: AgentNodeContext): Promise<MastraAuditStepResult>;
}) {
  if (input.signal.aborted) throw new Error('Agent run aborted');
  const stepId = makeId('step');
  await createAgentStep({
    id: stepId,
    runId: input.run.id,
    nodeId: input.nodeId,
    agentName: input.agentName,
    status: 'running',
    attempt: 1,
    inputRefs: [...input.artifactRefs],
    startedAt: new Date(),
  });

  const createArtifact = async (artifact: {
    type: string;
    content?: JsonMap;
    objectKey?: string;
    contentHash?: string;
  }) => {
    const created = await createAgentArtifact({
      id: makeId('artifact'),
      runId: input.run.id,
      stepId,
      ...artifact,
    });
    input.artifactRefs.push(created.id);
    return created;
  };

  const ctx: AgentNodeContext = {
    run: input.run,
    stepId,
    input: {
      runInput: asRecord(input.run.input),
      previous: input.previous,
      artifactRefs: [...input.artifactRefs],
    },
    artifacts: { create: createArtifact },
    tools: { worker: workerTools },
    logger: input.logger,
    signal: input.signal,
  };

  try {
    const result = await input.runStep(ctx);
    const outputArtifact = result.output
      ? await createArtifact({
          type: `agent.workflow_output.${input.nodeId}`,
          content: result.output,
        })
      : undefined;
    const outputRefs = [...(result.artifactRefs || []), ...(outputArtifact ? [outputArtifact.id] : [])];
    await updateAgentStep(stepId, {
      status: result.status === 'failed' ? 'failed' : result.status === 'skipped' ? 'skipped' : 'completed',
      outputRefs,
      decision: result.decision,
      reason: result.reason,
      error: result.status === 'failed' ? result.reason : null,
      finishedAt: new Date(),
    });
    if (result.status === 'failed' && input.blocking !== false) {
      throw new Error(result.reason || `Mastra workflow step failed: ${input.nodeId}`);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : `Mastra workflow step failed: ${input.nodeId}`;
    await updateAgentStep(stepId, {
      status: 'failed',
      decision: 'failed',
      reason: message,
      error: message,
      finishedAt: new Date(),
    }).catch(() => undefined);
    throw error;
  }
}

function mastraDispatches(workflow: JsonMap) {
  return asArray(asRecord(workflow.result).dispatches).map((item) => asRecord(item));
}

async function executeMastraScriptGenerate(input: {
  run: AgentRunRecord;
  taskId: string;
  signal: AbortSignal;
  logger?: AgentLogger;
}): Promise<MastraScriptGenerateOutput> {
  const logger = input.logger || defaultAgentLogger();
  const graphVersion = 'mastra.workflow.script_generate.v1';
  const initialRunInput = asRecord(input.run.input);
  const mastraWorkflow = await planMastraAgentRunDispatch({
    kind: 'script_generate',
    runInput: initialRunInput,
    runId: input.run.id,
  });
  const normalizedWorkflow = asRecord(mastraWorkflow);
  const mergedRunInput = { ...initialRunInput, mastraWorkflow: normalizedWorkflow };
  const run: AgentRunRecord = { ...input.run, input: mergedRunInput, graphVersion, status: 'running' };
  const artifactRefs: string[] = [];
  const executed: string[] = [];
  let previous: JsonMap = {};

  await updateAgentRun(run.id, {
    status: 'running',
    graphVersion,
    input: mergedRunInput,
    error: null,
  });

  const appendOutput = (nodeId: string, result: MastraAuditStepResult) => {
    executed.push(nodeId);
    if (result.output) previous = { ...previous, ...result.output };
  };

  const requirements = await runMastraAuditStep({
    run,
    nodeId: 'requirements.confirm',
    agentName: 'researcher',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    runStep: async () => {
      const normalized = normalizeScriptGenerateRunInput(initialRunInput);
      if (asRecord(normalizedWorkflow.result).status === 'needs_input' || normalized.status === 'waiting_input') {
        return {
          status: 'waiting_input',
          output: normalized.output,
          decision: normalized.decision,
          reason: normalized.reason,
        };
      }
      return normalized;
    },
  });
  appendOutput('requirements.confirm', requirements);

  if (requirements.status === 'waiting_input') {
    const output = { graphVersion, executed, artifactRefs, result: previous, mastraWorkflow: normalizedWorkflow };
    await updateAgentRun(run.id, { status: 'waiting_input', output });
    return output;
  }

  const scriptDispatch = mastraDispatches(normalizedWorkflow).find(
    (dispatch) => readString(dispatch.nodeId) === 'script.compose',
  );
  if (readString(scriptDispatch?.target) !== 'BullMQ:aigc.script') {
    throw new Error('Mastra workflow 未返回 script.compose 的 BullMQ:aigc.script 派发描述。');
  }

  const productIngest = await runMastraAuditStep({
    run,
    nodeId: 'product.ingest',
    agentName: 'researcher',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    blocking: false,
    runStep: async () => ({ status: 'completed', ...(await ingestProductForScript(previous, input.taskId)) }),
  });
  appendOutput('product.ingest', productIngest);

  const materialContext = await runMastraAuditStep({
    run,
    nodeId: 'material.context',
    agentName: 'researcher',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    blocking: false,
    runStep: async (ctx) => {
      const productId = readString(previous.productId);
      const materialInventory = await runRegisteredTool(ctx, 'db.list_materials', { productId, limit: 50 });
      return {
        status: 'completed',
        output: { materialInventory },
        decision: 'material_context_loaded',
        reason: `已检查当前商品素材库：素材 ${readNumber(materialInventory.materialCount, 0)} 个，切片 ${readNumber(materialInventory.sliceCount, 0)} 个。`,
      };
    },
  });
  appendOutput('material.context', materialContext);

  const referenceRetrieve = await runMastraAuditStep({
    run,
    nodeId: 'reference.retrieve',
    agentName: 'researcher',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    blocking: false,
    runStep: async (ctx) => {
      const shouldReadReferences =
        Boolean(readString(previous.ref)) || readRetrievalMode(previous.retrievalMode) === 'rag';
      const referenceContext = shouldReadReferences
        ? await runRegisteredTool(ctx, 'db.list_reference_videos', {
            ref: readString(previous.ref) || undefined,
            query: readString(previous.freePrompt, readString(previous.productId)),
            limit: 3,
          })
        : {};
      const hotVideoDna = makeHotVideoDna(previous, referenceContext);
      return {
        status: 'completed',
        output: { referenceContext, hotVideoDna },
        decision: 'reference_retrieved',
        reason: `已提炼 ${hotVideoDna.factors.length} 个爆款配方因子。`,
      };
    },
  });
  appendOutput('reference.retrieve', referenceRetrieve);

  const policyPrecheck = await runMastraAuditStep({
    run,
    nodeId: 'policy.precheck',
    agentName: 'auditor',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    runStep: async (ctx) => {
      const productId = readString(previous.productId);
      const ledger = buildEvidenceLedger(productId, asRecord(previous.materialInventory));
      const shouldUseWeb =
        readBoolean(previous.webSearch, true) && (ledger.evidence.length < 2 || ledger.claims.length === 0);
      const merged = shouldUseWeb
        ? mergeEvidenceLedgers(
            ledger,
            await runResearchAgent({
              productId,
              productUrl: readString(previous.productUrl) || undefined,
              product: productForResearch(previous),
              uploadedSlices: [],
              taskId: input.taskId,
              noCache: true,
              strictEvidence: false,
              webSearch: true,
              searchScopes: readSearchScopes(previous.searchScopes),
            }),
          )
        : {
            ...ledger,
            webEvidenceCount: 0,
            webClaimCount: 0,
            traces: [],
            searchPlan: [],
          };
      await runRegisteredTool(ctx, 'db.upsert_evidence_record', {
        productId,
        output: {
          evidence: merged.evidence,
          claims: merged.claims,
          materialCount: merged.materialCount,
          webEvidenceCount: merged.webEvidenceCount,
          webClaimCount: merged.webClaimCount,
          webSearch: shouldUseWeb,
          searchPlan: merged.searchPlan,
          traces: merged.traces,
          generatedBy: 'mastra_script_generate_use_case',
        },
      });
      const claims = policyCheckClaims(merged.claims);
      const approvedClaims = claims.filter((claim) => claim.status === 'approved');
      const blockedClaims = claims.filter((claim) => claim.status === 'blocked');
      const allowLowEvidence =
        readString(previous.generationProfile) === 'quick_preview' || readBoolean(previous.allowLowEvidence, false);
      const output = {
        evidence: merged.evidence,
        rawClaims: merged.claims,
        materialCount: merged.materialCount,
        webEvidenceCount: merged.webEvidenceCount,
        webClaimCount: merged.webClaimCount,
        researchTraces: merged.traces,
        searchPlan: merged.searchPlan,
        approvedClaims,
        blockedClaims,
        needsEvidenceClaims: claims.filter((claim) => claim.status === 'needs_evidence'),
        readiness: approvedClaims.length ? 'evidence_ready' : 'low_evidence_preview',
      };
      if (blockedClaims.length) {
        return {
          status: 'failed',
          output,
          decision: 'blocked_claims_found',
          reason: `命中违规 claim ${blockedClaims.length} 条，已阻止生成。`,
        };
      }
      if (approvedClaims.length === 0 && !allowLowEvidence) {
        return {
          status: 'failed',
          output: { ...output, readiness: 'insufficient_evidence' },
          decision: 'insufficient_evidence',
          reason:
            '尚无可核验卖点：请补充商品名/链接、主打卖点，或上传可作证据的素材后再生成；如只想看草稿，可显式选择快速预览。',
        };
      }
      return {
        status: 'completed',
        output,
        decision: 'claims_approved',
        reason: `approved=${approvedClaims.length}, blocked=${blockedClaims.length}`,
      };
    },
  });
  appendOutput('policy.precheck', policyPrecheck);

  const researchMerge = await runMastraAuditStep({
    run,
    nodeId: 'research.merge',
    agentName: 'composer',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    runStep: async () => {
      const hotVideoDna = asRecord(previous.hotVideoDna);
      const approvedClaims = Array.isArray(previous.approvedClaims) ? previous.approvedClaims : [];
      const mode = readMode(previous.mode);
      const strategy = {
        mode,
        reference: readString(previous.ref, 'auto'),
        hook: readString(hotVideoDna.hook, '前三秒问题式开场'),
        factorPolicy: approvedClaims.length ? 'evidence_first' : 'safe_preview',
        generationStyle: mode === 'imitate' ? '爆款仿写' : mode === 'template' ? '灵感模板融合' : '自动化策略组合',
      };
      return {
        status: 'completed',
        output: { strategy },
        decision: 'research_context_merged',
        reason: `已合并调研、参考和合规上下文，策略=${strategy.factorPolicy}。`,
      };
    },
  });
  appendOutput('research.merge', researchMerge);

  const scriptCompose = await runMastraAuditStep({
    run,
    nodeId: 'script.compose',
    agentName: 'composer',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    runStep: async (ctx) => {
      await runRegisteredTool(ctx, 'worker.process_script_generate', {
        taskId: input.taskId,
        productId: previous.productId,
        mode: previous.mode,
        provider: previous.provider,
        retrievalMode: previous.retrievalMode,
        generationProfile: previous.generationProfile,
        ref: readString(previous.ref) || undefined,
        freePrompt: readString(previous.freePrompt) || undefined,
        approvedClaims: asArray(previous.approvedClaims),
        evidence: asArray(previous.evidence),
        hotVideoDna: asRecord(previous.hotVideoDna),
        strategy: asRecord(previous.strategy),
        referenceImageUrl: readString(previous.referenceImageUrl) || undefined,
      });
      const task = await getTask(input.taskId);
      const payload = asRecord(task?.payload);
      const scriptId = readString(payload.scriptId);
      if (!scriptId) {
        return {
          status: 'failed',
          decision: 'script_missing',
          reason: 'Script use case 执行完成，但任务 payload 未返回 scriptId。',
        };
      }
      return {
        status: 'completed',
        output: {
          scriptId,
          provider: payload.provider,
          retrievalMode: payload.retrievalMode,
          generationProfile: payload.generationProfile,
          approvedClaims: asArray(previous.approvedClaims),
          evidence: asArray(previous.evidence),
          hotVideoDna: asRecord(previous.hotVideoDna),
          strategy: asRecord(previous.strategy),
        },
        decision: 'script_generated',
        reason: `Mastra script.compose 已通过 Worker use case 生成结构化剧本 ${scriptId}。`,
      };
    },
  });
  appendOutput('script.compose', scriptCompose);

  const storyboardCompose = await runMastraAuditStep({
    run,
    nodeId: 'storyboard.compose',
    agentName: 'composer',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    runStep: async () => {
      const storyboard = await buildStoryboard(readString(previous.scriptId));
      return {
        status: 'completed',
        output: { storyboard },
        decision: 'storyboard_composed',
        reason: `已整理 ${storyboard.shots.length} 个可渲染分镜。`,
      };
    },
  });
  appendOutput('storyboard.compose', storyboardCompose);

  const qaScore = await runMastraAuditStep({
    run,
    nodeId: 'qa.script_score',
    agentName: 'auditor',
    previous,
    artifactRefs,
    signal: input.signal,
    logger,
    blocking: false,
    runStep: async () => {
      const scriptScore = scoreScript({
        hotVideoDna: asRecord(previous.hotVideoDna),
        storyboard: asRecord(previous.storyboard),
        approvedClaims: Array.isArray(previous.approvedClaims) ? previous.approvedClaims : [],
        blockedClaims: Array.isArray(previous.blockedClaims) ? previous.blockedClaims : [],
      });
      return {
        status: 'completed',
        output: { scriptScore },
        decision: 'script_scored',
        reason: `Viral Score=${scriptScore.viralScore}, Conversion Fit=${scriptScore.conversionFit}。`,
      };
    },
  });
  appendOutput('qa.script_score', qaScore);

  const output = { graphVersion, executed, artifactRefs, result: previous, mastraWorkflow: normalizedWorkflow };
  await updateAgentRun(run.id, {
    status: 'completed',
    output,
    productId: readString(previous.productId) || undefined,
    scriptId: readString(previous.scriptId) || undefined,
  });
  return output;
}

type ThreeAgentOwner = 'researcher' | 'composer' | 'auditor';

function agentOwner(nodeId: string, currentName: string): ThreeAgentOwner {
  if (
    nodeId.startsWith('validator.') ||
    nodeId.startsWith('qa.') ||
    nodeId.startsWith('passport.') ||
    nodeId.startsWith('growth.')
  ) {
    return 'auditor';
  }
  if (
    nodeId.startsWith('strategy.') ||
    nodeId.startsWith('creative.') ||
    nodeId.startsWith('storyboard.') ||
    nodeId.startsWith('editing.') ||
    nodeId.startsWith('production.') ||
    nodeId.startsWith('render.') ||
    nodeId.startsWith('ab.')
  ) {
    return 'composer';
  }
  if (currentName === 'qa' || currentName === 'validator' || currentName === 'passport' || currentName === 'growth') {
    return 'auditor';
  }
  return 'researcher';
}

function organizeIntoThreeAgents(graph: AgentGraph): AgentGraph {
  return {
    ...graph,
    version: graph.version.includes('three-agent') ? graph.version : `${graph.version}.three-agent`,
    nodes: Object.fromEntries(
      Object.entries(graph.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          ...node,
          agentName: agentOwner(nodeId, node.agentName),
        },
      ]),
    ),
  };
}

function scriptGenerateGraph(): AgentGraph {
  return {
    version: 'agent-graph.script-generate.v3',
    entry: 'intake.normalize',
    nodes: {
      'intake.normalize': {
        id: 'intake.normalize',
        agentName: 'intake',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const input = asRecord(ctx.run.input);
          const productId = readString(input.productId);
          if (!productId) {
            return {
              status: 'waiting_input',
              output: {
                waitingFor: {
                  fields: ['productId'],
                  message: '需要 productId 才能生成剧本。',
                },
              },
              decision: 'missing_product',
              reason: 'script_generate 需要 productId，已进入等待用户补充输入状态。',
            };
          }
          const normalized = {
            productId,
            title: readString(input.title) || undefined,
            productUrl: readString(input.productUrl) || undefined,
            referenceImageUrl: readString(input.referenceImageUrl) || undefined,
            description: readString(input.description) || undefined,
            price: readString(input.price) || undefined,
            webSearch: readBoolean(input.webSearch, true),
            searchScopes: readSearchScopes(input.searchScopes),
            mode: readMode(input.mode),
            provider: readScriptProvider(input.provider),
            retrievalMode: readRetrievalMode(input.retrievalMode),
            generationProfile:
              input.generationProfile === 'quick_preview' || input.generationProfile === 'trusted_publish'
                ? input.generationProfile
                : 'trusted_publish',
            ref: readString(input.ref) || undefined,
            freePrompt: readString(input.freePrompt) || undefined,
          };
          return {
            status: 'completed',
            output: normalized,
            decision: 'normalized',
            reason: `已规范化商品 ${productId} 的剧本生成输入。`,
          };
        },
      },
      'product.ingest': productIngestNode(),
      'material.index': materialIndexNode(),
      'hot_video_dna.analyze': {
        id: 'hot_video_dna.analyze',
        agentName: 'hot_video_dna',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const shouldReadReferences =
            Boolean(readString(previous.ref)) || readRetrievalMode(previous.retrievalMode) === 'rag';
          const referenceContext = shouldReadReferences
            ? await runRegisteredTool(ctx, 'db.list_reference_videos', {
                ref: readString(previous.ref) || undefined,
                query: readString(previous.freePrompt, readString(previous.productId)),
                limit: 3,
              })
            : {};
          const dna = makeHotVideoDna(previous, referenceContext);
          return {
            status: 'completed',
            output: { hotVideoDna: dna },
            decision: 'dna_extracted',
            reason: `已从 ${dna.sourceMode === 'reference_breakdown' ? `${dna.referenceIds.length} 条参考拆解` : '安全模板'} 提炼 ${dna.factors.length} 个爆款 DNA 因子。`,
          };
        },
      },
      'research.evidence': {
        id: 'research.evidence',
        agentName: 'research',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const productId = readString(previous.productId);
          const materialInventory = await runRegisteredTool(ctx, 'db.list_materials', { productId, limit: 50 });
          const ledger = buildEvidenceLedger(productId, materialInventory);
          const shouldUseWeb =
            readBoolean(previous.webSearch, true) && (ledger.evidence.length < 2 || ledger.claims.length === 0);
          const merged = shouldUseWeb
            ? mergeEvidenceLedgers(
                ledger,
                await runResearchAgent({
                  productId,
                  productUrl: readString(previous.productUrl) || undefined,
                  product: productForResearch(previous),
                  uploadedSlices: [],
                  taskId: readString(ctx.run.taskId, ctx.run.id),
                  noCache: true,
                  strictEvidence: false,
                  webSearch: true,
                  searchScopes: readSearchScopes(previous.searchScopes),
                }),
              )
            : {
                ...ledger,
                webEvidenceCount: 0,
                webClaimCount: 0,
                traces: [],
                searchPlan: [],
              };
          await runRegisteredTool(ctx, 'db.upsert_evidence_record', {
            productId,
            output: {
              evidence: merged.evidence,
              claims: merged.claims,
              materialCount: merged.materialCount,
              webEvidenceCount: merged.webEvidenceCount,
              webClaimCount: merged.webClaimCount,
              webSearch: shouldUseWeb,
              searchPlan: merged.searchPlan,
              traces: merged.traces,
              generatedBy: 'agent_orchestrator',
            },
          });
          return {
            status: 'completed',
            output: {
              evidence: merged.evidence,
              rawClaims: merged.claims,
              materialCount: merged.materialCount,
              webEvidenceCount: merged.webEvidenceCount,
              webClaimCount: merged.webClaimCount,
              researchTraces: merged.traces,
              searchPlan: merged.searchPlan,
            },
            decision: 'evidence_collected',
            reason: `收集 ${merged.evidence.length} 条证据（web=${merged.webEvidenceCount}），生成 ${merged.claims.length} 条候选 claim。`,
          };
        },
      },
      'policy.claim_check': {
        id: 'policy.claim_check',
        agentName: 'policy',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const rawClaims = Array.isArray(previous.rawClaims)
            ? (previous.rawClaims as Array<{ id: string; text: string; evidenceIds: string[] }>)
            : [];
          const claims = policyCheckClaims(rawClaims);
          const approvedClaims = claims.filter((claim) => claim.status === 'approved');
          const blockedClaims = claims.filter((claim) => claim.status === 'blocked');

          // ── 生成就绪闸门 ──────────────────────────────────────────────
          // 带货视频必须"有料可说"：至少 1 条带证据的可核验卖点才放行。
          // 仅当用户显式选择快速预览(quick_preview)时，才允许在无卖点下出保守预览。
          const allowLowEvidence =
            readString(previous.generationProfile) === 'quick_preview' || readBoolean(previous.allowLowEvidence, false);
          if (blockedClaims.length) {
            return {
              status: 'failed',
              output: { approvedClaims, blockedClaims },
              decision: 'blocked_claims_found',
              reason: `命中违规 claim ${blockedClaims.length} 条，已阻止生成。`,
            };
          }
          if (approvedClaims.length === 0 && !allowLowEvidence) {
            return {
              status: 'failed',
              output: {
                approvedClaims,
                blockedClaims,
                needsEvidenceClaims: claims.filter((claim) => claim.status === 'needs_evidence'),
                readiness: 'insufficient_evidence',
              },
              decision: 'insufficient_evidence',
              reason:
                '尚无可核验卖点：请补充商品名/链接、主打卖点，或上传可作证据的素材后再生成；如只想看草稿，可显式选择快速预览。',
            };
          }
          return {
            status: 'completed',
            output: {
              approvedClaims,
              blockedClaims,
              needsEvidenceClaims: claims.filter((claim) => claim.status === 'needs_evidence'),
              readiness: approvedClaims.length ? 'evidence_ready' : 'low_evidence_preview',
            },
            decision: 'claims_approved',
            reason: `approved=${approvedClaims.length}, blocked=${blockedClaims.length}`,
          };
        },
      },
      'strategy.select': {
        id: 'strategy.select',
        agentName: 'strategy',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const hotVideoDna = asRecord(previous.hotVideoDna);
          const approvedClaims = Array.isArray(previous.approvedClaims) ? previous.approvedClaims : [];
          const mode = readMode(previous.mode);
          const strategy = {
            mode,
            reference: readString(previous.ref, 'auto'),
            hook: readString(hotVideoDna.hook, '前三秒问题式开场'),
            factorPolicy: approvedClaims.length ? 'evidence_first' : 'safe_preview',
            generationStyle: mode === 'imitate' ? '爆款仿写' : mode === 'template' ? '灵感模板融合' : '自动化策略组合',
          };
          return {
            status: 'completed',
            output: { strategy },
            decision: 'strategy_selected',
            reason: `已选择 ${strategy.generationStyle}，claim 策略=${strategy.factorPolicy}。`,
          };
        },
      },
      'creative.script': {
        id: 'creative.script',
        agentName: 'creative',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const taskId = readString(ctx.run.taskId);
          if (!taskId) {
            return {
              status: 'failed',
              decision: 'missing_task',
              reason: 'AgentRun 缺少 taskId，无法同步任务状态。',
            };
          }

          await runRegisteredTool(ctx, 'worker.process_script_generate', {
            taskId,
            productId: previous.productId,
            mode: previous.mode,
            provider: previous.provider,
            retrievalMode: previous.retrievalMode,
            generationProfile: previous.generationProfile,
            ref: readString(previous.ref) || undefined,
            freePrompt: readString(previous.freePrompt) || undefined,
            approvedClaims: asArray(previous.approvedClaims),
            evidence: asArray(previous.evidence),
            hotVideoDna: asRecord(previous.hotVideoDna),
            strategy: asRecord(previous.strategy),
            referenceImageUrl: readString(previous.referenceImageUrl) || undefined,
          });

          const task = await getTask(taskId);
          const payload = asRecord(task?.payload);
          const scriptId = readString(payload.scriptId);
          if (!scriptId) {
            return {
              status: 'failed',
              decision: 'script_missing',
              reason: 'Creative Script Agent 执行完成，但任务 payload 未返回 scriptId。',
            };
          }
          return {
            status: 'completed',
            output: {
              scriptId,
              provider: payload.provider,
              retrievalMode: payload.retrievalMode,
              generationProfile: payload.generationProfile,
              approvedClaims: asArray(previous.approvedClaims),
              evidence: asArray(previous.evidence),
              hotVideoDna: asRecord(previous.hotVideoDna),
              strategy: asRecord(previous.strategy),
            },
            decision: 'script_generated',
            reason: `已生成结构化剧本 ${scriptId}。`,
          };
        },
      },
      'storyboard.plan': {
        id: 'storyboard.plan',
        agentName: 'storyboard',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const scriptId = readString(previous.scriptId);
          const storyboard = await buildStoryboard(scriptId);
          return {
            status: 'completed',
            output: { storyboard },
            decision: 'storyboard_planned',
            reason: `已生成 ${storyboard.shots.length} 个可渲染分镜计划。`,
          };
        },
      },
      'validator.script_score': {
        id: 'validator.script_score',
        agentName: 'validator',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const scriptScore = scoreScript({
            hotVideoDna: asRecord(previous.hotVideoDna),
            storyboard: asRecord(previous.storyboard),
            approvedClaims: Array.isArray(previous.approvedClaims) ? previous.approvedClaims : [],
            blockedClaims: Array.isArray(previous.blockedClaims) ? previous.blockedClaims : [],
          });
          return {
            status: 'completed',
            output: { scriptScore },
            decision: 'script_scored',
            reason: `Viral Score=${scriptScore.viralScore}, Conversion Fit=${scriptScore.conversionFit}。`,
          };
        },
      },
    },
    edges: [
      { from: 'intake.normalize', to: 'product.ingest' },
      { from: 'product.ingest', to: 'material.index' },
      { from: 'material.index', to: 'hot_video_dna.analyze' },
      { from: 'hot_video_dna.analyze', to: 'research.evidence' },
      { from: 'research.evidence', to: 'policy.claim_check' },
      { from: 'policy.claim_check', to: 'strategy.select' },
      { from: 'strategy.select', to: 'creative.script' },
      { from: 'creative.script', to: 'storyboard.plan' },
      { from: 'storyboard.plan', to: 'validator.script_score' },
    ],
  };
}

function renderFullGraph(): AgentGraph {
  return {
    version: 'agent-graph.render-full.v2',
    entry: 'render.load_context',
    nodes: {
      'render.load_context': {
        id: 'render.load_context',
        agentName: 'production',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const input = asRecord(ctx.run.input);
          const scriptId = readString(input.scriptId);
          if (!scriptId) {
            return {
              status: 'waiting_input',
              output: {
                waitingFor: {
                  fields: ['scriptId'],
                  message: '需要 scriptId 才能导出成片。',
                },
              },
              decision: 'missing_script',
              reason: 'render_full 需要 scriptId，已进入等待用户补充输入状态。',
            };
          }
          return {
            status: 'completed',
            output: {
              scriptId,
              exportOptions: asRecord(input.exportOptions),
            },
            decision: 'render_context_loaded',
            reason: `已加载剧本 ${scriptId} 的导出上下文。`,
          };
        },
      },
      'editing.plan': {
        id: 'editing.plan',
        agentName: 'editing',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const scriptId = readString(previous.scriptId);
          const editingPlan = await buildEditingPlan(ctx, scriptId);
          return {
            status: 'completed',
            output: { editingPlan },
            decision: 'editing_plan_ready',
            reason: `复用 ${editingPlan.reuseCount} 镜，生成 ${editingPlan.generateCount} 镜。`,
          };
        },
      },
      'production.render': {
        id: 'production.render',
        agentName: 'production',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const taskId = readString(ctx.run.taskId);
          const editingPlan = asRecord(previous.editingPlan);
          const renderPlan = asArray(editingPlan.plan).map((item) => {
            const planItem = asRecord(item);
            const transition = readString(planItem.transition);
            const normalizedTransition: 'fade' | 'whip' | 'hard_cut' | undefined =
              transition === 'fade' || transition === 'whip' || transition === 'hard_cut' ? transition : undefined;
            return {
              shotId: readString(planItem.shotId),
              action: 'generate' as const,
              referenceSliceIds: asArray(planItem.referenceSliceIds)
                .map((id) => readString(id))
                .filter(Boolean),
              score: readNumber(planItem.score, 0),
              transition: normalizedTransition,
              reason: readString(planItem.reason) || undefined,
            };
          });
          if (!taskId) {
            return {
              status: 'failed',
              decision: 'missing_task',
              reason: 'AgentRun 缺少 taskId，无法同步任务状态。',
            };
          }

          await runRegisteredTool(ctx, 'worker.process_render_full', {
            taskId,
            scriptId: previous.scriptId,
            exportOptions: asRecord(previous.exportOptions),
            renderPlan,
            subtitlePlan: asArray(editingPlan.subtitlePlan),
          });

          const task = await getTask(taskId);
          const payload = asRecord(task?.payload);
          return {
            status: 'completed',
            output: {
              scriptId: payload.scriptId,
              videoUrl: payload.videoUrl,
              objectKey: payload.objectKey,
              format: payload.format,
              provider: payload.provider,
              renderMetrics: payload.renderMetrics,
            },
            decision: 'render_completed',
            reason: `已完成成片导出：${readString(payload.videoUrl, '无 videoUrl')}`,
          };
        },
      },
      'validator.video_score': {
        id: 'validator.video_score',
        agentName: 'validator',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const editingPlan = asRecord(previous.editingPlan);
          const renderMetrics = asRecord(previous.renderMetrics);
          const plan = Array.isArray(editingPlan.plan) ? editingPlan.plan : [];
          const plannedReuseCount = readNumber(editingPlan.reuseCount, 0);
          const plannedTotalShots = Math.max(1, readNumber(editingPlan.totalShots, plan.length || 1));
          const renderedTotalShots = readNumber(renderMetrics.totalShots, 0);
          const renderedReuseCount = readNumber(renderMetrics.reusedMaterialShots, 0);
          const hasVideo = Boolean(readString(previous.videoUrl));
          const dnaAssessment = dnaCoverage(asRecord(previous.hotVideoDna), asRecord(previous.storyboard));
          const materialRatio = renderedTotalShots
            ? renderedReuseCount / renderedTotalShots
            : plannedReuseCount / plannedTotalShots;
          const seedanceOnlyRatio = 1 - materialRatio;
          const videoScore = {
            viralScore: clamp(48 + seedanceOnlyRatio * 18 + (hasVideo ? 14 : 0) + dnaAssessment.coverage * 20, 0, 100),
            conversionFit: clamp(
              44 + seedanceOnlyRatio * 20 + (hasVideo ? 12 : 0) + dnaAssessment.coverage * 20,
              0,
              100,
            ),
            materialReuseRatio: Number(materialRatio.toFixed(4)),
            reuseMetricSource: renderedTotalShots ? 'rendered' : 'planned',
            dnaCoverage: dnaAssessment,
            referenceIds: asArray(asRecord(previous.hotVideoDna).referenceIds),
            issues: [
              ...(hasVideo ? [] : [{ level: 'warn', message: '未返回 videoUrl，需检查渲染产物。' }]),
              ...(dnaAssessment.sourceMode === 'reference_breakdown' && dnaAssessment.coverage < 0.35
                ? [{ level: 'warn', message: '成片未充分覆盖参考视频 DNA/评论关注点，建议局部优化。' }]
                : []),
            ],
          };
          return {
            status: 'completed',
            output: { videoScore },
            decision: 'video_scored',
            reason: `视频评分完成：viral=${videoScore.viralScore}, conversion=${videoScore.conversionFit}。`,
          };
        },
      },
      'qa.audit': {
        id: 'qa.audit',
        agentName: 'qa',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const videoScore = asRecord(previous.videoScore);
          const renderMetrics = asRecord(previous.renderMetrics);
          const issues = Array.isArray(videoScore.issues) ? videoScore.issues : [];
          const audit = {
            level: issues.some((item) => asRecord(item).level === 'block') ? 'block' : issues.length ? 'warn' : 'pass',
            issues,
            metrics: {
              issueCount: issues.length,
              viralScore: videoScore.viralScore,
              conversionFit: videoScore.conversionFit,
              materialReuseRatio: videoScore.materialReuseRatio,
              dnaCoverage: videoScore.dnaCoverage,
              renderMetrics,
            },
            repairActions:
              issues.length > 0
                ? [{ action: 'inspect_render_output', reason: 'Validator 发现导出产物或评分风险。' }]
                : [],
          };
          const taskId = readString(ctx.run.taskId, ctx.run.id);
          const scriptId = readString(previous.scriptId);
          if (scriptId) {
            await runRegisteredTool(ctx, 'db.upsert_audit_result', {
              taskId,
              scriptId,
              level: audit.level,
              issues: audit.issues,
              metrics: audit.metrics,
            });
          }
          return {
            status: 'completed',
            output: { audit },
            decision: 'audit_completed',
            reason: `QA 审计完成，level=${audit.level}，issues=${issues.length}。`,
          };
        },
      },
      'passport.compute': {
        id: 'passport.compute',
        agentName: 'passport',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const editingPlan = asRecord(previous.editingPlan);
          const renderMetrics = asRecord(previous.renderMetrics);
          const videoScore = asRecord(previous.videoScore);
          const audit = asRecord(previous.audit);
          const materialReuseRatio = readNumber(videoScore.materialReuseRatio, 0);
          const seedanceOnlyRatio = 1 - materialReuseRatio;
          const approvedClaims = asArray(previous.approvedClaims);
          const blockedClaims = asArray(previous.blockedClaims);
          const needsEvidenceClaims = asArray(previous.needsEvidenceClaims);
          const claimEvidenceCoverage = approvedClaims.length
            ? approvedClaims.filter((claim) => asArray(asRecord(claim).evidenceIds).length > 0).length /
              approvedClaims.length
            : 0;
          const evidenceCoverage = claimEvidenceCoverage;
          const videoId = readString(previous.videoUrl, readString(previous.objectKey, ctx.run.id));
          const passport = {
            videoId,
            scriptId: previous.scriptId,
            trustScore: clamp(
              readNumber(videoScore.conversionFit, 60) * 0.6 + evidenceCoverage * 30 + seedanceOnlyRatio * 10,
              0,
              100,
            ),
            evidenceCoverage,
            realMaterialRatio: materialReuseRatio,
            approvedClaims: approvedClaims.length,
            needsEvidenceClaims: needsEvidenceClaims.length,
            blockedClaims: blockedClaims.length,
            repairedClaims: asArray(previous.repairLog).length,
            policyRisk: audit.level === 'pass' ? 'low' : audit.level === 'warn' ? 'medium' : 'high',
            renderFormat: previous.format,
            provider: previous.provider,
            shotCount: readNumber(renderMetrics.totalShots, readNumber(editingPlan.totalShots, 0)),
          };
          if (readString(passport.scriptId) && videoId) {
            await runRegisteredTool(ctx, 'db.upsert_passport', {
              videoId,
              scriptId: readString(passport.scriptId),
              trustScore: readNumber(passport.trustScore, 0),
              evidenceCoverage,
              realMaterialRatio: materialReuseRatio,
              approvedClaims: approvedClaims.length,
              needsEvidenceClaims: needsEvidenceClaims.length,
              blockedClaims: blockedClaims.length,
              repairedClaims: asArray(previous.repairLog).length,
              policyRisk: passport.policyRisk,
              iterationCount: readNumber(previous.iterationCount, 1),
              evidenceBreakdown: {
                materialReuseRatio,
                claimEvidenceCoverage,
                renderMetrics,
                videoScore,
                hotVideoDna: asRecord(previous.hotVideoDna),
                audit,
              },
            });
          }
          return {
            status: 'completed',
            output: { passport },
            decision: 'passport_computed',
            reason: `视频护照已生成，trustScore=${Math.round(passport.trustScore)}。`,
          };
        },
      },
      'growth.snapshot': {
        id: 'growth.snapshot',
        agentName: 'growth',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const videoScore = asRecord(previous.videoScore);
          const growthSnapshot = {
            predictedViralScore: readNumber(videoScore.viralScore, 0),
            predictedConversionFit: readNumber(videoScore.conversionFit, 0),
            dnaCoverage: asRecord(videoScore.dnaCoverage),
            nextActions: [
              '保留高分 Hook 和真实素材镜头。',
              '将低匹配分镜进入下一轮素材替换或 Seedance 重生成。',
              '上线后用真实表现数据回填因子权重。',
            ],
          };
          return {
            status: 'completed',
            output: { growthSnapshot },
            decision: 'growth_snapshot_ready',
            reason: `增长快照已生成，预测转化匹配=${growthSnapshot.predictedConversionFit}。`,
          };
        },
      },
    },
    edges: [
      { from: 'render.load_context', to: 'editing.plan' },
      { from: 'editing.plan', to: 'production.render' },
      { from: 'production.render', to: 'validator.video_score' },
      { from: 'validator.video_score', to: 'qa.audit' },
      { from: 'qa.audit', to: 'passport.compute' },
      { from: 'passport.compute', to: 'growth.snapshot' },
    ],
  };
}

function oneClickVideoGraph(): AgentGraph {
  const scriptGraph = scriptGenerateGraph();
  const renderGraph = renderFullGraph();
  const baseScriptValidator = scriptGraph.nodes['validator.script_score'];
  const baseVideoValidator = renderGraph.nodes['validator.video_score'];
  return {
    version: 'agent-graph.one-click-video.v3',
    entry: scriptGraph.entry,
    nodes: {
      ...scriptGraph.nodes,
      ...renderGraph.nodes,
      'validator.script_score': {
        ...baseScriptValidator,
        async run(ctx) {
          const result = await baseScriptValidator.run(ctx);
          const output = asRecord(result.output);
          const scriptScore = asRecord(output.scriptScore);
          const issues = asArray(scriptScore.issues);
          const previous = asRecord(ctx.input.previous);
          const iterationCount = readNumber(previous.iterationCount, 0);
          return {
            ...result,
            output: { ...output, iterationCount },
            next: issues.length > 0 && iterationCount < 1 ? ['qa.repair_script'] : ['render.load_context'],
          };
        },
      },
      'qa.repair_script': {
        id: 'qa.repair_script',
        agentName: 'qa',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const scriptId = readString(previous.scriptId);
          const repair = await runRegisteredTool(ctx, 'db.update_script_repair', { scriptId });
          const iterationCount = readNumber(previous.iterationCount, 0) + 1;
          return {
            status: 'completed',
            output: { repairLog: [...asArray(previous.repairLog), repair], iterationCount },
            decision: 'script_repaired',
            reason: `Validator 触发自动修复，repairCount=${readNumber(repair.repairCount, 0)}。`,
            next: ['storyboard.plan'],
          };
        },
      },
      'validator.video_score': {
        ...baseVideoValidator,
        async run(ctx) {
          const result = await baseVideoValidator.run(ctx);
          const output = asRecord(result.output);
          const videoScore = asRecord(output.videoScore);
          const coverage = asRecord(videoScore.dnaCoverage);
          const previous = asRecord(ctx.input.previous);
          const videoIterationCount = readNumber(previous.videoIterationCount, 0);
          const missingSignals = asArray(coverage.missingSignals)
            .map((signal) => readString(signal))
            .filter(Boolean);
          // 快速预览（demo）跳过 DNA 对齐重渲——那一轮会多花 1-2 分钟 Seedance，只为补齐覆盖缺口，
          // 对一键演示不值得；trusted_publish 仍保留。
          const isQuickPreview = readString(asRecord(ctx.run.input).generationProfile) === 'quick_preview';
          const shouldRepair =
            !isQuickPreview &&
            readString(coverage.sourceMode) === 'reference_breakdown' &&
            missingSignals.length > 0 &&
            videoIterationCount < 1;
          return {
            ...result,
            output: { ...output, videoIterationCount },
            next: shouldRepair ? ['qa.align_video_dna'] : ['qa.audit'],
          };
        },
      },
      'qa.align_video_dna': {
        id: 'qa.align_video_dna',
        agentName: 'qa',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const scriptId = readString(previous.scriptId);
          const script = await getScript(scriptId);
          const targetShot = script?.shots[script.shots.length - 1];
          const missingSignals = asArray(asRecord(asRecord(previous.videoScore).dnaCoverage).missingSignals)
            .map((signal) => readString(signal))
            .filter(Boolean);
          const targetSignal = missingSignals[0];
          if (!targetShot || !targetSignal) {
            return {
              status: 'skipped',
              output: { videoIterationCount: 1 },
              decision: 'dna_alignment_not_needed',
              reason: '未找到可修复的 DNA 覆盖缺口或目标分镜。',
              next: ['qa.audit'],
            };
          }
          const repair = await runRegisteredTool(ctx, 'db.update_shot_content', {
            scriptId,
            shotId: targetShot.id,
            issue: {
              action: 'align_dna',
              targetSignal,
              message: '成片验证发现参考 DNA 覆盖缺口，执行一次局部对齐。',
            },
          });
          return {
            status: 'completed',
            output: {
              repairLog: [...asArray(previous.repairLog), repair],
              videoIterationCount: readNumber(previous.videoIterationCount, 0) + 1,
            },
            decision: 'video_dna_repair_applied',
            reason: `已将分镜 ${targetShot.id} 对齐参考关注点：${targetSignal}。`,
            next: ['storyboard.refresh_video_repair'],
          };
        },
      },
      'storyboard.refresh_video_repair': {
        id: 'storyboard.refresh_video_repair',
        agentName: 'storyboard',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const scriptId = readString(asRecord(ctx.input.previous).scriptId);
          const storyboard = await buildStoryboard(scriptId);
          return {
            status: 'completed',
            output: { storyboard },
            decision: 'video_repair_storyboard_refreshed',
            reason: '局部 DNA 修复后已刷新分镜，并重新进入剪辑与成片验证。',
            next: ['editing.plan'],
          };
        },
      },
      'render.load_context': {
        ...renderGraph.nodes['render.load_context'],
        async run(ctx) {
          const input = asRecord(ctx.input.runInput);
          const previous = asRecord(ctx.input.previous);
          const scriptId = readString(previous.scriptId, readString(input.scriptId));
          if (!scriptId) {
            return {
              status: 'failed',
              decision: 'missing_script',
              reason: 'one_click_video 需要先生成 scriptId 后才能进入 Render Agent。',
            };
          }
          return {
            status: 'completed',
            output: {
              scriptId,
              exportOptions: {
                ...asRecord(input.exportOptions),
                provider: readRenderProvider(input.provider),
                aspectRatio: readString(
                  input.aspectRatio,
                  readString(asRecord(input.exportOptions).aspectRatio, '9:16'),
                ),
                resolution: readString(
                  input.resolution,
                  readString(asRecord(input.exportOptions).resolution, '720x1280'),
                ),
                audioMode: readString(
                  input.audioMode,
                  readString(asRecord(input.exportOptions).audioMode, 'voiceover'),
                ),
                retrievalMode: readRetrievalMode(input.retrievalMode),
                generationProfile:
                  input.generationProfile === 'quick_preview' || input.generationProfile === 'trusted_publish'
                    ? input.generationProfile
                    : undefined,
                referenceImageUrl: readString(input.referenceImageUrl) || undefined,
              },
            },
            decision: 'render_context_loaded',
            reason: `一键生成已接收剧本 ${scriptId}，进入成片导出。`,
          };
        },
      },
    },
    edges: [
      ...scriptGraph.edges,
      { from: 'validator.script_score', to: 'qa.repair_script' },
      { from: 'validator.script_score', to: 'render.load_context' },
      { from: 'qa.repair_script', to: 'storyboard.plan' },
      ...renderGraph.edges,
      { from: 'validator.video_score', to: 'qa.align_video_dna' },
      { from: 'qa.align_video_dna', to: 'storyboard.refresh_video_repair' },
      { from: 'storyboard.refresh_video_repair', to: 'editing.plan' },
    ],
  };
}

function repairShotGraph(): AgentGraph {
  return {
    version: 'agent-graph.repair-shot.v2',
    entry: 'repair.load_context',
    nodes: {
      'repair.load_context': {
        id: 'repair.load_context',
        agentName: 'qa',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const input = asRecord(ctx.run.input);
          const scriptId = readString(input.scriptId);
          if (!scriptId) {
            return {
              status: 'failed',
              decision: 'missing_script',
              reason: 'repair_shot 需要 scriptId。',
            };
          }
          return {
            status: 'completed',
            output: {
              scriptId,
              shotId: readString(input.shotId) || undefined,
              issue: asRecord(input.issue),
              provider: readRenderProvider(input.provider),
              referenceImageUrl: readString(input.referenceImageUrl) || undefined,
            },
            decision: 'repair_context_loaded',
            reason: `已加载剧本 ${scriptId} 的局部修复上下文。`,
          };
        },
      },
      'qa.detect_issue': {
        id: 'qa.detect_issue',
        agentName: 'qa',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const detected = await detectRepairIssue({
            scriptId: readString(previous.scriptId),
            shotId: readString(previous.shotId) || undefined,
            requestedIssue: asRecord(previous.issue),
          });
          return {
            status: 'completed',
            output: detected,
            decision: 'issue_selected',
            reason: `选择修复分镜 ${detected.shotId}，动作=${detected.issue.action}。`,
          };
        },
      },
      'qa.apply_repair': {
        id: 'qa.apply_repair',
        agentName: 'qa',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const scriptId = readString(previous.scriptId);
          const shotId = readString(previous.shotId);
          const script = await getScript(scriptId);
          const shot = script?.shots.find((item) => item.id === shotId);
          const repair = await runRegisteredTool(ctx, 'db.update_shot_content', {
            scriptId,
            shotId,
            issue: asRecord(previous.issue),
          });
          return {
            status: 'completed',
            output: { repair, repairLog: [repair] },
            decision: 'shot_repaired',
            reason: `已执行局部修复动作：${readString(repair.action, 'unknown')}。`,
          };
        },
      },
      'production.rerender_shot': {
        id: 'production.rerender_shot',
        agentName: 'production',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const taskId = readString(ctx.run.taskId);
          if (!taskId) {
            return { status: 'failed', decision: 'missing_task', reason: 'repair_shot 缺少 taskId。' };
          }
          const scriptId = readString(previous.scriptId);
          const shotId = readString(previous.shotId);
          await runRegisteredTool(ctx, 'worker.process_render_shot', {
            taskId,
            scriptId,
            shotId,
            provider: previous.provider,
            referenceImageUrl: readString(previous.referenceImageUrl) || undefined,
          });
          const task = await getTask(taskId);
          const payload = asRecord(task?.payload);
          return {
            status: 'completed',
            output: {
              scriptId,
              shotId,
              assetUrl: payload.assetUrl,
              provider: payload.provider,
            },
            decision: 'shot_rerendered',
            reason: `已重渲染分镜 ${shotId}。`,
          };
        },
      },
      'validator.repair_score': {
        id: 'validator.repair_score',
        agentName: 'validator',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const scriptId = readString(previous.scriptId);
          const storyboard = await buildStoryboard(scriptId);
          const scriptScore = scoreScript({ storyboard });
          return {
            status: 'completed',
            output: { storyboard, scriptScore, iterationCount: 1 },
            decision: 'repair_validated',
            reason: `修复后评分：viral=${scriptScore.viralScore}, conversion=${scriptScore.conversionFit}。`,
          };
        },
      },
    },
    edges: [
      { from: 'repair.load_context', to: 'qa.detect_issue' },
      { from: 'qa.detect_issue', to: 'qa.apply_repair' },
      { from: 'qa.apply_repair', to: 'production.rerender_shot' },
      { from: 'production.rerender_shot', to: 'validator.repair_score' },
    ],
  };
}

function abTestGraph(): AgentGraph {
  return {
    version: 'agent-graph.ab-test.v2',
    entry: 'ab.prepare_variants',
    nodes: {
      'ab.prepare_variants': {
        id: 'ab.prepare_variants',
        agentName: 'growth',
        blocking: true,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const input = asRecord(ctx.run.input);
          const taskId = readString(ctx.run.taskId);
          if (!taskId) {
            return { status: 'failed', decision: 'missing_task', reason: 'ab_test 缺少 taskId。' };
          }
          const existingScripts = [readString(input.scriptA), readString(input.scriptB)].filter(Boolean);
          const variants: Array<{ label: string; scriptId: string; source: string }> = [];
          if (existingScripts.length >= 2) {
            variants.push(
              { label: 'A', scriptId: existingScripts[0], source: 'existing' },
              { label: 'B', scriptId: existingScripts[1], source: 'existing' },
            );
          } else {
            const productId = readString(input.productId);
            if (!productId) {
              return {
                status: 'failed',
                decision: 'missing_product',
                reason: 'ab_test 需要 productId，或提供 scriptA/scriptB。',
              };
            }
            const basePrompt = readString(input.freePrompt, productId);
            for (const variant of [
              { label: 'A', mode: 'auto' as const, suffix: '问题式开场，强调真实场景。' },
              { label: 'B', mode: 'template' as const, suffix: '评论顾虑开场，强调购买前疑问。' },
            ]) {
              await runRegisteredTool(ctx, 'worker.process_script_generate', {
                taskId,
                productId,
                mode: variant.mode,
                provider: input.provider,
                retrievalMode: input.retrievalMode,
                ref: readString(input.ref) || undefined,
                freePrompt: `${basePrompt} ${variant.suffix}`.trim(),
                abLabel: variant.label,
              });
              const task = await getTask(taskId);
              const scriptId = readString(asRecord(task?.payload).scriptId);
              if (scriptId) variants.push({ label: variant.label, scriptId, source: 'generated' });
            }
          }
          return {
            status: variants.length >= 2 ? 'completed' : 'failed',
            output: { variants },
            decision: variants.length >= 2 ? 'variants_ready' : 'variants_missing',
            reason: `A/B 已准备 ${variants.length} 个剧本变体。`,
          };
        },
      },
      'ab.render_variants': {
        id: 'ab.render_variants',
        agentName: 'production',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const taskId = readString(ctx.run.taskId);
          const variants = asArray(previous.variants).map((item) => asRecord(item));
          const rendered = [];
          for (const variant of variants) {
            const scriptId = readString(variant.scriptId);
            if (!scriptId) continue;
            await runRegisteredTool(ctx, 'worker.process_render_full', {
              taskId,
              scriptId,
              exportOptions: { ...asRecord(asRecord(ctx.input.runInput).exportOptions), abLabel: variant.label },
            });
            const task = await getTask(taskId);
            const payload = asRecord(task?.payload);
            rendered.push({
              label: readString(variant.label),
              scriptId,
              videoUrl: payload.videoUrl,
              objectKey: payload.objectKey,
              provider: payload.provider,
              format: payload.format,
            });
          }
          return {
            status: 'completed',
            output: { renderedVariants: rendered },
            decision: 'variants_rendered',
            reason: `已渲染 ${rendered.length} 个 A/B 变体。`,
          };
        },
      },
      'ab.compare': {
        id: 'ab.compare',
        agentName: 'validator',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const variants = asArray(previous.renderedVariants).map((item) => asRecord(item));
          const scored: JsonMap[] = [];
          for (const variant of variants) {
            const summary = await summarizeScriptForVariant(readString(variant.scriptId), readString(variant.label));
            scored.push({ ...variant, score: summary.score });
          }
          const winner = [...scored].sort(
            (a, b) => readNumber(asRecord(b.score).conversionFit, 0) - readNumber(asRecord(a.score).conversionFit, 0),
          )[0];
          return {
            status: 'completed',
            output: { abResult: { variants: scored, winner } },
            decision: 'ab_compared',
            reason: winner
              ? `推荐 ${readString(winner.label)}，Conversion Fit=${readNumber(asRecord(winner.score).conversionFit, 0)}。`
              : '没有可比较的变体。',
          };
        },
      },
      'growth.recommend': {
        id: 'growth.recommend',
        agentName: 'growth',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          const previous = asRecord(ctx.input.previous);
          const abResult = asRecord(previous.abResult);
          const winner = asRecord(abResult.winner);
          const recommendation = {
            winnerLabel: readString(winner.label, 'A'),
            scriptId: winner.scriptId,
            videoUrl: winner.videoUrl,
            reason: '选择预测转化匹配最高的变体；上线后需要真实投放数据回填因子权重。',
          };
          return {
            status: 'completed',
            output: { recommendation },
            decision: 'recommendation_ready',
            reason: `A/B 推荐完成：${recommendation.winnerLabel}。`,
          };
        },
      },
    },
    edges: [
      { from: 'ab.prepare_variants', to: 'ab.render_variants' },
      { from: 'ab.render_variants', to: 'ab.compare' },
      { from: 'ab.compare', to: 'growth.recommend' },
    ],
  };
}

function skeletonGraph(kind: AgentRunKind): AgentGraph {
  return {
    version: `agent-graph.${kind}.skeleton.v1`,
    entry: 'intake.normalize',
    nodes: {
      'intake.normalize': {
        id: 'intake.normalize',
        agentName: 'intake',
        blocking: false,
        retry: { attempts: 1, backoffMs: 0 },
        async run(ctx) {
          return {
            status: 'completed',
            output: { kind, input: asRecord(ctx.run.input) },
            decision: 'skeleton_ready',
            reason: `${kind} 的 AgentRun 已进入真实编排运行时；业务节点将在后续阶段接入。`,
          };
        },
      },
    },
    edges: [],
  };
}

const agentGraphRegistry = createAgentRegistry([
  {
    kind: 'one_click_video',
    description: 'End-to-end script, storyboard, editing, render, validation, passport, and growth snapshot.',
    createGraph: oneClickVideoGraph,
  },
  {
    kind: 'render_full',
    description: 'Render an existing script into a composed video with editing, audit, passport, and growth outputs.',
    createGraph: renderFullGraph,
  },
  {
    kind: 'repair_shot',
    description: 'Detect, repair, rerender, and validate a single problematic shot.',
    createGraph: repairShotGraph,
  },
  {
    kind: 'ab_test',
    description: 'Prepare, render, compare, and recommend A/B creative variants.',
    createGraph: abTestGraph,
  },
]);

function graphForRun(kind: string): AgentGraph {
  return organizeIntoThreeAgents(agentGraphRegistry.create(kind) || skeletonGraph(kind as AgentRunKind));
}

export async function processAgentRun(data: { taskId: string; runId: string; kind: AgentRunKind }) {
  const run = await getAgentRun(data.runId);
  if (!run) throw new Error(`AgentRun 不存在：${data.runId}`);
  if (run.status === 'cancelled') {
    await updateTask(data.taskId, {
      status: 'cancelled',
      progress: 0,
      step: 'agent_cancelled',
      trace: {
        step: 'agent_cancelled',
        progress: 0,
        message: `AgentRun ${run.id} 已取消，Worker 跳过执行。`,
        data: { runId: run.id },
      },
    });
    return;
  }

  const abortController = new AbortController();
  const cancelPoll = setInterval(() => {
    void getAgentRun(run.id)
      .then((current) => {
        if (current?.status === 'cancelled') abortController.abort();
      })
      .catch(() => undefined);
  }, 1000);
  const logger = defaultAgentLogger();

  if (run.kind === 'script_generate') {
    const graphVersion = 'mastra.workflow.script_generate.v1';
    await updateTask(data.taskId, {
      status: 'processing',
      progress: 8,
      step: 'agent_orchestrating',
      trace: {
        step: 'agent_orchestrating',
        progress: 8,
        message: 'Mastra Workflow 开始执行 script_generate。',
        data: { runId: run.id, graphVersion },
      },
    });

    try {
      const output = await executeMastraScriptGenerate({
        run: run as AgentRunRecord,
        taskId: data.taskId,
        signal: abortController.signal,
        logger,
      });
      const result = asRecord(output.result);
      const currentRun = await getAgentRun(run.id);
      if (currentRun?.status === 'waiting_input') {
        await updateTask(data.taskId, {
          status: 'waiting_input',
          progress: 20,
          step: 'agent_waiting_input',
          payload: {
            agentRunId: run.id,
            agentOutput: output.result,
            graphVersion,
            waitingFor: asRecord(result.waitingFor),
          },
          trace: {
            step: 'agent_waiting_input',
            progress: 20,
            message: `AgentRun ${run.id} 正在等待用户补充输入。`,
            data: { runId: run.id, waitingFor: asRecord(result.waitingFor) },
          },
        });
        return;
      }
      if (currentRun?.status === 'cancelled') {
        await updateTask(data.taskId, {
          status: 'cancelled',
          progress: 0,
          step: 'agent_cancelled',
          trace: {
            step: 'agent_cancelled',
            progress: 0,
            message: `AgentRun ${run.id} 已取消。`,
            data: { runId: run.id },
          },
        });
        return;
      }

      await updateTask(data.taskId, {
        status: 'completed',
        progress: 100,
        step: 'agent_done',
        payload: {
          agentRunId: run.id,
          agentOutput: output.result,
          graphVersion,
          scriptId: readString(result.scriptId) || undefined,
        },
        trace: {
          step: 'agent_done',
          progress: 100,
          message: `AgentRun ${run.id} 已完成。`,
          data: { runId: run.id, executed: output.executed, artifactRefs: output.artifactRefs },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AgentRun 执行失败';
      await updateAgentRun(run.id, {
        status: abortController.signal.aborted || message === 'Agent run aborted' ? 'cancelled' : 'failed',
        error: message,
      }).catch(() => undefined);
      if (abortController.signal.aborted || message === 'Agent run aborted') {
        await updateTask(data.taskId, {
          status: 'cancelled',
          progress: 0,
          step: 'agent_cancelled',
          error: 'AgentRun 已取消',
          trace: {
            step: 'agent_cancelled',
            progress: 0,
            message: `AgentRun ${run.id} 已取消。`,
            data: { runId: run.id, graphVersion },
          },
        });
        return;
      }
      await updateTask(data.taskId, {
        status: 'failed',
        progress: 0,
        step: 'agent_failed',
        error: message,
        trace: {
          step: 'agent_failed',
          progress: 0,
          message,
          data: { runId: run.id, graphVersion },
        },
      });
      throw error;
    } finally {
      clearInterval(cancelPoll);
    }
    return;
  }

  const graph = graphForRun(run.kind);
  await updateAgentRun(run.id, { graphVersion: graph.version });
  await updateTask(data.taskId, {
    status: 'processing',
    progress: 8,
    step: 'agent_orchestrating',
    trace: {
      step: 'agent_orchestrating',
      progress: 8,
      message: `Agent Orchestrator 开始执行 ${run.kind}。`,
      data: { runId: run.id, graphVersion: graph.version },
    },
  });

  try {
    const output = await executeAgentGraph({
      run: run as AgentRunRecord,
      graph,
      store,
      tools: { worker: workerTools },
      signal: abortController.signal,
      createId: makeId,
      logger,
    });
    const result = asRecord(output.result);
    const currentRun = await getAgentRun(run.id);
    if (currentRun?.status === 'waiting_input') {
      await updateTask(data.taskId, {
        status: 'waiting_input',
        progress: 20,
        step: 'agent_waiting_input',
        payload: {
          agentRunId: run.id,
          agentOutput: output.result,
          graphVersion: graph.version,
          waitingFor: asRecord(result.waitingFor),
        },
        trace: {
          step: 'agent_waiting_input',
          progress: 20,
          message: `AgentRun ${run.id} 正在等待用户补充输入。`,
          data: { runId: run.id, waitingFor: asRecord(result.waitingFor) },
        },
      });
      return;
    }
    if (currentRun?.status === 'cancelled') {
      await updateTask(data.taskId, {
        status: 'cancelled',
        progress: 0,
        step: 'agent_cancelled',
        trace: {
          step: 'agent_cancelled',
          progress: 0,
          message: `AgentRun ${run.id} 已取消。`,
          data: { runId: run.id },
        },
      });
      return;
    }
    const passport = asRecord(result.passport);
    const videoId = readString(result.videoUrl, readString(passport.videoId, readString(result.objectKey)));
    await updateAgentRun(run.id, {
      scriptId: readString(result.scriptId) || undefined,
      videoId: videoId || undefined,
    });

    await updateTask(data.taskId, {
      status: 'completed',
      progress: 100,
      step: 'agent_done',
      payload: {
        agentRunId: run.id,
        agentOutput: output.result,
        graphVersion: graph.version,
        scriptId: readString(result.scriptId) || undefined,
        videoId: videoId || undefined,
        videoUrl: readString(result.videoUrl) || undefined,
      },
      trace: {
        step: 'agent_done',
        progress: 100,
        message: `AgentRun ${run.id} 已完成。`,
        data: { runId: run.id, executed: output.executed, artifactRefs: output.artifactRefs },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AgentRun 执行失败';
    if (abortController.signal.aborted || message === 'Agent run aborted') {
      await updateTask(data.taskId, {
        status: 'cancelled',
        progress: 0,
        step: 'agent_cancelled',
        error: 'AgentRun 已取消',
        trace: {
          step: 'agent_cancelled',
          progress: 0,
          message: `AgentRun ${run.id} 已取消。`,
          data: { runId: run.id, graphVersion: graph.version },
        },
      });
      return;
    }
    await updateTask(data.taskId, {
      status: 'failed',
      progress: 0,
      step: 'agent_failed',
      error: message,
      trace: {
        step: 'agent_failed',
        progress: 0,
        message,
        data: { runId: run.id, graphVersion: graph.version },
      },
    });
    throw error;
  } finally {
    clearInterval(cancelPoll);
  }
}
