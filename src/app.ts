import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { requestIdMiddleware } from './api/middlewares/request-id.middleware';
import { requestContextMiddleware } from './api/middlewares/request-context.middleware';
import { healthRoutes } from './api/routes/health.routes';
import { maintenanceModeMiddleware } from './api/middlewares/maintenance-mode.middleware';
import { httpMetricsMiddleware } from './modules/system/metrics/http-metrics.middleware';
import { metricsRoutes } from './modules/system/metrics/metrics.routes';
import { errorHandlerMiddleware } from './api/middlewares/error-handler.middleware';
import { ERROR_CODES } from './core/error-codes';
import { createAppError } from './core/errors';
import { ALLOWED_ORIGINS, BOT_FILE_BODY_LIMIT, JSON_BODY_LIMIT, TRUST_PROXY, WEBHOOK_BODY_LIMIT } from './config/http.config';
import { logger } from './core/logging';
import { globalRateLimiter } from './api/rate-limit/rate-limit.middleware';

/**
 * The CORS policy. Mirrors wi-admin's `buildCorsOptions`, including its two subtleties.
 */
function buildCorsOptions(): cors.CorsOptions {
    const allowed = new Set(ALLOWED_ORIGINS);

    return {
        origin(origin, callback) {
            // No Origin header: a server-to-server caller, a mobile app, or curl. CORS is a
            // browser mechanism and does not apply to any of them.
            if (!origin || allowed.has(origin)) {
                callback(null, true);
                return;
            }
            logger().warn({ origin }, 'CORS: rejected disallowed origin');
            // `false`, never an Error. This omits the CORS headers, which is the correct
            // browser-visible outcome; throwing would turn a blocked cross-origin READ into
            // a 500 in our logs and tell the caller more than a silent refusal does.
            callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
        // So a browser client can read the correlation id off a failed response and quote
        // it — which is what makes the Support lookup usable from a bug report.
        exposedHeaders: ['X-Request-Id'],
        maxAge: 600,
    };
}

const app = express();

// ─── Request Correlation ID (must be first) ───────────────────────────────────
app.use(requestIdMiddleware);

// ─── Request context — immediately after, and that adjacency matters ──────────
// It opens the AsyncLocalStorage store the logger's `mixin` reads, so every log line produced
// while serving this request carries its correlation id with nothing threaded by hand. Anything
// mounted between the two would log without one — including, before this, the metrics
// middleware directly below.
app.use(requestContextMiddleware);

// ─── HTTP metrics — nearly first, and deliberately so ─────────────────────────
// It records on `res.on('finish')`, so mounting it ahead of helmet, CORS and the body parsers
// is what makes a request rejected by CORS — or one that dies in body parsing — still counted
// and timed. Mounted after them, the traffic you most want during an incident is exactly the
// traffic that never reaches the counter.
app.use(httpMetricsMiddleware);

// ─── Trust proxy — required before anything reads req.ip ─────────────────────
//
// Without this every request behind an ingress reports the PROXY's address as
// `req.ip`, so the rate limiter's anonymous bucket would treat the entire
// internet as one client and throttle the platform as a whole. Off by default
// (`TRUST_PROXY` unset ⇒ `false`) because trusting `X-Forwarded-For` when
// nothing strips it lets any caller spoof their own address and bypass the
// limit — it must be switched on only where a proxy really does sit in front.
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');

// ─── helmet, with its defaults intact ────────────────────────────────────────
//
// The CSP used to be widened to `script-src 'unsafe-inline'` and
// `script-src-attr 'unsafe-inline'`, labelled "for development" and applied in
// every environment. It existed for exactly one thing: the inline `<script>`
// and the `onclick=` handlers in the `GET /test-auth` page below it. That page
// is gone, so the relaxation goes with it — this is the rare security fix that
// comes free with a deletion.
app.use(helmet());

// ─── CORS — an allowlist, not a mirror ───────────────────────────────────────
//
// This was `cors({ origin: true, credentials: true })`, unconditionally, in every
// environment. `origin: true` REFLECTS whatever `Origin` the request carried, and
// combined with `credentials: true` that means any website on the internet could make
// authenticated, cookie-bearing requests to this API in a logged-in user's browser and
// read the responses — the exact thing the same-origin policy exists to prevent. The
// comment beside it said "in development"; there was no environment branch.
//
// Now: an explicit allowlist from `ALLOWED_ORIGINS`, mirroring wi-admin's
// `buildCorsOptions`. A request with NO `Origin` header is still allowed — that is every
// server-to-server caller (geo-tracker, wi-admin, the gateways) and every mobile client,
// none of which is subject to CORS at all; refusing them would break the platform to
// protect against a mechanism that does not apply to them.
//
// ⚠ This is the one change in Phase 16 that can break a frontend nobody wrote down.
// `ALLOWED_ORIGINS` must be populated with the origins actually in use before this ships.
// Left empty, browser clients on other origins lose access — which is the correct failure
// direction for a security control, and a loud one.
app.use(cors(buildCorsOptions()));

// Gateway webhook signature verification needs the raw request bytes, so these
// paths must bypass the JSON body parser. Mounted BEFORE express.json().
//
// Their own limit is deliberately larger than the global one: a gateway event
// with a big expanded object is legitimate traffic we cannot ask the sender to
// shrink, and a 413 here loses a payment notification.
//
// ⚠ Three explicit paths, NOT the `/api/webhooks` prefix. That prefix also
// carries the WhatsApp and Telegram bot routers (`api/index.ts`), which read a
// parsed JSON body — widening this mount would hand them a Buffer and break
// every bot command silently.
//
// `type: () => true` — every content type, not just `application/json`. A
// gateway posting `x-www-form-urlencoded` would otherwise fall through to
// `express.json`, arrive parsed, and destroy the exact bytes the HMAC is
// computed over. The verifier would then compare against re-serialised JSON and
// refuse every genuine callback — a failure that looks like a wrong secret and
// is not.
//
// The predicate form rather than the equivalent `'*/*'` string is deliberate:
// that literal contains the character sequence that ENDS a block comment, so it
// silently breaks any comment-stripping source scanner reading this file —
// including `test:payments`' own, which is what caught it.
app.use(
    ['/api/webhooks/stripe', '/api/webhooks/notchpay', '/api/webhooks/mycoolpay'],
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT })
);

