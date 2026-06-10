import { v4 as uuid } from 'uuid';
import {
  createAgentRun,
  createTask,
  deleteMaterial,
  getMaterial,
  getScript,
  getTask,
  latestRenderTaskForScript,
  listMaterialAngles,
  listMaterials,
  replaceMaterialAngles,
  searchSlices,
  createShotForScript,
  updateTask,
  updateScriptContent,
  updateShotContent,
  deleteShot,
  upsertMaterial,
  upsertMaterialAngle,
  type ProductionMaterialAngleInput,
  type AgentRunKind,
  type ProductionMaterialInput,
  type ProductionShotInput,
  type ProductionTaskType,
} from '@aigc-video-hub/db';
import type { MaterialAngle } from '@aigc-video-hub/shared';
import { createQueues, enqueueProductionJob, type ProductionJob, type QueueSet } from '@aigc-video-hub/queue';
import { vectorSearchEnabled } from './light-mode';

let queues: QueueSet | undefined;

function getQueues() {
  if (!queues) queues = createQueues();
  return queues;
}

function readMode(value: unknown): 'imitate' | 'template' | 'auto' {
  return value === 'imitate' || value === 'template' || value === 'auto' ? value : 'auto';
}

function readScriptProvider(value: unknown): 'auto' | 'local' | 'doubao' {
  return value === 'local' || value === 'doubao' || value === 'auto' ? value : 'auto';
}

function readRenderProvider(value: unknown): 'auto' | 'local' | 'seedance' {
  return value === 'local' || value === 'seedance' || value === 'auto' ? value : 'auto';
}

function readRetrievalMode(value: unknown): 'rag' | 'none' {
  return value === 'none' ? 'none' : 'rag';
}

function jobForTask(type: ProductionTaskType, payload: Record<string, unknown> & { taskId: string }): ProductionJob {
  if (type === 'script') {
    return {
      name: 'script.generate',
      data: {
        taskId: payload.taskId,
        productId: String(payload.productId || ''),
        mode: readMode(payload.mode),
        provider: readScriptProvider(payload.provider),
        retrievalMode: readRetrievalMode(payload.retrievalMode),
        generationProfile:
          payload.generationProfile === 'quick_preview' || payload.generationProfile === 'trusted_publish'
            ? payload.generationProfile
            : undefined,
        ref: typeof payload.ref === 'string' ? payload.ref : undefined,
        freePrompt: typeof payload.freePrompt === 'string' ? payload.freePrompt : undefined,
      },
    };
  }

  if (type === 'compose') {
    return {
      name: 'render.full',
      data: {
        taskId: payload.taskId,
        scriptId: String(payload.scriptId || ''),
        exportOptions: payload.exportOptions
          ? (payload.exportOptions as Record<string, unknown>)
          : {
              provider: payload.provider,
              aspectRatio: payload.aspectRatio,
              resolution: payload.resolution,
              audioMode: payload.audioMode,
              retrievalMode: payload.retrievalMode,
              referenceImageUrl: payload.referenceImageUrl,
              subtitleMode: payload.subtitleMode,
              subtitlePlacementProvider: payload.subtitlePlacementProvider,
              subtitleFontFamily: payload.subtitleFontFamily,
              subtitleFontSize: payload.subtitleFontSize,
            },
      },
    };
  }

  if (type === 'video') {
    return {
      name: 'render.shot',
      data: {
        taskId: payload.taskId,
        scriptId: String(payload.scriptId || ''),
        shotId: String(payload.shotId || ''),
        provider: readRenderProvider(payload.provider),
        referenceImageUrl: typeof payload.referenceImageUrl === 'string' ? payload.referenceImageUrl : undefined,
        referenceAnglePrompt:
          typeof payload.referenceAnglePrompt === 'string' ? payload.referenceAnglePrompt : undefined,
        preview: payload.preview === true,
      },
    };
  }

  if (type === 'slice') {
    return {
      name: 'material.slice',
      data: {
        taskId: payload.taskId,
        materialId: String(payload.materialId || ''),
        seedText: String(payload.seedText || payload.materialId || ''),
      },
    };
  }

  if (type === 'angle') {
    return {
      name: 'material.angle',
      data: {
        taskId: payload.taskId,
        materialId: String(payload.materialId || ''),
        force: payload.force === true || payload.force === 'true',
        includePresets: payload.includePresets !== false,
        customAngles: payload.customAngles,
      },
    };
  }

  if (type === 'index') {
    return {
      name: 'video-tags.reindex',
      data: {
        taskId: payload.taskId,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      },
    };
  }

  if (type === 'trend') {
    return {
      name: 'trend.refresh',
      data: {
        taskId: payload.taskId,
        productId: typeof payload.productId === 'string' ? payload.productId : undefined,
        source: typeof payload.source === 'string' ? payload.source : undefined,
      },
    };
  }

  throw new Error(`不支持的生产任务类型：${type}`);
}

