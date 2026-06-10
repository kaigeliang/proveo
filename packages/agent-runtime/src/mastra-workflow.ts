import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const EXECUTION_LAYER = 'BullMQ + Postgres + Worker' as const;
const WORKFLOW_ID = 'proveo-tiktok-video-production';
const APPROVAL_RESUME_LABEL = '确认出片 / 修改分镜 / 补充素材';

const uiPhaseSchema = z.enum([
  'needs_input',
  'researching_product',
  'generating_script',
  'awaiting_storyboard_confirmation',
  'generating_video',
  'completed',
  'failed',
]);

const dispatchDescriptorSchema = z.object({
  nodeId: z.string(),
  target: z.enum(['BullMQ:aigc.agent', 'BullMQ:aigc.script', 'BullMQ:aigc.render']),
  kind: z.string(),
  queued: z.boolean(),
  note: z.string(),
});

export const mastraProductionWorkflowInputSchema = z
  .object({
    latestText: z.string().optional(),
    productId: z.string().optional(),
    scriptId: z.string().optional(),
    videoId: z.string().optional(),
    productTitle: z.string().optional(),
    productUrl: z.string().optional(),
    referenceImageUrl: z.string().optional(),
    target: z.enum(['script', 'video']).optional(),
    hasResearch: z.boolean().optional(),
    hasScript: z.boolean().optional(),
    renderConsent: z.boolean().optional(),
    approvalAction: z.enum(['confirm_render', 'revise_script', 'add_material', 'none']).optional(),
  })
  .passthrough();

const requirementOutputSchema = z
  .object({
    route: z.enum(['needs_input', 'continue']),
    workflowDecision: z.enum(['ask_for_product', 'research_first', 'script_first', 'render_confirmed']),
    missing: z.array(z.string()),
    uiPhase: uiPhaseSchema,
    title: z.string(),
    summary: z.string().optional(),
  })
  .passthrough();

const branchMarkerSchema = z
  .object({
    branch: z.enum(['needs_input', 'continue']),
  })
  .passthrough();

const workflowContextSchema = z
  .object({
    workflowDecision: z.string(),
    missing: z.array(z.string()),
    uiPhase: uiPhaseSchema,
    executionLayer: z.literal(EXECUTION_LAYER),
    dispatches: z.array(dispatchDescriptorSchema),
  })
  .passthrough();

const researchOutputSchema = z
  .object({
    nodeId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  })
  .passthrough();

const parallelResearchOutputSchema = z.record(researchOutputSchema);

export const mastraProductionWorkflowOutputSchema = z
  .object({
    status: z.enum(['needs_input', 'awaiting_storyboard_confirmation', 'dispatched', 'completed']),
    uiPhase: uiPhaseSchema,
    nextAction: z.string(),
    executionLayer: z.literal(EXECUTION_LAYER),
    dispatches: z.array(dispatchDescriptorSchema),
    visibleEvent: z.object({
      title: z.string(),
      summary: z.string().optional(),
    }),
  })
  .passthrough();

export type MastraProductionWorkflowInput = z.infer<typeof mastraProductionWorkflowInputSchema>;
export type MastraProductionWorkflowOutput = z.infer<typeof mastraProductionWorkflowOutputSchema>;

function hasProductSignal(input: MastraProductionWorkflowInput) {
  return Boolean(
    input.productId || input.scriptId || input.productTitle || input.productUrl || input.referenceImageUrl,
  );
}

