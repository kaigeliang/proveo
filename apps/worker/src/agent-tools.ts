import { randomUUID } from 'crypto';
import {
  createAgentToolCall,
  getScript,
  getTask,
  listMaterials,
  listReferenceVideos,
  searchSlices,
  updateShotContent,
  upsertAuditResult,
  upsertEvidenceRecord,
  upsertPassport,
  type ProductionFactor,
} from '@aigc-video-hub/db';
import {
  createToolRegistry,
  type AgentNodeContext,
  type JsonMap,
  type ToolRegistry,
  type ToolRunContext,
} from '@aigc-video-hub/agent-runtime';
import { processRenderFull, processRenderShot, processScriptGenerate, type ProcessorToolTracer } from './processors';

export type WorkerTools = {
  registry: ToolRegistry;
  execute(name: string, input: JsonMap, context?: ToolRunContext): Promise<JsonMap>;
  record<TOutput extends JsonMap>(
    ctx: AgentNodeContext,
    toolName: string,
    input: JsonMap,
    run: () => Promise<TOutput>,
  ): Promise<TOutput>;
};

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readNonNegativeInteger(value: unknown, fallback: number) {
  return Math.max(0, Math.floor(readNumber(value, fallback)));
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

function readGenerationProfile(value: unknown): 'quick_preview' | 'trusted_publish' | undefined {
  return value === 'quick_preview' || value === 'trusted_publish' ? value : undefined;
}

function readRecord(value: unknown): JsonMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonMap) : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function createProcessorToolTracer(ctx: AgentNodeContext): ProcessorToolTracer {
  return async <T>(toolName: string, input: JsonMap, run: () => Promise<T>, summarize: (result: T) => JsonMap) => {
    let result!: T;
    await recordToolCall(ctx, toolName, input, async () => {
      result = await run();
      return summarize(result);
    });
    return result;
  };
}