function agentRunKindForTask(type: ProductionTaskType): AgentRunKind | undefined {
  if (type === 'script') return 'script_generate';
  if (type === 'compose') return 'render_full';
  return undefined;
}

function formatElapsedMs(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

export function queuedTaskResponse(task: Awaited<ReturnType<typeof getTask>>) {
  if (!task) return undefined;
  const terminal = task.status === 'completed' || task.status === 'failed';
  const elapsedMs = Math.max(0, (terminal ? task.updatedAt.getTime() : Date.now()) - task.createdAt.getTime());
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    progress: task.progress,
    step: task.step,
    error: task.error || undefined,
    elapsedMs,
    elapsedText: formatElapsedMs(elapsedMs),
    payload: task.payload || undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    trace: task.traces.map((trace) => ({
      at: trace.createdAt.toISOString(),
      step: trace.step,
      progress: trace.progress,
      message: trace.message,
      elapsedMs: Math.max(0, trace.createdAt.getTime() - task.createdAt.getTime()),
      elapsedText: formatElapsedMs(Math.max(0, trace.createdAt.getTime() - task.createdAt.getTime())),
      data: trace.data || undefined,
    })),
  };
}

export async function getQueuedTaskResponse(taskId: string) {
  return queuedTaskResponse(await getTask(taskId));
}

export async function createQueuedTask(type: ProductionTaskType, payload: Record<string, unknown>) {
  const taskId = `task_${uuid().slice(0, 10)}`;
  const fullPayload: Record<string, unknown> & { taskId: string } = { ...payload, taskId };
  await createTask({
    id: taskId,
    type,
    payload: fullPayload,
    step: 'queued',
    message: '任务已写入 Postgres，并等待 BullMQ Worker 领取。',
  });

  try {
    const agentRunKind = agentRunKindForTask(type);
    let agentRunId: string | undefined;
    if (agentRunKind && process.env.AGENT_ORCHESTRATION_ENABLED !== 'false') {
      agentRunId = `run_${uuid().slice(0, 10)}`;
      await createAgentRun({
        id: agentRunId,
        taskId,
        kind: agentRunKind,
        graphVersion: `agent-graph.${agentRunKind}.pending`,
        productId: typeof fullPayload.productId === 'string' ? fullPayload.productId : undefined,
        scriptId: typeof fullPayload.scriptId === 'string' ? fullPayload.scriptId : undefined,
        videoId: typeof fullPayload.videoId === 'string' ? fullPayload.videoId : undefined,
        input: fullPayload,
      });
      await enqueueProductionJob(getQueues(), {
        name: 'agent.run',
        data: { taskId, runId: agentRunId, kind: agentRunKind },
      });
    } else {
      await enqueueProductionJob(getQueues(), jobForTask(type, fullPayload));
    }
    const queued = await updateTask(taskId, {
      status: 'pending',
      progress: 0,
      step: 'queue_submitted',
      payload: agentRunId ? { agentRunId } : undefined,
      trace: {
        step: 'queue_submitted',
        progress: 0,
        message: agentRunId ? '任务已投递到 Agent Orchestrator。' : '任务已投递到 BullMQ。',
        data: { pipeline: 'queue', agentRunId },
      },
    });
    return queuedTaskResponse(queued) || { id: taskId };
  } catch (error) {
    await updateTask(taskId, {
      status: 'failed',
      progress: 0,
      step: 'queue_submit_failed',
      error: error instanceof Error ? error.message : 'BullMQ 投递失败',
      trace: {
        step: 'queue_submit_failed',
        progress: 0,
        message: error instanceof Error ? error.message : 'BullMQ 投递失败',
      },
    });
    throw error;
  }
}

export async function retryQueuedTask(taskId: string) {
  const source = await getTask(taskId);
  if (!source) return undefined;
  if (source.status !== 'failed') {
    throw new Error('只有 failed 任务需要重试');
  }

  const payload: Record<string, unknown> = {
    ...((source.payload as Record<string, unknown> | null) || {}),
    retryOf: source.id,
  };
  delete payload.taskId;
  return createQueuedTask(source.type as ProductionTaskType, payload);
}

function publicSlice(row: NonNullable<Awaited<ReturnType<typeof getMaterial>>>['slices'][number], productId?: string) {
  return {
    id: row.id,
    materialId: row.materialId,
    productId,
    thumbnailUrl: row.thumbnailUrl,
    clipUrl: row.clipUrl,
    startTime: row.startTime,
    endTime: row.endTime,
    tags: row.tags,
    summary: row.summary,
  };
}

