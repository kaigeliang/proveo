import path from 'path';

export type AgentTrace = {
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
};

export type Evidence = {
  id: string;
  sourceType: 'product' | 'material' | 'web' | 'review' | 'reference' | 'policy';
  sourceScope?: 'official' | 'commerce' | 'review' | 'social' | 'general';
  sourceUrl?: string;
  sourceTitle?: string;
  text: string;
  reliability: 'high' | 'medium' | 'low';
  fetchedAt: string;
};

export type Claim = {
  id: string;
  productId: string;
  text: string;
  category: 'feature' | 'benefit' | 'scenario' | 'spec' | 'price' | 'social_proof';
  evidenceIds: string[];
  confidence: number;
  status: 'approved' | 'needs_evidence' | 'blocked';
  policyHits?: Array<{ ruleId: string; level: 'block' | 'warn' | 'needs_evidence'; reason: string }>;
  createdAt: string;
};

export type Slice = {
  id: string;
  materialId: string;
  thumbnailUrl: string;
  clipUrl: string;
  startTime: number;
  endTime: number;
  tags: Record<string, string[]>;
  summary: string;
  embedding?: number[];
};

export type Product = {
  id: string;
  title: string;
  category: string;
  price: string;
  audience: string;
  description: string;
  sellingPoints: string[];
  assets: unknown[];
  reviewStatus: 'approved' | 'needs_review' | 'blocked';
};

export type ResearchSearchScope = 'official' | 'commerce' | 'review' | 'social';

export type SearchPlanItem = {
  scope: ResearchSearchScope;
  label: string;
  query: string;
  sourceType: 'web' | 'review';
  maxItems: number;
};

export interface ResearchInput {
  productId: string;
  productUrl?: string;
  product: Product;
  uploadedSlices: Slice[];
  taskId?: string;
  localOnly?: boolean;
  strictEvidence?: boolean;
  webSearch?: boolean;
  searchScopes?: ResearchSearchScope[];
}

export interface ResearchOutput {
  productUrl?: string;
  evidence: Evidence[];
  claims: Claim[];
  traces: AgentTrace[];
  fromCache: boolean;
  searchPlan?: SearchPlanItem[];
}

export type ResearchProviderError = {
  message: string;
  statusText?: string;
  timeout: boolean;
};

export type ResearchCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      references?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
  }>;
};

export type ResearchResponsesResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      content?: string;
      annotations?: ResearchUrlCitation[];
    }>;
  }>;
  usage?: unknown;
};

export type ResearchUrlCitation = {
  type?: string;
  title?: string;
  url?: string;
  summary?: string;
  site_name?: string;
  publish_time?: string;
};

