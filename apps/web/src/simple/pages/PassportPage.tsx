import { useEffect, useMemo, useState } from 'react';
import {
  BarChart2,
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  Link2,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  API_BASE,
  taskElapsedText,
  type ClaimItem,
  type EvidenceItem,
  type RenderResult,
  type RenderVersion,
  type ResearchData,
  type ScriptData,
  type TaskStatus,
} from '../studio-types';

type Overview = {
  dataMode: 'observed' | 'kalodata_seed' | 'simulated' | 'empty';
  disclosure: string;
  headline: string;
  totalVideos: number;
  totalImpressions: number;
  avgConversion: number;
};

type Attribution = {
  factor: string;
  factorType: string;
  factorValue: string;
  lift: number;
  sampleSize: number;
  impressions?: number;
  confidenceScore: number;
};

type AttributionState =
  | { status: 'idle'; overview: null; factors: Attribution[]; error: '' }
  | { status: 'loading'; overview: null; factors: Attribution[]; error: '' }
  | { status: 'ready'; overview: Overview | null; factors: Attribution[]; error: '' }
  | { status: 'error'; overview: Overview | null; factors: Attribution[]; error: string };

type PassportPageProps = {
  task: TaskStatus | null;
  result: RenderResult | null;
  renderVersions?: RenderVersion[];
  activeRenderVersionId?: string | null;
  script?: ScriptData | null;
  research?: ResearchData | null;
  onSelectRenderVersion?: (versionId: string) => void;
};

// 模型驱动的转化预估，对应 GET /api/scripts/:id/conversion（真实带货视频训练的打分模型）。
type ConversionResult = {
  source: string;
  modelVersion: string;
  usedEmbedding: boolean;
  appealScore: number;
  predictedConversion: number;
  archetypeMatch?: 'organic' | 'paid_roas' | 'low_follower';
  cohortSimilarities: { organicWinner: number; paidRoasWinner: number; lowFollowerWinner: number };
  label: string;
};