function readClaimArray(value: unknown) {
  return readArray(value)
    .map((item) => {
      const record = readRecord(item);
      const id = readString(record.id);
      const text = readString(record.text);
      if (!id || !text) return undefined;
      return {
        id,
        text,
        category: readString(record.category) || undefined,
        evidenceIds: readArray(record.evidenceIds)
          .map((evidenceId) => String(evidenceId))
          .filter(Boolean),
        confidence: readNumber(record.confidence, 0),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function readEvidenceArray(value: unknown) {
  return readArray(value)
    .map((item) => {
      const record = readRecord(item);
      const id = readString(record.id);
      if (!id) return undefined;
      return {
        id,
        text: readString(record.text) || undefined,
        sourceTitle: readString(record.sourceTitle) || undefined,
        sourceUrl: readString(record.sourceUrl) || undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function readPolicyRisk(value: unknown) {
  const risk = readString(value, 'medium');
  return risk === 'low' || risk === 'medium' || risk === 'high' ? risk : 'medium';
}

function readRenderPlan(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => {
        const record = readRecord(item);
        const transition = readString(record.transition);
        const normalizedTransition: 'hard_cut' | 'fade' | 'whip' | undefined =
          transition === 'hard_cut' || transition === 'fade' || transition === 'whip' ? transition : undefined;
        return {
          shotId: readString(record.shotId),
          action: 'generate' as const,
          referenceSliceIds: readArray(record.referenceSliceIds)
            .map((id) => readString(id))
            .filter(Boolean),
          score: readNumber(record.score, 0),
          transition: normalizedTransition,
          reason: readString(record.reason) || undefined,
        };
      })
    : undefined;
}

function taskPayload(task: Awaited<ReturnType<typeof getTask>>) {
  return readRecord(task?.payload);
}

function safeNarration(value: string) {
  return value
    .replace(/第一|最强|永久|100%|治愈|保证|绝对/g, '更适合真实场景')
    .replace(/\s+/g, ' ')
    .trim();
}

function readProductionFactors(value: unknown): ProductionFactor[] {
  return readArray(value).map((factor) => readRecord(factor) as ProductionFactor);
}

async function repairScriptIssues(scriptId: string) {
  const script = await getScript(scriptId);
  if (!script) throw new Error(`剧本不存在：${scriptId}`);
  const totalDuration = script.shots.reduce((sum, shot) => sum + shot.duration, 0);
  const durationScale = totalDuration > 15 ? 15 / totalDuration : 1;
  const repairs: Array<{ shotId: string; order: number; actions: string[] }> = [];

  for (const shot of script.shots) {
    const narration = safeNarration(shot.narration);
    const subtitle = safeNarration(shot.subtitle);
    const duration =
      durationScale < 1 ? clamp(Math.floor(shot.duration * durationScale), 3, 6) : Math.max(3, shot.duration);
    const changed = narration !== shot.narration || subtitle !== shot.subtitle || duration !== shot.duration;
    if (!changed) continue;
    await updateShotContent(shot.id, {
      narration,
      subtitle,
      duration,
      status: 'draft',
      clearAsset: true,
      factors: [
        ...readProductionFactors(shot.factors),
        { type: '自动修复', value: 'validator_script_repair', sourceStrategy: 'qa_repair_agent' },
      ],
    });
    repairs.push({
      shotId: shot.id,
      order: shot.order,
      actions: [
        narration !== shot.narration || subtitle !== shot.subtitle ? 'rewrite_safe_text' : '',
        duration !== shot.duration ? 'trim_duration' : '',
      ].filter(Boolean),
    });
  }

  return { scriptId, repairCount: repairs.length, repairs, saved: repairs.length > 0 };
}

async function applyShotRepair(input: {
  scriptId: string;
  shotId: string;
  issue: JsonMap;
  selectedMaterialRef?: string;
}) {
  const script = await getScript(input.scriptId);
  if (!script) throw new Error(`剧本不存在：${input.scriptId}`);
  const shot = script.shots.find((item) => item.id === input.shotId);
  if (!shot) throw new Error(`分镜不存在：${input.shotId}`);

  const action = readString(input.issue.action, 'rewrite_narration');
  const targetSignal = readString(input.issue.targetSignal, '参考结构关注点');
  const visualDesc = action === 'align_dna' ? `${shot.visualDesc}；补充镜头关注点：${targetSignal}` : shot.visualDesc;
  const narration =
    action === 'rewrite_narration'
      ? `${safeNarration(shot.narration) || '先看真实使用场景，再判断是否适合自己。'} 规格和权益以页面为准。`
      : action === 'align_dna'
        ? `${safeNarration(shot.narration)} 补充展示${targetSignal}，具体体验以真实素材为准。`
        : shot.narration;
  const subtitle =
    action === 'rewrite_narration'
      ? safeNarration(shot.subtitle || narration).slice(0, 24) || '看真实场景'
      : action === 'align_dna'
        ? targetSignal.slice(0, 24)
        : shot.subtitle;
  const duration = action === 'trim_duration' ? clamp(shot.duration, 3, 6) : Math.max(3, shot.duration);
  const materialRef = null;

  const updated = await updateShotContent(shot.id, {
    visualDesc,
    narration,
    subtitle,
    duration,
    materialRef,
    status: 'draft',
    clearAsset: true,
    factors: [
      ...readProductionFactors(shot.factors),
      { type: '修复动作', value: action, sourceStrategy: 'qa_repair_agent' },
    ],
  });

  return {
    scriptId: script.id,
    shotId: shot.id,
    action,
    selectedMaterialRef: undefined,
    changed: {
      visualDesc: updated.visualDesc,
      narration: updated.narration,
      subtitle: updated.subtitle,
      duration: updated.duration,
      materialRef: updated.materialRef,
    },
    saved: true,
  };
}

export function createWorkerTools(): WorkerTools {
  const registry = createToolRegistry([
    {
      name: 'db.list_materials',
      description: 'List production materials and slices for a product.',
      async run(input) {
        const productId = readString(input.productId);
        const limit = Math.max(1, Math.min(50, readNumber(input.limit, 20)));
        const materials = await listMaterials({ productId });
        return {
          productId,
          materialCount: materials.length,
          sliceCount: materials.reduce((sum, material) => sum + material.slices.length, 0),
          materials: materials.slice(0, limit).map((material) => ({
            id: material.id,
            type: material.type,
            name: material.name,
            sourceUrl: material.sourceUrl,
            sourceObjectKey: material.sourceObjectKey,
            sourceDeclaration: material.sourceDeclaration,
            sliceCount: material.slices.length,
            slices: material.slices.map((slice) => ({
              id: slice.id,
              summary: slice.summary,
              tags: slice.tags,
              thumbnailUrl: slice.thumbnailUrl,
              thumbnailObjectKey: slice.thumbnailObjectKey,
              clipUrl: slice.clipUrl,
              clipObjectKey: slice.clipObjectKey,
              startTime: slice.startTime,
              endTime: slice.endTime,
            })),
          })),
        };
      },
    },
    {
      name: 'db.list_reference_videos',
      description: 'Load structured reference-video breakdowns for HotVideoDNA analysis without reusing source media.',
      async run(input) {
        const preferredId = readString(input.ref);
        const limit = Math.max(1, Math.min(10, readNumber(input.limit, 3)));
        const references = await listReferenceVideos();
        const ordered = preferredId
          ? [
              ...references.filter((reference) => reference.id === preferredId),
              ...references.filter((reference) => reference.id !== preferredId),
            ]
          : references;
        return {
          preferredId: preferredId || undefined,
          references: ordered.slice(0, limit).map((reference) => ({
            id: reference.id,
            sourceUrl: reference.sourceUrl,
            sourceDeclaration: reference.sourceDeclaration,
            licenseType: reference.licenseType,
            usageScope: reference.usageScope,
            breakdownReport: readRecord(reference.breakdownReport),
          })),
        };
      },
    },
    {
      name: 'db.search_slices',
      description: 'Search merchant-owned material slices as generation references for the current product.',
      async run(input) {
        const query = readString(input.query);
        const limit = Math.max(1, Math.min(20, readNumber(input.limit, 3)));
        const productId = readString(input.productId);
        if (!productId) {
          return {
            query,
            productId: undefined,
            limit,
            warning:
              'productId is required; slices are generation references only and cannot be reused as output media.',
            slices: [],
          };
        }
        const slices = await searchSlices(query, limit, productId);
        return {
          query,
          productId,
          limit,
          slices: slices.map((slice) => ({
            id: slice.id,
            materialId: slice.materialId,
            score: readNumber(slice.score, 0),
            summary: slice.summary,
            tags: slice.tags,
            thumbnailUrl: slice.thumbnailUrl,
            thumbnailObjectKey: slice.thumbnailObjectKey,
            clipUrl: slice.clipUrl,
            clipObjectKey: slice.clipObjectKey,
            startTime: slice.startTime,
            endTime: slice.endTime,
            material: {
              id: slice.material.id,
              productId: slice.material.productId,
              type: slice.material.type,
              name: slice.material.name,
              sourceUrl: slice.material.sourceUrl,
              sourceObjectKey: slice.material.sourceObjectKey,
              sourceDeclaration: slice.material.sourceDeclaration,
            },
          })),
        };
      },
    },
    {
      name: 'db.upsert_evidence_record',
      description: 'Persist a product evidence ledger generated by Research Agent.',
      async run(input) {
        const productId = readString(input.productId);
        const output = readRecord(input.output);
        if (!productId) throw new Error('db.upsert_evidence_record requires productId');
        await upsertEvidenceRecord(productId, output);
        return {
          productId,
          saved: true,
          evidenceCount: readArray(output.evidence).length,
          claimCount: readArray(output.claims).length,
        };
      },
    },
    {
      name: 'db.upsert_audit_result',
      description: 'Persist QA audit output for a rendered task/script.',
      async run(input) {
        const taskId = readString(input.taskId);
        const scriptId = readString(input.scriptId);
        const level = readString(input.level, 'warn');
        const issues = readArray(input.issues);
        const metrics = readRecord(input.metrics);
        if (!taskId) throw new Error('db.upsert_audit_result requires taskId');
        if (!scriptId) throw new Error('db.upsert_audit_result requires scriptId');
        await upsertAuditResult(taskId, scriptId, level, issues, metrics);
        return {
          taskId,
          scriptId,
          level,
          issueCount: issues.length,
          saved: true,
        };
      },
    },
    {
      name: 'db.update_script_repair',
      description: 'Apply script-level QA repairs to unsafe copy or overlong shots.',
      async run(input) {
        const scriptId = readString(input.scriptId);
        if (!scriptId) throw new Error('db.update_script_repair requires scriptId');
        return repairScriptIssues(scriptId);
      },
    },
    {
      name: 'db.update_shot_content',
      description: 'Apply a targeted QA repair patch to one script shot.',
      async run(input) {
        const scriptId = readString(input.scriptId);
        const shotId = readString(input.shotId);
        if (!scriptId) throw new Error('db.update_shot_content requires scriptId');
        if (!shotId) throw new Error('db.update_shot_content requires shotId');
        return applyShotRepair({
          scriptId,
          shotId,
          issue: readRecord(input.issue),
          selectedMaterialRef: readString(input.selectedMaterialRef) || undefined,
        });
      },
    },
    {
      name: 'db.upsert_passport',
      description: 'Persist the generated video passport and trust metadata.',
      async run(input) {
        const videoId = readString(input.videoId);
        const scriptId = readString(input.scriptId);
        if (!videoId) throw new Error('db.upsert_passport requires videoId');
        if (!scriptId) throw new Error('db.upsert_passport requires scriptId');
        const trustScore = readNumber(input.trustScore, 0);
        const evidenceCoverage = readNumber(input.evidenceCoverage, 0);
        const realMaterialRatio = readNumber(input.realMaterialRatio, 0);
        const approvedClaims = readNonNegativeInteger(input.approvedClaims, 0);
        const needsEvidenceClaims = readNonNegativeInteger(input.needsEvidenceClaims, 0);
        const blockedClaims = readNonNegativeInteger(input.blockedClaims, 0);
        const repairedClaims = readNonNegativeInteger(input.repairedClaims, 0);
        const policyRisk = readPolicyRisk(input.policyRisk);
        const iterationCount = Math.max(1, readNonNegativeInteger(input.iterationCount, 1));
        const evidenceBreakdown = readRecord(input.evidenceBreakdown);
        await upsertPassport({
          videoId,
          scriptId,
          trustScore,
          evidenceCoverage,
          realMaterialRatio,
          approvedClaims,
          needsEvidenceClaims,
          blockedClaims,
          repairedClaims,
          policyRisk,
          iterationCount,
          evidenceBreakdown,
          generatedAt: new Date(),
        });
        return {
          videoId,
          scriptId,
          trustScore,
          policyRisk,
          saved: true,
        };
      },
    },
    {
      name: 'worker.process_script_generate',
      description: 'Generate a production script through the Worker script processor and return task payload.',
      async run(input, context) {
        const taskId = readString(input.taskId);
        await processScriptGenerate({
          taskId,
          productId: readString(input.productId),
          mode: readMode(input.mode),
          provider: readScriptProvider(input.provider),
          retrievalMode: readRetrievalMode(input.retrievalMode),
          generationProfile: readGenerationProfile(input.generationProfile),
          ref: readString(input.ref) || undefined,
          freePrompt: readString(input.freePrompt) || undefined,
          referenceImageUrl: readString(input.referenceImageUrl) || undefined,
          approvedClaims: readClaimArray(input.approvedClaims),
          evidence: readEvidenceArray(input.evidence),
          hotVideoDna: readRecord(input.hotVideoDna),
          strategy: readRecord(input.strategy),
          traceTool: context?.node ? createProcessorToolTracer(context.node) : undefined,
        });
        return taskPayload(await getTask(taskId));
      },
    },
    {
      name: 'worker.process_render_full',
      description: 'Render a full production video through the Worker render processor and return task payload.',
      async run(input, context) {
        const taskId = readString(input.taskId);
        await processRenderFull({
          taskId,
          scriptId: readString(input.scriptId),
          exportOptions: readRecord(input.exportOptions),
          renderPlan: readRenderPlan(input.renderPlan),
          subtitlePlan: readArray(input.subtitlePlan) as Parameters<typeof processRenderFull>[0]['subtitlePlan'],
          traceTool: context?.node ? createProcessorToolTracer(context.node) : undefined,
        });
        return taskPayload(await getTask(taskId));
      },
    },
    {
      name: 'worker.process_render_shot',
      description: 'Render one repaired shot through the Worker render processor and return task payload.',
      async run(input, context) {
        const taskId = readString(input.taskId);
        await processRenderShot({
          taskId,
          scriptId: readString(input.scriptId),
          shotId: readString(input.shotId),
          provider: readRenderProvider(input.provider),
          referenceImageUrl: readString(input.referenceImageUrl) || undefined,
          traceTool: context?.node ? createProcessorToolTracer(context.node) : undefined,
        });
        return taskPayload(await getTask(taskId));
      },
    },
  ]);

  return {
    registry,
    execute(name, input, context) {
      return registry.execute(name, input, context);
    },
    async record(ctx, toolName, input, run) {
      const startedAt = Date.now();
      try {
        const output = await run();
        await createAgentToolCall({
          id: makeId('tool'),
          runId: ctx.run.id,
          stepId: ctx.stepId,
          toolName,
          status: 'completed',
          input,
          output,
          latencyMs: Date.now() - startedAt,
        });
        return output;
      } catch (error) {
        await createAgentToolCall({
          id: makeId('tool'),
          runId: ctx.run.id,
          stepId: ctx.stepId,
          toolName,
          status: 'failed',
          input,
          error: error instanceof Error ? error.message : 'tool call failed',
          latencyMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
}

export function getWorkerTools(ctx: AgentNodeContext): WorkerTools {
  const tools = (ctx.tools.worker || ctx.tools) as Partial<WorkerTools>;
  if (!tools.record || !tools.execute || !tools.registry) {
    throw new Error('Worker tool registry is not available in AgentNodeContext');
  }
  return tools as WorkerTools;
}

export async function recordToolCall<TOutput extends JsonMap>(
  ctx: AgentNodeContext,
  toolName: string,
  input: JsonMap,
  run: () => Promise<TOutput>,
) {
  return getWorkerTools(ctx).record(ctx, toolName, input, run);
}

export async function runRegisteredTool(ctx: AgentNodeContext, toolName: string, input: JsonMap) {
  return recordToolCall(ctx, toolName, input, () =>
    getWorkerTools(ctx).execute(toolName, input, { node: ctx, signal: ctx.signal, logger: ctx.logger }),
  );
}
