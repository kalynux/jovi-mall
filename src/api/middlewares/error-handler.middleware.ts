import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, DEFAULT_ERROR_MESSAGES } from '../../core/errors';
import { ErrorCode, ERROR_CODES } from '../../core/error-codes';
import { categoryFor, ErrorCategory, ERROR_CATEGORIES } from '../../core/error-category';
import { projectDetails, projectMessage } from '../../core/error-detail-policy';
import { logger } from '../../core/logging';
import { routeGroup } from '../../modules/system/domain/route-group';
import { recordError } from '../../modules/system/metrics/metrics';
import { customerMessageFor } from '../../modules/bot-surface/domain/bot-error-copy';
import { botResponseLanguageOf } from '../../modules/bot-surface/middlewares/bot-identity.middleware';

/**
 * Global Express error handler.
 *
 * MUST be registered as the LAST middleware in app.ts, after all routes.
 *
 * ── The contract returned to a client (unchanged shape, one new field) ────────
 * {
 *   success: false,
 *   requestId: string,
 *   error: {
 *     code: ErrorCode,
 *     message: string,
 *     statusCode: number,
 *     category: ErrorCategory,     // NEW in Phase 16, always present
 *     customerMessage?: string,    // NEW in GAP-002, BOT SURFACE ONLY
 *     details?: Record<string, unknown>
 *   }
 * }
 *
 * `category` is additive: a JSON reader ignores keys it does not know, and `details` is
 * already conditionally present, so every existing consumer already tolerates a varying key
 * set. It is the one thing a frontend can branch on generically without a 541-entry switch
 * — "offer a retry on external_service, highlight the field on validation".
 *
 * ── `customerMessage` — the sentence a chat window can relay verbatim ─────────
 * Present ONLY on `/api/internal/bot/*` responses, and absent everywhere else.
 *
 * `message` is written for a developer and an operator; the automation layer that calls the
 * bot surface has no copy table and no translator, so relaying it would put *"No platform
 * account is bound to this messaging identity"* in front of a customer. This service is the
 * only place that knows the code, the category AND the customer's language, so it is the
 * only place that can produce the sentence. `bot-surface/domain/bot-error-copy.ts` holds
 * the copy and the reasoning; the language was stamped on `req.bot` while the request was
 * still healthy, so no lookup happens on the failure path.
 *
 * ⚠ **It is ADDED, never a replacement for `message`.** An operator reading *"Something
 * went wrong. Please try again."* in an incident has been told nothing, and a code alone
 * does not say which of its several call sites fired. Two audiences, two strings.
 *
 * ⚠ **Scoped to the bot surface deliberately.** The four dashboards ship their own
 * localised copy and branch on `code`; sending them a second, server-chosen sentence would
 * be a second source of truth for wording they already own.
 *
 * ── What Phase 16 changed, and why it is here rather than at 1362 throw sites ─
 * Filtering happens HERE, keyed on category. `payment-orchestrator.service.ts` raises five
 * errors carrying `{ cause: error.message }` — raw axios/gateway prose — and
 * `google-calendar.client.ts` carries Google's own error body. None of those files is
 * edited: they are `external_service`, and `projectDetails` drops their details on the way
 * out. A rule enforced at every call site is a rule enforced at all but one of them.
 *
 * The masking is NOT environment-gated. `internal` and `external_service` are masked in
 * development exactly as in production; `test:errors` asserts the two produce identical
 * output. A rule that only runs in prod is a rule nobody has watched work.
 *
 * ── Logging ───────────────────────────────────────────────────────────────────
 * Through pino directly, not `console.*`. The handler predated the Phase-15 logging module
 * and leaned on the console bridge for structure, which meant it could not attach
 * structured fields — and the fields are the point: `httpError` is what
 * `GET /api/internal/admin/system/errors` reads back, and what wi-admin projects by tier.
 *
 * Severity is `warn` for the seven client-facing categories and `error` for
 * `external_service` and `internal`, which is also the level floor the capped `system_logs`
 * sink persists at.
 *
 * Stack traces are NEVER sent to a client, in any environment.
 */