// ─── Body parsing, with a ceiling ────────────────────────────────────────────
//
// `express.json()` had no `limit`, so it fell back to body-parser's 100 kb
// default — which meant the ceiling existed but nothing in this service could
// name it, and `REQUEST_BODY_TOO_LARGE` was unreachable because the rejection
// had no branch in the error handler. Setting it explicitly makes the number a
// decision rather than a default, and the handler's new body-parser branch
// turns the rejection into a 413 a caller can act on instead of a 500 blaming
// the server for their payload.
// ─── One path with a wider JSON ceiling, mounted BEFORE the global parser ─────
//
// `POST /api/internal/bot/files/inbound` carries a photo a customer sent in a chat, as
// base64 — the automation layer holds the channel tokens and this service must not, so
// the bytes have to arrive in a body. Base64 inflates by a third and the global ceiling
// is 1 MB, which refuses every real image.
//
// Order matters and is the same reason the raw webhook parsers sit above: body-parser
// marks a request it has already read, so the global `express.json` below sees this one
// parsed and does nothing. Mounted the other way round, the 1 MB limit would fire first
// and this would never be reached.
app.use('/api/internal/bot/files/inbound', express.json({ limit: BOT_FILE_BODY_LIMIT }));

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));
app.use(cookieParser()); // Required for session authentication

// ─── Probes and telemetry — before the maintenance gate ──────────────────────
//
// `/api/health` keeps its exact path and its exact body; geo-tracker's readiness checker and
// wi-admin's `pingPlatform()` both depend on it. See `api/routes/health.routes.ts`.
//
// Both mounts sit ahead of `maintenanceModeMiddleware` on purpose: a probe that fails during a
// maintenance window makes the orchestrator restart the fleet, and telemetry matters most
// during the incident.
app.use('/api/health', healthRoutes);
app.use('/metrics', metricsRoutes);

// ─── Rate limiting, Layer A — IP-scoped backstop ─────────────────────────────
//
// Position is four decisions at once:
//
//  - AFTER `/api/health` and `/metrics`, so probes and scrapes are structurally exempt
//    rather than exempt by a list that could be edited wrong. `exempt-paths.ts` names them
//    too; belt and braces, because a 429 on `/api/health` pulls geo-tracker out of rotation
//    and kills every live tracking session (ADR-014 D-1).
//  - AFTER `httpMetricsMiddleware`, so a 429 is counted and timed like any other response.
//    That middleware's own header makes this argument about CORS and body-parse failures.
//  - BEFORE `maintenanceModeMiddleware` and `/api`, so a flood is refused cheaply rather
//    than after a database read.
//  - BEFORE authentication, which is the point of Layer A: it protects the login endpoint,
//    which by definition has no authenticated caller to key on. Layer B, mounted at the
//    tail of `requireAuth`, is where the per-role ceilings live.
app.use(globalRateLimiter);

// ─── Maintenance gate ────────────────────────────────────────────────────────
//
// After body parsing and after the probes, immediately before every business route. Mounted
// once by prefix rather than per router for the same reason `api/index.ts` mounts
// `adminActionLogMiddleware` that way: one mount cannot miss an endpoint by omission, and a
// router added next year inherits it without its author having to know it exists.
//
// The exemption list — and in particular why `/api/internal/admin/*`, `/api/internal/agents/*`
// and the gateway webhooks stay open — is in `modules/system/domain/maintenance-mode.ts`.
app.use(maintenanceModeMiddleware);

import { apiRouter } from './api';
app.use('/api', apiRouter);

// ─── 404 Handler (unmatched routes) ──────────────────────────────────────────
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(createAppError(ERROR_CODES.NOT_FOUND, 404, 'No route matches this method and path'));
});

// ─── Global Error Handler (must be last) ─────────────────────────────────────
app.use(errorHandlerMiddleware);

export { app };
