import { Request, Response, NextFunction } from 'express';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { evaluateMaintenance } from '../../modules/system/domain/maintenance-mode';
import { currentMaintenance } from '../../modules/system/services/maintenance.service';
import { setMaintenanceGauge } from '../../modules/system/metrics/metrics';

/**
 * Refuse traffic during a maintenance window.
 *
 * All of the policy — which modes exist, what each refuses, and the exemption list with the
 * reasoning behind every entry — lives in `modules/system/domain/maintenance-mode.ts` as pure
 * functions, so `npm run test:system` can drive the whole table without a database or an HTTP
 * server. This file is only the Express adapter.
 *
 * The state read is **synchronous** (a few-second in-process cache over the Mongo singleton), so
 * this costs a map lookup per request rather than a query.
 */
export function maintenanceModeMiddleware(req: Request, res: Response, next: NextFunction): void {
    const state = currentMaintenance();
    const verdict = evaluateMaintenance(state, new Date(), req.method, req.path);

    setMaintenanceGauge(verdict.mode);

    if (verdict.allowed) {
        next();
        return;
    }

    // `Retry-After` is set here rather than in the global error handler, which has no way to
    // know a 503 came from a window with a known end. A client that respects it backs off to
    // roughly the right time instead of hammering.
    if (state.expiresAt) {
        const seconds = Math.max(1, Math.ceil((state.expiresAt.getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', String(seconds));
    }

    next(createAppError(
        ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE,
        503,
        state.reason ?? 'The platform is temporarily unavailable for maintenance.',
        {
            mode: verdict.mode,
            reason: state.reason,
            startedAt: state.startedAt?.toISOString() ?? null,
            expiresAt: state.expiresAt?.toISOString() ?? null,
        },
    ));
}
