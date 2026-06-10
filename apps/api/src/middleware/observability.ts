import type { Request, RequestHandler, Response } from 'express';
import pino from 'pino';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { getPrisma } from '@aigc-video-hub/db';
import { createRedisConnection } from '@aigc-video-hub/queue';

const register = new Registry();
collectDefaultMetrics({ register, prefix: 'aigc_api_' });

const requestTotal = new Counter({
  name: 'aigc_http_requests_total',
  help: 'HTTP requests handled by the API.',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [register],
});

const requestDuration = new Histogram({
  name: 'aigc_http_request_duration_seconds',
  help: 'HTTP response duration in seconds.',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30],
  registers: [register],
});

const logger = pino({
  name: 'aigc-video-api',
  level: process.env.LOG_LEVEL || 'info',
});

function normalizedPath(path: string) {
  return path
    .replace(/\/(task|script|run|shot|evidence|claim|video|asset)_[A-Za-z0-9_-]+/g, '/:id')
    .replace(/\/[a-f0-9]{24,64}(?=\/|$)/gi, '/:hash');
}

function requestId(req: Request) {
  return (req as Request & { requestId?: string }).requestId;
}

export const observeRequests: RequestHandler = (req, res, next) => {
  const endTimer = requestDuration.startTimer();
  res.once('finish', () => {
    if (req.path === '/metrics') return;
    const labels = {
      method: req.method,
      path: normalizedPath(req.path),
      status: String(res.statusCode),
    };
    requestTotal.inc(labels);
    const seconds = endTimer(labels);
    const entry = {
      requestId: requestId(req),
      ...labels,
      durationMs: Number((seconds * 1000).toFixed(2)),
    };
    if (res.statusCode >= 500) logger.error(entry, 'http_request');
    else logger.info(entry, 'http_request');
  });
  next();
};

export async function metricsHandler(_req: Request, res: Response) {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
}

type CheckState = 'up' | 'down' | 'not_configured';

// 专用健康检查 Redis 连接（懒建一次，静默错误事件避免未处理异常）。
let healthRedis: ReturnType<typeof createRedisConnection> | undefined;
function getHealthRedis(): ReturnType<typeof createRedisConnection> {
  if (healthRedis) return healthRedis;
  const conn = createRedisConnection();
  conn.on('error', () => {});
  healthRedis = conn;
  return conn;
}

async function checkDatabase(): Promise<CheckState> {
  if (!process.env.DATABASE_URL?.trim()) return 'not_configured';
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return 'up';
  } catch {
    return 'down';
  }
}

async function checkRedis(): Promise<CheckState> {
  if (!process.env.REDIS_URL?.trim()) return 'not_configured';
  try {
    const pong = await Promise.race([
      getHealthRedis().ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('redis ping timeout')), 2000)),
    ]);
    return pong === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export async function healthzHandler(_req: Request, res: Response) {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  // DB 与 Redis 都是生成链路的关键依赖；任一 down 即 not ready（503）。
  const ok = database !== 'down' && redis !== 'down';
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'api',
    checks: { database, redis },
    uptimeSeconds: Number(process.uptime().toFixed(3)),
    generatedAt: new Date().toISOString(),
  });
}