const requirementsStep = createStep({
  id: 'requirements.confirm',
  description: 'Branch gate: decide whether to ask for product information or continue into production planning.',
  inputSchema: mastraProductionWorkflowInputSchema,
  outputSchema: requirementOutputSchema,
  execute: async ({ inputData }) => {
    const missing: string[] = [];
    if (!hasProductSignal(inputData)) missing.push('商品链接、商品名、主图或核心卖点');

    if (missing.length) {
      return {
        route: 'needs_input',
        workflowDecision: 'ask_for_product',
        missing,
        uiPhase: 'needs_input',
        title: '需要补充信息',
        summary: missing[0],
      } as const;
    }

    if (inputData.hasScript && inputData.renderConsent) {
      return {
        route: 'continue',
        workflowDecision: 'render_confirmed',
        missing,
        uiPhase: 'generating_video',
        title: '准备派发成片任务',
      } as const;
    }

    return {
      route: 'continue',
      workflowDecision: inputData.hasResearch ? 'script_first' : 'research_first',
      missing,
      uiPhase: inputData.hasResearch ? 'generating_script' : 'researching_product',
      title: inputData.hasResearch ? '正在生成剧本' : '正在调研商品',
    } as const;
  },
});

const needsInputBranchStep = createStep({
  id: 'requirements.needs_input',
  description: 'Terminal branch marker for incomplete briefs.',
  inputSchema: requirementOutputSchema,
  outputSchema: branchMarkerSchema,
  execute: async () => ({ branch: 'needs_input' as const }),
});

const continueBranchStep = createStep({
  id: 'requirements.ready',
  description: 'Branch marker for briefs that can continue into research/script planning.',
  inputSchema: requirementOutputSchema,
  outputSchema: branchMarkerSchema,
  execute: async () => ({ branch: 'continue' as const }),
});

const routeAfterRequirementsStep = createStep({
  id: 'requirements.route',
  description: 'Normalizes branch output and bails with a user-facing needs-input result when required.',
  inputSchema: z.record(z.unknown()),
  outputSchema: workflowContextSchema,
  execute: async ({ getStepResult, bail }) => {
    const requirements = getStepResult<typeof requirementsStep>(requirementsStep);
    if (requirements.route === 'needs_input') {
      return bail({
        status: 'needs_input',
        uiPhase: 'needs_input',
        nextAction: 'ask_for_product',
        executionLayer: EXECUTION_LAYER,
        dispatches: [],
        visibleEvent: {
          title: requirements.title,
          summary: requirements.summary,
        },
      } satisfies MastraProductionWorkflowOutput);
    }

    return {
      workflowDecision: requirements.workflowDecision,
      missing: requirements.missing,
      uiPhase: requirements.uiPhase,
      executionLayer: EXECUTION_LAYER,
      dispatches: [],
    };
  },
});

function researchStep(id: string, summary: string) {
  return createStep({
    id,
    description: `Parallel research node: ${summary}`,
    inputSchema: workflowContextSchema,
    outputSchema: researchOutputSchema,
    execute: async () => ({
      nodeId: id,
      ok: true,
      summary,
    }),
  });
}

const productIngestStep = researchStep('product.ingest', '商品页抓取只产出资料引用，不直接改写成片素材。');
const materialContextStep = researchStep('material.context', '只检查当前商品素材库，素材切片仅作为 Seedance 参考。');
const referenceRetrieveStep = researchStep('reference.retrieve', '爆款参考库只提供 Hook、节奏和字幕策略。');
const policyPrecheckStep = researchStep('policy.precheck', '合规预检输出可用表达和风险提示。');

const mergeResearchStep = createStep({
  id: 'research.merge',
  description: 'Merges parallel research results back into the workflow context.',
  inputSchema: parallelResearchOutputSchema,
  outputSchema: workflowContextSchema,
  execute: async ({ inputData, getStepResult }) => {
    const context = getStepResult<typeof routeAfterRequirementsStep>(routeAfterRequirementsStep);
    return {
      ...context,
      uiPhase: 'generating_script' as const,
      research: inputData,
    };
  },
});

