import { Response } from 'express';

/**
 * Standard success-response envelope.
 *
 * Mirrors the error envelope produced by
 * `src/api/middlewares/error-handler.middleware.ts`:
 *
 *   success responses → { success: true,  data, meta?, message? }
 *   error responses   → { success: false, requestId, error: { code, message, statusCode, details? } }
 *
 * Every frontend-facing controller MUST send success responses through these
 * helpers so the client can rely on a single, uniform shape:
 *
 *   - `data`  always carries the payload (an object, an array, or `null`).
 *   - `meta`  carries pagination (`{ total, page, limit, pages }`) or other
 *             list-level summary fields; omitted when there is nothing to report.
 *   - `message` is an optional human-readable note (e.g. "Connection approved").
 *
 * Do NOT hand-roll `res.json({ success: true, ... })` in new code — use these so
 * the shape never drifts again.
 */

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
  /** Optional list-level summary fields (e.g. `totalReserved`). */
  [key: string]: number | string | boolean | null | undefined;
}

interface SuccessOptions {
  /** HTTP status code. Defaults to 200. */
  status?: number;
  /** Optional human-readable note. */
  message?: string;
  /** Pagination / list-level summary. Omitted from the body when undefined. */
  meta?: PaginationMeta | Record<string, unknown>;
}

/**
 * Send a standard success envelope: `{ success: true, data, meta?, message? }`.
 */
export function sendSuccess<T>(res: Response, data: T, options: SuccessOptions = {}): void {
  const { status = 200, message, meta } = options;
  res.status(status).json({
    success: true,
    data,
    ...(meta !== undefined ? { meta } : {}),
    ...(message !== undefined ? { message } : {}),
  });
}

/**
 * Send a `201 Created` success envelope. Use for resource-creation endpoints.
 */
export function sendCreated<T>(res: Response, data: T, options: Omit<SuccessOptions, 'status'> = {}): void {
  sendSuccess(res, data, { ...options, status: 201 });
}

/**
 * Send a paginated list: `{ success: true, data: [...], meta: { total, page, limit, pages, ... } }`.
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  meta: PaginationMeta,
  options: Omit<SuccessOptions, 'meta'> = {},
): void {
  sendSuccess(res, data, { ...options, meta });
}

/**
 * Send a message-only success (no payload): `{ success: true, data: null, message }`.
 * Use for actions whose only result is an acknowledgement (logout, "Cart cleared").
 */
export function sendMessage(res: Response, message: string, options: { status?: number } = {}): void {
  sendSuccess(res, null, { message, status: options.status });
}
