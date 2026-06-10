import { Queue, QueueEvents, type ConnectionOptions, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

export const queueNames = {
  script: 'aigc.script',
  render: 'aigc.render',
  material: 'aigc.material',
  maintenance: 'aigc.maintenance',
  agent: 'aigc.agent',
} as const;

export type ProductionJob =
  | {
      name: 'script.generate';
      data: {
        taskId: string;
        productId: string;
        mode: 'imitate' | 'template' | 'auto';
        provider: 'auto' | 'local' | 'doubao';
        retrievalMode: 'rag' | 'none';
        generationProfile?: 'quick_preview' | 'trusted_publish';
        ref?: string;
        freePrompt?: string;
      };
    }
  | {
      name: 'render.full';
      data: {
        taskId: string;
        scriptId: string;
        exportOptions: Record<string, unknown>;
      };
    }
  | {
      name: 'render.shot';
      data: {
        taskId: string;
        scriptId: string;
        shotId: string;
        provider: 'auto' | 'local' | 'seedance';
        referenceImageUrl?: string;
        referenceAnglePrompt?: string;
        preview?: boolean;
      };
    }
  | {
      name: 'material.slice';
      data: {
        taskId: string;
        materialId: string;
        seedText: string;
      };
    }
  | {
      name: 'material.angle';
      data: {
        taskId: string;
        materialId: string;
        force?: boolean;
        includePresets?: boolean;
        customAngles?: unknown;
      };
    }
  | {
      name: 'video-tags.reindex';
      data: {
        taskId: string;
        reason?: string;
      };
    }
  | {
      name: 'trend.refresh';
      data: {
        taskId: string;
        productId?: string;
        source?: string;
      };
    }
  | {
      name: 'agent.run';
      data: {
        taskId: string;
        runId: string;
        kind: 'one_click_video' | 'script_generate' | 'render_full' | 'repair_shot' | 'ab_test';
        enqueueId?: string;
      };
    };

export type QueueSet = {
  script: Queue;
  render: Queue;
  material: Queue;
  maintenance: Queue;
  agent: Queue;
};

export function redisUrlFromEnv() {
  return process.env.REDIS_URL || 'redis://localhost:6379';
}

type BullMqRedisClient = IORedis & ConnectionOptions;

export function createRedisConnection(redisUrl = redisUrlFromEnv()): BullMqRedisClient {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }) as BullMqRedisClient;
}

export function defaultJobOptions(): JobsOptions {
  return {
    attempts: Number(process.env.QUEUE_JOB_ATTEMPTS || 2),
    backoff: { type: 'exponential', delay: Number(process.env.QUEUE_JOB_BACKOFF_MS || 3000) },
    removeOnComplete: { age: Number(process.env.QUEUE_REMOVE_COMPLETE_SECONDS || 86400), count: 1000 },
    removeOnFail: { age: Number(process.env.QUEUE_REMOVE_FAIL_SECONDS || 604800), count: 5000 },
  };
}

export function createQueues(redisUrl = redisUrlFromEnv()): QueueSet {
  const connection = createRedisConnection(redisUrl);
  const options = { connection, defaultJobOptions: defaultJobOptions() };
  return {
    script: new Queue(queueNames.script, options),
    render: new Queue(queueNames.render, options),
    material: new Queue(queueNames.material, options),
    maintenance: new Queue(queueNames.maintenance, options),
    agent: new Queue(queueNames.agent, options),
  };
}

export function createQueueEvents(redisUrl = redisUrlFromEnv()) {
  const connection = createRedisConnection(redisUrl);
  return {
    script: new QueueEvents(queueNames.script, { connection }),
    render: new QueueEvents(queueNames.render, { connection }),
    material: new QueueEvents(queueNames.material, { connection }),
    maintenance: new QueueEvents(queueNames.maintenance, { connection }),
    agent: new QueueEvents(queueNames.agent, { connection }),
  };
}

export async function enqueueProductionJob(queues: QueueSet, job: ProductionJob) {
  if (job.name === 'script.generate') {
    return queues.script.add(job.name, job.data, { jobId: job.data.taskId });
  }
  if (job.name === 'material.slice' || job.name === 'material.angle') {
    return queues.material.add(job.name, job.data, { jobId: job.data.taskId });
  }
  if (job.name === 'video-tags.reindex' || job.name === 'trend.refresh') {
    return queues.maintenance.add(job.name, job.data, { jobId: job.data.taskId });
  }
  if (job.name === 'agent.run') {
    return queues.agent.add(job.name, job.data, { jobId: job.data.enqueueId || job.data.runId });
  }
  return queues.render.add(job.name, job.data, { jobId: job.data.taskId });
}

export async function closeQueues(queues: QueueSet) {
  await Promise.all([
    queues.script.close(),
    queues.render.close(),
    queues.material.close(),
    queues.maintenance.close(),
    queues.agent.close(),
  ]);
}
