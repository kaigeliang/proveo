import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Clapperboard,
  ExternalLink,
  Loader2,
  Play,
  Search,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { API_BASE, type TaskStatus } from '../studio-types';

type ReferenceHit = {
  id: string;
  sourceUrl?: string;
  sourceDeclaration?: string;
  score: number;
  vectorScore: number;
  breakdownReport?: {
    factors?: string[];
    category?: string;
    productTitle?: string;
    qwenTruthSlice?: { shotStructure?: string[] };
  } | null;
  metadata?: {
    category?: string;
    benchmarkScore?: number | null;
    qwenTruth?: { factorIds?: string[] };
    labels?: { organicWinner?: boolean; lowFollowerWinner?: boolean; paidValidatedWinner?: boolean };
  } | null;
};

type SearchResponse = {
  query: string;
  mode: string;
  results: ReferenceHit[];
};

type RecipeSegment = {
  t: string;
  role: 'hook' | 'proof' | 'demo' | 'offer' | 'cta';
  tactic: string;
  shot: string;
  bgm?: string;
};

type CloneRecipe = {
  id: string;
  sourceUrl?: string;
  sourceReferenceId?: string;
  sourceDeclaration: string;
  productId?: string;
  title: string;
  category?: string;
  durationSeconds?: number;
  pace?: string;
  segments: RecipeSegment[];
  factors: {
    canonical: string[];
    byType: Record<string, string>;
    raw: string[];
  };
  visual?: {
    prototype?: string;
  };
  scoring?: {
    benchmarkScore?: number | null;
    vectorScore?: number | null;
    labels?: Record<string, unknown>;
  };
};

type RecipeScore = {
  benchmarkScore?: number | null;
  compositeScore?: number;
  cohortSimilarities?: {
    organicWinner?: number;
    paidRoasWinner?: number;
    lowFollowerWinner?: number;
  };
  qwenCalibrationLift?: number;
  qwenCalibratedBenchmarkScore?: number;
  missingFactors: string[];
  scriptFactors: string[];
  reasoning: string;
  improvements: string[];
};

const FACTOR_LABELS: Record<string, string> = {
  'hook:question': '钩子·痛点提问',
  'hook:shock': '钩子·高能反差',
  'hook:product_reveal': '钩子·产品揭示',
  'hook:lifestyle': '钩子·生活场景',
  'proof:demonstration': '证明·手部演示',
  'cta:benefit': 'CTA·利益点',
  'cta:urgency': 'CTA·紧迫感',
  'bgm:upbeat': 'BGM·轻快',
  'bgm:ambient': 'BGM·氛围',
  'bgm:trending': 'BGM·趋势',
  'duration:under_8': '时长·8s 内',
  'duration:8_to_12': '时长·8-12s',
  'duration:12_to_15': '时长·12-15s',
  'selling_point_density:high': '卖点密度·高',
  'selling_point_density:medium': '卖点密度·中',
  'selling_point_density:low': '卖点密度·低',
  'hook_type:product_demo': '产品演示',
  'hook_type:pain_point': '痛点开场',
  'hook_type:before_after': '前后对比',
  'hook_type:unboxing': '开箱',
  'has_hand_demo:true': '手部演示',
  'has_before_after:true': '前后对比',
  'cta_count:one': '单 CTA',
  'cta_count:multi': '多 CTA',
  'product_first_visible_second:under_1s': '产品≤1s 出现',
  'product_visible_ratio:high': '产品高占比',
  'scene_count:five_plus': '5+ 场景',
};

function labelFor(id: string) {
  if (FACTOR_LABELS[id]) return FACTOR_LABELS[id];
  const [type, value] = id.split(':');
  return value ? `${type} · ${value}` : id;
}

function percent(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '未返回';
}

function scoreText(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
}

function factorsOf(hit: ReferenceHit): string[] {
  return hit.breakdownReport?.factors || hit.metadata?.qwenTruth?.factorIds || [];
}

