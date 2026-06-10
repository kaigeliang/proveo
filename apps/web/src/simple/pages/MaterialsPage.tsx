import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  BadgeCheck,
  Check,
  Eye,
  Image as ImageIcon,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Upload,
} from 'lucide-react';
import { createMaterialAngles, waitForAngleTask } from '../material-angle-api';
import { API_BASE, type MaterialAngle } from '../studio-types';

interface MaterialSlice {
  id: string;
  materialId: string;
  thumbnailUrl?: string;
  clipUrl?: string;
  summary: string;
  score?: number;
}

interface Material {
  id: string;
  productId?: string;
  name?: string;
  type: 'image' | 'video';
  sourceUrl: string;
  posterUrl?: string;
  sourceDeclaration: string;
  slices?: MaterialSlice[];
  angles?: MaterialAngle[];
}

type OrbitCustomAngle = {
  label: string;
  promptHint: string;
  azimuthDeg?: number;
  elevationDeg?: number;
  distanceLevel?: number;
};

const AZIMUTH_LABELS: Record<number, { zh: string; en: string }> = {
  0: { zh: '正面', en: 'front view' },
  45: { zh: '右前 45°', en: 'front-right quarter view' },
  90: { zh: '右侧 90°', en: 'right side view' },
  135: { zh: '右后 135°', en: 'back-right quarter view' },
  180: { zh: '背面 180°', en: 'back view' },
  225: { zh: '左后 225°', en: 'back-left quarter view' },
  270: { zh: '左侧 90°', en: 'left side view' },
  315: { zh: '左前 45°', en: 'front-left quarter view' },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function nearestOrbitAzimuth(value: number) {
  return (((Math.round(value / 45) * 45) % 360) + 360) % 360;
}

function elevationLabel(value: number) {
  if (value <= -20) return { zh: '低角度仰拍', en: 'low-angle shot' };
  if (value >= 35) return { zh: '高角度俯拍', en: 'high-angle shot' };
  if (value >= 15) return { zh: '轻微俯视', en: 'elevated shot' };
  return { zh: '平视', en: 'eye-level shot' };
}

function distanceLabel(value: number) {
  if (value <= 3) return { zh: '远景', en: 'wide shot' };
  if (value >= 8) return { zh: '特写', en: 'close-up' };
  return { zh: '中景', en: 'medium shot' };
}

// ── 爆款参考库（优质视频库 / 真实 TikTok 爆款）──────────────────────────────
interface ReferenceVideo {
  id: string;
  sourceUrl: string;
  breakdownReport?: {
    tiktokUrl?: string;
    creatorHandle?: string;
    productTitle?: string;
    description?: string;
    category?: string;
    datasets?: string[];
    factors?: string[];
  };
}

const DATASET_LABEL: Record<string, string> = {
  low_follower_videos: '低粉爆款',
  organic_sales_videos: '自然流爆款',
  high_roas_ads: '投流爆款',
};

function ReferenceCard({ video }: { video: ReferenceVideo }) {
  const br = video.breakdownReport || {};
  const url = br.tiktokUrl || video.sourceUrl;
  const handle = (br.creatorHandle || '').replace(/^@/, '');
  const datasets = Array.isArray(br.datasets) ? br.datasets : [];
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/reference-videos/oembed?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d?.thumbnailUrl) setThumb(d.thumbnailUrl as string);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [url]);

  return (
    <a
      className="ref-card"
      href={url}
      target="_blank"
      rel="noreferrer"
      title={br.description || br.productTitle || url}
    >
      <div className="ref-cover">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <div className="ref-cover-ph">
            <Play size={20} />
            {handle && <span>@{handle}</span>}
          </div>
        )}
        <span className="ref-play">
          <Play size={13} />
        </span>
      </div>
      <div className="ref-body">
        <strong>{br.productTitle || br.description || video.id}</strong>
        <div className="ref-badges">
          {br.category && <span className="ref-badge">{br.category}</span>}
          {datasets.slice(0, 1).map((d) => (
            <span key={d} className="ref-badge ds">
              {DATASET_LABEL[d] || d}
            </span>
          ))}
        </div>
        <span className="ref-handle">{handle ? `@${handle}` : 'TikTok'} ↗</span>
      </div>
    </a>
  );
}