const scriptComposeStep = createStep({
  id: 'script.compose',
  description:
    'Decision node for script generation; returns a BullMQ dispatch descriptor instead of doing model work inline.',
  inputSchema: workflowContextSchema,
  outputSchema: workflowContextSchema,
  execute: async ({ inputData, getInitData, bail }) => {
    const init = getInitData<MastraProductionWorkflowInput>();
    const dispatches = [
      ...inputData.dispatches,
      {
        nodeId: 'script.compose',
        target: 'BullMQ:aigc.script' as const,
        kind: 'script_generate',
        queued: false,
        note: 'Mastra step only decides/declares dispatch; existing API/Worker enqueues the real job.',
      },
    ];

    if ((init.target || 'script') === 'script') {
      return bail({
        status: 'dispatched',
        uiPhase: 'generating_script',
        nextAction: 'worker_runs_script_generate',
        executionLayer: EXECUTION_LAYER,
        dispatches,
        visibleEvent: {
          title: '剧本分镜已进入队列',
          summary: '真实生成仍由 BullMQ Worker 执行。',
        },
      } satisfies MastraProductionWorkflowOutput);
    }

    return {
      ...inputData,
      uiPhase: 'generating_script' as const,
      dispatches,
    };
  },
});

const storyboardComposeStep = createStep({
  id: 'storyboard.compose',
  description: 'Converts script plan into a Seedance-only storyboard approval checkpoint.',
  inputSchema: workflowContextSchema,
  outputSchema: workflowContextSchema,
  execute: async ({ inputData }) => ({
    ...inputData,
    uiPhase: 'awaiting_storyboard_confirmation' as const,
    storyboard: {
      requiresApproval: true,
      rule: '所有分镜必须由 Seedance 生成，禁止 materialRef 裁切混剪。',
    },
  }),
});

const approvalResumeSchema = z
  .object({
    action: z.enum(['confirm_render', 'revise_script', 'add_material']),
    note: z.string().optional(),
  })
  .passthrough();

const approvalSuspendSchema = z
  .object({
    uiPhase: z.literal('awaiting_storyboard_confirmation'),
    resumeLabel: z.string(),
    visibleEvent: z.object({
      title: z.string(),
      summary: z.string().optional(),
    }),
  })
  .passthrough();

const storyboardApprovalStep = createStep({
  id: 'storyboard.approval',
  description: 'Human-in-the-loop suspend point before any costly render dispatch.',
  inputSchema: workflowContextSchema,
  outputSchema: workflowContextSchema,
  resumeSchema: approvalResumeSchema,
  suspendSchema: approvalSuspendSchema,
  execute: async ({ inputData, getInitData, resumeData, suspend }) => {
    const init = getInitData<MastraProductionWorkflowInput>();
    const action = resumeData?.action || init.approvalAction;
    if (!action || action === 'none') {
      return suspend(
        {
          uiPhase: 'awaiting_storyboard_confirmation',
          resumeLabel: APPROVAL_RESUME_LABEL,
          visibleEvent: {
            title: '等待你确认分镜',
            summary: '确认后才会派发 Seedance 成片任务。',
          },
        },
        { resumeLabel: APPROVAL_RESUME_LABEL },
      );
    }

    return {
      ...inputData,
      approval: { action, note: resumeData?.note },
      uiPhase: action === 'confirm_render' ? ('generating_video' as const) : ('generating_script' as const),
    };
  },
});

const renderDispatchStep = createStep({
  id: 'render.dispatch',
  description: 'Dispatch descriptor for render_full; the existing BullMQ Worker performs Seedance/FFmpeg work.',
  inputSchema: workflowContextSchema,
  outputSchema: workflowContextSchema,
  execute: async ({ inputData }) => ({
    ...inputData,
    uiPhase: 'generating_video' as const,
    dispatches: [
      ...inputData.dispatches,
      {
        nodeId: 'render.dispatch',
        target: 'BullMQ:aigc.agent' as const,
        kind: 'render_full',
        queued: false,
        note: 'Caller must enqueue the existing render_full AgentRun; Mastra does not call Seedance directly.',
      },
    ],
  }),
});

const qaPassportStep = createStep({
  id: 'qa.passport',
  description: 'Final QA/passport checkpoint descriptor after worker completion.',
  inputSchema: workflowContextSchema,
  outputSchema: mastraProductionWorkflowOutputSchema,
  execute: async ({ inputData }) => ({
    status: 'completed' as const,
    uiPhase: 'completed' as const,
    nextAction: 'worker_tracks_render_and_passport',
    executionLayer: EXECUTION_LAYER,
    dispatches: inputData.dispatches,
    visibleEvent: {
      title: '质检与交付已接入',
      summary: '成片、QA 和 Passport 仍由现有 Worker 链路完成。',
    },
  }),
});