export type ResearchDependencies = {
  fetchPublicHtml(url: string): Promise<string>;
  completeText(body: Record<string, unknown>, timeoutMs: number): Promise<ResearchCompletionResponse>;
  createResponse(body: Record<string, unknown>, timeoutMs: number): Promise<ResearchResponsesResponse>;
  isTextConfigured(): boolean;
  describeProviderError(error: unknown): ResearchProviderError;
  readResponseText(response: ResearchResponsesResponse): string;
  readUrlCitations(response: ResearchResponsesResponse): ResearchUrlCitation[];
  ensureLocalDir(folder: string): void;
  localPathExists(filePath: string): boolean;
  readLocalText(filePath: string): string;
  statLocalPath(filePath: string): { mtimeMs: number };
  writeLocalText(filePath: string, data: string): void;
  cacheRoot?: string;
  fixtureRoot?: string;
  webSearchEnabled?: () => boolean;
  now?: () => Date;
  createId?: () => string;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function defaultNow() {
  return new Date();
}

function webSearchEnabled(deps: ResearchDependencies): boolean {
  if (deps.webSearchEnabled) return deps.webSearchEnabled();
  const value = (process.env.TRUSTLOOP_WEB_SEARCH || 'true').trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}

function randomSuffix(deps: ResearchDependencies): string {
  if (deps.createId)
    return deps
      .createId()
      .replace(/^[^_]+_?/, '')
      .slice(0, 12);
  return Math.random().toString(36).slice(2, 10);
}

function evidenceId(deps: ResearchDependencies): string {
  return `evidence_${randomSuffix(deps).slice(0, 8)}`;
}

function claimId(deps: ResearchDependencies): string {
  return `claim_${randomSuffix(deps).slice(0, 8)}`;
}

function traceId(deps: ResearchDependencies): string {
  return `trace_${randomSuffix(deps).slice(0, 8)}`;
}

function isoNow(deps: ResearchDependencies): string {
  return (deps.now || defaultNow)().toISOString();
}

function cacheDir(deps: ResearchDependencies): string {
  const dir = deps.cacheRoot || path.resolve(process.cwd(), 'apps/api/var/research-cache');
  deps.ensureLocalDir(dir);
  return dir;
}

function cacheFile(deps: ResearchDependencies, productId: string): string {
  return path.join(cacheDir(deps), `${productId}.json`);
}

function readCache(deps: ResearchDependencies, productId: string): ResearchOutput | null {
  try {
    const file = cacheFile(deps, productId);
    if (!deps.localPathExists(file)) return null;
    const stat = deps.statLocalPath(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const data = JSON.parse(deps.readLocalText(file)) as ResearchOutput;
    return { ...data, fromCache: true };
  } catch {
    return null;
  }
}

function writeCache(deps: ResearchDependencies, productId: string, output: ResearchOutput): void {
  try {
    deps.writeLocalText(cacheFile(deps, productId), JSON.stringify(output, null, 2));
  } catch {
    // Cache failures must not block production runs.
  }
}

function readFixture(deps: ResearchDependencies, productId: string): ResearchOutput | null {
  try {
    const root = deps.fixtureRoot || path.resolve(process.cwd(), 'scripts/fixtures');
    const file = path.join(root, `research-cache-${productId}.json`);
    if (!deps.localPathExists(file)) return null;
    const data = JSON.parse(deps.readLocalText(file)) as ResearchOutput;
    return { ...data, fromCache: true };
  } catch {
    return null;
  }
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)"'，。；、]+/g)].map((match) => match[0]);
}

function dedupeEvidence(items: Evidence[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceUrl || ''}|${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function configuredSearchScopes(): ResearchSearchScope[] {
  const raw = (process.env.TRUSTLOOP_SEARCH_SCOPES || 'official,commerce,review,social')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return normalizeSearchScopes(raw);
}

export function normalizeSearchScopes(value: unknown): ResearchSearchScope[] {
  const allowed: ResearchSearchScope[] = ['official', 'commerce', 'review', 'social'];
  const raw = Array.isArray(value) ? value : [];
  const scopes = raw.filter((item): item is ResearchSearchScope =>
    allowed.includes(String(item) as ResearchSearchScope),
  );
  return scopes.length ? [...new Set(scopes)] : allowed;
}

export function buildSearchPlan(product: Product, scopes: ResearchSearchScope[]): SearchPlanItem[] {
  const keyword = `${product.title} ${product.category || ''}`.trim();
  const title = product.title.trim();
  const plans: Record<ResearchSearchScope, SearchPlanItem> = {
    official: {
      scope: 'official',
      label: '官方/品牌来源',
      query: `${keyword} 官方网站 官方参数 规格 产品介绍`,
      sourceType: 'web',
      maxItems: 3,
    },
    commerce: {
      scope: 'commerce',
      label: '电商平台商品页',
      query: `${keyword} 京东 天猫 抖音电商 商品页 价格 参数 卖点`,
      sourceType: 'web',
      maxItems: 3,
    },
    review: {
      scope: 'review',
      label: '专业测评/对比',
      query: `${keyword} 专业测评 对比 评测 参数 体验`,
      sourceType: 'review',
      maxItems: 3,
    },
    social: {
      scope: 'social',
      label: '用户评论/社媒体验',
      query: `${title || keyword} 真实用户评价 小红书 知乎 什么值得买 使用体验 缺点`,
      sourceType: 'review',
      maxItems: 3,
    },
  };
  return scopes.map((scope) => plans[scope]);
}

class TraceCollector {
  private traces: AgentTrace[] = [];

  constructor(
    private readonly deps: ResearchDependencies,
    private readonly taskId: string,
  ) {}

  start(step: string): {
    finish: (data: Omit<AgentTrace, 'id' | 'taskId' | 'agent' | 'step' | 'startedAt' | 'finishedAt'>) => void;
  } {
    const startedAt = isoNow(this.deps);
    return {
      finish: (data) => {
        this.traces.push({
          id: traceId(this.deps),
          taskId: this.taskId,
          agent: 'research',
          step,
          startedAt,
          finishedAt: isoNow(this.deps),
          ...data,
        });
      },
    };
  }

  all(): AgentTrace[] {
    return this.traces;
  }
}

const TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;
const META_DESC_RE = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i;
const META_OG_DESC_RE = /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i;

async function fetchProductPage(deps: ResearchDependencies, url: string): Promise<Evidence | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const data = await deps.fetchPublicHtml(url);
    if (typeof data !== 'string') return null;

    const title = (data.match(TITLE_RE)?.[1] || '').trim();
    const desc = (data.match(META_DESC_RE)?.[1] || data.match(META_OG_DESC_RE)?.[1] || '').trim();
    const text = [title, desc].filter(Boolean).join('\n').slice(0, 500);
    if (!text) return null;

    return {
      id: evidenceId(deps),
      sourceType: 'product',
      sourceUrl: url,
      sourceTitle: title || '商品页',
      text,
      reliability: 'high',
      fetchedAt: isoNow(deps),
    };
  } catch {
    return null;
  }
}

async function searchVolcWeb(
  deps: ResearchDependencies,
  plan: SearchPlanItem,
  taskTracer: TraceCollector,
  requestWebSearch = true,
): Promise<Evidence[]> {
  const query = plan.query;
  if (!deps.isTextConfigured()) {
    const finish = taskTracer.start('search_volc_web').finish;
    finish({
      inputRefs: [query],
      outputRefs: [],
      decision: 'skipped',
      reason: '未配置 Doubao 文本 provider',
      status: 'fallback',
    });
    return [];
  }

  const t = taskTracer.start('search_volc_web');

  try {
    const useWebSearch = requestWebSearch && webSearchEnabled(deps);
    const systemPrompt = `你是严谨的电商商品研究员。本轮只关注「${plan.label}」。整理 3-${plan.maxItems} 条可引用的事实摘录或同类商品参考，每条 ≤ 100 字。
来源优先级：官方/商品页 > 权威测评/媒体 > 用户评价/社媒 > 通用常识。
reliability 判定：有明确官方/测评出处=high；多方一致的用户反馈=medium；仅凭通用推断=low。
只整理可被引用的客观事实，不要编造参数、功效或承诺；不确定 URL 可省略，但 text 必须是可独立成立的事实陈述。
输出 JSON 数组：[{"title":string,"url":string,"text":string,"reliability":"high|medium|low"}]。`;

    let content = '';
    let refs: Array<{ title?: string; url?: string; snippet?: string }> = [];

    if (useWebSearch) {
      const response = await deps.createResponse(
        {
          input: `${systemPrompt}\n\n请联网研究：${query}`,
          tools: [{ type: 'web_search' }],
          temperature: 0.3,
          max_output_tokens: 1200,
        },
        60_000,
      );
      content = deps.readResponseText(response);
      refs = deps.readUrlCitations(response).map((citation) => ({
        title: citation.title || citation.site_name,
        url: citation.url,
        snippet: citation.summary,
      }));
      if (refs.length === 0) {
        refs = extractUrls(content).map((url) => ({ title: url, url, snippet: url }));
      }
    } else {
      const response = await deps.completeText(
        {
          messages: [
            {
              role: 'system',
              content: `${systemPrompt} 基于你已有的知识和 case 库回答，不要假装已经联网。`,
            },
            { role: 'user', content: `请研究：${query}` },
          ],
          temperature: 0.3,
        },
        30_000,
      );
      const message = response.choices?.[0]?.message || {};
      content = typeof message.content === 'string' ? message.content : '';
      refs = Array.isArray(message.references) ? message.references : [];
    }

    const jsonMatch = content.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    let parsed: Array<{ title?: string; url?: string; text?: string; reliability?: string }> = [];
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
      } catch {
        parsed = [];
      }
    }

    const merged: Evidence[] = dedupeEvidence(
      [
        ...parsed.map((item) => ({
          id: evidenceId(deps),
          sourceType: plan.sourceType,
          sourceScope: plan.scope,
          sourceUrl: item.url,
          sourceTitle: item.title || '搜索结果',
          text: (item.text || '').slice(0, 500),
          reliability:
            item.reliability === 'high' || item.reliability === 'low'
              ? (item.reliability as 'high' | 'low')
              : ('medium' as const),
          fetchedAt: isoNow(deps),
        })),
        ...refs.map((ref) => ({
          id: evidenceId(deps),
          sourceType: plan.sourceType,
          sourceScope: plan.scope,
          sourceUrl: ref.url,
          sourceTitle: ref.title || '搜索引用',
          text: (ref.snippet || ref.title || ref.url || '').slice(0, 500),
          reliability: 'medium' as const,
          fetchedAt: isoNow(deps),
        })),
      ].filter((e) => e.text && (!useWebSearch || e.sourceUrl)),
    ).slice(0, plan.maxItems);

    t.finish({
      inputRefs: [query],
      outputRefs: merged.map((e) => e.id),
      decision: `获得 ${merged.length} 条 web evidence`,
      reason: useWebSearch ? `豆包内置 web_search 联网 · ${plan.label}` : `仅 LLM 知识库 · ${plan.label}`,
      status: merged.length > 0 ? 'ok' : 'fallback',
    });

    return merged;
  } catch (err) {
    const providerError = deps.describeProviderError(err);
    t.finish({
      inputRefs: [query],
      outputRefs: [],
      decision: 'failed',
      reason: providerError.message,
      status: 'error',
      errorMessage: providerError.statusText || providerError.message,
    });
    return [];
  }
}

