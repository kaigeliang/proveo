import type { Request, Response, NextFunction } from 'express';
import { createHmac, randomUUID } from 'crypto';
import { sendApiError } from './http/api-error';

const AUTH_MODE = (process.env.AUTH_MODE || 'disabled') as 'disabled' | 'api-key' | 'jwt';

function envValue(name: string) {
  return process.env[name]?.replace(/[​-‍﻿]/g, '').trim();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aHash = createHmac('sha256', 'timing-safe').update(a).digest();
  const bHash = createHmac('sha256', 'timing-safe').update(b).digest();
  let diff = 0;
  for (let i = 0; i < aHash.length; i++) diff |= aHash[i] ^ bHash[i];
  return diff === 0;
}

function verifyApiKey(key: string): boolean {
  const valid = envValue('API_KEY');
  if (!valid) return false;
  return timingSafeEqual(key, valid);
}

function verifyJwt(token: string): { sub: string; role: string } | null {
  const secret = envValue('JWT_SECRET');
  if (!secret) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    if (!timingSafeEqual(sig, expected)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: String(decoded.sub || ''), role: String(decoded.role || 'user') };
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (AUTH_MODE === 'disabled') {
    next();
    return;
  }

  const authHeader = req.headers.authorization || '';

  if (AUTH_MODE === 'api-key') {
    const key = authHeader.replace(/^Bearer\s+/i, '').trim() || String(req.headers['x-api-key'] || '');
    if (!key || !verifyApiKey(key)) {
      sendApiError(res, 401, '未授权：API Key 无效');
      return;
    }
    next();
    return;
  }

  if (AUTH_MODE === 'jwt') {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      sendApiError(res, 401, '未授权：缺少 Bearer token');
      return;
    }
    const claims = verifyJwt(token);
    if (!claims) {
      sendApiError(res, 401, '未授权：token 无效或已过期');
      return;
    }
    (req as Request & { auth?: { sub: string; role: string } }).auth = claims;
    next();
    return;
  }

  next();
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = String(req.headers['x-request-id'] || randomUUID());
  res.setHeader('x-request-id', id);
  (req as Request & { requestId?: string }).requestId = id;
  next();
}

export function issueJwt(sub: string, role = 'user', expiresInSeconds = 86400): string {
  const secret = envValue('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET 未配置');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}
