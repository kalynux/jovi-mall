import { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestsInFlight, httpRequestsTotal } from './metrics';
import { routeGroup, statusClass } from '../domain/route-group';
import { logger } from '../../../core/logging/logger';
import { loggingConfig } from '../../../core/logging/logging.config';

/**
 * Count and time every request.
 *
 * ── Where this mounts, and why it is nearly first ─────────────────────────────
 * Immediately after `requestIdMiddleware` and BEFORE helmet, CORS and the body parsers. It
 * measures on `res.on('finish')`, so mounting it early is precisely what makes a request
 * rejected by CORS, or one that dies in body parsing, still get counted and timed. Mounted
 * after those, the traffic you most want to see during an incident is the traffic that never
 * reaches the counter.
 *
 * `finish` also fires for a response the client aborted mid-write, which is the honest place to
 * stop the clock — the server did its work either way.
 */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    httpRequestsInFlight.inc();

    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;

        httpRequestsInFlight.dec();

        const group = routeGroup(req.path);
        const method = req.method.toUpperCase();
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

        httpRequestsTotal.inc({
            method,
            route_group: group,
            status_class: statusClass(res.statusCode),
        });
        httpRequestDuration.observe({ method, route_group: group }, seconds);

        /**
         * The access log (Phase 15) — free, because everything it needs is already computed.
         *
         * `routeGroup`, never the raw path, for exactly the cardinality reason the metric uses
         * it: a scanner hitting `/api/.env` must not mint a distinct log shape per request. The
         * raw path is attached only at **warn+** (4xx/5xx), where knowing precisely what was
         * asked for is the whole point and the volume is self-limiting.
         *
         * `requestId` arrives via the logger's ALS mixin, so it is not passed here.
         */
        if (loggingConfig().HTTP_ACCESS) {
            const status = res.statusCode;
            const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
            logger()[level](
                {
                    method,
                    routeGroup: group,
                    status,
                    durationMs: Math.round(seconds * 1000),
                    ...(level === 'info' ? {} : { path: req.originalUrl }),
                },
                `${method} ${group} ${status}`,
            );
        }
    };

    // `close` as well as `finish`: a connection dropped before the response completed never
    // fires `finish`, and without this the in-flight gauge would leak upward forever — a gauge
    // that only ever rises is worse than no gauge, because it looks like load.
    res.on('finish', settle);
    res.on('close', settle);

    next();
}
