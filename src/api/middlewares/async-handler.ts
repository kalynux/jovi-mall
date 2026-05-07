import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async Express handler to forward unhandled promise rejections
 * to the global error handler middleware via next(err).
 *
 * Usage:
 *   router.get('/path', asyncHandler(myAsyncController));
 */
export const asyncHandler = (fn: RequestHandler): RequestHandler =>
    (req: Request, res: Response, next: NextFunction): void => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
