import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { completeApiIdempotency, reserveApiIdempotency } from '@aigc-video-hub/db';
import { sendApiError } from '../lib/http/api-error';

type CachedResponse = {
  requestHash: string;
  status: 'pending' | 'completed' | 'failed';
  statusCode?: number;
  response?: unknown;
  expiresAt: number;
};

const TTL_MS = 24 * 60 * 60 * 1000;
const memory = new Map<string, CachedResponse>();

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function purgeExpired(now: number) {
  for (const [key, entry] of memory.entries()) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
}

function configuredForPersistence() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function routeScope(req: Request) {
  return req.params.scriptId ? 'POST /api/render/:scriptId/export' : 'POST /api/render/full';
}

export async function renderIdempotency(req: Request, res: Response, next: NextFunction) {
  const supplied = String(req.header('Idempotency-Key') || '').trim();
  if (!supplied) {
    next();
    return;
  }
  if (supplied.length > 256) {
    sendApiError(res, 400, 'Idempotency-Key must be no longer than 256 characters');
    return;
  }

  const now = Date.now();
  purgeExpired(now);
  const route = routeScope(req);
  const key = hash(`${route}:${supplied}`);
  const requestHash = hash(JSON.stringify({ params: req.params, body: req.body || {} }));
  const local = memory.get(key);
  if (local) {
    if (local.requestHash !== requestHash) {
      sendApiError(res, 409, 'Idempotency-Key was already used with a different request body');
      return;
    }
    if (local.status === 'completed' || local.status === 'failed') {
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(local.statusCode || 200).json(local.response);
      return;
    }
    res.setHeader('Retry-After', '1');
    sendApiError(res, 409, 'A request with this Idempotency-Key is already in progress');
    return;
  }

  const expiresAt = now + TTL_MS;
  if (configuredForPersistence()) {
    try {
      const reservation = await reserveApiIdempotency({
        key,
        route,
        requestHash,
        expiresAt: new Date(expiresAt),
      });
      if (!reservation.reserved) {
        if (reservation.record.requestHash !== requestHash) {
          sendApiError(res, 409, 'Idempotency-Key was already used with a different request body');
          return;
        }
        if (reservation.record.status !== 'pending' && reservation.record.response !== null) {
          res.setHeader('Idempotency-Replayed', 'true');
          res.status(reservation.record.statusCode || 200).json(reservation.record.response);
          return;
        }
        res.setHeader('Retry-After', '1');
        sendApiError(res, 409, 'A request with this Idempotency-Key is already in progress');
        return;
      }
    } catch {
      // The local runtime remains usable while Postgres is intentionally off.
    }
  }

  memory.set(key, { requestHash, status: 'pending', expiresAt });
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    const statusCode = res.statusCode;
    const status = statusCode >= 500 ? 'failed' : 'completed';
    memory.set(key, { requestHash, status, statusCode, response: body, expiresAt });
    if (configuredForPersistence()) {
      void completeApiIdempotency(key, statusCode, body).catch(() => undefined);
    }
    return json(body);
  }) as Response['json'];
  next();
}