function categoryOf(hit: ReferenceHit) {
  return hit.metadata?.category || hit.breakdownReport?.category || '未分类';
}

function titleOf(hit: ReferenceHit) {
  return hit.breakdownReport?.productTitle || categoryOf(hit);
}

function benchmarkOf(hit: ReferenceHit) {
  return hit.metadata?.benchmarkScore ?? null;
}

function productIdFromQuery(query: string) {
  const base = query
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `clone_${base || Date.now()}`;
}

async function readApiError(response: Response) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function waitTask(taskId: string, onUpdate: (task: TaskStatus) => void): Promise<TaskStatus> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`);
    if (!response.ok) throw new Error(`任务 HTTP ${response.status}`);
    const task = (await response.json()) as TaskStatus;
    onUpdate(task);
    if (task.status === 'failed') throw new Error(task.error || '任务失败');
    if (task.status === 'completed') return task;
    await new Promise((resolve) => window.setTimeout(resolve, 900));
  }
  throw new Error('任务超时');
}

export default function CloneRadarPage({ querySeed }: { querySeed?: string }) {
  const [query, setQuery] = useState(querySeed || '');
  const [productId, setProductId] = useState(productIdFromQuery(querySeed || 'demo'));
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReferenceHit | null>(null);
  const [recipe, setRecipe] = useState<CloneRecipe | null>(null);
  const [task, setTask] = useState<TaskStatus | null>(null);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [score, setScore] = useState<RecipeScore | null>(null);

  const search = useCallback(async (value: string) => {
    const q = value.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setRecipe(null);
    setScore(null);
    setScriptId(null);
    try {
      const response = await fetch(`${API_BASE}/reference-videos/search?q=${encodeURIComponent(q)}&k=8`);
      if (!response.ok) throw new Error(await readApiError(response));
      setData((await response.json()) as SearchResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!querySeed) return;
    const timer = window.setTimeout(() => {
      void search(querySeed);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [querySeed, search]);

  const recommendedFactors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of data?.results || []) {
      for (const factor of factorsOf(hit)) counts.set(factor, (counts.get(factor) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [data]);

  const engine = data?.mode?.includes('qdrant')
    ? 'Qdrant ANN'
    : data?.mode?.includes('pgvector')
      ? 'pgvector'
      : '关键词兜底';

  const extractRecipe = async (hit: ReferenceHit) => {
    setSelected(hit);
    setExtracting(true);
    setError(null);
    setRecipe(null);
    setScore(null);
    setScriptId(null);
    try {
      const response = await fetch(`${API_BASE}/recipes/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          referenceId: hit.id,
          query,
          productId,
          title: titleOf(hit),
          category: categoryOf(hit),
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { recipe: CloneRecipe };
      setRecipe(payload.recipe);
    } catch (err) {
      setError(err instanceof Error ? err.message : '配方拆解失败');
    } finally {
      setExtracting(false);
    }
  };

  const cloneRecipe = async () => {
    if (!recipe) return;
    setCloning(true);
    setError(null);
    setTask(null);
    setScore(null);
    setScriptId(null);
    try {
      const response = await fetch(`${API_BASE}/recipes/${encodeURIComponent(recipe.id)}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: productId || productIdFromQuery(query),
          productTitle: query || recipe.title,
          provider: 'auto',
          generationProfile: 'quick_preview',
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { taskId: string; cloneId: string };
      const completed = await waitTask(payload.taskId, setTask);
      const completedPayload = (completed.payload || {}) as Record<string, unknown>;
      const completedResult =
        completedPayload.result && typeof completedPayload.result === 'object'
          ? (completedPayload.result as Record<string, unknown>)
          : {};
      const nextScriptId =
        typeof completedPayload.scriptId === 'string'
          ? completedPayload.scriptId
          : typeof completedResult.scriptId === 'string'
            ? completedResult.scriptId
            : '';
      if (!nextScriptId) throw new Error('克隆任务完成但未返回 scriptId');
      setScriptId(nextScriptId);
      const scoreResponse = await fetch(`${API_BASE}/recipes/${encodeURIComponent(recipe.id)}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptId: nextScriptId, cloneId: payload.cloneId }),
      });
      if (!scoreResponse.ok) throw new Error(await readApiError(scoreResponse));
      setScore((await scoreResponse.json()) as RecipeScore);
    } catch (err) {
      setError(err instanceof Error ? err.message : '配方克隆失败');
    } finally {
      setCloning(false);
    }
  };

  const selectedBenchmark = selected ? benchmarkOf(selected) : null;
  const recipeBenchmark = recipe?.scoring?.benchmarkScore ?? selectedBenchmark;

  return (
    <div className="clone-page">
      <section className="clone-command">
        <div className="clone-command-main">
          <label className="clone-input-wrap">
            <span>商品 / 爆款线索</span>
            <input
              value={query}
              onChange={(event) => {
                const next = event.target.value;
                setQuery(next);
                setProductId(productIdFromQuery(next));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void search(query);
              }}
              placeholder="例如：削皮器 厨房 蔬菜 演示"
            />
          </label>
          <label className="clone-input-wrap clone-product-id">
            <span>productId</span>
            <input value={productId} onChange={(event) => setProductId(event.target.value)} />
          </label>
        </div>
        <button type="button" className="clone-primary-btn" onClick={() => void search(query)} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
          {loading ? '检索中' : '找同款爆款'}
        </button>
      </section>

      {error && (
        <div className="clone-alert">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      <div className="clone-split">
        <section className="clone-panel clone-left">
          <div className="clone-panel-head">
            <div>
              <p>CloneCast</p>
              <h3>{recipe ? recipe.title : '爆款配方'}</h3>
            </div>
            {recipe && selected && (
              <button type="button" className="clone-ghost-btn" onClick={() => setRecipe(null)}>
                <ArrowLeft size={14} />
                返回列表
              </button>
            )}
          </div>

          {!recipe && (
            <>
              {data && (
                <div className="clone-search-meta">
                  <span>{engine}</span>
                  <span>{data.results.length} 条</span>
                  <span>jina-clip-v2</span>
                </div>
              )}

              {recommendedFactors.length > 0 && (
                <div className="clone-factor-strip">
                  <div className="clone-strip-title">
                    <Sparkles size={15} />
                    高频成功因子
                  </div>
                  <div className="clone-chip-row">
                    {recommendedFactors.map(([id, count]) => (
                      <span className="clone-chip" key={id}>
                        {labelFor(id)}
                        <b>x{count}</b>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="clone-hit-list">
                {(data?.results || []).map((hit, index) => (
                  <button
                    type="button"
                    className="clone-hit"
                    key={hit.id}
                    onClick={() => void extractRecipe(hit)}
                    disabled={extracting}
                  >
                    <span className="clone-rank">#{index + 1}</span>
                    <span className="clone-hit-main">
                      <span className="clone-hit-title">{titleOf(hit)}</span>
                      <span className="clone-hit-meta">
                        benchmark {scoreText(benchmarkOf(hit))} · similarity {hit.vectorScore.toFixed(3)}
                      </span>
                      <span className="clone-chip-row">
                        {factorsOf(hit)
                          .slice(0, 5)
                          .map((factor) => (
                            <span className="clone-chip small" key={factor}>
                              {labelFor(factor)}
                            </span>
                          ))}
                      </span>
                    </span>
                    {extracting && selected?.id === hit.id ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <Clapperboard size={16} />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {recipe && (
            <div className="clone-recipe">
              <div className="clone-score-row">
                <div>
                  <span>对标 benchmark</span>
                  <strong>{scoreText(recipeBenchmark)}</strong>
                </div>
                <div>
                  <span>原型</span>
                  <strong>{recipe.visual?.prototype || 'reference'}</strong>
                </div>
                <div>
                  <span>节奏</span>
                  <strong>{recipe.pace || '标准'}</strong>
                </div>
              </div>

              <div className="clone-timeline">
                {recipe.segments.map((segment, index) => (
                  <article className={`clone-segment role-${segment.role}`} key={`${segment.t}-${index}`}>
                    <span>{segment.t}</span>
                    <b>{segment.role}</b>
                    <p>{segment.tactic}</p>
                    <small>
                      {segment.shot}
                      {segment.bgm ? ` · ${segment.bgm}` : ''}
                    </small>
                  </article>
                ))}
              </div>

              <div className="clone-factor-strip">
                <div className="clone-strip-title">
                  <BarChart3 size={15} />
                  裁判识别因子
                </div>
                <div className="clone-chip-row">
                  {recipe.factors.canonical.map((factor) => (
                    <span className="clone-chip strong" key={factor}>
                      {labelFor(factor)}
                    </span>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="clone-primary-btn wide"
                onClick={() => void cloneRecipe()}
                disabled={cloning}
              >
                {cloning ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
                {cloning ? '克隆中' : '用这个配方克隆'}
              </button>

              {recipe.sourceUrl && (
                <a className="clone-source-link" href={recipe.sourceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} />
                  来源仅作结构化分析
                </a>
              )}
            </div>
          )}
        </section>

        <section className="clone-panel clone-right">
          <div className="clone-panel-head">
            <div>
              <p>生成结果</p>
              <h3>{scriptId ? '剧本已生成' : '等待克隆任务'}</h3>
            </div>
            {score && (
              <span className="clone-status-ok">
                <CheckCircle2 size={15} />
                已评分
              </span>
            )}
          </div>

          <div className="clone-stage">
            {!task && !scriptId && (
              <div className="clone-empty">
                <Play size={24} />
                <span>选择左侧配方后开始生成</span>
              </div>
            )}
            {task && (
              <div className="clone-task">
                <div className="clone-task-top">
                  <span>{task.step}</span>
                  <b>{task.progress}%</b>
                </div>
                <div className="clone-progress">
                  <span style={{ width: `${Math.max(4, Math.min(100, task.progress || 0))}%` }} />
                </div>
                <p>{task.elapsedText || task.status}</p>
              </div>
            )}
            {score && (
              <div className="clone-score-board">
                <div className="clone-hero-score">
                  <span>新片 benchmark</span>
                  <strong>{percent(score.benchmarkScore ?? undefined)}</strong>
                </div>
                <div className="clone-score-row">
                  <div>
                    <span>自然流</span>
                    <strong>{percent(score.cohortSimilarities?.organicWinner)}</strong>
                  </div>
                  <div>
                    <span>高 ROAS</span>
                    <strong>{percent(score.cohortSimilarities?.paidRoasWinner)}</strong>
                  </div>
                  <div>
                    <span>低粉</span>
                    <strong>{percent(score.cohortSimilarities?.lowFollowerWinner)}</strong>
                  </div>
                </div>
                <p>{score.reasoning}</p>
              </div>
            )}
          </div>

          <div className="clone-referee">
            <div>
              <span>对标爆款</span>
              <strong>{percent(recipeBenchmark ?? undefined)}</strong>
            </div>
            <div>
              <span>克隆得分</span>
              <strong>{percent(score?.benchmarkScore ?? undefined)}</strong>
            </div>
            <div className={score?.missingFactors?.length ? 'warn' : 'ok'}>
              <span>{score?.missingFactors?.length ? '待补因子' : '因子覆盖'}</span>
              <strong>
                {score?.missingFactors?.length
                  ? score.missingFactors.slice(0, 2).map(labelFor).join(' / ')
                  : score
                    ? '已覆盖'
                    : '待评分'}
              </strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