export default function MaterialsPage({
  productId,
  querySeed,
  selectedAngle,
  onAngleSelect,
}: {
  productId: string;
  querySeed: string;
  selectedAngle?: MaterialAngle | null;
  onAngleSelect?: (angle: MaterialAngle) => void;
}) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [matches, setMatches] = useState<MaterialSlice[]>([]);
  const [query, setQuery] = useState(querySeed);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [angleMaterialId, setAngleMaterialId] = useState<string | null>(null);
  const [angleProgress, setAngleProgress] = useState<string | null>(null);
  const [activeMaterialId, setActiveMaterialId] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState('45° 侧前方');
  const [customPrompt, setCustomPrompt] = useState(
    '保持商品身份一致，生成侧前方约 45 度、主体完整、棚拍干净的参考图。',
  );
  const [orbitAzimuth, setOrbitAzimuth] = useState(45);
  const [orbitElevation, setOrbitElevation] = useState(0);
  const [orbitDistance, setOrbitDistance] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [grain, setGrain] = useState<'all' | 'image' | 'video' | 'sliced'>('all');
  const [refVideos, setRefVideos] = useState<ReferenceVideo[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const TAG_CHIPS = ['质感特写', '使用场景', '细节'];

  // 素材库展示"上传过的全部素材"，不被当前商品过滤到空（上传时仍会绑定当前商品）。
  const materialsUrl = useCallback(() => {
    return `${API_BASE}/materials`;
  }, []);

  const load = async () => {
    try {
      const response = await fetch(materialsUrl());
      if (!response.ok) throw new Error(`素材库 HTTP ${response.status}`);
      setMaterials((await response.json()) as Material[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '素材读取失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/reference-videos`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (active && Array.isArray(data)) setRefVideos(data.slice(0, 12) as ReferenceVideo[]);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const updateMaterialAngles = (materialId: string, angles: MaterialAngle[]) => {
    setMaterials((current) =>
      current.map((material) => (material.id === materialId ? { ...material, angles } : material)),
    );
  };

  useEffect(() => {
    let active = true;
    fetch(materialsUrl())
      .then((response) => {
        if (!response.ok) throw new Error(`素材库 HTTP ${response.status}`);
        return response.json() as Promise<Material[]>;
      })
      .then((data) => {
        if (active) setMaterials(data);
      })
      .catch((fetchError) => {
        if (active) setError(fetchError instanceof Error ? fetchError.message : '素材读取失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [materialsUrl]);

  const search = async () => {
    setLoading(true);
    try {
      const scope = productId ? `&productId=${encodeURIComponent(productId)}` : '';
      const response = await fetch(`${API_BASE}/materials/search?q=${encodeURIComponent(query.trim())}&k=9${scope}`);
      if (!response.ok) throw new Error(`检索 HTTP ${response.status}`);
      setMatches((await response.json()) as MaterialSlice[]);
      setError(null);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : '检索失败');
    } finally {
      setLoading(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append('file', file);
        body.append('sourceDeclaration', 'Demo 页面商家上传');
        if (productId) body.append('productId', productId);
        const response = await fetch(`${API_BASE}/materials/upload`, { method: 'POST', body });
        if (!response.ok) throw new Error(`上传 HTTP ${response.status}`);
      }
      await load();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const generateAngles = async (
    material: Material,
    options: {
      force?: boolean;
      includePresets?: boolean;
      customAngles?: OrbitCustomAngle[];
      preferCustom?: boolean;
    } = {},
  ) => {
    setAngleMaterialId(material.id);
    setAngleProgress('queued');
    setError(null);
    try {
      const response = await createMaterialAngles(material.id, {
        force: options.force,
        includePresets: options.includePresets,
        customAngles: options.customAngles,
      });
      const angles = response.taskId
        ? await waitForAngleTask(response.taskId, (task) => {
            setAngleProgress(`${task.progress ?? 0}% ${task.step || 'processing'}`);
          })
        : response.angles || [];
      updateMaterialAngles(material.id, angles);
      const preferred = options.preferCustom ? angles.find((angle) => angle.view === 'custom') : angles[0];
      if (preferred) onAngleSelect?.(preferred);
      await load();
    } catch (angleError) {
      setError(angleError instanceof Error ? angleError.message : '角度参考图生成失败');
    } finally {
      setAngleMaterialId(null);
      setAngleProgress(null);
    }
  };

  const imageMaterials = materials.filter((material) => material.type === 'image');
  const activeMaterial = imageMaterials.find((material) => material.id === activeMaterialId) || imageMaterials[0];
  const activeAngles = activeMaterial?.angles || [];
  const canGenerateCustom = Boolean(activeMaterial && customLabel.trim() && customPrompt.trim());
  const materialById = new Map(materials.map((material) => [material.id, material]));
  const orbitAzimuthLabel = AZIMUTH_LABELS[orbitAzimuth] || AZIMUTH_LABELS[0];
  const orbitElevationLabel = elevationLabel(orbitElevation);
  const orbitDistanceLabel = distanceLabel(orbitDistance);
  const orbitPrompt = `<sks> ${orbitAzimuthLabel.en} ${orbitElevationLabel.en} ${orbitDistanceLabel.en}`;
  const orbitAngleLabel = `${orbitAzimuthLabel.zh} · ${orbitElevationLabel.zh} · ${orbitDistanceLabel.zh}`;
  const orbitPromptHint = [
    `保持商品身份一致，生成${orbitAzimuthLabel.zh}、${orbitElevationLabel.zh}、${orbitDistanceLabel.zh}的多角度参考图。`,
    '商品主体完整，文字和 Logo 不变，电商棚拍背景，适合 Seedance 图生视频。',
  ].join('\n');
  const orbitRadians = (orbitAzimuth * Math.PI) / 180;
  const orbitEyeStyle = {
    left: `${50 + Math.sin(orbitRadians) * 38}%`,
    top: `${53 - Math.cos(orbitRadians) * 19}%`,
  };
  const orbitCardStyle = {
    transform: `perspective(860px) rotateX(${clamp(-orbitElevation / 3, -18, 18)}deg) rotateY(${orbitAzimuth}deg) scale(${
      0.96 + orbitDistance * 0.012
    })`,
  };

  const updateOrbitFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    const degree = (Math.atan2(x, -y) * 180) / Math.PI;
    setOrbitAzimuth(nearestOrbitAzimuth(degree));
  };

  return (
    <div className="mat-root">
      <form
        className="mat-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="mat-search-box">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜素材：关键词 / 标签 / 以图搜图（向量相似）…"
          />
        </div>
        <input
          ref={fileRef}
          hidden
          type="file"
          multiple
          accept="image/*,video/*"
          onChange={(event) => void upload(event.target.files)}
        />
        <button type="button" className="mat-upload" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? <Loader2 className="spin" size={14} /> : <Upload size={14} />} 上传
        </button>
      </form>

      <div className="mat-chips">
        <span className="grain-label">颗粒度</span>
        <button type="button" className={`mat-chip${grain === 'all' ? ' on' : ''}`} onClick={() => setGrain('all')}>
          全部
        </button>
        <button type="button" className={`mat-chip${grain === 'image' ? ' on' : ''}`} onClick={() => setGrain('image')}>
          商品维度
        </button>
        <button type="button" className={`mat-chip${grain === 'video' ? ' on' : ''}`} onClick={() => setGrain('video')}>
          视频维度
        </button>
        <button
          type="button"
          className={`mat-chip${grain === 'sliced' ? ' on' : ''}`}
          onClick={() => setGrain('sliced')}
        >
          切片 slice
        </button>
        <span className="mat-chip-divider" />
        {TAG_CHIPS.map((tag) => (
          <button
            key={tag}
            type="button"
            className="mat-chip"
            onClick={() => {
              setQuery(tag);
              void search();
            }}
          >
            {tag}
          </button>
        ))}
      </div>

      <div className="grounding-banner">
        {selectedAngle
          ? `当前出片参考角度：${selectedAngle.label} · ${selectedAngle.provider}`
          : productId
            ? `素材绑定当前商品 ${productId}，并作为 TrustDAG evidence 输入。`
            : '选择商品后上传素材，才能维持商品隔离与证据归属。'}
      </div>
      {error && <div className="chat-error">{error}</div>}

      <div className="mat-grid">
        {(grain === 'sliced'
          ? materials.filter((m) => m.slices?.length)
          : grain === 'all'
            ? materials
            : materials.filter((m) => m.type === grain)
        ).map((material) => {
          const sliceCount = material.slices?.length ?? 0;
          const vectorized = (material.angles?.length ?? 0) > 0;
          return (
            <article key={material.id} className="mat-card">
              <div className="mat-card-media">
                {material.type === 'image' ? (
                  material.sourceUrl || material.posterUrl ? (
                    <img src={material.sourceUrl || material.posterUrl} alt={material.name || material.id} />
                  ) : (
                    <ImageIcon size={22} />
                  )
                ) : (
                  <video src={material.sourceUrl} muted playsInline />
                )}
                <span className="mat-type">{material.type === 'image' ? '主图' : '视频'}</span>
              </div>
              <div className="mat-card-body">
                <strong>{material.name || material.id}</strong>
                {sliceCount ? (
                  <span className="mat-badge">
                    <Scissors size={12} /> {sliceCount} 个切片
                  </span>
                ) : vectorized ? (
                  <span className="mat-badge vec">
                    <BadgeCheck size={12} /> 已向量化
                  </span>
                ) : (
                  <span className="mat-badge run">
                    <Loader2 size={12} className="spin" /> 解析中
                  </span>
                )}
              </div>
            </article>
          );
        })}
        {!materials.length &&
          (loading ? (
            <div className="dash-empty">
              <Loader2 size={14} className="spin" /> 加载素材…
            </div>
          ) : (
            <div className="dash-empty">还没有素材。点右上角「上传」导入商品主图 / 视频，系统会自动切片 + 向量化。</div>
          ))}
      </div>

      {refVideos.length > 0 && (
        <section className="ref-section">
          <div className="ref-section-head">
            <span className="mat-section-title">
              <TrendingUp size={15} /> 爆款参考库 · 真实 TikTok
            </span>
            <span className="ref-section-note">点击封面跳转原视频；仅保存结构化分析，不复刻不混剪</span>
          </div>
          <div className="ref-grid">
            {refVideos.map((video) => (
              <ReferenceCard key={video.id} video={video} />
            ))}
          </div>
        </section>
      )}

      <details className="mat-advanced">
        <summary>
          <SlidersHorizontal size={14} /> 进阶：多角度参考图 & 切片检索
        </summary>
        <div className="mat-advanced-body">
          {angleProgress && <div className="grounding-banner">角度任务：{angleProgress}</div>}
          <section className="angle-workbench">
            <div className="angle-source-panel">
              <div className="angle-source-preview">
                {activeMaterial ? (
                  <img
                    src={activeMaterial.sourceUrl || activeMaterial.posterUrl}
                    alt={activeMaterial.name || activeMaterial.id}
                  />
                ) : (
                  <ImageIcon size={22} />
                )}
              </div>
              <div className="angle-source-meta">
                <strong>{activeMaterial?.name || activeMaterial?.id || '未选择素材'}</strong>
                <span>{activeMaterial?.sourceDeclaration || '等待图片素材'}</span>
              </div>
              <div className="angle-source-strip">
                {imageMaterials.map((material) => (
                  <button
                    key={material.id}
                    type="button"
                    className={activeMaterial?.id === material.id ? 'selected' : ''}
                    onClick={() => setActiveMaterialId(material.id)}
                    aria-label={`选择素材 ${material.name || material.id}`}
                    aria-pressed={activeMaterial?.id === material.id}
                  >
                    <img src={material.sourceUrl || material.posterUrl} alt="" />
                  </button>
                ))}
              </div>
            </div>
            <div className="angle-control-panel">
              <header>
                <div>
                  <h3>角度工作台</h3>
                  <span>
                    {activeAngles.length} angles · {selectedAngle ? selectedAngle.label : 'none selected'}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!activeMaterial || angleMaterialId === activeMaterial.id}
                  onClick={() =>
                    activeMaterial &&
                    void generateAngles(activeMaterial, {
                      force: Boolean(activeMaterial.angles?.length),
                      includePresets: true,
                    })
                  }
                >
                  {angleMaterialId === activeMaterial?.id ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  生成预设
                </button>
              </header>
              <div className="multiangle-lab">
                <div
                  className="orbit-stage"
                  role="slider"
                  aria-label="360 度相机方位"
                  aria-valuemin={0}
                  aria-valuemax={315}
                  aria-valuenow={orbitAzimuth}
                  tabIndex={0}
                  onPointerDown={updateOrbitFromPointer}
                  onPointerMove={(event) => {
                    if (event.buttons === 1) updateOrbitFromPointer(event);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') setOrbitAzimuth((value) => nearestOrbitAzimuth(value - 45));
                    if (event.key === 'ArrowRight') setOrbitAzimuth((value) => nearestOrbitAzimuth(value + 45));
                  }}
                >
                  <div className="orbit-floor" />
                  <div className="orbit-track" />
                  <span className="orbit-eye" style={orbitEyeStyle}>
                    <Eye size={15} />
                  </span>
                  <div className="orbit-product-card" style={orbitCardStyle}>
                    {activeMaterial ? (
                      <img
                        src={activeMaterial.sourceUrl || activeMaterial.posterUrl}
                        alt={`${activeMaterial.name || activeMaterial.id} 多角度预览`}
                      />
                    ) : (
                      <ImageIcon size={22} />
                    )}
                  </div>
                </div>
                <div className="orbit-controls">
                  <div className="orbit-readout">
                    <strong>{orbitAngleLabel}</strong>
                    <code>{orbitPrompt}</code>
                  </div>
                  <label>
                    <span>水平环绕 {orbitAzimuth}°</span>
                    <input
                      type="range"
                      min={0}
                      max={315}
                      step={45}
                      value={orbitAzimuth}
                      onChange={(event) => setOrbitAzimuth(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>俯仰 {orbitElevation}°</span>
                    <input
                      type="range"
                      min={-30}
                      max={60}
                      step={15}
                      value={orbitElevation}
                      onChange={(event) => setOrbitElevation(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>距离 {orbitDistance}/10</span>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={orbitDistance}
                      onChange={(event) => setOrbitDistance(Number(event.target.value))}
                    />
                  </label>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!activeMaterial || angleMaterialId === activeMaterial?.id}
                    onClick={() =>
                      activeMaterial &&
                      void generateAngles(activeMaterial, {
                        force: true,
                        includePresets: true,
                        customAngles: [
                          {
                            label: orbitAngleLabel,
                            promptHint: orbitPromptHint,
                            azimuthDeg: orbitAzimuth,
                            elevationDeg: orbitElevation,
                            distanceLevel: orbitDistance,
                          },
                        ],
                        preferCustom: true,
                      })
                    }
                  >
                    {angleMaterialId === activeMaterial?.id ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Eye size={14} />
                    )}
                    生成当前视角
                  </button>
                </div>
              </div>
              <div className="custom-angle-form">
                <label>
                  <span>角度名称</span>
                  <input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} maxLength={24} />
                </label>
                <label>
                  <span>角度提示词</span>
                  <textarea
                    value={customPrompt}
                    onChange={(event) => setCustomPrompt(event.target.value)}
                    maxLength={260}
                  />
                </label>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!canGenerateCustom || angleMaterialId === activeMaterial?.id}
                  onClick={() =>
                    activeMaterial &&
                    void generateAngles(activeMaterial, {
                      force: true,
                      includePresets: true,
                      customAngles: [{ label: customLabel.trim(), promptHint: customPrompt.trim() }],
                      preferCustom: true,
                    })
                  }
                >
                  <Plus size={14} /> 生成自定义
                </button>
              </div>
              <div className="angle-reference-grid">
                {activeAngles.length ? (
                  activeAngles.map((angle) => (
                    <button
                      key={angle.id}
                      type="button"
                      className={`angle-reference-card${selectedAngle?.id === angle.id ? ' selected' : ''}`}
                      onClick={() => onAngleSelect?.(angle)}
                      aria-pressed={selectedAngle?.id === angle.id}
                    >
                      <img src={angle.previewUrl || angle.imageUrl} alt={`${angle.label} 参考图`} />
                      <span>
                        <strong>{angle.label}</strong>
                        <small>
                          {angle.provider === 'qwen'
                            ? 'Qwen'
                            : angle.view === 'custom'
                              ? 'Custom fallback'
                              : 'Local fallback'}
                        </small>
                      </span>
                      {selectedAngle?.id === angle.id && <Check size={16} />}
                    </button>
                  ))
                ) : (
                  <div className="angle-empty-state">
                    <SlidersHorizontal size={18} />
                    <span>暂无角度参考图</span>
                  </div>
                )}
              </div>
            </div>
          </section>
          <section className="material-split">
            <div>
              <h3>素材主库 ({materials.length})</h3>
              {loading && !materials.length && <Loader2 className="spin" />}
              <div className="material-visual-grid">
                {materials.map((material) => (
                  <article key={material.id} className="material-tile">
                    <div className="media-preview">
                      {material.type === 'image' ? (
                        <img src={material.sourceUrl || material.posterUrl} alt={material.name || material.id} />
                      ) : (
                        <video src={material.sourceUrl} muted playsInline />
                      )}
                    </div>
                    <div className="material-tile-details">
                      <strong>{material.name || material.id}</strong>
                      <span className="tag">{material.type}</span>
                      <span>{material.sourceDeclaration}</span>
                      {material.type === 'image' && (
                        <button
                          type="button"
                          className="secondary-button material-angle-button"
                          disabled={angleMaterialId === material.id}
                          onClick={() =>
                            void generateAngles(material, {
                              force: Boolean(material.angles?.length),
                              includePresets: true,
                            })
                          }
                        >
                          {angleMaterialId === material.id ? (
                            <Loader2 className="spin" size={14} />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                          {material.angles?.length ? '刷新角度' : '生成角度'}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
            <div>
              <h3>检索切片 ({matches.length})</h3>
              <div className="slice-grid">
                {matches.map((slice) => {
                  const owner = materialById.get(slice.materialId);
                  const canUseForAngles = owner?.type === 'image';
                  return (
                    <article key={slice.id} className="slice-card">
                      {(slice.thumbnailUrl || slice.clipUrl || owner?.posterUrl || owner?.sourceUrl) && (
                        <div className="media-preview compact">
                          {slice.clipUrl || owner?.type === 'video' ? (
                            <video src={slice.clipUrl || owner?.sourceUrl} muted playsInline />
                          ) : (
                            <img src={slice.thumbnailUrl || owner?.posterUrl || owner?.sourceUrl} alt="" />
                          )}
                        </div>
                      )}
                      <div className="slice-card-body">
                        <strong>{slice.summary}</strong>
                        <span>{slice.score?.toFixed(2) ?? 'matched'}</span>
                        {canUseForAngles && owner && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={angleMaterialId === owner.id}
                            onClick={() => {
                              setActiveMaterialId(owner.id);
                              void generateAngles(owner, {
                                force: Boolean(owner.angles?.length),
                                includePresets: true,
                              });
                            }}
                          >
                            {angleMaterialId === owner.id ? (
                              <Loader2 className="spin" size={14} />
                            ) : (
                              <Sparkles size={14} />
                            )}
                            设为角度源
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}
