import type { Express, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { getPrisma } from '@aigc-video-hub/db';
import { sendApiError } from '../http/api-error';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function compactJson(value: unknown, fallback: unknown = null): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? fallback)) as Prisma.InputJsonValue;
}

function nullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null ? Prisma.DbNull : compactJson(value);
}

function dateFromMs(value: unknown) {
  const ms = asNumber(value, Date.now());
  return new Date(ms);
}

function activeTaskIdFrom(session: JsonRecord, snapshot: JsonRecord) {
  const task = asRecord(snapshot.task);
  return asString(session.taskId) || asString(task.id) || undefined;
}

function activeRunIdFrom(session: JsonRecord, snapshot: JsonRecord) {
  return asString(session.runId) || asString(snapshot.activeAgentRunId) || undefined;
}

function activeScriptIdFrom(session: JsonRecord, snapshot: JsonRecord) {
  const scriptVersions = asArray(snapshot.scriptVersions).map(asRecord);
  const activeVersionId = asString(snapshot.activeScriptVersionId);
  const activeVersion =
    scriptVersions.find((version) => asString(version.id) === activeVersionId) || scriptVersions.at(-1) || {};
  const script = asRecord(activeVersion.script);
  return asString(session.scriptId) || asString(script.id) || undefined;
}

function statusFromSnapshot(snapshot: JsonRecord) {
  const task = asRecord(snapshot.task);
  const taskStatus = asString(task.status);
  if (['queued', 'pending', 'processing', 'waiting_input'].includes(taskStatus)) return 'active';
  if (asArray(snapshot.renderVersions).length > 0) return 'completed';
  if (asArray(snapshot.scriptVersions).length > 0) return 'draft';
  return 'active';
}

function sessionFromProject(project: JsonRecord) {
  const snapshot = asRecord(project.snapshot);
  if (asString(snapshot.id)) return snapshot;
  return {
    id: asString(project.id),
    title: asString(project.title, '新对话'),
    productId: asString(project.productId) || undefined,
    productTitle: asString(project.productTitle) || undefined,
    messages: [],
    createdAt: project.createdAt instanceof Date ? project.createdAt.getTime() : Date.now(),
    updatedAt: project.updatedAt instanceof Date ? project.updatedAt.getTime() : Date.now(),
  };
}

