import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Job, Queue, Worker } from 'bullmq';
import { disconnectPrisma, updateTask } from '@aigc-video-hub/db';
import { createRedisConnection, defaultJobOptions, queueNames, type ProductionJob } from '@aigc-video-hub/queue';
import { processAgentRun } from './agent-orchestrator';
import {
  processMaterialAngle,
  processMaterialSlice,
  processRenderFull,
  processRenderShot,
  processScriptGenerate,
  processTrendRefresh,
  processVideoTagsReindex,
} from './processors';

function resolveRepoRoot() {
  let current = path.resolve(__dirname);
  const root = path.parse(current).root;
  while (current !== root) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'apps/worker/package.json'))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, '../../..');
}

const repoRoot = resolveRepoRoot();
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, 'apps/worker/.env') });

// 启动期环境校验：缺关键基础设施 fail-fast（清晰报错而非深层崩溃）；缺可选模型 key 只降级告警。
{
  const missing = ['DATABASE_URL', 'REDIS_URL'].filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    console.error(`[env] 缺少必需环境变量：${missing.join(', ')}，无法启动。请检查 .env 或部署环境变量。`);
    process.exit(1);
  }
  const optional: Record<string, string> = {
    ARK_API_KEY: 'Doubao 剧本 / Seedance 视频',
    ARK_TEXT_MODEL_ID: 'Doubao 文本模型',
    ARK_VIDEO_MODEL_ID: 'Seedance 视频模型',
  };
  const degraded = Object.entries(optional)
    .filter(([k]) => !process.env[k]?.trim())
    .map(([k, v]) => `${k}(${v})`);
  if (degraded.length) console.warn(`[env] 可选能力缺失，将降级运行：${degraded.join('、')}`);
}

const localStorageRoot = process.env.OBJECT_STORAGE_LOCAL_ROOT || 'tmp/object-storage';
if (!path.isAbsolute(localStorageRoot)) {
  process.env.OBJECT_STORAGE_LOCAL_ROOT = path.join(repoRoot, localStorageRoot);
}
if ((process.env.OBJECT_STORAGE_DRIVER || 'local') === 'local' && !process.env.OBJECT_STORAGE_PUBLIC_BASE_URL) {
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL =
    process.env.PUBLIC_API_BASE_URL || `http://localhost:${process.env.PORT || 5001}/objects`;
}

const connection = createRedisConnection();
const processorMode = process.env.WORKER_PROCESSOR_MODE || 'production-local';
const maintenanceScheduler = new Queue(queueNames.maintenance, {
  connection,
  defaultJobOptions: defaultJobOptions(),
});

