import type { Express, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  createAgentRun,
  createTask,
  getAgentRun,
  listAgentArtifacts,
  listAgentRuns,
  updateAgentRun,
  updateTask,
  type AgentRunKind,
} from '@aigc-video-hub/db';
import { createQueues, enqueueProductionJob, type QueueSet } from '@aigc-video-hub/queue';
import { planMastraAgentRunDispatch } from '@aigc-video-hub/agent-runtime';
import { sendApiError } from './http/api-error';

let queues: QueueSet | undefined;

function getQueues() {
  if (!queues) queues = createQueues();
  return queues;
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function readKind(value: unknown): AgentRunKind {
  if (
    value === 'one_click_video' ||
    value === 'script_generate' ||
    value === 'render_full' ||
    value === 'repair_shot' ||
    value === 'ab_test'
  ) {
    return value;
  }
  return 'one_click_video';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sendError(res: Response, status: number, message: string) {
  sendApiError(res, status, message);
}

async function enqueueAgentRun(input: { taskId: string; runId: string; kind: AgentRunKind; enqueueId?: string }) {
  await enqueueProductionJob(getQueues(), {
    name: 'agent.run',
    data: {
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      enqueueId: input.enqueueId,
    },
  });
}

export async function createQueuedAgentRun(input: {
  kind: AgentRunKind;
  runInput: Record<string, unknown>;
  enqueueId?: string;
}) {
  const runId = makeId('run');
  const taskId = makeId('task');
  const mastraWorkflow = await planMastraAgentRunDispatch({ kind: input.kind, runInput: input.runInput, runId });
  const runInput: Record<string, unknown> = { ...input.runInput, mastraWorkflow };

  await createTask({
    id: taskId,
    type: 'agent',
    payload: { runId, kind: input.kind, input: runInput },
    step: 'agent_queued',
    message: 'AgentRun 已创建，等待 Worker 编排执行。',
  });
  const run = await createAgentRun({
    id: runId,
    taskId,
    kind: input.kind,
    graphVersion: `mastra.workflow.${input.kind}.v1`,
    productId: readString(runInput.productId),
    scriptId: readString(runInput.scriptId),
    videoId: readString(runInput.videoId),
    input: runInput,
  });

  await enqueueAgentRun({ taskId, runId, kind: input.kind, enqueueId: input.enqueueId });
  await updateTask(taskId, {
    status: 'pending',
    progress: 0,
    step: 'agent_queue_submitted',
    trace: {
      step: 'agent_queue_submitted',
      progress: 0,
      message: 'AgentRun 已投递到 BullMQ。',
      data: { runId, kind: input.kind },
    },
  });

  return { taskId, runId, kind: input.kind, status: run.status };
}

async function removeQueuedAgentJob(runId: string) {
  const job = await getQueues().agent.getJob(runId);
  if (!job) return false;
  const state = await job.getState();
  if (state === 'active') return false;
  try {
    await job.remove();
    return true;
  } catch {
    return false;
  }
}

export function registerAgentRunRoutes(app: Express) {
  app.post('/api/agent-runs', async (req: Request, res: Response) => {
    const kind = readKind(req.body?.kind);
    const input = readRecord(req.body?.input || req.body);

    try {
      res.status(202).json(await createQueuedAgentRun({ kind, runInput: input }));
    } catch (error) {
      sendError(res, 503, error instanceof Error ? error.message : 'AgentRun 创建失败');
    }
  });

  app.get('/api/agent-runs', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    res.json(await listAgentRuns(limit));
  });

  app.get('/api/agent-runs/:runId', async (req, res) => {
    const run = await getAgentRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'AgentRun 不存在');
      return;
    }
    res.json(run);
  });

  app.get('/api/agent-runs/:runId/steps', async (req, res) => {
    const run = await getAgentRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'AgentRun 不存在');
      return;
    }
    res.json(run.steps);
  });

  app.get('/api/agent-runs/:runId/artifacts', async (req, res) => {
    const run = await getAgentRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'AgentRun 不存在');
      return;
    }
    res.json(await listAgentArtifacts(req.params.runId));
  });

  app.post('/api/agent-runs/:runId/cancel', async (req, res) => {
    const run = await getAgentRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'AgentRun 不存在');
      return;
    }
    if (run.status === 'completed') {
      sendError(res, 409, '已完成的 AgentRun 不能取消');
      return;
    }

    const removedQueuedJob = await removeQueuedAgentJob(run.id);
    const updated = await updateAgentRun(run.id, {
      status: 'cancelled',
      error: readString(req.body?.reason) || '用户取消 AgentRun',
    });
    if (run.taskId) {
      await updateTask(run.taskId, {
        status: 'cancelled',
        progress: 0,
        step: 'agent_cancelled',
        error: readString(req.body?.reason) || '用户取消 AgentRun',
        trace: {
          step: 'agent_cancelled',
          progress: 0,
          message: removedQueuedJob ? 'AgentRun 已取消，队列 job 已移除。' : 'AgentRun 已标记取消。',
          data: { runId: run.id, removedQueuedJob },
        },
      });
    }
    res.json({ runId: run.id, status: updated.status, removedQueuedJob });
  });

  app.post('/api/agent-runs/:runId/retry', async (req, res) => {
    const source = await getAgentRun(req.params.runId);
    if (!source) {
      sendError(res, 404, 'AgentRun 不存在');
      return;
    }
    if (source.status !== 'failed' && source.status !== 'cancelled') {
      sendError(res, 409, '只有 failed/cancelled 的 AgentRun 可以 retry');
      return;
    }

    const kind = readKind(source.kind);
    const input: Record<string, unknown> = {
      ...readRecord(source.input),
      retryOf: source.id,
      ...readRecord(req.body?.input),
    };
    const runId = makeId('run');
    const taskId = makeId('task');

    try {
      await createTask({
        id: taskId,
        type: 'agent',
        payload: { runId, kind, input, retryOf: source.id },
        step: 'agent_retry_queued',
        message: 'AgentRun retry 已创建，等待 Worker 编排执行。',
      });
      const run = await createAgentRun({
        id: runId,
        taskId,
        kind,
        graphVersion: `agent-graph.${kind}.pending`,
        productId: readString(input.productId) || source.productId || undefined,
        scriptId: readString(input.scriptId) || source.scriptId || undefined,
        videoId: readString(input.videoId) || source.videoId || undefined,
        input,
      });
      await enqueueAgentRun({ taskId, runId, kind });
      await updateTask(taskId, {
        status: 'pending',
        progress: 0,
        step: 'agent_retry_submitted',
        trace: {
          step: 'agent_retry_submitted',
          progress: 0,
          message: 'AgentRun retry 已投递到 BullMQ。',
          data: { runId, retryOf: source.id, kind },
        },
      });
      res.status(202).json({ taskId, runId, retryOf: source.id, kind, status: run.status });
    } catch (error) {
      await updateTask(taskId, {
        status: 'failed',
        progress: 0,
        step: 'agent_retry_failed',
        error: error instanceof Error ? error.message : 'AgentRun retry 创建失败',
      }).catch(() => undefined);
      sendError(res, 503, error instanceof Error ? error.message : 'AgentRun retry 创建失败');
    }
  });

  app.post('/api/agent-runs/:runId/resume', async (req, res) => {
    const run = await getAgentRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'AgentRun 不存在');
      return;
    }
    if (run.status !== 'waiting_input') {
      sendError(res, 409, '只有 waiting_input 的 AgentRun 可以 resume');
      return;
    }
    if (!run.taskId) {
      sendError(res, 409, 'AgentRun 缺少 taskId，不能 resume');
      return;
    }

    const additions = readRecord(req.body?.input || req.body?.answers || req.body);
    const input = { ...readRecord(run.input), ...additions };
    const kind = readKind(run.kind);
    const enqueueId = `${run.id}:resume:${Date.now()}`;
    const updated = await updateAgentRun(run.id, {
      status: 'queued',
      input,
      productId: readString(input.productId) || run.productId || undefined,
      scriptId: readString(input.scriptId) || run.scriptId || undefined,
      videoId: readString(input.videoId) || run.videoId || undefined,
      error: null,
    });
    await updateTask(run.taskId, {
      status: 'pending',
      progress: 0,
      step: 'agent_resume_submitted',
      payload: { runId: run.id, kind, resumed: true },
      trace: {
        step: 'agent_resume_submitted',
        progress: 0,
        message: 'AgentRun 已合并用户输入并重新投递。',
        data: { runId: run.id, enqueueId },
      },
    });
    await enqueueAgentRun({ taskId: run.taskId, runId: run.id, kind, enqueueId });
    res.status(202).json({ taskId: run.taskId, runId: run.id, kind, status: updated.status });
  });

  app.get('/api/agent-runs/:runId/stream', async (req, res) => {
    const run = await getAgentRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'AgentRun 不存在');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const write = async () => {
      const current = await getAgentRun(req.params.runId);
      if (!current) return;
      res.write(`event: agent:update\ndata: ${JSON.stringify(current)}\n\n`);
      if (['completed', 'failed', 'cancelled'].includes(current.status)) {
        clearInterval(timer);
        res.end();
      }
    };

    const timer = setInterval(() => void write(), 700);
    void write();
    req.on('close', () => clearInterval(timer));
  });
}
