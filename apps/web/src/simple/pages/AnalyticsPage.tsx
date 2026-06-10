import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API_BASE, type ScriptData } from '../studio-types';

interface Overview {
  dataMode: 'observed' | 'kalodata_seed' | 'simulated' | 'empty';
  disclosure: string;
  headline: string;
  totalVideos: number;
  totalImpressions: number;
  avgConversion: number;
  bestFactor?: { lift: number } | null;
}

interface Attribution {
  factorType: string;
  factorValue: string;
  lift: number;
  sampleSize: number;
}

interface AbVariant {
  label: string;
  scriptId: string;
  narrative?: string;
  conversionRate: number;
}
interface AbCompare {
  variants: AbVariant[];
  winner?: AbVariant | null;
  methodNote?: string;
}

const DATA_MODE_LABEL: Record<Overview['dataMode'], string> = {
  observed: '真实回流',
  kalodata_seed: 'Kalodata seed',
  simulated: '模拟数据',
  empty: '待接入',
};

function pct(value: number, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

export default function AnalyticsPage({ script }: { script: ScriptData | null }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [factors, setFactors] = useState<Attribution[]>([]);
  const [ab, setAb] = useState<AbCompare | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const scope = script?.id ? `?scriptId=${encodeURIComponent(script.id)}` : '';
    const factorScope = script?.id ? `&scriptId=${encodeURIComponent(script.id)}` : '';
    Promise.all([
      fetch(`${API_BASE}/analytics/overview${scope}`).then((r) => r.json() as Promise<Overview>),
      fetch(`${API_BASE}/analytics/attribution?factorType=${factorScope}`).then(
        (r) => r.json() as Promise<Attribution[]>,
      ),
      fetch(`${API_BASE}/analytics/ab-compare`)
        .then((r) => r.json() as Promise<AbCompare>)
        .catch(() => null),
    ])
      .then(([summary, data, abData]) => {
        if (!active) return;
        setOverview(summary);
        setFactors(Array.isArray(data) ? data.slice(0, 6) : []);
        setAb(abData);
      })
      .catch(() => {
        if (active)
          setOverview({
            dataMode: 'empty',
            disclosure: 'API 未就绪，等待真实回流数据。',
            headline: '',
            totalVideos: 0,
            totalImpressions: 0,
            avgConversion: 0,
          });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [script?.id]);

  if (loading)
    return (
      <div className="empty-page">
        <Loader2 size={18} className="spin" /> 加载数据看板...
      </div>
    );

  const mode = overview?.dataMode ?? 'empty';
  const maxLift = Math.max(1, ...factors.map((f) => Math.abs(f.lift)));
  const abVariants = ab?.variants ?? [];

  return (
    <div className="dash-root">
      <div className={`dash-disclosure ${mode}`}>
        <strong>{DATA_MODE_LABEL[mode]}</strong>
        <span>{overview?.disclosure}</span>
      </div>

      <div className="dash-cards">
        <div className="dash-card">
          <div className="label">生成视频</div>
          <div className="value">{overview?.totalVideos?.toLocaleString() ?? 0}</div>
        </div>
        <div className="dash-card">
          <div className="label">平均转化率</div>
          <div className="value">{pct(overview?.avgConversion ?? 0, 1)}</div>
        </div>
        <div className="dash-card">
          <div className="label">曝光样本</div>
          <div className="value">{(overview?.totalImpressions ?? 0).toLocaleString()}</div>
        </div>
        <div className="dash-card">
          <div className="label">最高因子 lift</div>
          <div className="value">{overview?.bestFactor ? `+${overview.bestFactor.lift}%` : '—'}</div>
        </div>
      </div>

      <section className="dash-panel">
        <h3>创作因子 × 转化率</h3>
        <p className="sub">哪些手法更能带来成交（按转化 lift 排序）</p>
        {factors.length ? (
          [...factors]
            .sort((a, b) => b.lift - a.lift)
            .map((f) => (
              <div className="dash-bar-row" key={f.factorType + f.factorValue}>
                <span className="name">{f.factorValue}</span>
                <div className="dash-bar-track">
                  <div
                    className={`dash-bar-fill${f.lift <= 0 ? ' dim' : ''}`}
                    style={{ width: `${Math.max(4, (Math.abs(f.lift) / maxLift) * 100)}%` }}
                  />
                </div>
                <span className={`pct${f.lift <= 0 ? ' dim' : ''}`}>
                  {f.lift > 0 ? '+' : ''}
                  {f.lift}%
                </span>
              </div>
            ))
        ) : (
          <div className="dash-empty">
            尚无可计算的因子归因。导入 Kalodata seed 或录入真实投放数据后，这里会按转化 lift 排序展示创作手法。
          </div>
        )}
      </section>

      <section className="dash-panel">
        <h3>A / B 版本对比</h3>
        <p className="sub">{ab?.methodNote || '为两条导出视频分别录入真实曝光与转化后判断胜出。'}</p>
        {abVariants.length >= 2 ? (
          <div className="dash-ab">
            {abVariants.map((v) => {
              const isWinner = ab?.winner?.scriptId === v.scriptId;
              return (
                <div className="dash-ab-card" key={v.scriptId}>
                  <div className="head">
                    <strong>
                      版本 {v.label} · {v.narrative?.slice(0, 8) || v.scriptId.slice(0, 6)}
                    </strong>
                    <span className={isWinner ? 'win' : 'ctrl'}>{isWinner ? '胜出' : '对照'}</span>
                  </div>
                  <div className="big">
                    {pct(v.conversionRate, 1)}
                    <span>转化</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="dash-empty">
            还没有可对比的两个版本。导出 A、B 两条视频并录入投放数据后，这里会标出胜出版本与相对提升。
          </div>
        )}
      </section>
    </div>
  );
}
