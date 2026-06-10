import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  ExternalLink,
  Film,
  Globe2,
  Loader2,
  Pause,
  Play,
  ShieldCheck,
  Sparkles,
  Wand2,
} from 'lucide-react';
import type { ClaimItem, EvidenceItem, RenderResult, RenderVersion } from '../studio-types';
import { type MagicActId, type MagicProgressState } from '../generation-pipeline';

type MagicProgressProps = {
  state: MagicProgressState;
  error: string | null;
  renderVersions?: RenderVersion[];
  activeRenderVersionId?: string | null;
  onUseResult?: (renderVersionId?: string) => void;
  onSelectResult?: (renderVersionId: string) => void;
  onRegenerate?: () => void;
  onRefine?: (instruction: string) => void | Promise<void>;
  refineSuggestions?: string[];
  onPause?: () => void;
  pauseBusy?: boolean;
};

const ACT_LABELS: Record<MagicActId, { title: string; fallbackDetail: string }> = {
  research: { title: '读懂你的商品', fallbackDetail: '主图 · 卖点 · 适用人群' },
  evidence: { title: '翻真实爆款', fallbackDetail: '参考库和联网来源' },
  compose: { title: '生成剧本分镜', fallbackDetail: '脚本、镜头和字幕规划' },
  render: { title: '确认后出片', fallbackDetail: '确认分镜后再渲染视频' },
};

function EvidenceChain({ evidence, claims }: { evidence: EvidenceItem[]; claims: ClaimItem[] }) {
  if (!evidence.length && !claims.length) {
    return (
      <div className="magic-empty-note">
        本轮没有返回可展示的来源记录。补充商品资料或开启联网调研后，证据链会在这里显示。
      </div>
    );
  }
  return (
    <div className="magic-reveal-list">
      {evidence.slice(0, 8).map((item) => (
        <a
          key={item.id}
          className="magic-source-row"
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={item.sourceTitle || item.text}
        >
          <span>{item.sourceTitle || item.text}</span>
          <small>{item.sourceScope || item.sourceType}</small>
          {item.sourceUrl && <ExternalLink size={12} />}
        </a>
      ))}
      {claims.slice(0, 6).map((claim) => (
        <div key={claim.id} className="magic-source-row magic-claim-row">
          <span>{claim.text}</span>
          <small>{claim.status}</small>
          <ShieldCheck size={12} />
        </div>
      ))}
    </div>
  );
}

type ResultVersionView = {
  id?: string;
  label: string;
  createdAt?: number;
  result: RenderResult;
  active: boolean;
};

function renderMediaUrl(result: RenderResult | null | undefined) {
  return result?.videoUrl || result?.assetUrl || result?.previewUrl || '';
}

function buildResultVersions(
  state: MagicProgressState,
  renderVersions: RenderVersion[] | undefined,
  activeRenderVersionId?: string | null,
): ResultVersionView[] {
  const versions = (renderVersions || [])
    .filter((version) => renderMediaUrl(version.result))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((version, index) => ({
      id: version.id,
      label: version.label || `成片V${String(index + 1).padStart(2, '0')}`,
      createdAt: version.createdAt,
      result: version.result,
      active: version.id === activeRenderVersionId,
    }));
  if (versions.length > 0) {
    if (!versions.some((version) => version.active)) {
      versions[versions.length - 1] = { ...versions[versions.length - 1], active: true };
    }
    return versions;
  }
  return renderMediaUrl(state.renderResult)
    ? [
        {
          label: '当前成片',
          result: state.renderResult as RenderResult,
          active: true,
        },
      ]
    : [];
}