function publicMaterial(row: NonNullable<Awaited<ReturnType<typeof getMaterial>>>) {
  return {
    id: row.id,
    productId: row.productId || undefined,
    name: row.name || undefined,
    type: row.type,
    sourceUrl: row.sourceUrl,
    sourceObjectKey: row.sourceObjectKey || undefined,
    sourceDeclaration: row.sourceDeclaration,
    uploadedAt: row.uploadedAt,
    slices: row.slices.map((slice) => publicSlice(slice, row.productId || undefined)),
    angles: row.angles.map(publicMaterialAngle),
  };
}

function publicMaterialAngle(row: Awaited<ReturnType<typeof listMaterialAngles>>[number]): MaterialAngle {
  return {
    id: row.id,
    materialId: row.materialId,
    productId: row.productId || undefined,
    view: row.view as MaterialAngle['view'],
    key: row.key,
    label: row.label,
    imageUrl: row.imageUrl,
    referenceImageUrl: row.referenceImageUrl,
    previewUrl: row.previewUrl || undefined,
    sourceImageUrl: row.sourceImageUrl,
    promptHint: row.promptHint,
    pose: (row.pose as MaterialAngle['pose'] | null) || undefined,
    provider: row.provider as MaterialAngle['provider'],
    status: row.status as MaterialAngle['status'],
    note: row.note || undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function productionMaterialAngleInput(angle: MaterialAngle): ProductionMaterialAngleInput {
  return {
    id: angle.id,
    materialId: angle.materialId,
    productId: angle.productId,
    view: angle.view,
    key: angle.key,
    label: angle.label,
    imageUrl: angle.imageUrl,
    referenceImageUrl: angle.referenceImageUrl,
    previewUrl: angle.previewUrl,
    sourceImageUrl: angle.sourceImageUrl,
    promptHint: angle.promptHint,
    pose: angle.pose as Record<string, unknown> | undefined,
    provider: angle.provider,
    status: angle.status,
    note: angle.note,
    createdAt: angle.createdAt ? new Date(angle.createdAt) : undefined,
  };
}

function publicScript(row: NonNullable<Awaited<ReturnType<typeof getScript>>>) {
  return {
    id: row.id,
    productId: row.productId,
    generationProfile: row.generationProfile as 'quick_preview' | 'trusted_publish',
    productUrl: row.productUrl || undefined,
    referenceImageUrl: row.referenceImageUrl || undefined,
    materialIds: row.materialIds,
    sourceMode: row.sourceMode,
    sourceRef: row.sourceRef || undefined,
    narrative: row.narrative,
    visualStyle: row.visualStyle,
    bgm: row.bgm,
    aspectRatio: row.aspectRatio,
    language: row.language,
    constraints: row.constraints,
    shots: row.shots.map((shot) => ({
      id: shot.id,
      order: shot.order,
      duration: shot.duration,
      visualDesc: shot.visualDesc,
      camera: shot.camera,
      narration: shot.narration,
      subtitle: shot.subtitle,
      materialRef: shot.materialRef || undefined,
      transition: shot.transition || undefined,
      factors: shot.factors,
      status: shot.status,
      assetUrl: shot.assetUrl || undefined,
      claimIds: shot.claimIds,
      evidenceIds: shot.evidenceIds,
    })),
  };
}

export async function patchProductionScript(
  scriptId: string,
  input: {
    narrative?: string;
    visualStyle?: string;
    bgm?: string;
    language?: string;
    aspectRatio?: '9:16' | '16:9';
    shotOrder?: string[];
  },
) {
  const existing = await getScript(scriptId);
  if (!existing) return undefined;
  await updateScriptContent(scriptId, input);
  const updated = await getScript(scriptId);
  return updated ? publicScript(updated) : undefined;
}

function asProductionFactors(value: unknown): ProductionShotInput['factors'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const factors = value
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const type = typeof row.type === 'string' ? row.type : '';
      const factorValue = typeof row.value === 'string' ? row.value : '';
      const sourceStrategy = typeof row.sourceStrategy === 'string' ? row.sourceStrategy : 'manual_edit';
      return type && factorValue ? { type, value: factorValue, sourceStrategy } : undefined;
    })
    .filter((item): item is ProductionShotInput['factors'][number] => Boolean(item));
  return factors.length ? factors : undefined;
}

