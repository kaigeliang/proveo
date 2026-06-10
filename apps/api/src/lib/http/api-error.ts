import type { Response } from 'express';

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ApiErrorBody = {
  /**
   * Backward-compatible field for existing frontend code.
   * New callers should prefer errorInfo.code/message/details.
   */
  error: string;
  errorInfo: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

export function apiErrorCodeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 503 || status === 502 || status === 504) return 'UPSTREAM_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'BAD_REQUEST';
}

export function apiErrorBody(status: number, message: string, details?: unknown): ApiErrorBody {
  const body: ApiErrorBody = {
    error: message,
    errorInfo: {
      code: apiErrorCodeForStatus(status),
      message,
    },
  };
  if (details !== undefined) body.errorInfo.details = details;
  return body;
}

export function sendApiError(res: Response, status: number, message: string, details?: unknown) {
  res.status(status).json(apiErrorBody(status, message, details));
}
