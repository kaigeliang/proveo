import { v4 as uuid } from 'uuid';
import type { TaskStatus } from '@aigc-video-hub/shared';

export type TaskTrace = {
  at: string;
  step: string;
  progress: number;
  message: string;
  elapsedMs?: number;
  elapsedText?: string;
  data?: Record<string, unknown>;
};

export type RuntimeTask = TaskStatus & {
  payload?: Record<string, unknown>;
  trace: TaskTrace[];
};

export type TaskPatch = {
  error?: string;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

function clampProgress(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export class RuntimeTaskService {
  constructor(
    private readonly tasks: Map<string, RuntimeTask>,
    private readonly persist: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(type: TaskStatus['type'], payload: Record<string, unknown> = {}) {
    const at = this.now();
    const task: RuntimeTask = {
      id: `task_${uuid().slice(0, 10)}`,
      type,
      status: 'pending',
      progress: 0,
      step: 'queued',
      createdAt: at,
      updatedAt: at,
      payload,
      trace: [{ at: at.toISOString(), step: 'queued', progress: 0, message: '任务已创建，等待后台执行。' }],
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  update(
    taskId: string,
    status: TaskStatus['status'],
    progress: number,
    step: string,
    message: string,
    patch: TaskPatch = {},
  ) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const nextProgress = clampProgress(progress);
    task.status = status;
    task.progress = status === 'failed' ? nextProgress : Math.max(task.progress, nextProgress);
    task.step = step;
    task.updatedAt = this.now();
    if (patch.error !== undefined) task.error = patch.error;
    if (patch.payload) task.payload = { ...(task.payload || {}), ...patch.payload };
    task.trace.push({
      at: task.updatedAt.toISOString(),
      step,
      progress: task.progress,
      message,
      data: patch.data,
    });
    this.persist();
  }

  response(task: RuntimeTask) {
    return {
      id: task.id,
      type: task.type,
      status: task.status,
      progress: task.progress,
      step: task.step,
      error: task.error,
      payload: task.payload,
      trace: task.trace,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }
}