async function saveProjectSnapshot(req: Request, res: Response) {
  const body = asRecord(req.body);
  const session = asRecord(body.session || body);
  const projectId = asString(req.params.projectId || session.id);
  if (!projectId) {
    sendApiError(res, 400, '需要项目 id');
    return;
  }
  const title = asString(session.title, '新对话').slice(0, 80) || '新对话';
  const snapshot = asRecord(session.projectSnapshot);
  const conversationId = asString(session.id, projectId);
  const createdAt = dateFromMs(session.createdAt);
  const activeTaskId = activeTaskIdFrom(session, snapshot);
  const activeRunId = activeRunIdFrom(session, snapshot);
  const activeScriptId = activeScriptIdFrom(session, snapshot);
  const scriptVersions = asArray(snapshot.scriptVersions)
    .map(asRecord)
    .filter((version) => asString(version.id));
  const renderVersions = asArray(snapshot.renderVersions)
    .map(asRecord)
    .filter((version) => asString(version.id));

  try {
    const prisma = getPrisma();
    await prisma.$transaction(async (tx) => {
      await tx.project.upsert({
        where: { id: projectId },
        create: {
          id: projectId,
          title,
          productId: asString(session.productId) || asString(snapshot.productId) || null,
          productTitle: asString(session.productTitle) || asString(snapshot.productTitle) || null,
          status: statusFromSnapshot(snapshot),
          activeConversationId: conversationId,
          activeScriptVersionId: asString(snapshot.activeScriptVersionId) || null,
          activeRenderVersionId: asString(snapshot.activeRenderVersionId) || null,
          activeTaskId: activeTaskId || null,
          activeRunId: activeRunId || null,
          snapshot: compactJson({ ...session, id: projectId }),
          createdAt,
        },
        update: {
          title,
          productId: asString(session.productId) || asString(snapshot.productId) || null,
          productTitle: asString(session.productTitle) || asString(snapshot.productTitle) || null,
          status: statusFromSnapshot(snapshot),
          activeConversationId: conversationId,
          activeScriptVersionId: asString(snapshot.activeScriptVersionId) || null,
          activeRenderVersionId: asString(snapshot.activeRenderVersionId) || null,
          activeTaskId: activeTaskId || null,
          activeRunId: activeRunId || null,
          snapshot: compactJson({ ...session, id: projectId }),
        },
      });

      await tx.conversation.upsert({
        where: { id: conversationId },
        create: {
          id: conversationId,
          projectId,
          title,
          messages: compactJson(session.messages, []),
          activityItems: compactJson(session.activityItems, []),
          magicProgress: nullableJson(session.magicProgress),
          activeTaskId: activeTaskId || null,
          activeRunId: activeRunId || null,
          activeScriptId: activeScriptId || null,
          snapshot: compactJson(session),
          createdAt,
        },
        update: {
          title,
          messages: compactJson(session.messages, []),
          activityItems: compactJson(session.activityItems, []),
          magicProgress: nullableJson(session.magicProgress),
          activeTaskId: activeTaskId || null,
          activeRunId: activeRunId || null,
          activeScriptId: activeScriptId || null,
          snapshot: compactJson(session),
        },
      });

      const scriptIds = scriptVersions.map((version) => asString(version.id));
      await tx.projectScriptVersion.deleteMany({
        where: { projectId, id: { notIn: scriptIds.length ? scriptIds : ['__none__'] } },
      });
      for (const version of scriptVersions) {
        const script = asRecord(version.script);
        await tx.projectScriptVersion.upsert({
          where: { id: asString(version.id) },
          create: {
            id: asString(version.id),
            projectId,
            label: asString(version.label, '剧本方案'),
            scriptId: asString(script.id) || null,
            sourceRunId: asString(version.sourceRunId) || null,
            scriptSnapshot: compactJson(script, {}),
            createdAt: dateFromMs(version.createdAt),
          },
          update: {
            label: asString(version.label, '剧本方案'),
            scriptId: asString(script.id) || null,
            sourceRunId: asString(version.sourceRunId) || null,
            scriptSnapshot: compactJson(script, {}),
          },
        });
      }

      const renderIds = renderVersions.map((version) => asString(version.id));
      await tx.projectRenderVersion.deleteMany({
        where: { projectId, id: { notIn: renderIds.length ? renderIds : ['__none__'] } },
      });
      for (const version of renderVersions) {
        const result = asRecord(version.result);
        const scriptVersionId = asString(version.scriptVersionId);
        const persistedScriptVersionId = scriptIds.includes(scriptVersionId) ? scriptVersionId : null;
        const status =
          asString(result.videoUrl) || asString(result.assetUrl) || asString(result.previewUrl)
            ? 'completed'
            : 'pending';
        await tx.projectRenderVersion.upsert({
          where: { id: asString(version.id) },
          create: {
            id: asString(version.id),
            projectId,
            scriptVersionId: persistedScriptVersionId,
            label: asString(version.label, '成片版本'),
            taskId: asString(version.taskId) || null,
            videoId: asString(result.videoId) || null,
            status,
            result: compactJson(result, {}),
            createdAt: dateFromMs(version.createdAt),
          },
          update: {
            scriptVersionId: persistedScriptVersionId,
            label: asString(version.label, '成片版本'),
            taskId: asString(version.taskId) || null,
            videoId: asString(result.videoId) || null,
            status,
            result: compactJson(result, {}),
          },
        });
      }
    });

    const project = await getPrisma().project.findUnique({ where: { id: projectId } });
    res.json({
      ok: true,
      session: project ? sessionFromProject(project as unknown as JsonRecord) : { ...session, id: projectId },
    });
  } catch (error) {
    sendApiError(res, 503, `项目快照保存失败：${error instanceof Error ? error.message : 'unknown'}`);
  }
}

export function registerProjectRoutes(app: Express) {
  app.get('/api/projects', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    try {
      const projects = await getPrisma().project.findMany({
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });
      res.json({ items: projects.map((project) => sessionFromProject(project as unknown as JsonRecord)) });
    } catch (error) {
      sendApiError(res, 503, `项目列表读取失败：${error instanceof Error ? error.message : 'unknown'}`);
    }
  });

  app.get('/api/projects/:projectId/snapshot', async (req, res) => {
    try {
      const project = await getPrisma().project.findUnique({ where: { id: req.params.projectId } });
      if (!project) {
        sendApiError(res, 404, '项目不存在');
        return;
      }
      res.json({ session: sessionFromProject(project as unknown as JsonRecord) });
    } catch (error) {
      sendApiError(res, 503, `项目快照读取失败：${error instanceof Error ? error.message : 'unknown'}`);
    }
  });

  app.put('/api/projects/:projectId/snapshot', saveProjectSnapshot);
  app.post('/api/projects/snapshot', saveProjectSnapshot);

  app.delete('/api/projects/:projectId', async (req, res) => {
    try {
      await getPrisma().project.delete({ where: { id: req.params.projectId } });
      res.json({ ok: true });
    } catch (error) {
      sendApiError(res, 404, `项目删除失败：${error instanceof Error ? error.message : 'unknown'}`);
    }
  });
}
