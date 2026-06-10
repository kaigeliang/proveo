export type SubtitleMode = 'auto' | 'always' | 'off';
export type SubtitlePlacementProvider = 'auto' | 'local' | 'qwenvl';
export type SubtitlePosition = 'bottom' | 'middle_lower' | 'top';

export type ComposerSubtitlePlanItem = {
  shotId: string;
  order: number;
  show: boolean;
  text: string;
  position: SubtitlePosition;
  reason: string;
};

export type SubtitleOverlayEvent = {
  id: string;
  shotId: string;
  shotOrder: number;
  start: number;
  end: number;
  text: string;
  position: SubtitlePosition;
  source: 'composer' | 'qwenvl';
  reason: string;
};

export type SubtitlePlacementAdvice = {
  order: number;
  show?: boolean;
  position?: SubtitlePosition | 'none';
  reason?: string;
};

export type SubtitleOverlayPlan = {
  mode: SubtitleMode;
  provider: SubtitlePlacementProvider;
  placementSource: 'composer' | 'qwenvl' | 'disabled';
  events: SubtitleOverlayEvent[];
  skipped: Array<{ shotId: string; order: number; reason: string }>;
  qwenNote?: string;
};

type SubtitleShotInput = {
  id: string;
  order: number;
  duration: number;
  narration?: string;
  subtitle?: string;
  visualDesc?: string;
  textLayers?: unknown;
};

type SubtitleRenderDecisionInput = {
  shotId: string;
  action: 'generate';
  provider: string;
};

type SubtitleTransitionInput = {
  transition: string;
  duration: number;
};

const POSITIONS = new Set<SubtitlePosition>(['bottom', 'middle_lower', 'top']);

export function readSubtitleMode(value: unknown): SubtitleMode {
  return value === 'always' || value === 'off' || value === 'auto' ? value : 'auto';
}

export function readSubtitlePlacementProvider(value: unknown): SubtitlePlacementProvider {
  return value === 'local' || value === 'qwenvl' || value === 'auto' ? value : 'auto';
}

function readText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSubtitleText(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[。；;，,、]+$/g, '')
    .trim();
}

function compactSubtitleText(value: string) {
  const text = normalizeSubtitleText(value);
  if (text.length <= 28) return text;
  return `${text.slice(0, 27)}…`;
}

function wrapSubtitleText(value: string) {
  const text = compactSubtitleText(value);
  if (text.length <= 14) return text;
  const splitAt = Math.min(14, Math.ceil(text.length / 2));
  return `${text.slice(0, splitAt)}\n${text.slice(splitAt)}`;
}

function textLayerPosition(textLayers: unknown): SubtitlePosition | undefined {
  if (!Array.isArray(textLayers)) return undefined;
  const layer = textLayers.find((item) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return record.type === 'subtitle' && record.position && typeof record.position === 'object';
  });
  if (!layer || typeof layer !== 'object') return undefined;
  const position = (layer as { position?: { y?: unknown } }).position;
  const y = Number(position?.y);
  if (!Number.isFinite(y)) return undefined;
  if (y < 0.34) return 'top';
  if (y < 0.68) return 'middle_lower';
  return 'bottom';
}

function inferPosition(shot: SubtitleShotInput): SubtitlePosition {
  const fromLayer = textLayerPosition(shot.textLayers);
  if (fromLayer) return fromLayer;
  const text = `${shot.visualDesc || ''} ${shot.subtitle || ''}`;
  if (/底部|下方|价格|权益|规格|页面|按钮/.test(text)) return 'top';
  return 'bottom';
}

function shouldShowByDefault(input: {
  mode: SubtitleMode;
  text: string;
  audioMode: 'original' | 'voiceover' | 'mute';
  decision?: SubtitleRenderDecisionInput;
  visualDecisionMode?: boolean;
}) {
  if (input.mode === 'off') return { show: false, reason: '导出设置关闭字幕。' };
  if (!input.text) return { show: false, reason: '该分镜没有字幕文案。' };
  if (input.mode === 'always') return { show: true, reason: '导出设置要求始终显示字幕。' };
  if (input.visualDecisionMode) {
    return { show: true, reason: '候选字幕交给 Qwen-VL 基于画面 OCR 和定位直接决策。' };
  }
  return {
    show: true,
    reason: input.audioMode === 'voiceover' ? '配音模式需要同步字幕。' : '自动模式为生成镜头添加字幕。',
  };
}

export function buildComposerSubtitlePlan(shots: SubtitleShotInput[]): ComposerSubtitlePlanItem[] {
  return [...shots]
    .sort((a, b) => a.order - b.order)
    .map((shot) => {
      const text = compactSubtitleText(readText(shot.subtitle, readText(shot.narration)));
      return {
        shotId: shot.id,
        order: shot.order,
        show: Boolean(text),
        text,
        position: inferPosition(shot),
        reason: text ? 'Composer 根据分镜字幕生成后期字幕候选。' : '分镜没有可用字幕文案。',
      };
    });
}