export async function patchProductionShot(
  scriptId: string,
  shotId: string,
  input: {
    visualDesc?: string;
    camera?: string;
    narration?: string;
    subtitle?: string;
    materialRef?: string | null;
    transition?: unknown;
    duration?: number;
    order?: number;
    factors?: unknown;
    claimIds?: string[];
    evidenceIds?: string[];
    status?: 'draft' | 'generating' | 'done' | 'failed';
    clearAsset?: boolean;
  },
) {
  const existing = await getScript(scriptId);
  if (!existing || !existing.shots.some((shot) => shot.id === shotId)) return undefined;
  await updateShotContent(shotId, {
    visualDesc: input.visualDesc,
    camera: input.camera,
    narration: input.narration,
    subtitle: input.subtitle,
    materialRef: input.materialRef,
    transition:
      input.transition === 'hard_cut' || input.transition === 'fade' || input.transition === 'whip'
        ? input.transition
        : undefined,
    duration: input.duration,
    order: input.order,
    factors: asProductionFactors(input.factors),
    claimIds: input.claimIds,
    evidenceIds: input.evidenceIds,
    status: input.status,
    clearAsset: input.clearAsset,
  });
  const updated = await getScript(scriptId);
  return updated ? publicScript(updated) : undefined;
}

export async function createProductionShot(scriptId: string, input: ProductionShotInput) {
  const existing = await getScript(scriptId);
  if (!existing) return undefined;
  const requestedOrder = Number(input.order);
  const order =
    Number.isFinite(requestedOrder) && requestedOrder > 0 ? Math.round(requestedOrder) : existing.shots.length + 1;
  await createShotForScript(scriptId, { ...input, order });
  const updated = await getScript(scriptId);
  return updated ? publicScript(updated) : undefined;
}

export async function deleteProductionShot(scriptId: string, shotId: string) {
  const existing = await getScript(scriptId);
  if (!existing || !existing.shots.some((shot) => shot.id === shotId)) return undefined;
  await deleteShot(shotId);
  const updated = await getScript(scriptId);
  return updated ? publicScript(updated) : undefined;
}

export async function saveProductionMaterial(input: ProductionMaterialInput) {
  return publicMaterial(await upsertMaterial(input));
}

export async function getProductionMaterial(materialId: string) {
  const material = await getMaterial(materialId);
  return material ? publicMaterial(material) : undefined;
}

export async function deleteProductionMaterial(materialId: string) {
  const deleted = await deleteMaterial(materialId);
  if (!deleted) return undefined;
  return {
    id: deleted.id,
    deletedSliceIds: deleted.slices.map((slice) => slice.id),
    deletedAngleIds: deleted.angles.map((angle) => angle.id),
  };
}

export async function listProductionMaterials(filters: { type?: string; productId?: string } = {}) {
  return (await listMaterials(filters)).map(publicMaterial);
}

export async function listProductionMaterialAngles(materialId: string) {
  return (await listMaterialAngles(materialId)).map(publicMaterialAngle);
}

export async function saveProductionMaterialAngle(angle: MaterialAngle) {
  return publicMaterialAngle(await upsertMaterialAngle(productionMaterialAngleInput(angle)));
}

export async function saveProductionMaterialAngles(materialId: string, angles: MaterialAngle[]) {
  return (await replaceMaterialAngles(materialId, angles.map(productionMaterialAngleInput))).map(publicMaterialAngle);
}

export async function searchProductionMaterialSlices(query: string, limit: number, productId: string) {
  if (!vectorSearchEnabled()) {
    const normalized = query.trim().toLowerCase();
    const materials = await listMaterials({ productId });
    const rows = materials
      .flatMap((material) =>
        material.slices.map((slice) => {
          const haystack = `${slice.summary || ''} ${material.name || ''} ${material.sourceDeclaration || ''}`
            .trim()
            .toLowerCase();
          const keywordScore = normalized && haystack.includes(normalized) ? 1 : 0;
          return { material, slice, score: keywordScore || 0.55 };
        }),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return rows.map((row) => ({
      ...publicSlice(row.slice, row.material.productId || undefined),
      score: row.score,
      match: {
        keyword: row.score,
        vector: 0,
        tag: 0,
        rrf: row.score,
        phrase: row.score,
      },
    }));
  }
  return (await searchSlices(query, limit, productId)).map((row) => ({
    ...publicSlice(row, row.material.productId || undefined),
    score: row.score,
    match: {
      keyword: 0,
      vector: row.score,
      tag: 0,
      rrf: row.score,
      phrase: 0,
    },
  }));
}

export async function getProductionSlice(sliceId: string) {
  const materials = await listMaterials();
  for (const material of materials) {
    const slice = material.slices.find((item) => item.id === sliceId);
    if (slice) return publicSlice(slice, material.productId || undefined);
  }
  return undefined;
}

export async function getProductionScript(scriptId: string) {
  const script = await getScript(scriptId);
  return script ? publicScript(script) : undefined;
}

export async function getProductionRenderPreview(scriptId: string) {
  const script = await getScript(scriptId);
  if (!script) return undefined;
  const render = await latestRenderTaskForScript(scriptId);
  const payload = (render?.payload as Record<string, unknown> | null) || {};
  return {
    videoUrl: payload.videoUrl || null,
    status: render?.status === 'completed' ? 'done' : 'pending',
    shots: publicScript(script).shots,
  };
}