async function extractClaims(
  deps: ResearchDependencies,
  product: Product,
  evidence: Evidence[],
  taskTracer: TraceCollector,
): Promise<Claim[]> {
  if (!deps.isTextConfigured() || evidence.length === 0) {
    return [];
  }

  const t = taskTracer.start('extract_claims');
  const evidenceSubset = [...evidence]
    .sort((a, b) => (b.reliability === 'high' ? 1 : 0) - (a.reliability === 'high' ? 1 : 0))
    .slice(0, 8);
  const evidenceDigest = evidenceSubset
    .map((e, i) => `[E${i}|${e.id}|${e.sourceType}|${e.reliability}] ${e.text.slice(0, 150)}`)
    .join('\n');

  const systemPrompt = `你是电商带货剧本的"卖点提炼师"。基于给定的 evidence 列表，为商品提取 5-8 个可引用的 claim（卖点）。
每个 claim 必须：
1. 文本简短自然（≤ 30 字），适合视频台词
2. 在 evidenceIds 中列出**至少一条**支撑证据（用 E0/E1... 对应的 id）
3. 不得编造证据中没有的内容
4. category 在 feature/benefit/scenario/spec/price/social_proof 中选一
输出 JSON 对象，不要任何额外文字。Schema：
{"claims":[{"text":string,"category":string,"evidenceIds":string[],"confidence":number}]}`;

  const userPrompt = `商品：${product.title}（${product.category}）
卖点提示：${(product.sellingPoints || []).join('、')}
人群：${product.audience}
描述：${product.description}

Evidence：
${evidenceDigest}`;

  const callLLM = async () =>
    deps.completeText(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      },
      90_000,
    );

  try {
    let resp;
    try {
      resp = await callLLM();
    } catch (firstErr) {
      if (deps.describeProviderError(firstErr).timeout) {
        await new Promise((r) => setTimeout(r, 2000));
        resp = await callLLM();
      } else {
        throw firstErr;
      }
    }

    const content: string = resp.choices?.[0]?.message?.content || '';
    let parsed: Array<{
      text?: string;
      category?: string;
      evidenceIds?: string[];
      confidence?: number;
    }> = [];

    try {
      const root = JSON.parse(content) as unknown;
      if (Array.isArray(root)) {
        parsed = root as typeof parsed;
      } else if (root && typeof root === 'object' && Array.isArray((root as { claims?: unknown }).claims)) {
        parsed = (root as { claims: typeof parsed }).claims;
      } else {
        const jsonMatch = content.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
      }
    } catch {
      // JSON parse failure is reported through trace below.
    }

    if (parsed.length === 0) {
      t.finish({
        inputRefs: evidence.map((e) => e.id),
        outputRefs: [],
        decision: 'no_json',
        reason: 'LLM 未返回有效 JSON 数据',
        status: 'error',
      });
      return [];
    }

    const evidenceLookup = new Map<string, string>();
    evidence.forEach((e, i) => {
      evidenceLookup.set(`E${i}`, e.id);
      evidenceLookup.set(e.id, e.id);
    });

    const claims: Claim[] = parsed
      .filter((c) => c.text && Array.isArray(c.evidenceIds))
      .map((c) => {
        const resolvedEvidenceIds = (c.evidenceIds || [])
          .map((id) => evidenceLookup.get(id))
          .filter((id): id is string => Boolean(id));
        return {
          id: claimId(deps),
          productId: product.id,
          text: c.text!.trim().slice(0, 60),
          category: (['feature', 'benefit', 'scenario', 'spec', 'price', 'social_proof'].includes(c.category || '')
            ? c.category
            : 'feature') as Claim['category'],
          evidenceIds: resolvedEvidenceIds,
          confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.7,
          status: 'needs_evidence',
          createdAt: isoNow(deps),
        };
      });

    t.finish({
      inputRefs: evidence.map((e) => e.id),
      outputRefs: claims.map((c) => c.id),
      decision: `抽取 ${claims.length} 条 claim`,
      reason: `LLM 基于 ${evidence.length} 条 evidence 抽取`,
      status: claims.length > 0 ? 'ok' : 'fallback',
    });

    return claims;
  } catch (err) {
    const providerError = deps.describeProviderError(err);
    t.finish({
      inputRefs: evidence.map((e) => e.id),
      outputRefs: [],
      decision: 'failed',
      reason: providerError.message,
      status: 'error',
      errorMessage: providerError.message,
    });
    return [];
  }
}

