import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { registerAgentRunRoutes } from './lib/agent-runs';
import { registerAgentWorkflowRoutes } from './lib/agents/routes';
import { registerIntelligenceRoutes } from './lib/routes/intelligence';
import { registerProjectRoutes } from './lib/routes/projects';
import { registerSpecRuntimeRoutes } from './spec-runtime';
import { registerTrendRoutes } from './lib/trends/routes';
import { issueJwt, requestId } from './lib/auth';
import { sendApiError } from './lib/http/api-error';
import { renderIdempotency } from './middleware/idempotency';
import { healthzHandler, metricsHandler, observeRequests } from './middleware/observability';
import { ensureLocalDir, localPathExists } from './lib/providers/files';
import { isQwenAngleProviderConfigured } from './lib/providers/material-angles';

function resolveRepoRoot() {
  let current = path.resolve(__dirname);
  const root = path.parse(current).root;
  while (current !== root) {
    if (
      localPathExists(path.join(current, 'package.json')) &&
      localPathExists(path.join(current, 'apps/api/package.json'))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, '../../..');
}

function envValue(name: string) {
  return process.env[name]?.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function isAllowedOrigin(origin: string, allowedOrigins: string[]) {
  return allowedOrigins.includes(origin);
}

const repoRoot = resolveRepoRoot();
const apiRoot = path.join(repoRoot, 'apps/api');

dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(apiRoot, '.env') });
process.env.PIPELINE_MODE = 'queue';
process.env.USE_PRODUCTION_PIPELINE = 'true';

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

const app = express();
app.disable('x-powered-by');
app.use(requestId);
app.use(observeRequests);

const port = Number(process.env.PORT || 5001);
const publicDir = path.join(apiRoot, 'public');
const uploadDir = path.join(publicDir, 'uploads');
const generatedDir = path.join(publicDir, 'generated');
const localObjectStorageRoot = path.isAbsolute(envValue('OBJECT_STORAGE_LOCAL_ROOT') || '')
  ? envValue('OBJECT_STORAGE_LOCAL_ROOT') || ''
  : path.join(repoRoot, envValue('OBJECT_STORAGE_LOCAL_ROOT') || 'tmp/object-storage');
process.env.OBJECT_STORAGE_LOCAL_ROOT = localObjectStorageRoot;
if ((envValue('OBJECT_STORAGE_DRIVER') || 'local') === 'local' && !envValue('OBJECT_STORAGE_PUBLIC_BASE_URL')) {
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = envValue('PUBLIC_API_BASE_URL') || `http://localhost:${port}/objects`;
}
const allowedOrigins = (envValue('ALLOWED_ORIGINS') || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

ensureLocalDir(uploadDir);
ensureLocalDir(generatedDir);
ensureLocalDir(localObjectStorageRoot);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin, allowedOrigins)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);
app.use(express.json({ limit: '30mb' }));
app.use('/generated', express.static(generatedDir));
app.use('/uploads', express.static(uploadDir));
app.use('/reference-videos', express.static(path.join(publicDir, 'reference-videos')));
if ((envValue('OBJECT_STORAGE_DRIVER') || 'local') === 'local') {
  app.use('/objects', express.static(localObjectStorageRoot));
}

app.get('/healthz', healthzHandler);
app.get('/api/healthz', healthzHandler);
app.get('/metrics', metricsHandler);
app.post('/api/render/full', renderIdempotency);
app.post('/api/render/:scriptId/export', renderIdempotency);

registerSpecRuntimeRoutes(app, { publicDir, uploadDir, generatedDir });
registerAgentRunRoutes(app);
registerAgentWorkflowRoutes(app);
registerProjectRoutes(app);
registerTrendRoutes(app);
registerIntelligenceRoutes(app);

app.post('/api/auth/token', express.json(), (req, res) => {
  const apiKey = String(req.body?.apiKey || req.headers['x-api-key'] || '');
  const configuredKey = process.env.API_KEY?.trim();
  if (!configuredKey || apiKey !== configuredKey) {
    sendApiError(res, 401, '无效 API Key');
    return;
  }
  try {
    const token = issueJwt(req.body?.sub || 'api-user', req.body?.role || 'user');
    res.json({ token });
  } catch {
    sendApiError(res, 500, 'JWT_SECRET 未配置');
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    runtime: 'production-bullmq',
    providers: {
      doubaoText: Boolean(envValue('ARK_API_KEY') && (envValue('ARK_TEXT_MODEL_ID') || envValue('ARK_MODEL_ID'))),
      seedanceVideo: Boolean(envValue('ARK_API_KEY') && envValue('ARK_VIDEO_MODEL_ID')),
      qwenAngleImage: isQwenAngleProviderConfigured(),
    },
    pipeline: {
      mode: 'queue',
      postgres: Boolean(envValue('DATABASE_URL')),
      redis: Boolean(envValue('REDIS_URL')),
      objectStorage: envValue('OBJECT_STORAGE_DRIVER') || 'local',
    },
    generatedAt: new Date().toISOString(),
  });
});

app.get('/', (_req, res) => {
  res.status(404).json({
    error: '后端只提供 API，不提供前端页面。请打开 http://localhost:5173',
  });
});

app.listen(port, () => {
  console.log(`[fresh-aigc] API listening on ${port}`);
});
