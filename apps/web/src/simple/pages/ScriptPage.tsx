import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Captions,
  ChevronDown,
  Clapperboard,
  Film,
  Image as ImageIcon,
  Layers,
  Loader2,
  MessageSquareText,
  Mic,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Send,
  Sparkles,
  Trash2,
  Video,
  Wand2,
} from 'lucide-react';
import {
  API_BASE,
  normalizeScript,
  type MaterialAngle,
  type RenderResult,
  type RenderVersion,
  type ResearchData,
  type ScriptData,
  type ScriptVersion,
  type ShotItem,
  type TaskStatus,
  type TextLayerItem,
} from '../studio-types';

type ShotStatus = 'done' | 'running' | 'failed' | 'draft';
type SubtitlePosition = 'top' | 'middle' | 'bottom';

const WORKFLOW_STAGES = ['素材', '配方', '分镜', '成片', '交付'] as const;
const ASSISTANT_SUGGESTIONS = ['强化痛点', '字幕下移', '节奏更快'] as const;

function isVideoAsset(url?: string) {
  return Boolean(url && /\.(mp4|mov|webm|m3u8)(\?|$)/i.test(url));
}

function isImageAsset(url?: string) {
  return Boolean(url && (url.startsWith('data:image/') || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)));
}

function fmtTime(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function shotStatus(shot: ShotItem, renderBusy: boolean, selectedId?: string): ShotStatus {
  if (shot.status) return shot.status === 'generating' ? 'running' : shot.status;
  if (shot.assetUrl) return 'done';
  if (renderBusy && shot.id === selectedId) return 'running';
  return 'draft';
}

function shortShotLabel(shot: ShotItem) {
  const source = shot.subtitle || shot.narration || shot.visualDesc || `镜头 ${shot.order}`;
  const compact = source
    .replace(/[，。,.!?！？]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)[0];
  return (compact || `镜头 ${shot.order}`).slice(0, 6);
}

function positionFromShot(shot?: ShotItem): SubtitlePosition {
  const y = shot?.textLayers?.[0]?.position?.y ?? 0.82;
  if (y < 0.45) return 'top';
  if (y < 0.74) return 'middle';
  return 'bottom';
}

function updateSubtitlePosition(shot: ShotItem, position: SubtitlePosition): TextLayerItem[] {
  const y = position === 'top' ? 0.28 : position === 'middle' ? 0.64 : 0.82;
  const baseLayers = shot.textLayers?.length
    ? shot.textLayers
    : [
        {
          id: `text_${shot.id}_subtitle`,
          type: 'subtitle' as const,
          text: shot.subtitle || shot.narration || '',
          start: 0,
          end: Math.max(1, Number(shot.duration || 3)),
          position: { x: 0.5, y },
          style: { fontSize: 28, color: '#FFFFFF', stroke: '#111827', align: 'center' as const },
          editable: true,
        },
      ];
  return baseLayers.map((layer, index) => (index === 0 ? { ...layer, position: { ...layer.position, y } } : layer));
}

function MediaThumb({ url, label }: { url?: string; label: string }) {
  if (!url) {
    return (
      <span className="edit-thumb-fallback" aria-hidden="true">
        <ImageIcon size={15} />
      </span>
    );
  }
  if (isVideoAsset(url)) return <video src={url} muted playsInline title={label} />;
  if (isImageAsset(url)) return <img src={url} alt={label} />;
  return <iframe title={label} src={url} />;
}

export default function ScriptPage({
  research,
  script,
  busy,
  error,
  task,
  renderResult,
  renderVersions = [],
  activeRenderVersionId,
  scriptVersions = [],
  activeScriptVersionId,
  selectedAngle,
  productTitle,
  onScriptChange,
  onSelectScriptVersion,
  onSelectRenderVersion,
  onRenameScriptVersion,
  onRenameRenderVersion,
  onRender,
  onPreviewFirstShot,
  onNavigateStart,
  onNavigateMaterials,
  onNavigatePassport,
}: {
  research: ResearchData | null;
  script: ScriptData | null;
  busy: string | null;
  error: string | null;
  task: TaskStatus | null;
  renderResult: RenderResult | null;
  renderVersions?: RenderVersion[];
  activeRenderVersionId?: string | null;
  scriptVersions?: ScriptVersion[];
  activeScriptVersionId?: string | null;
  selectedAngle?: MaterialAngle | null;
  productTitle?: string;
  onScriptChange: (script: ScriptData) => void;
  onSelectScriptVersion?: (versionId: string) => void;
  onSelectRenderVersion?: (versionId: string) => void;
  onRenameScriptVersion?: (versionId: string, label: string) => void;
  onRenameRenderVersion?: (versionId: string, label: string) => void;
  onRender: () => Promise<void>;
  onPreviewFirstShot: () => Promise<void>;
  onNavigateStart: () => void;
  onNavigateMaterials: () => void;
  onNavigatePassport: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<(typeof WORKFLOW_STAGES)[number]>('分镜');
  const [assetsCollapsed, setAssetsCollapsed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [activePreviewShotId, setActivePreviewShotId] = useState<string | null>(null);
  const [loopPreviewSegment, setLoopPreviewSegment] = useState(false);
  const [addingShot, setAddingShot] = useState(false);
  const [deletingShot, setDeletingShot] = useState(false);
  const [assistantText, setAssistantText] = useState('');
  const [assistantStatus, setAssistantStatus] = useState('');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    formula: false,
    narration: false,
    compliance: false,
    feedback: false,
  });

  const shots = useMemo(() => script?.shots ?? [], [script?.shots]);
  const renderBusy = busy === 'render';
  const selected = shots.find((s) => s.id === selectedId) ?? shots[0];
  const activeScriptVersion =
    scriptVersions.find((version) => version.id === activeScriptVersionId) || scriptVersions.at(-1) || null;
  const activeRenderVersion =
    renderVersions.find((version) => version.id === activeRenderVersionId) || renderVersions.at(-1) || null;
  const versionTreeVisible = scriptVersions.length > 0 || renderVersions.length > 0;
  const versionTreeTitle = activeScriptVersion?.label || activeRenderVersion?.label || '未命名方案';
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const rawRanges = useMemo(() => {
    return shots.reduce<Array<{ shot: ShotItem; start: number; end: number; duration: number }>>((items, shot) => {
      const start = items.at(-1)?.end ?? 0;
      const duration = Math.max(1, Number(shot.duration || 3));
      return [...items, { shot, start, end: start + duration, duration }];
    }, []);
  }, [shots]);

  const scriptDuration = rawRanges.at(-1)?.end ?? 0;
  const approvedClaims = research?.claims.filter((claim) => claim.status === 'approved').length ?? 0;
  const blockedClaims = research?.claims.filter((claim) => claim.status === 'blocked').length ?? 0;
  const selectedStatus = selected ? shotStatus(selected, renderBusy, selected.id) : 'draft';
  const subtitlePosition = positionFromShot(selected);
  const fullVideoUrl = renderResult?.videoUrl || renderResult?.assetUrl || renderResult?.previewUrl;
  const hasFullVideo = isVideoAsset(fullVideoUrl);
  const previewUrl =
    fullVideoUrl ||
    selected?.assetUrl ||
    selectedAngle?.previewUrl ||
    selectedAngle?.referenceImageUrl ||
    selectedAngle?.imageUrl;
  const totalDuration = hasFullVideo && videoDuration > 0 ? videoDuration : scriptDuration;
  const ranges = useMemo(() => {
    if (!scriptDuration || !totalDuration) return rawRanges;
    const scale = totalDuration / scriptDuration;
    return rawRanges.map((range) => ({
      ...range,
      start: range.start * scale,
      end: range.end * scale,
      duration: range.duration * scale,
    }));
  }, [rawRanges, scriptDuration, totalDuration]);
  const activePreviewRange = activePreviewShotId
    ? ranges.find((range) => range.shot.id === activePreviewShotId) || null
    : null;
  const transportDuration = activePreviewRange
    ? Math.max(0, activePreviewRange.end - activePreviewRange.start)
    : totalDuration;
  const transportPlayhead = activePreviewRange
    ? Math.min(transportDuration, Math.max(0, playhead - activePreviewRange.start))
    : playhead;
  const transportProgress = transportDuration
    ? Math.min(100, Math.max(0, (transportPlayhead / transportDuration) * 100))
    : 0;
  const timelineTicks = useMemo(() => {
    const end = Math.max(totalDuration || 0, 1);
    return Array.from({ length: 6 }, (_, index) => (end * index) / 5);
  }, [totalDuration]);
  const projectStatus = renderBusy
    ? `正在成片${task?.progress ? ` · ${task.progress}%` : ''}`
    : renderResult
      ? '可预览导出'
      : '分镜待确认';
  const workbenchTitle = productTitle?.trim() || '商品宣传片';

  const materialItems = useMemo(() => {
    const items: Array<{ key: string; label: string; source: string; url?: string; shotId?: string }> = [];
    if (selectedAngle) {
      items.push({
        key: selectedAngle.id,
        label: selectedAngle.label,
        source: '角度参考',
        url: selectedAngle.referenceImageUrl || selectedAngle.imageUrl,
      });
    }
    shots
      .filter((shot) => shot.assetUrl)
      .slice(0, 3)
      .forEach((shot) => {
        items.push({
          key: shot.id,
          label: `镜头 ${shot.order}`,
          source: '已生成画面',
          url: shot.assetUrl,
          shotId: shot.id,
        });
      });
    while (items.length < 3) {
      const idx = items.length + 1;
      items.push({
        key: `empty-${idx}`,
        label: idx === 1 ? '主图参考' : idx === 2 ? '细节角度' : '包装视角',
        source: '待补充',
      });
    }
    return items.slice(0, 3);
  }, [selectedAngle, shots]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVideoDuration(0);
      setPlayhead(0);
      setIsPlaying(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [previewUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setActivePreviewShotId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fullVideoUrl]);

  if (!script) {
    return (
      <div className="edit-root">
        <div className="edit-empty">
          <Film size={30} />
          <strong>制作台还没有分镜</strong>
          <p>从“开始生成”输入商品名或链接，系统会先生成可编辑的分镜时间线，确认后再成片。</p>
          <button type="button" className="edit-primary" onClick={onNavigateStart}>
            <Wand2 size={14} /> 回到开始生成
          </button>
        </div>
      </div>
    );
  }

  const updateShot = (id: string, patch: Partial<ShotItem>) => {
    onScriptChange({ ...script, shots: shots.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)) });
  };

  const seekPreview = (seconds: number) => {
    const next = Math.max(0, Math.min(seconds, totalDuration || seconds));
    setPlayhead(next);
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(next, Math.max(0, video.duration - 0.05));
    }
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      return;
    }
    if (
      activePreviewRange &&
      (video.currentTime < activePreviewRange.start || video.currentTime >= activePreviewRange.end)
    ) {
      video.currentTime = activePreviewRange.start;
      setPlayhead(activePreviewRange.start);
    } else if (video.duration && video.currentTime >= video.duration) {
      video.currentTime = 0;
      setPlayhead(0);
    }
    void video.play().catch(() => setIsPlaying(false));
  };

  const handleVideoTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const current = video.currentTime;
    if (activePreviewRange && current >= activePreviewRange.end - 0.04) {
      if (loopPreviewSegment) {
        video.currentTime = activePreviewRange.start;
        setPlayhead(activePreviewRange.start);
        void video.play().catch(() => setIsPlaying(false));
        return;
      }
      video.pause();
      video.currentTime = activePreviewRange.end;
      setPlayhead(activePreviewRange.end);
      setIsPlaying(false);
      return;
    }
    setPlayhead(current);
    if (!activePreviewRange) {
      const nextRange = ranges.find((range) => current >= range.start && current < range.end);
      if (nextRange && nextRange.shot.id !== selectedId) setSelectedId(nextRange.shot.id);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`${API_BASE}/scripts/${encodeURIComponent(script.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          narrative: script.narrative,
          visualStyle: script.visualStyle,
          bgm: script.bgm,
          language: script.language,
        }),
      });
      await Promise.all(
        shots.map((shot) =>
          fetch(`${API_BASE}/scripts/${encodeURIComponent(script.id)}/shots/${encodeURIComponent(shot.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(shot),
          }),
        ),
      );
      setAssistantStatus('已保存当前制作台。');
      return true;
    } catch {
      setAssistantStatus('网络不可用，本地修改已保留。');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const confirmRender = async () => {
    const saved = await save();
    if (!saved) return;
    await onRender();
  };

  const selectShot = (id: string) => {
    setSelectedId(id);
    const nextRange = ranges.find((range) => range.shot.id === id);
    if (nextRange) seekPreview(nextRange.start);
    setIsPlaying(false);
  };

  const selectTimelineShot = (id: string) => {
    const nextRange = ranges.find((range) => range.shot.id === id);
    const isCancellingSelection = activePreviewShotId === id;
    setSelectedId(id);
    setActivePreviewShotId(isCancellingSelection ? null : id);
    setIsPlaying(false);
    const video = videoRef.current;
    video?.pause();
    if (isCancellingSelection) {
      seekPreview(0);
      return;
    }
    if (nextRange) {
      seekPreview(nextRange.start);
      if (video && isVideoAsset(previewUrl)) {
        void video.play().catch(() => setIsPlaying(false));
      }
    }
  };

  const returnToFullPreview = () => {
    const video = videoRef.current;
    video?.pause();
    setActivePreviewShotId(null);
    setLoopPreviewSegment(false);
    setIsPlaying(false);
    seekPreview(0);
  };

  const addShot = async () => {
    const order = shots.length + 1;
    const nextShot: ShotItem = {
      id: `shot_local_${Date.now()}`,
      order,
      duration: 3,
      visualDesc: '补充一个产品使用场景，保持画面干净。',
      narration: '',
      subtitle: '',
      camera: '固定',
      status: 'draft',
    };
    setAddingShot(true);
    try {
      const response = await fetch(`${API_BASE}/scripts/${encodeURIComponent(script.id)}/shots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextShot),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextScript = normalizeScript((await response.json()) as Partial<ScriptData>, script.productId);
      onScriptChange(nextScript);
      const created = nextScript.shots.find((shot) => shot.order === order) || nextScript.shots.at(-1);
      if (created) setSelectedId(created.id);
      setAssistantStatus('已添加新镜头。');
    } catch {
      onScriptChange({ ...script, shots: [...shots, nextShot] });
      setSelectedId(nextShot.id);
      setAssistantStatus('已添加本地草稿，保存时会同步到后端。');
    } finally {
      setAddingShot(false);
    }
  };

  const deleteSelectedShot = async () => {
    if (!selected || shots.length <= 1 || deletingShot) return;
    const removeSelectedShotLocally = () => {
      const remaining = shots
        .filter((shot) => shot.id !== selected.id)
        .map((shot, index) => ({ ...shot, order: index + 1 }));
      onScriptChange({ ...script, shots: remaining });
      setSelectedId(remaining[Math.max(0, selected.order - 2)]?.id || remaining[0]?.id || null);
    };
    setDeletingShot(true);
    try {
      if (!selected.id.startsWith('shot_local_')) {
        const response = await fetch(
          `${API_BASE}/scripts/${encodeURIComponent(script.id)}/shots/${encodeURIComponent(selected.id)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextScript = normalizeScript((await response.json()) as Partial<ScriptData>, script.productId);
        onScriptChange(nextScript);
        const nextSelected = nextScript.shots.find((shot) => shot.order >= selected.order) || nextScript.shots.at(-1);
        setSelectedId(nextSelected?.id || null);
      } else {
        removeSelectedShotLocally();
      }
      setActivePreviewShotId(null);
      seekPreview(0);
      setAssistantStatus('已删除当前镜头。');
    } catch (deleteError) {
      removeSelectedShotLocally();
      setActivePreviewShotId(null);
      seekPreview(0);
      setAssistantStatus(
        `后端同步失败，已先删除本地镜头：${deleteError instanceof Error ? deleteError.message : '网络不可用'}`,
      );
    } finally {
      setDeletingShot(false);
    }
  };

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  };

  const selectStage = (item: (typeof WORKFLOW_STAGES)[number]) => {
    setStage(item);
    if (item === '素材') {
      setAssetsCollapsed(false);
      return;
    }
    if (item === '配方') {
      setAssetsCollapsed(false);
      setOpenSections((current) => ({ ...current, formula: true }));
      return;
    }
    if (item === '交付') {
      if (renderResult) {
        onNavigatePassport();
      } else {
        setAssistantStatus('确认成片后会回到对话页显示生成进度。');
      }
      return;
    }
    if (item === '成片') {
      setAssistantStatus('当前可以预览镜头，确认后开始成片。');
    }
  };

  const applyAssistantCommand = (raw: string) => {
    const text = raw.trim();
    if (!text || !selected) return;
    const lower = text.toLowerCase();
    if (text.includes('字幕') && (text.includes('下') || text.includes('底'))) {
      updateShot(selected.id, { textLayers: updateSubtitlePosition(selected, 'bottom') });
      setAssistantStatus('已把字幕移到底部安全区。');
    } else if (text.includes('节奏') || lower.includes('faster')) {
      updateShot(selected.id, { duration: Math.max(3, Number(selected.duration || 3) - 0.5) });
      setAssistantStatus('已压缩当前镜头时长。');
    } else {
      updateShot(selected.id, {
        visualDesc: `${selected.visualDesc || '当前镜头'}；强化前 3 秒痛点和产品动作。`,
      });
      setAssistantStatus('已把建议应用到画面重点。');
    }
    setAssistantText('');
    setOpenSections((current) => ({ ...current, narration: true }));
  };

  return (
    <div className={`edit-root${assetsCollapsed ? ' assets-collapsed' : ''}`}>
      <header className="edit-topbar">
        <div className="edit-title">
          <Clapperboard size={16} aria-hidden="true" />
          <div>
            <strong>{workbenchTitle}</strong>
            <span>{projectStatus}</span>
          </div>
        </div>

        <div className="edit-stage-tabs" role="tablist" aria-label="制作流程">
          {WORKFLOW_STAGES.map((item) => (
            <button
              type="button"
              key={item}
              className={item === stage ? 'active' : ''}
              onClick={() => selectStage(item)}
              aria-selected={item === stage}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="edit-actions">
          {versionTreeVisible && (
            <details className="edit-version-tree">
              <summary title={versionTreeTitle}>
                <div className="edit-version-summary-main">
                  <span>方案树</span>
                  <strong>{versionTreeTitle}</strong>
                </div>
                <div className="edit-version-summary-meta" aria-label="版本数量">
                  <span>{scriptVersions.length} 剧本</span>
                  <span>{renderVersions.length} 成片</span>
                </div>
                <ChevronDown size={15} aria-hidden="true" />
              </summary>
              <div className="edit-version-menu">
                {scriptVersions.map((version) => {
                  const relatedRenders = renderVersions.filter((item) => item.scriptVersionId === version.id);
                  const duration = version.script.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
                  return (
                    <section key={version.id} className="edit-version-group">
                      <button
                        type="button"
                        className={`edit-version-script${version.id === activeScriptVersionId ? ' active' : ''}`}
                        onClick={() => onSelectScriptVersion?.(version.id)}
                      >
                        <Clapperboard size={14} aria-hidden="true" />
                        <span>
                          <strong>{version.label}</strong>
                          <small>
                            {version.script.shots.length} 镜 · 约 {Math.round(duration)} 秒
                          </small>
                        </span>
                      </button>
                      {relatedRenders.length > 0 ? (
                        relatedRenders.map((renderVersion) => (
                          <button
                            type="button"
                            key={renderVersion.id}
                            className={`edit-version-render${renderVersion.id === activeRenderVersionId ? ' active' : ''}`}
                            onClick={() => onSelectRenderVersion?.(renderVersion.id)}
                          >
                            <Film size={13} aria-hidden="true" />
                            <span>{renderVersion.label}</span>
                          </button>
                        ))
                      ) : (
                        <span className="edit-version-empty">还没有成片版本</span>
                      )}
                    </section>
                  );
                })}
                <div className="edit-version-tools">
                  {activeScriptVersion && (
                    <button
                      type="button"
                      onClick={() => {
                        const label = window.prompt('重命名当前剧本方案', activeScriptVersion.label);
                        if (label) onRenameScriptVersion?.(activeScriptVersion.id, label);
                      }}
                    >
                      重命名剧本
                    </button>
                  )}
                  {activeRenderVersion && (
                    <button
                      type="button"
                      onClick={() => {
                        const label = window.prompt('重命名当前成片版本', activeRenderVersion.label);
                        if (label) onRenameRenderVersion?.(activeRenderVersion.id, label);
                      }}
                    >
                      重命名成片
                    </button>
                  )}
                  <button
                    type="button"
                    className="edit-version-render-again"
                    onClick={() => void confirmRender()}
                    disabled={busy !== null || saving}
                  >
                    用此剧本再生成
                  </button>
                </div>
              </div>
            </details>
          )}
          <button
            type="button"
            className="edit-ghost"
            onClick={() => void save()}
            disabled={saving}
            title="保存当前镜头、字幕和节奏修改"
          >
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            保存修改
          </button>
          {renderResult ? (
            <button type="button" className="edit-primary" onClick={onNavigatePassport}>
              查看交付
            </button>
          ) : (
            <button
              type="button"
              className="edit-primary"
              onClick={() => void confirmRender()}
              disabled={busy !== null || saving}
            >
              {renderBusy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              确认成片
            </button>
          )}
        </div>
      </header>

      <section className="edit-workspace" aria-label="视频制作台">
        <aside className="edit-assets" aria-label="素材和配方">
          <button
            type="button"
            className="edit-assets-toggle"
            onClick={() => setAssetsCollapsed((value) => !value)}
            aria-expanded={!assetsCollapsed}
            title={assetsCollapsed ? '展开素材' : '收起素材'}
          >
            <Layers size={15} />
            <span>素材</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>

          <div className="edit-assets-body">
            <div className="edit-material-strip">
              {materialItems.map((item) => (
                <button
                  type="button"
                  className="edit-material"
                  key={item.key}
                  title={`${item.label} · ${item.source}`}
                  onClick={() => {
                    if (item.shotId) selectShot(item.shotId);
                  }}
                >
                  <MediaThumb url={item.url} label={item.label} />
                  <span className="edit-material-copy">
                    <span>{item.label}</span>
                    <small>{item.source}</small>
                  </span>
                </button>
              ))}
            </div>
            <button type="button" className="edit-add-material" onClick={onNavigateMaterials}>
              <Plus size={14} /> 添加素材
            </button>
            <div className={`edit-disclosure${openSections.formula ? ' open' : ''}`}>
              <button type="button" onClick={() => toggleSection('formula')} aria-expanded={openSections.formula}>
                <span>爆款配方</span>
                <ChevronDown size={14} />
              </button>
              <div className="edit-disclosure-body">
                <p>痛点开场 → 产品演示 → 对比证明 → 行动引导</p>
                <small>配方只作为结构参考，不进入素材混剪池。</small>
              </div>
            </div>
          </div>
        </aside>

        <main className="edit-canvas" aria-label="预览画布">
          <div className="edit-preview-stage">
            <div className="edit-phone-frame">
              {previewUrl ? (
                isVideoAsset(previewUrl) ? (
                  <video
                    ref={videoRef}
                    src={previewUrl}
                    controls={false}
                    playsInline
                    onLoadedMetadata={(event) => {
                      const duration = event.currentTarget.duration;
                      setVideoDuration(Number.isFinite(duration) ? duration : 0);
                    }}
                    onTimeUpdate={handleVideoTimeUpdate}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                ) : isImageAsset(previewUrl) ? (
                  <img src={previewUrl} alt="当前镜头预览" />
                ) : (
                  <iframe title="当前镜头预览" src={previewUrl} />
                )
              ) : (
                <div className="edit-product-scene">
                  <Video size={34} />
                  <strong>{selected?.subtitle || '车载演示'}</strong>
                  <span>{selected?.visualDesc || '生成后会在这里预览成片画面'}</span>
                </div>
              )}
              {selected && (selected.subtitle || selected.narration) && (
                <div className={`edit-caption ${subtitlePosition}`}>{selected.subtitle || selected.narration}</div>
              )}
            </div>
          </div>

          <div className="edit-transport" aria-label="播放控制">
            <button
              type="button"
              onClick={togglePlayback}
              disabled={!isVideoAsset(previewUrl)}
              aria-label={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <span>{fmtTime(transportPlayhead)}</span>
            <div className="edit-scrub" aria-hidden="true">
              <span style={{ width: `${transportProgress}%` }} />
            </div>
            <span>{fmtTime(transportDuration)}</span>
            <button
              type="button"
              className={activePreviewRange ? 'active' : ''}
              onClick={returnToFullPreview}
              disabled={!activePreviewRange}
              title="退出片段播放，回到整条成片"
            >
              整片
            </button>
            <button
              type="button"
              className={loopPreviewSegment ? 'active' : ''}
              onClick={() => setLoopPreviewSegment((value) => !value)}
              disabled={!activePreviewRange || !isVideoAsset(previewUrl)}
              title="选中时间线片段后，可循环播放该段"
            >
              <RotateCcw size={14} />
              循环片段
            </button>
            <button
              type="button"
              onClick={() => void onPreviewFirstShot()}
              disabled={busy !== null}
              title="只生成第一镜的测试画面，不导出完整视频"
            >
              {busy === 'script' ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
              首镜测试
            </button>
          </div>
        </main>

        <aside className="edit-inspector" aria-label="当前镜头设置">
          <div className="edit-inspector-head">
            <span>当前镜头</span>
            <strong>
              {selected ? shortShotLabel(selected) : '未选择'}
              <i className={`edit-status ${selectedStatus}`}>
                {selectedStatus === 'running'
                  ? '生成中'
                  : selectedStatus === 'done'
                    ? '已生成'
                    : selectedStatus === 'failed'
                      ? '需重试'
                      : '草稿'}
              </i>
            </strong>
          </div>

          {selected && (
            <>
              <label className="edit-field">
                <span>画面重点</span>
                <textarea
                  rows={4}
                  value={selected.visualDesc}
                  onChange={(event) => updateShot(selected.id, { visualDesc: event.target.value })}
                />
              </label>

              <div className="edit-field">
                <span>字幕位置</span>
                <div className="edit-segmented" role="group" aria-label="字幕位置">
                  {(
                    [
                      ['top', '上方'],
                      ['middle', '中下'],
                      ['bottom', '底部'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={subtitlePosition === value ? 'active' : ''}
                      onClick={() => updateShot(selected.id, { textLayers: updateSubtitlePosition(selected, value) })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="edit-field">
                <span>节奏</span>
                <input
                  type="range"
                  min={3}
                  max={5}
                  step={0.5}
                  value={Math.max(3, Math.min(5, Number(selected.duration || 3)))}
                  onChange={(event) => updateShot(selected.id, { duration: Number(event.target.value) })}
                />
              </label>

              <div className={`edit-disclosure${openSections.narration ? ' open' : ''}`}>
                <button type="button" onClick={() => toggleSection('narration')} aria-expanded={openSections.narration}>
                  <span>口播文案</span>
                  <ChevronDown size={14} />
                </button>
                <div className="edit-disclosure-body">
                  <textarea
                    rows={3}
                    value={selected.narration}
                    onChange={(event) =>
                      updateShot(selected.id, { narration: event.target.value, subtitle: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className={`edit-disclosure${openSections.compliance ? ' open' : ''}`}>
                <button
                  type="button"
                  onClick={() => toggleSection('compliance')}
                  aria-expanded={openSections.compliance}
                >
                  <span>合规提示</span>
                  <ChevronDown size={14} />
                </button>
                <div className="edit-disclosure-body">
                  <p>{blockedClaims > 0 ? '有卖点需要人工复核。' : `${approvedClaims} 条卖点已接地。`}</p>
                </div>
              </div>

              <div className={`edit-disclosure${openSections.feedback ? ' open' : ''}`}>
                <button type="button" onClick={() => toggleSection('feedback')} aria-expanded={openSections.feedback}>
                  <span>数据反馈</span>
                  <ChevronDown size={14} />
                </button>
                <div className="edit-disclosure-body edit-feedback">
                  <span>CTR 3.8%</span>
                  <span>完播 41%</span>
                  <span>参考热度 高</span>
                </div>
              </div>

              <button
                type="button"
                className="edit-danger"
                onClick={() => void deleteSelectedShot()}
                disabled={shots.length <= 1 || deletingShot}
                title={shots.length <= 1 ? '至少保留一个镜头' : '删除当前镜头'}
              >
                {deletingShot ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                删除镜头
              </button>
            </>
          )}
        </aside>
      </section>

      <section className="edit-timeline" aria-label="时间线">
        <div className="edit-timeline-head">
          <span>时间线</span>
          <div className="edit-ruler" aria-hidden="true">
            {timelineTicks.map((tick) => (
              <i key={tick}>{Math.round(tick)}s</i>
            ))}
          </div>
          <button type="button" className="edit-add-shot" onClick={() => void addShot()} disabled={addingShot}>
            {addingShot ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 添加镜头
          </button>
        </div>

        {(
          [
            { key: 'visual', label: '画面', icon: <Video size={13} /> },
            { key: 'voice', label: '口播', icon: <Mic size={13} /> },
            { key: 'caption', label: '字幕', icon: <Captions size={13} /> },
          ] as const
        ).map((track) => (
          <div className="edit-track" key={track.key}>
            <span className="edit-track-label">
              {track.icon} {track.label}
            </span>
            <div className="edit-track-row">
              {ranges.map((range) => {
                const status = shotStatus(range.shot, renderBusy, selected?.id);
                return (
                  <button
                    type="button"
                    key={`${track.key}-${range.shot.id}`}
                    className={`edit-clip ${track.key}${range.shot.id === selected?.id ? ' active' : ''} ${
                      range.shot.id === activePreviewShotId ? ' previewing' : ''
                    } ${status}`}
                    style={{ flexGrow: range.duration }}
                    onClick={() => selectTimelineShot(range.shot.id)}
                    aria-label={`选择${track.label}镜头 ${range.shot.order}`}
                  >
                    {track.key === 'visual' ? shortShotLabel(range.shot) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <form
        className="edit-agent-chip"
        onSubmit={(event) => {
          event.preventDefault();
          applyAssistantCommand(assistantText);
        }}
      >
        <MessageSquareText size={14} />
        <input
          value={assistantText}
          onChange={(event) => setAssistantText(event.target.value)}
          placeholder={assistantStatus || '调整当前镜头...'}
        />
        <div className="edit-agent-suggestions" aria-label="快捷指令">
          {ASSISTANT_SUGGESTIONS.map((item) => (
            <button type="button" key={item} onClick={() => applyAssistantCommand(item)}>
              {item}
            </button>
          ))}
        </div>
        <button type="submit" aria-label="发送调整指令">
          <Send size={14} />
        </button>
      </form>

      {error && (
        <div className="chat-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
