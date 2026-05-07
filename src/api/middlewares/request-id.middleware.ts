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
 * Request ID middleware.
 *
 * Injects a unique correlation ID on every request:
 *  - Reads `X-Request-Id` header if provided by upstream proxy/client
 *  - Generates a UUIDv4 otherwise
 *  - Attaches as `req.requestId`
 *  - Sets `X-Request-Id` response header so clients can trace incidents
 *
 * Must be registered as the FIRST middleware in app.ts.
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const id = (req.headers['x-request-id'] as string | undefined) || randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
};
