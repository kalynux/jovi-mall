import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            requestId: string;
        }
    }
}

/**
 * What an inbound `X-Request-Id` is allowed to look like.
 *
 * ── Why the header is no longer trusted verbatim ──────────────────────────────
 * This id is written into every structured log line (via the ALS mixin), persisted to the
 * capped `system_logs` collection, and — since Phase 16 — is the key a support agent uses
 * to look an incident up through `/system/errors`. Accepting whatever arrived made that
 * two problems at once:
 *
 *   - **log injection.** Newlines, control characters and ANSI escapes in a field that is
 *     rendered into a log stream and read by a human.
 *   - **poisoning the lookup.** A caller could stamp every request with one id, or collide
 *     deliberately with somebody else's, and make the errors they caused unfindable.
 *
 * Same expression wi-admin's request-id middleware uses. 128 characters is well past any
 * real tracing id and short enough not to be a payload.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Request ID middleware.
 *
 * Injects a unique correlation ID on every request:
 *  - Reuses `X-Request-Id` from an upstream proxy/client **when it is well-formed**
 *  - Generates a UUIDv4 otherwise
 *  - Attaches as `req.requestId`
 *  - Sets `X-Request-Id` response header so clients can trace incidents
 *
 * A malformed inbound id is REPLACED, not rejected. Answering 400 would take out every
 * request through a misconfigured gateway, and the correlation is worth less than the
 * traffic.
 *
 * Must be registered as the FIRST middleware in app.ts.
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.headers['x-request-id'];
    const candidate = typeof inbound === 'string' ? inbound : undefined;
    const id = candidate && VALID_REQUEST_ID.test(candidate) ? candidate : randomUUID();

    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
};