function formatLift(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatPercent(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '未返回';
}

function hostFromUrl(value?: string) {
  if (!value) return '';
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toAttributionRows(value: unknown): Attribution[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item as Partial<Attribution>)
    .filter((item) => typeof item.factorValue === 'string')
    .map((item) => ({
      factor: String(item.factor ?? `${item.factorType ?? ''}:${item.factorValue ?? ''}`),
      factorType: String(item.factorType ?? ''),
      factorValue: String(item.factorValue),
      lift: isFiniteNumber(item.lift) ? item.lift : 0,
      sampleSize: isFiniteNumber(item.sampleSize) ? item.sampleSize : 0,
      impressions: isFiniteNumber(item.impressions) ? item.impressions : undefined,
      confidenceScore: isFiniteNumber(item.confidenceScore) ? item.confidenceScore : 0,
    }));
}

function overviewFallback(scriptId?: string): Overview {
  return {
    dataMode: 'empty',
    disclosure: scriptId ? '该视频尚未录入投放表现，请在出片后录入真实数据。' : '当前还没有可查询的成片数据。',
    headline: '暂无可计算的归因数据。',
    totalVideos: 0,
    totalImpressions: 0,
    avgConversion: 0,
  };
}

function evidenceLabel(item: EvidenceItem) {
  return item.sourceTitle || hostFromUrl(item.sourceUrl) || item.text || item.id;
}

function EvidenceChain({ claims, evidence }: { claims: ClaimItem[]; evidence: EvidenceItem[] }) {
  const evidenceById = useMemo(() => new Map(evidence.map((item) => [item.id, item])), [evidence]);
  const supportedClaims = claims.filter((claim) => claim.evidenceIds.length);
  if (!supportedClaims.length) {
    return <div className="empty-inline">证据链未命中，当前结果没有可反查的 claims/evidence。</div>;
  }

  return (
    <div className="passport-evidence-list">
      {supportedClaims.slice(0, 4).map((claim) => {
        const linkedEvidence = claim.evidenceIds
          .map((id) => evidenceById.get(id))
          .filter((item): item is EvidenceItem => Boolean(item));
        return (
          <article key={claim.id} className="passport-evidence-claim">
            <div>
              <strong>{claim.text}</strong>
              <span>{claim.status === 'approved' ? '已采纳卖点' : '证据状态需复核'}</span>
            </div>
            {linkedEvidence.length ? (
              <div className="passport-evidence-sources">
                {linkedEvidence.slice(0, 3).map((item) =>
                  item.sourceUrl ? (
                    <a key={item.id} href={item.sourceUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={12} />
                      <span>{evidenceLabel(item)}</span>
                      <small>{item.reliability}</small>
                    </a>
                  ) : (
                    <span key={item.id} className="passport-evidence-source">
                      <Link2 size={12} />
                      <span>{evidenceLabel(item)}</span>
                      <small>{item.reliability}</small>
                    </span>
                  ),
                )}
              </div>
            ) : (
              <div className="passport-reveal-note">claim 有 evidenceIds，但当前 evidence 列表未返回对应来源。</div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function CohortPanel({ conversion, loading }: { conversion: ConversionResult | null; loading: boolean }) {
  if (loading && !conversion) {
    return (
      <div className="empty-inline">
        <Loader2 size={14} className="spin" /> 正在用训练基准模型预测转化…
      </div>
    );
  }
  if (!conversion) {
    return <div className="empty-inline">转化预测未返回（需要已生成的剧本）。</div>;
  }
  const cohorts = conversion.cohortSimilarities;
  return (
    <div className="passport-cohort-grid">
      <article className="passport-cohort-card primary">
        <span>预测转化 · organic winner prob</span>
        <strong>{formatPercent(conversion.predictedConversion)}</strong>
        <p>真实带货视频训练的打分模型判定「匹配高转化自然带货视频」的概率。{conversion.label}。</p>
      </article>
      <article className="passport-cohort-card">
        <span>整体吸引力 benchmarkScore</span>
        <strong>{formatPercent(conversion.appealScore)}</strong>
        <p>模型综合吸引力分（0-1），越高越贴近高表现样本。</p>
      </article>
      <article className="passport-cohort-card">
        <span>organic cohort 相似度</span>
        <strong>{formatPercent((cohorts.organicWinner + 1) / 2)}</strong>
        <p>与零粉自然流量赢家 cohort 的相似度，过滤“账号体量带来的假优势”。</p>
      </article>
      <article className="passport-cohort-card">
        <span>archetype · {conversion.modelVersion}</span>
        <strong>{conversion.archetypeMatch || '未返回'}</strong>
        <p>
          模型归类的最相近爆款原型；{conversion.usedEmbedding ? '基于剧本语义 embedding' : 'embedding 未返回，走兜底'}。
        </p>
      </article>
    </div>
  );
}

function AttributionTable({ factors, loading }: { factors: Attribution[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="empty-inline">
        <Loader2 size={14} className="spin" /> 正在读取可解释归因...
      </div>
    );
  }
  if (!factors.length) return <div className="empty-inline">暂无因子归因数据，当前不生成替代数字。</div>;

  const maxLift = Math.max(...factors.map((factor) => Math.abs(factor.lift)), 1);
  return (
    <div className="passport-attribution-table">
      {factors.slice(0, 8).map((factor, index) => (
        <div key={`${factor.factorType}:${factor.factorValue}`} className={index === 0 ? 'top' : undefined}>
          <span className="passport-factor-name">{factor.factorValue}</span>
          <span className="passport-lift-bar">
            <i
              className={factor.lift >= 0 ? 'pos' : 'neg'}
              style={{ width: `${Math.max(5, Math.min((Math.abs(factor.lift) / maxLift) * 100, 100))}%` }}
            />
          </span>
          <strong>{formatLift(factor.lift)}</strong>
          <small>{factor.sampleSize} 样本</small>
          <small>置信 {factor.confidenceScore.toFixed(2)}</small>
        </div>
      ))}
    </div>
  );
}

export default function PassportPage({
  task,
  result,
  renderVersions = [],
  activeRenderVersionId,
  script,
  research,
  onSelectRenderVersion,
}: PassportPageProps) {
  const [revealOpen, setRevealOpen] = useState(false);
  const [attribution, setAttribution] = useState<AttributionState>({
    status: 'idle',
    overview: null,
    factors: [],
    error: '',
  });
  const [conversion, setConversion] = useState<ConversionResult | null>(null);
  const [conversionLoading, setConversionLoading] = useState(false);

  const passport = result?.passport;
  const progress = task?.progress ?? (result ? 100 : 0);
  const elapsed = taskElapsedText(task);
  const videoUrl = result?.videoUrl || result?.assetUrl;
  const scriptId = script?.id || result?.scriptId || result?.passport?.scriptId;
  const claims = research?.claims || [];
  const evidence = research?.evidence || [];
  const sampleCount = attribution.factors.reduce((sum, factor) => sum + factor.sampleSize, 0);
  const overview = attribution.overview || overviewFallback(scriptId);

  useEffect(() => {
    if (!revealOpen || !scriptId) return;
    let active = true;
    const scope = encodeURIComponent(scriptId);
    Promise.all([
      fetch(`${API_BASE}/analytics/overview?scriptId=${scope}`).then((response) => {
        if (!response.ok) throw new Error(`overview HTTP ${response.status}`);
        return response.json() as Promise<Overview>;
      }),
      fetch(`${API_BASE}/analytics/attribution?scriptId=${scope}`).then((response) => {
        if (!response.ok) throw new Error(`attribution HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
      }),
    ])
      .then(([nextOverview, rawFactors]) => {
        if (!active) return;
        setAttribution({
          status: 'ready',
          overview: nextOverview,
          factors: toAttributionRows(rawFactors),
          error: '',
        });
      })
      .catch((error) => {
        if (!active) return;
        setAttribution({
          status: 'error',
          overview: overviewFallback(scriptId),
          factors: [],
          error: error instanceof Error ? error.message : 'analytics API unavailable',
        });
      });

    return () => {
      active = false;
    };
  }, [revealOpen, scriptId]);

  useEffect(() => {
    if (!revealOpen || !scriptId) return;
    let active = true;
    const scope = encodeURIComponent(scriptId);
    Promise.resolve()
      .then(() => {
        if (!active) return null;
        setConversionLoading(true);
        return fetch(`${API_BASE}/scripts/${scope}/conversion`);
      })
      .then((response) => {
        if (!response) return null;
        if (!response.ok) throw new Error(`conversion HTTP ${response.status}`);
        return response.json() as Promise<ConversionResult>;
      })
      .then((next) => {
        if (active && next) setConversion(next);
      })
      .catch(() => {
        if (active) setConversion(null);
      })
      .finally(() => {
        if (active) setConversionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revealOpen, scriptId]);

  const toggleReveal = () => {
    const nextOpen = !revealOpen;
    if (nextOpen && scriptId) setAttribution({ status: 'loading', overview: null, factors: [], error: '' });
    setRevealOpen(nextOpen);
  };

  if (!task && !result)
    return <div className="empty-page">完成脚本出片后，此处显示视频护照、可信分数和可交付预览。</div>;

  return (
    <div className="passport-page">
      <section className="passport-hero">
        <div>
          <p className="demo-kicker">Delivery artifact</p>
          <h2>{result ? 'Video Passport 已签发' : 'Auditor 正在核验成片'}</h2>
          <p>
            {task?.step || result?.mediaNote || '成片证据、素材来源与合规报告集中在此。'}
            {elapsed ? ` · 生成用时 ${elapsed}` : ''}
          </p>
        </div>
        <div className="passport-hero-actions">
          {renderVersions.length > 0 && (
            <label className="passport-version-select">
              <span>成片版本</span>
              <select
                value={activeRenderVersionId || renderVersions.at(-1)?.id || ''}
                onChange={(event) => onSelectRenderVersion?.(event.target.value)}
              >
                {renderVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!result && <Loader2 className="spin" />}
        </div>
      </section>
      {!result && (
        <div className="render-progress">
          <span style={{ width: `${Math.max(progress, 5)}%` }} />
        </div>
      )}
      {passport && (
        <div className="passport-score-grid">
          <article className="trust">
            <ShieldCheck />
            <strong>{passport.trustScore}</strong>
            <span>TrustScore</span>
          </article>
          <article>
            <strong>{Math.round(passport.evidenceCoverage * 100)}%</strong>
            <span>证据覆盖</span>
          </article>
          <article>
            <strong>{Math.round(passport.realMaterialRatio * 100)}%</strong>
            <span>真实素材</span>
          </article>
          <article>
            <strong>{passport.policyRisk}</strong>
            <span>合规风险</span>
          </article>
        </div>
      )}
      {videoUrl && (
        <div className="passport-delivery">
          {result.format === 'mp4' ? (
            <video controls playsInline src={videoUrl} />
          ) : (
            <iframe title="交付预览" src={videoUrl} />
          )}
          <a className="download-button" href={videoUrl}>
            <Download size={14} /> 打开交付成片
          </a>
        </div>
      )}

      {result && (
        <section className={`passport-reveal ${revealOpen ? 'open' : ''}`}>
          <button type="button" className="passport-reveal-toggle" aria-expanded={revealOpen} onClick={toggleReveal}>
            <span>为什么是这一版？</span>
            <ChevronDown size={15} />
          </button>
          {revealOpen && (
            <div className="passport-reveal-body">
              <div className="passport-reveal-line">
                这一版不是猜的：{sampleCount} 条样本回归出的因子归因 + 自然流量 cohort 验证 + 证据链可反查。
              </div>
              <div className={`data-disclosure ${overview.dataMode}`}>
                <strong>
                  {overview.dataMode === 'observed'
                    ? '真实回流数据'
                    : overview.dataMode === 'kalodata_seed'
                      ? 'Kalodata seed'
                      : overview.dataMode === 'simulated'
                        ? '模拟数据'
                        : '待接入'}
                </strong>
                <span>
                  {overview.disclosure}
                  {attribution.status === 'error' ? ` · ${attribution.error}` : ''}
                </span>
              </div>

              <div className="passport-reveal-grid">
                <section>
                  <h3>
                    <BarChart2 size={14} />
                    可解释归因 / lift
                  </h3>
                  <p className="passport-reveal-note">
                    {overview.headline} · 视频样本 {overview.totalVideos} · 曝光 {overview.totalImpressions}
                  </p>
                  <AttributionTable factors={attribution.factors} loading={attribution.status === 'loading'} />
                </section>

                <section>
                  <h3>
                    <Sparkles size={14} />
                    模型转化预估
                  </h3>
                  <p className="passport-reveal-note">
                    由真实带货视频训练的打分模型对当前剧本打分得出，作为转化代理，不是真实成交。
                  </p>
                  <CohortPanel conversion={conversion} loading={conversionLoading} />
                </section>

                <section>
                  <h3>
                    <Info size={14} />
                    证据链
                  </h3>
                  <p className="passport-reveal-note">
                    被采纳卖点反查到 claim 和 evidence；没有来源时明确标注，不补假来源。
                  </p>
                  <EvidenceChain claims={claims} evidence={evidence} />
                </section>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
