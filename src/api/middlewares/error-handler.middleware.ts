import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

/**
 * Global Express error handler.
 *
 * MUST be registered as the LAST middleware in app.ts, after all routes.
 *
 * Contract returned to client:
 * {
 *   success: false,
 *   requestId: string,
 *   error: {
 *     code: ErrorCode,
 *     message: string,
 *     statusCode: number,
 *     details?: Record<string, unknown>
 *   }
 * }
 *
 * Logging behaviour:
 * - Operational AppError   → console.warn (expected business error)
 * - Non-operational AppError → console.error + stack (infra/programming bug)
 * - ZodError               → console.warn with validation details
 * - Mongoose CastError     → console.warn, mapped to 404
 * - Mongoose duplicate key → console.warn, mapped to 409
 * - Unknown error          → console.error + stack, response masked in production
 *
 * Stack traces are NEVER sent to the client in production.
 */
export const errorHandlerMiddleware = (
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction
): void => {
    const requestId = req.requestId ?? 'unknown';
    const isProd = process.env.NODE_ENV === 'production';

    // ── 1. AppError (our own domain errors) ────────────────────────────────────
    if (err instanceof AppError) {
        if (err.isOperational) {
            console.warn(
                `[${requestId}] AppError [${err.code}] ${err.statusCode} — ${err.message}`,
                { path: req.path, method: req.method, details: err.details }
            );
        } else {
            console.error(
                `[${requestId}] Non-operational AppError [${err.code}]`,
                { path: req.path, stack: err.stack }
            );
        }

        res.status(err.statusCode).json({
            success: false,
            requestId,
            error: {
                code: err.code,
                message: err.message,
                statusCode: err.statusCode,
                ...(err.details !== undefined && { details: err.details }),
            },
        });
        return;
    }

    // ── 2. ZodError (schema validation bubble-up) ──────────────────────────────
    if (err instanceof ZodError) {
        const details: Record<string, unknown> = {
            fields: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message, code: e.code })),
        };
        console.warn(`[${requestId}] ZodError at ${req.method} ${req.path}`, details);

        res.status(400).json({
            success: false,
            requestId,
            error: {
                code: ERROR_CODES.VALIDATION_ERROR,
                message: 'Validation failed',
                statusCode: 400,
                details,
            },
        });
        return;
    }

    // ── 3. Mongoose CastError (invalid ObjectId, etc.) ─────────────────────────
    if (isMongooseCastError(err)) {
        console.warn(`[${requestId}] Mongoose CastError at ${req.method} ${req.path}`, { value: err.value });

        res.status(404).json({
            success: false,
            requestId,
            error: {
                code: ERROR_CODES.NOT_FOUND,
                message: 'Resource not found',
                statusCode: 404,
            },
        });
        return;
    }

    // ── 4. Mongoose Duplicate Key (code 11000) ─────────────────────────────────
    if (isMongooseDuplicateKeyError(err)) {
        const keyValue = (err as any).keyValue ?? {};
        console.warn(`[${requestId}] Duplicate key error at ${req.method} ${req.path}`, keyValue);

        res.status(409).json({
            success: false,
            requestId,
            error: {
                code: ERROR_CODES.DATABASE_UNIQUE_CONSTRAINT_VIOLATION,
                message: 'A record with this value already exists',
                statusCode: 409,
                details: { keyValue },
            },
        });
        return;
    }

    // ── 5. Unknown / unexpected error ─────────────────────────────────────────
    const unknownErr = err instanceof Error ? err : new Error(String(err));
    console.error(
        `[${requestId}] Unhandled error at ${req.method} ${req.path}`,
        { stack: unknownErr.stack }
    );

    res.status(500).json({
        success: false,
        requestId,
        error: {
            code: ERROR_CODES.INTERNAL_SERVER_ERROR,
            message: isProd ? 'Something went wrong' : unknownErr.message,
            statusCode: 500,
        },
    });
};

// ── Type guards ──────────────────────────────────────────────────────────────

function isMongooseCastError(err: unknown): err is { name: string; value: unknown } {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as any).name === 'CastError'
    );
}

function isMongooseDuplicateKeyError(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as any).code === 11000
    );
}