export const errorHandlerMiddleware = (
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction
): void => {
    const requestId = req.requestId ?? 'unknown';

    // ── 1. AppError (our own domain errors) ────────────────────────────────────
    if (err instanceof AppError) {
        respond(req, res, requestId, {
            code: err.code,
            statusCode: err.statusCode,
            category: err.category,
            thrownMessage: err.message,
            details: err.details,
            error: err,
        });
        return;
    }

    // ── 2. ZodError (schema validation bubble-up) ──────────────────────────────
    if (err instanceof ZodError) {
        respond(req, res, requestId, {
            code: ERROR_CODES.VALIDATION_ERROR,
            statusCode: 400,
            category: ERROR_CATEGORIES.VALIDATION,
            thrownMessage: 'Validation failed',
            details: {
                fields: err.errors.map((e) => ({
                    path: e.path.join('.'),
                    message: e.message,
                    code: e.code,
                })),
            },
            error: err,
        });
        return;
    }

    // ── 3. Body-parser rejection — malformed before any schema saw it ──────────
    // Express rejects these inside `express.json()`, so no route and no Zod schema is ever
    // reached. Without this branch they fell through to case 6 and a caller sending
    // malformed JSON was told `500 — Something went wrong`: our fault, unactionable, and
    // false. The three outcomes are the three different things the caller must do about it
    // — fix the JSON, send less, send a different `Content-Type`.
    //
    // Ported from wi-admin, which fixed this first; ADR-005's own consequences section
    // records "jovi-mall still does".
    const bodyFailure = classifyBodyParserFailure(err);
    if (bodyFailure) {
        respond(req, res, requestId, {
            code: bodyFailure.code,
            statusCode: bodyFailure.statusCode,
            category: ERROR_CATEGORIES.VALIDATION,
            thrownMessage: bodyFailure.message,
            details: undefined,
            error: err,
        });
        return;
    }

    // ── 4. Mongoose CastError (invalid ObjectId, etc.) ─────────────────────────
    if (isMongooseCastError(err)) {
        respond(req, res, requestId, {
            code: ERROR_CODES.NOT_FOUND,
            statusCode: 404,
            category: ERROR_CATEGORIES.NOT_FOUND,
            thrownMessage: 'Resource not found',
            details: undefined,
            error: err,
        });
        return;
    }

    // ── 5. Mongoose Duplicate Key (code 11000) ─────────────────────────────────
    if (isMongooseDuplicateKeyError(err)) {
        const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
        respond(req, res, requestId, {
            code: ERROR_CODES.DATABASE_UNIQUE_CONSTRAINT_VIOLATION,
            statusCode: 409,
            category: ERROR_CATEGORIES.CONFLICT,
            thrownMessage: 'A record with this value already exists',
            details: { keyValue },
            error: err,
        });
        return;
    }

    // ── 6. Multer errors (file size/count limits hit during multipart parsing) ─
    if (isMulterError(err)) {
        const multerCode = (err as { code?: string }).code;
        const isSize = multerCode === 'LIMIT_FILE_SIZE';
        const isCount = multerCode === 'LIMIT_FILE_COUNT' || multerCode === 'LIMIT_UNEXPECTED_FILE';
        const statusCode = isSize ? 413 : 400;

        respond(req, res, requestId, {
            code: isSize ? ERROR_CODES.CATALOG_FILE_TOO_LARGE : ERROR_CODES.VALIDATION_ERROR,
            statusCode,
            category: ERROR_CATEGORIES.VALIDATION,
            thrownMessage: isSize
                ? 'Uploaded file exceeds the maximum allowed size'
                : isCount
                    ? 'Too many files or unexpected field in the upload'
                    : 'The upload could not be read',
            details: undefined,
            error: err,
        });
        return;
    }

    // ── 7. Unknown / unexpected error ─────────────────────────────────────────
    // `internal`, so the message is masked and no details travel — the same treatment a 500
    // raised through `createAppError` now gets. The two used to differ, which meant the one
    // path we knew least about was the one we masked and the one we had written ourselves
    // was sent verbatim.
    respond(req, res, requestId, {
        code: ERROR_CODES.INTERNAL_SERVER_ERROR,
        statusCode: 500,
        category: ERROR_CATEGORIES.INTERNAL,
        thrownMessage: err instanceof Error ? err.message : String(err),
        details: undefined,
        error: err,
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// The one exit
// ─────────────────────────────────────────────────────────────────────────────

interface Outcome {
    code: ErrorCode;
    statusCode: number;
    category: ErrorCategory;
    /** What the code threw. May be masked before it reaches the client. */
    thrownMessage: string;
    /** Unfiltered. Journaled in full; filtered on the way to the client. */
    details: Record<string, unknown> | undefined;
    /** The original throwable, for its stack and cause chain. */
    error: unknown;
}

/**
 * Journal the full truth, send the projected copy.
 *
 * Every branch above funnels through here so there is exactly one place that decides what
 * a client sees and exactly one place that decides what is recorded. Six branches each
 * building their own response is how the two drift.
 */
function respond(req: Request, res: Response, requestId: string, outcome: Outcome): void {
    const registryDefault = DEFAULT_ERROR_MESSAGES[outcome.code];
    const clientMessage = projectMessage(outcome.category, outcome.thrownMessage, registryDefault);
    const clientDetails = projectDetails(outcome.category, outcome.details);
    const masked = clientMessage !== outcome.thrownMessage;

    journal(req, requestId, outcome, clientMessage, masked);
    recordError(outcome.category, outcome.statusCode);

    /**
     * The customer-facing half — bot surface only.
     *
     * `botResponseLanguageOf` returns null off that surface, so the key is simply absent on
     * every other response and no existing consumer sees a change. Nothing is queried here:
     * the language was stamped on `req.bot` while the request was still healthy, precisely
     * so a failure whose cause is an unreachable database can still be worded correctly.
     */
    const customerMessage = req.bot
        ? customerMessageFor(outcome.code, outcome.category, botResponseLanguageOf(req))
        : undefined;

    res.status(outcome.statusCode).json({
        success: false,
        requestId,
        error: {
            code: outcome.code,
            message: clientMessage,
            statusCode: outcome.statusCode,
            category: outcome.category,
            ...(customerMessage !== undefined && { customerMessage }),
            ...(clientDetails !== undefined && { details: clientDetails }),
        },
    });
}

/**
 * Write the internal record.
 *
 * Everything lands under a single `httpError` key rather than as a dozen top-level fields,
 * and that nesting is load-bearing: `core/logging/log-record.ts` assigns every persisted
 * field BY NAME — its own header says adding one must be a deliberate edit, because "a loop
 * with a cast would quietly accept anything pino happened to emit". One object means one
 * assignment in `parseLogLine` and one in `log-query.service.ts`'s `toRecord`, instead of a
 * dozen in each.
 *
 * `requestId` and `actorId` arrive free from the ALS mixin. pino's `redact` and `scrub.ts`
 * still run over everything written here.
 */
function journal(
    req: Request,
    requestId: string,
    outcome: Outcome,
    clientMessage: string,
    masked: boolean,
): void {
    const err = outcome.error instanceof Error ? outcome.error : undefined;
    // `Error.cause` is ES2022 and this project targets lower, so it is read
    // structurally rather than by widening the whole lib for one field.
    const cause = (err as { cause?: unknown } | undefined)?.cause;

    const payload = {
        httpError: {
            category: outcome.category,
            code: outcome.code,
            statusCode: outcome.statusCode,
            routeGroup: routeGroup(req.originalUrl ?? req.path),
            actorRole: req.auth?.role ?? null,
            // What we actually sent, so an operator can see the customer's view beside ours
            // without re-deriving it — and so Support's projection has something safe to
            // show without echoing a free-text log message.
            clientMessage,
            // What the code threw. This is the half that never reaches a client for a
            // masked category, and the half an operator needs first.
            internalMessage: outcome.thrownMessage,
            // Unfiltered. `{ cause: <gateway prose> }` lives here and only here.
            details: outcome.details ?? null,
            causeMessage: cause instanceof Error ? cause.message : null,
            masked,
        },
        // `err` is pino's standard serializer key, so the stack is captured and bounded by
        // the existing MAX_STACK_BYTES rather than by a second mechanism.
        ...(err !== undefined && { err }),
        method: req.method,
        path: req.originalUrl ?? req.path,
        status: outcome.statusCode,
    };

    const message = `${outcome.category} ${outcome.statusCode} ${outcome.code}`;

    // 5xx and third-party failures are ours to chase; a 4xx is the caller's request and is
    // worth counting rather than paging on.
    if (
        outcome.category === ERROR_CATEGORIES.INTERNAL
        || outcome.category === ERROR_CATEGORIES.EXTERNAL_SERVICE
    ) {
        logger().error(payload, message);
    } else {
        logger().warn(payload, message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────────────────────────────────────

interface BodyParserFailure {
    code: ErrorCode;
    statusCode: number;
    message: string;
    type: string;
}

/**
 * Recognise a rejection raised by `express.json()` / `express.urlencoded()`.
 *
 * body-parser tags every one with a stable `type` string (and a `status`), which is what is
 * matched here — not the message, which is prose. The dotted-namespace check is what stops
 * this claiming any object that happens to carry a `type` and a `status`.
 *
 * Ported from wi-admin's `error-handler.middleware.ts`; exported for `test:errors`.
 */
export function classifyBodyParserFailure(err: unknown): BodyParserFailure | null {
    if (typeof err !== 'object' || err === null) return null;

    const candidate = err as { type?: unknown; status?: unknown };
    if (typeof candidate.type !== 'string' || typeof candidate.status !== 'number') return null;
    if (!candidate.type.includes('.')) return null;

    switch (candidate.type) {
        case 'entity.too.large':
        case 'parameters.too.many':
            return {
                code: ERROR_CODES.REQUEST_BODY_TOO_LARGE,
                statusCode: 413,
                message: 'The request body is too large',
                type: candidate.type,
            };

        case 'charset.unsupported':
        case 'encoding.unsupported':
            return {
                code: ERROR_CODES.REQUEST_MEDIA_TYPE_UNSUPPORTED,
                statusCode: 415,
                message: 'Unsupported content type — send application/json; charset=utf-8',
                type: candidate.type,
            };

        default:
            // `entity.parse.failed`, `request.aborted`, `request.size.invalid`, and anything
            // body-parser adds later. A 5xx-tagged one is genuinely ours, so it is left to
            // the unknown branch, which logs a stack.
            if (candidate.status >= 500) return null;
            return {
                code: ERROR_CODES.REQUEST_BODY_INVALID,
                statusCode: 400,
                message: 'The request body could not be read as JSON',
                type: candidate.type,
            };
    }
}

function isMongooseCastError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'CastError';
}

function isMulterError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'MulterError';
}

function isMongooseDuplicateKeyError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Re-exported so `test:errors` can assert derivation without importing two modules. */
export { categoryFor };
