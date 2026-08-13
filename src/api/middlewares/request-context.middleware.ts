import { Request, Response, NextFunction } from 'express';
import { runWithRequestContext } from '../../core/logging/request-context';

/**
 * Opens the AsyncLocalStorage request context, so every log line produced while serving this
 * request carries its correlation id without anyone threading a logger.
 *
 * **Must be registered immediately after `requestIdMiddleware`** — it reads `req.requestId`,
 * and anything mounted between the two produces log lines with no correlation id.
 *
 * `next()` is called INSIDE `runWithRequestContext`, which is what puts the rest of the
 * middleware chain and the route handler inside the store's async subtree. Calling it outside
 * would compile, run, and silently stamp nothing.
 */
export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    runWithRequestContext(
        {
            requestId: req.requestId,
            method: req.method,
            // `originalUrl` rather than `path`: the mounted prefix is part of what an operator
            // greps for, and `path` drops it inside a sub-router.
            path: req.originalUrl,
        },
        () => next(),
    );
};