export const mastraProductionWorkflow = createWorkflow({
  id: WORKFLOW_ID,
  description:
    'Mastra Workflow adapter for TikTok Shop AIGC video production. It handles branch/parallel/HITL/dispatch decisions while BullMQ + Worker performs durable generation.',
  inputSchema: mastraProductionWorkflowInputSchema,
  outputSchema: mastraProductionWorkflowOutputSchema,
})
  .then(requirementsStep)
  .branch([
    [
      async ({ getStepResult }) => getStepResult<typeof requirementsStep>(requirementsStep).route === 'needs_input',
      needsInputBranchStep,
    ],
    [
      async ({ getStepResult }) => getStepResult<typeof requirementsStep>(requirementsStep).route !== 'needs_input',
      continueBranchStep,
    ],
  ])
  .then(routeAfterRequirementsStep)
  .parallel([productIngestStep, materialContextStep, referenceRetrieveStep, policyPrecheckStep])
  .then(mergeResearchStep)
  .then(scriptComposeStep)
  .then(storyboardComposeStep)
  .then(storyboardApprovalStep)
  .then(renderDispatchStep)
  .then(qaPassportStep)
  .commit();

type SerializedFlowEntry = (typeof mastraProductionWorkflow.serializedStepGraph)[number];
type AgentRunDispatchKind = 'one_click_video' | 'script_generate' | 'render_full' | 'repair_shot' | 'ab_test';

function primitiveForEntry(entry: SerializedFlowEntry) {
  if (entry.type === 'conditional') return 'branch';
  return entry.type;
}

export function getMastraProductionWorkflowRuntimeSummary() {
  const stepGraph = mastraProductionWorkflow.serializedStepGraph;
  return {
    runtime: '@mastra/core Workflow',
    packageVersion: '1.37.1',
    workflowId: mastraProductionWorkflow.id,
    committed: mastraProductionWorkflow.committed,
    executionLayer: EXECUTION_LAYER,
    primitives: Array.from(new Set(stepGraph.map(primitiveForEntry))),
    steps: Object.keys(mastraProductionWorkflow.steps),
    stepGraph,
    hitl: {
      suspendNode: 'storyboard.approval',
      resumeLabel: APPROVAL_RESUME_LABEL,
      resumeRoute: 'POST /api/agent-runs/:runId/resume',
    },
  };
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolValue(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

export async function planMastraAgentRunDispatch(input: {
  kind: AgentRunDispatchKind;
  runInput: Record<string, unknown>;
  runId: string;
}) {
  const target = input.kind === 'script_generate' ? 'script' : 'video';
  const run = await mastraProductionWorkflow.createRun({ runId: `mastra_${input.runId}` });
  const result = await run.start({
    inputData: {
      latestText: textValue(input.runInput.prompt) || textValue(input.runInput.freePrompt),
      productId: textValue(input.runInput.productId),
      scriptId: textValue(input.runInput.scriptId),
      videoId: textValue(input.runInput.videoId),
      productTitle: textValue(input.runInput.productTitle) || textValue(input.runInput.title),
      productUrl: textValue(input.runInput.productUrl),
      referenceImageUrl: textValue(input.runInput.referenceImageUrl),
      hasResearch: boolValue(
        input.runInput.hasResearch,
        Boolean(input.runInput.productId || input.runInput.productUrl),
      ),
      hasScript: boolValue(input.runInput.hasScript, Boolean(input.runInput.scriptId)),
      renderConsent: target === 'video',
      approvalAction: target === 'video' ? 'confirm_render' : 'none',
      target,
    },
  });

  return {
    workflowId: mastraProductionWorkflow.id,
    mastraRunId: run.runId,
    status: result.status,
    executionLayer: EXECUTION_LAYER,
    result: 'result' in result ? result.result : undefined,
  };
}