function effectiveTransitionDuration(current: SubtitleTransitionInput, next?: SubtitleTransitionInput) {
  if (!next || current.transition === 'hard_cut') return 0;
  const duration = Math.min(0.35, Math.max(0, current.duration - 0.08), Math.max(0, next.duration - 0.08));
  return duration >= 0.15 ? duration : 0;
}

function boundedTime(value: number) {
  return Number(Math.max(0, value).toFixed(3));
}

export function buildSubtitleOverlayPlan(input: {
  shots: SubtitleShotInput[];
  transitionPlan: SubtitleTransitionInput[];
  decisions: SubtitleRenderDecisionInput[];
  composerPlan?: ComposerSubtitlePlanItem[];
  audioMode: 'original' | 'voiceover' | 'mute';
  mode: SubtitleMode;
  provider: SubtitlePlacementProvider;
}): SubtitleOverlayPlan {
  const orderedShots = [...input.shots].sort((a, b) => a.order - b.order);
  const decisions = new Map(input.decisions.map((decision) => [decision.shotId, decision]));
  const composerPlan = new Map(
    (input.composerPlan || buildComposerSubtitlePlan(orderedShots)).map((item) => [item.shotId, item]),
  );
  const events: SubtitleOverlayEvent[] = [];
  const skipped: SubtitleOverlayPlan['skipped'] = [];
  let cursor = 0;

  for (let index = 0; index < orderedShots.length; index++) {
    const shot = orderedShots[index];
    const transition = input.transitionPlan[index] || { transition: 'hard_cut', duration: Math.max(1, shot.duration) };
    const transitionOut = effectiveTransitionDuration(transition, input.transitionPlan[index + 1]);
    const planItem = composerPlan.get(shot.id);
    const text = wrapSubtitleText(readText(planItem?.text, readText(shot.subtitle, readText(shot.narration))));
    const visibility = shouldShowByDefault({
      mode: input.mode,
      text,
      audioMode: input.audioMode,
      decision: decisions.get(shot.id),
      visualDecisionMode: input.provider !== 'local',
    });

    if (!planItem?.show || !visibility.show) {
      skipped.push({
        shotId: shot.id,
        order: shot.order,
        reason: planItem?.show === false ? planItem.reason : visibility.reason,
      });
      cursor += Math.max(0.2, Math.max(1, shot.duration) - transitionOut);
      continue;
    }

    const start = boundedTime(cursor + 0.12);
    const end = boundedTime(Math.max(start + 0.8, cursor + Math.max(1, shot.duration) - transitionOut - 0.04));
    events.push({
      id: `subtitle_${shot.id}`,
      shotId: shot.id,
      shotOrder: shot.order,
      start,
      end,
      text,
      position: planItem?.position || inferPosition(shot),
      source: 'composer',
      reason: visibility.reason,
    });
    cursor += Math.max(0.2, Math.max(1, shot.duration) - transitionOut);
  }

  return {
    mode: input.mode,
    provider: input.provider,
    placementSource: input.mode === 'off' ? 'disabled' : 'composer',
    events,
    skipped,
  };
}

export function applyQwenSubtitleDecisions(
  plan: SubtitleOverlayPlan,
  advice: SubtitlePlacementAdvice[],
  qwenNote: string,
): SubtitleOverlayPlan {
  if (!advice.length || !plan.events.length) return { ...plan, qwenNote };

  const adviceByOrder = new Map(advice.map((item) => [item.order, item]));
  const events: SubtitleOverlayEvent[] = [];
  const skipped = [...plan.skipped];

  for (const event of plan.events) {
    const item = adviceByOrder.get(event.shotOrder);
    if (!item) {
      skipped.push({
        shotId: event.shotId,
        order: event.shotOrder,
        reason: 'Qwen-VL 未返回该候选字幕的显示决策，按视觉核心策略跳过。',
      });
      continue;
    }
    if (item.show === false || item.position === 'none') {
      skipped.push({
        shotId: event.shotId,
        order: event.shotOrder,
        reason: item.reason || 'Qwen-VL 判断该时段不适合叠加字幕。',
      });
      continue;
    }
    if (!POSITIONS.has(item.position as SubtitlePosition)) {
      skipped.push({
        shotId: event.shotId,
        order: event.shotOrder,
        reason: item.reason || 'Qwen-VL 未给出有效位置，按视觉核心策略跳过。',
      });
      continue;
    }
    const position = item.position as SubtitlePosition;
    events.push({
      ...event,
      position,
      source: 'qwenvl',
      reason: item.reason || 'Qwen-VL 根据画面 OCR、主体定位和安全区直接决定字幕位置。',
    });
  }

  return {
    ...plan,
    placementSource: 'qwenvl',
    events,
    skipped,
    qwenNote,
  };
}

export function summarizeSubtitlePlan(plan: SubtitleOverlayPlan) {
  const positions = plan.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.position] = (acc[event.position] || 0) + 1;
    return acc;
  }, {});
  return {
    mode: plan.mode,
    provider: plan.provider,
    placementSource: plan.placementSource,
    eventCount: plan.events.length,
    skippedCount: plan.skipped.length,
    positions,
    qwenNote: plan.qwenNote,
  };
}