function concurrency(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envBool(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function envMinutes(name: string, fallback: number, min: number) {
  const value = Number(process.env[name] || fallback);
  return Math.max(min, Number.isFinite(value) ? Math.floor(value) : fallback);
}

async function scheduleMaintenanceJobs() {
  if (processorMode === 'stub-complete') return;
  if (envBool('TREND_REFRESH_ENABLED', true)) {
    const every = envMinutes('TREND_REFRESH_INTERVAL_MINUTES', 60, 15) * 60 * 1000;
    await maintenanceScheduler.add(
      'trend.refresh',
      { taskId: 'scheduled_trend_refresh', source: process.env.TREND_REFRESH_SOURCE || 'default' },
      {
        jobId: 'scheduled-trend-refresh',
        repeat: { every },
        removeOnComplete: { age: 86400, count: 50 },
        removeOnFail: { age: 604800, count: 200 },
      },
    );
    console.log(`[worker] scheduled trend.refresh every ${Math.round(every / 60000)} minutes`);
  }
  if (envBool('VECTOR_REINDEX_ENABLED', true)) {
    const every = envMinutes('VECTOR_REINDEX_INTERVAL_MINUTES', 240, 30) * 60 * 1000;
    await maintenanceScheduler.add(
      'video-tags.reindex',
      { taskId: 'scheduled_video_tags_reindex', reason: 'scheduled' },
      {
        jobId: 'scheduled-video-tags-reindex',
        repeat: { every },
        removeOnComplete: { age: 86400, count: 50 },
        removeOnFail: { age: 604800, count: 200 },
      },
    );
    console.log(`[worker] scheduled video-tags.reindex every ${Math.round(every / 60000)} minutes`);
  }
}

async function markReceived(job: Job) {
  const taskId = String(job.data?.taskId || job.id || '');
  if (!taskId) return;
  await updateTask(taskId, {
    status: 'processing',
    progress: Math.max(1, Number(job.data?.progress || 1)),
    step: 'worker_received',
    trace: {
      step: 'worker_received',
      progress: Math.max(1, Number(job.data?.progress || 1)),
      message: `Worker 已领取 ${job.name}。`,
      data: { jobId: job.id, queue: job.queueName, attemptsMade: job.attemptsMade },
    },
  });
}

async function markFailed(job: Job, error: unknown) {
  const taskId = String(job.data?.taskId || job.id || '');
  if (!taskId) return;
  const message = error instanceof Error ? error.message : 'Worker 执行失败';
  await updateTask(taskId, {
    status: 'failed',
    progress: 0,
    step: 'worker_failed',
    error: message,
    trace: {
      step: 'worker_failed',
      progress: 0,
      message,
      data: { jobId: job.id, queue: job.queueName, attemptsMade: job.attemptsMade },
    },
  });
}

async function processJob(job: Job<ProductionJob['data']>) {
  await markReceived(job);

  if (processorMode === 'stub-complete') {
    const taskId = String(job.data?.taskId || job.id || '');
    await updateTask(taskId, {
      status: 'completed',
      progress: 100,
      step: 'stub_completed',
      payload: { workerMode: processorMode },
      trace: {
        step: 'stub_completed',
        progress: 100,
        message: 'Worker stub 已完成。该模式只用于基础设施冒烟，不生成真实媒体产物。',
      },
    });
    return;
  }

  if (job.name === 'script.generate')
    return processScriptGenerate(job.data as Parameters<typeof processScriptGenerate>[0]);
  if (job.name === 'material.slice')
    return processMaterialSlice(job.data as Parameters<typeof processMaterialSlice>[0]);
  if (job.name === 'material.angle')
    return processMaterialAngle(job.data as Parameters<typeof processMaterialAngle>[0]);
  if (job.name === 'video-tags.reindex')
    return processVideoTagsReindex(job.data as Parameters<typeof processVideoTagsReindex>[0]);
  if (job.name === 'trend.refresh') return processTrendRefresh(job.data as Parameters<typeof processTrendRefresh>[0]);
  if (job.name === 'render.shot') return processRenderShot(job.data as Parameters<typeof processRenderShot>[0]);
  if (job.name === 'render.full') return processRenderFull(job.data as Parameters<typeof processRenderFull>[0]);
  if (job.name === 'agent.run') return processAgentRun(job.data as Parameters<typeof processAgentRun>[0]);

  throw new Error(`未知生产任务：${job.name}`);
}

function createWorker(queueName: string, workerConcurrency: number) {
  // 一键成片 / 渲染单步（Seedance 一镜 1-2 分钟，DNA 对齐可能重渲多轮）远超 BullMQ 默认 30s lock，
  // 不调大 lockDuration 会被误判 stalled → 重新分发 → 旧任务被 abort → 反复重跑直至失败。
  const lockDuration = Math.max(60_000, Number(process.env.WORKER_LOCK_DURATION_MS || 900_000));
  const worker = new Worker(
    queueName,
    async (job) => {
      try {
        return await processJob(job);
      } catch (error) {
        await markFailed(job, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: workerConcurrency,
      lockDuration,
      // lock 每 lockDuration/2 续约一次；stalled 容忍 1 次即可（长任务不该被反复抢占）。
      stalledInterval: lockDuration,
      maxStalledCount: 1,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[worker] completed ${queueName}/${job.name}/${job.id}`);
  });
  worker.on('failed', (job, error) => {
    console.error(`[worker] failed ${queueName}/${job?.name}/${job?.id}: ${error.message}`);
  });
  return worker;
}

const workers = [
  createWorker(queueNames.script, concurrency('SCRIPT_WORKER_CONCURRENCY', 2)),
  createWorker(queueNames.render, concurrency('RENDER_WORKER_CONCURRENCY', 3)),
  createWorker(queueNames.material, concurrency('MATERIAL_WORKER_CONCURRENCY', 2)),
  createWorker(queueNames.maintenance, concurrency('MAINTENANCE_WORKER_CONCURRENCY', 1)),
  createWorker(queueNames.agent, concurrency('AGENT_WORKER_CONCURRENCY', 1)),
];

console.log(
  `[worker] listening queues=${Object.values(queueNames).join(', ')} mode=${processorMode} redis=${
    process.env.REDIS_URL || 'redis://localhost:6379'
  }`,
);
void scheduleMaintenanceJobs().catch((error) => {
  console.error(`[worker] maintenance scheduler failed: ${error instanceof Error ? error.message : String(error)}`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received, closing...`);
  await Promise.all(workers.map((worker) => worker.close().catch(() => undefined)));
  await maintenanceScheduler.close().catch(() => undefined);
  await connection.quit().catch(() => {
    connection.disconnect();
  });
  await disconnectPrisma().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