function evidenceFromMaterial(deps: ResearchDependencies, slices: Slice[], productId: string): Evidence[] {
  return slices.slice(0, 6).map((s) => ({
    id: evidenceId(deps),
    sourceType: 'material',
    sourceUrl: s.clipUrl || s.thumbnailUrl,
    sourceTitle: `素材切片 ${s.id}`,
    text: (s.summary || `slice ${s.id} 的真实素材`).slice(0, 300),
    reliability: 'high',
    fetchedAt: isoNow(deps),
  }));
}

function fallbackClaimsFromEvidence(deps: ResearchDependencies, product: Product, evidence: Evidence[]): Claim[] {
  return evidence.slice(0, 3).map((item) => ({
    id: claimId(deps),
    productId: product.id,
    text:
      item.sourceType === 'material'
        ? `已提供${product.title}真实素材，可查看外观细节`
        : `${product.title}信息以商品页原文为准`,
    category: 'feature',
    evidenceIds: [item.id],
    confidence: item.reliability === 'high' ? 0.8 : 0.6,
    status: 'needs_evidence',
    createdAt: isoNow(deps),
  }));
}

export async function runResearchAgent(
  input: ResearchInput & { noCache?: boolean },
  deps: ResearchDependencies,
): Promise<ResearchOutput> {
  if (!input.noCache && input.uploadedSlices.length === 0 && !input.productUrl) {
    const cached = readCache(deps, input.productId);
    if (cached) return cached;
  }

  const tracer = new TraceCollector(deps, input.taskId || `task_${randomSuffix(deps).slice(0, 8)}`);
  const evidence: Evidence[] = [];
  let searchPlan: SearchPlanItem[] = [];

  const materialEvidence = evidenceFromMaterial(deps, input.uploadedSlices, input.productId);
  evidence.push(...materialEvidence);

  if (input.productUrl && !input.localOnly) {
    const t = tracer.start('fetch_product_page');
    const pageEvidence = await fetchProductPage(deps, input.productUrl);
    if (pageEvidence) {
      evidence.push(pageEvidence);
      t.finish({
        inputRefs: [input.productUrl],
        outputRefs: [pageEvidence.id],
        decision: '抓取成功',
        reason: `提取 ${pageEvidence.text.length} 字`,
        status: 'ok',
      });
    } else {
      t.finish({
        inputRefs: [input.productUrl],
        outputRefs: [],
        decision: '抓取失败',
        reason: '页面超时/反爬/非 HTML',
        status: 'fallback',
      });
    }
  }

  if (!input.localOnly) {
    const scopes = Array.isArray(input.searchScopes)
      ? normalizeSearchScopes(input.searchScopes)
      : configuredSearchScopes();
    searchPlan = buildSearchPlan(input.product, scopes);
    const scopedEvidence = await Promise.all(
      searchPlan.map((plan) => searchVolcWeb(deps, plan, tracer, input.webSearch)),
    );
    evidence.push(...scopedEvidence.flat());
  }

  if (input.strictEvidence) {
    const before = evidence.length;
    const sourceBacked = evidence.filter(
      (item) =>
        item.sourceType === 'material' ||
        item.sourceType === 'product' ||
        Boolean(item.sourceUrl && item.sourceUrl.trim()),
    );
    if (sourceBacked.length !== before) {
      const t = tracer.start('strict_source_filter');
      t.finish({
        inputRefs: evidence.map((item) => item.id),
        outputRefs: sourceBacked.map((item) => item.id),
        decision: `保留 ${sourceBacked.length}/${before} 条可核验 evidence`,
        reason: '严格模式要求 evidence 具备商品页、上传素材或可访问来源 URL',
        status: sourceBacked.length > 0 ? 'ok' : 'error',
      });
      evidence.splice(0, evidence.length, ...sourceBacked);
    }
    if (evidence.length === 0) {
      const webSearchHint =
        input.webSearch && !webSearchEnabled(deps)
          ? '当前后端已显式关闭联网搜索（TRUSTLOOP_WEB_SEARCH=false/0/off）。'
          : '联网搜索没有返回带引用 URL 的结果。';
      throw new Error(
        `严格证据模式没有拿到可核验来源：${webSearchHint}请提供商品 URL、上传素材，或启用带引用 URL 的联网搜索。`,
      );
    }
  }

  let claims = input.localOnly ? [] : await extractClaims(deps, input.product, evidence, tracer);
  if (claims.length === 0 && evidence.length > 0 && !input.strictEvidence) {
    const fallback = tracer.start('extract_claims_local_fallback');
    claims = fallbackClaimsFromEvidence(deps, input.product, evidence);
    fallback.finish({
      inputRefs: evidence.map((item) => item.id),
      outputRefs: claims.map((claim) => claim.id),
      decision: `生成 ${claims.length} 条保守 claim`,
      reason: input.localOnly ? '本地演示模式只使用已上传素材' : '外部模型未产出可用 claim',
      status: 'fallback',
    });
  }
  if (input.strictEvidence && claims.length === 0) {
    throw new Error('严格证据模式未能从可核验 evidence 抽取 claim：请检查来源内容或文本模型配置。');
  }

  const output: ResearchOutput = {
    productUrl: input.productUrl,
    evidence,
    claims,
    traces: tracer.all(),
    fromCache: false,
    searchPlan,
  };

  if (evidence.length === 0 && claims.length === 0 && !input.strictEvidence) {
    const fixture = readFixture(deps, input.productId);
    if (fixture) return fixture;
  }

  writeCache(deps, input.productId, output);
  return output;
}

export function buildEvidenceMap(evidence: Evidence[]): Map<string, Evidence> {
  return new Map(evidence.map((e) => [e.id, e]));
}

export function buildClaimLedger(claims: Claim[]): Map<string, Claim> {
  return new Map(claims.map((c) => [c.id, c]));
}