function ResultCard({
  version,
  index,
  total,
  onUseResult,
  onSelectResult,
  onRegenerate,
}: {
  version: ResultVersionView;
  index: number;
  total: number;
  onUseResult?: (renderVersionId?: string) => void;
  onSelectResult?: (renderVersionId: string) => void;
  onRegenerate?: () => void;
}) {
  const videoUrl = renderMediaUrl(version.result);
  const passport = version.result.passport;

  return (
    <article className={`magic-result-version${version.active ? ' active' : ''}`}>
      <div className="magic-result-grid">
        <div className="magic-video-panel">
          {videoUrl ? (
            version.result.format === 'html' || !/\.(mp4|mov|webm|m3u8)(\?|$)/i.test(videoUrl) ? (
              <iframe title={`${version.label}预览`} src={videoUrl} />
            ) : (
              <video src={videoUrl} controls playsInline />
            )
          ) : (
            <div className="magic-video-empty">
              <Film size={26} />
              <span>成片地址未返回</span>
            </div>
          )}
        </div>
        <div className="magic-result-copy">
          <p className="assistant-work-kicker">
            Final output · {index + 1}/{total}
          </p>
          <h2>{version.label}</h2>
          <p>{version.active ? '当前选中的成片版本。' : '已保留的历史成片版本。'}</p>
          {passport && (
            <div className="magic-passport-mini">
              <span>
                TrustScore <strong>{passport.trustScore}</strong>
              </span>
              <span>
                证据覆盖 <strong>{Math.round(passport.evidenceCoverage * 100)}%</strong>
              </span>
              <span>
                合规 <strong>{passport.policyRisk}</strong>
              </span>
            </div>
          )}
          <div className="magic-result-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                if (version.active) {
                  onUseResult?.(version.id);
                  return;
                }
                if (version.id) onSelectResult?.(version.id);
              }}
              disabled={version.active ? !onUseResult : !version.id || !onSelectResult}
            >
              <Play size={14} />
              {version.active ? '用这条' : '切到这条'}
            </button>
            {version.active && (
              <button type="button" className="secondary-button" onClick={onRegenerate} disabled={!onRegenerate}>
                再生成一版
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function ResultScreen({
  state,
  renderVersions,
  activeRenderVersionId,
  onUseResult,
  onSelectResult,
  onRegenerate,
}: MagicProgressProps) {
  const versions = buildResultVersions(state, renderVersions, activeRenderVersionId);
  const resultCount = versions.length;

  return (
    <section className="magic-result magic-result-stack" aria-label="生成结果">
      <div className="magic-result-stack-head">
        <div>
          <p className="assistant-work-kicker">Final outputs</p>
          <h2>已生成 {resultCount} 个成片版本</h2>
        </div>
      </div>
      <div className="magic-result-list">
        {versions.map((version, index) => (
          <ResultCard
            key={version.id || `${version.label}_${index}`}
            version={version}
            index={index}
            total={versions.length}
            onUseResult={onUseResult}
            onSelectResult={onSelectResult}
            onRegenerate={onRegenerate}
          />
        ))}
      </div>
      <details className="magic-why">
        <summary>
          <span>证据链</span>
          <ChevronDown size={15} />
        </summary>
        <div className="magic-why-grid">
          <section>
            <h3>
              <Globe2 size={14} />
              证据链
            </h3>
            <EvidenceChain evidence={state.evidenceSamples} claims={state.claimSamples} />
          </section>
        </div>
      </details>
    </section>
  );
}

function RenderLoadingCard({ state, error, onPause, pauseBusy }: MagicProgressProps) {
  const progress = Math.max(0, Math.min(100, Math.round(state.renderTask?.progress ?? 0)));
  const step = state.renderTask?.step || state.acts.render.detail || '正在按确认后的分镜生成完整视频';
  const statusText = progress >= 95 ? '正在收尾合成' : progress >= 50 ? '正在生成镜头并合成' : '已进入成片队列';

  return (
    <section className="render-loading-card" aria-label="成片生成中" aria-live="polite">
      <div className="render-loading-orb" aria-hidden="true">
        <Loader2 size={22} className="spin" />
      </div>
      <div className="render-loading-main">
        <p className="assistant-work-kicker">Rendering video</p>
        <div className="render-loading-head">
          <h2>成片生成中</h2>
          <strong>{progress}%</strong>
        </div>
        <p>{statusText}。上一版结果会保留，完成后会直接出现在这里。</p>
        <div
          className="render-loading-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="render-loading-meta">
          <span>{step}</span>
          {state.subject && <span>{state.subject}</span>}
        </div>
        {error && <div className="render-loading-error">{error}</div>}
      </div>
      {onPause && (
        <button type="button" className="render-loading-pause" onClick={onPause} disabled={pauseBusy}>
          {pauseBusy ? <Loader2 size={14} className="spin" /> : <Pause size={14} />}
          {pauseBusy ? '暂停中' : '暂停'}
        </button>
      )}
    </section>
  );
}

export default function MagicProgress(props: MagicProgressProps) {
  const {
    state,
    error,
    onUseResult,
    onRefine,
    onPause,
    pauseBusy,
    refineSuggestions,
    renderVersions,
    activeRenderVersionId,
  } = props;
  const renderInProgress = state.acts.render.status === 'active';
  const completedVersions = buildResultVersions(state, renderVersions, activeRenderVersionId);
  const hasCompletedVersions = completedVersions.length > 0;
  const done = hasCompletedVersions && !renderInProgress;
  if (done) return <ResultScreen {...props} />;
  if (renderInProgress && hasCompletedVersions) {
    return (
      <div className="magic-result-with-loading">
        <ResultScreen {...props} />
        <RenderLoadingCard {...props} />
      </div>
    );
  }
  if (renderInProgress) return <RenderLoadingCard {...props} />;

  const renderProgress = renderInProgress
    ? (state.renderTask?.progress ?? 0)
    : (state.renderTask?.progress ?? (state.renderResult ? 100 : null));
  const videoUrl = renderInProgress ? '' : renderMediaUrl(state.renderResult);
  const cap = renderInProgress
    ? '正在基于当前分镜再生成一版…'
    : state.subject
      ? `正在为「${state.subject}」准备方案…`
      : '方案准备中…';
  const leadText = renderInProgress
    ? `正在基于当前剧本和分镜再生成一版${state.subject ? `「${state.subject}」` : ''}成片。上一版会保留，完成后可在版本里切换：`
    : `好的，我来生成${state.subject ? `「${state.subject}」` : ''}。先匹配同类目真实爆款、提炼套路，正在产出剧本和分镜：`;
  const chips = refineSuggestions?.length
    ? refineSuggestions.slice(0, 3)
    : ['强化开场吸引力', '突出真实使用场景', '换一个成交结尾'];
  const checklist = [
    { id: 'research' as MagicActId, count: '' },
    { id: 'evidence' as MagicActId, count: state.evidenceSamples.length ? `${state.evidenceSamples.length} 条` : '' },
    { id: 'compose' as MagicActId, count: '' },
    { id: 'render' as MagicActId, count: renderProgress != null ? `${renderProgress}%` : '' },
  ];

  return (
    <section className="cbx" aria-label="生成进度">
      <div className="cbx-conv">
        <div className="cbx-msg">
          <span className="cbx-avatar">
            <Sparkles size={15} />
          </span>
          <div className="cbx-msg-body">
            <p>{leadText}</p>
            <ul className="cbx-checklist">
              {checklist.map(({ id, count }) => {
                const st = state.acts[id].status;
                const cls =
                  st === 'done'
                    ? 'done'
                    : st === 'active'
                      ? 'active'
                      : st === 'error' || st === 'skipped'
                        ? 'active'
                        : 'idle';
                return (
                  <li key={id} className={`cbx-check ${cls}`}>
                    <span className="ic">
                      {st === 'done' ? (
                        <CheckCircle2 size={16} />
                      ) : st === 'active' ? (
                        <Loader2 size={16} className="spin" />
                      ) : st === 'error' || st === 'skipped' ? (
                        <AlertCircle size={16} />
                      ) : (
                        <Circle size={16} />
                      )}
                    </span>
                    <span>{state.acts[id].headline || ACT_LABELS[id].title}</span>
                    {count && <span className="count">{count}</span>}
                  </li>
                );
              })}
            </ul>
            <p className="cbx-hint">方案会先停在剧本和分镜；想调整可以直接说，确认后再出片。</p>
            <div className="cbx-chips">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="cbx-chip"
                  onClick={() => void onRefine?.(c)}
                  disabled={!onRefine}
                >
                  {c}
                </button>
              ))}
            </div>
            {state.fallbackNotes.length > 0 && <div className="cbx-fallback">{state.fallbackNotes.join(' · ')}</div>}
            {error && (
              <div className="cbx-fallback" style={{ color: 'var(--text-danger)' }}>
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      <aside className="cbx-preview">
        <span className="cbx-preview-label">方案 · {state.subject || '9:16'}</span>
        <div className="cbx-phone">
          {videoUrl ? <video src={videoUrl} controls playsInline /> : <Play size={40} />}
          {!videoUrl && <div className="cbx-phone-cap">{cap}</div>}
        </div>
        <div className="cbx-dots">
          {[0, 1, 2].map((i) => {
            const p = renderProgress ?? 0;
            const cls = p >= (i + 1) * 33 ? ' done' : p > i * 33 ? ' run' : '';
            return (
              <span key={i} className={`cbx-dot${cls}`}>
                {i + 1}
              </span>
            );
          })}
        </div>
        <div className="cbx-actions">
          {onPause && (
            <button type="button" className="cbx-pause" onClick={onPause} disabled={pauseBusy}>
              {pauseBusy ? <Loader2 size={14} className="spin" /> : <Pause size={14} />}
              {pauseBusy ? '暂停中' : '暂停生成'}
            </button>
          )}
          <button type="button" className="cbx-refine" onClick={() => onUseResult?.()} disabled={!onUseResult}>
            <Wand2 size={14} /> 打开制作台
          </button>
        </div>
      </aside>
    </section>
  );
}
