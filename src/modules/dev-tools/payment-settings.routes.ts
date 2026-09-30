import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { adminCallerActor } from '../../api/middlewares/admin-caller.middleware';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { PAYMENT_GATEWAY_NAMES, buildRoutingFacts, gatewaySupportsRefund } from '../payments/gateways/registry';
import { effectiveProviders, validateSettingsChange, SettingsIssue } from '../payments/domain/payment-routing';
import {
    getPaymentSettingsSync,
    setPaymentSettings,
    toPaymentSettingsView,
} from '../payments/services/payment-settings.service';

/**
 * `/api/internal/admin/dev-tools/payments` — the payment-routing switch wi-admin drives (ADR-A08).
 *
 * Mounted from `admin-dev-tools.routes.ts`, so it inherits that router's guards (the service
 * token and a required `X-Actor-Id`) and nothing else. It lives here rather than under
 * `modules/system/**` because it WRITES, and ADR-015 D-8 keeps that tree read-only.
 *
 * ── Not gated by `dev_tools.enabled`, and that is decided on the other side ──────
 * jovi-mall has no such flag; wi-admin does, and deliberately does not apply it to this switch
 * (owner decision 5, ADR-014 D-7 — the maintenance-mode precedent). This side re-checks no
 * permission, exactly like every route on this mount: `developer_tools.payments.set` is tier-1
 * only, and wi-admin decides that before the call arrives.
 *
 * Contract: `api-doc/payments/routing.md` § Administrator surface.
 */

/**
 * `.strict()`, so a misspelt key is a 400 rather than a stripped no-op that answers 200 and
 * switches nothing — and so an old client's `gateway` is refused here too.
 *
 * Aggregator and provider NAMES are strings, not enums. `validateSettingsChange` owns the lists
 * and answers `422 PAYMENT_SETTINGS_INVALID` with `COLLECTION_AGGREGATOR_UNKNOWN` /
 * `PROVIDER_UNKNOWN`, which tells an operator more than a Zod enum message would.
 */
export const SetPaymentSettingsSchema = z.object({
    collectionAggregator: z.string().trim().min(1).max(32).optional(),
    payoutAggregator: z.string().trim().min(1).max(32).optional(),
    stripeEnabled: z.boolean().optional(),
    providers: z.record(z.string().trim().min(1).max(32), z.object({ enabled: z.boolean() }).strict()).optional(),
    /** 0 when no document exists yet. A mismatch is 409 `PAYMENT_SETTINGS_VERSION_CONFLICT`. */
    expectedVersion: z.number().int().min(0),
    reason: z.string().trim().min(1).max(500),
}).strict();

/**
 * The problems the STORED settings have right now, for the GET.
 *
 * A write's warnings describe the moment of the write; this describes today. Credentials can
 * disappear after a switch (a rotated key, a redeploy without the env var), and payout
 * availability is a runtime fact, so `PAYOUT_UNAVAILABLE` on a setting nobody touched is exactly
 * what an operator should see when they open the screen.
 *
 * The stored state is validated against itself, and the two classes are kept APART:
 *
 * - `errors`: the stored state now breaks a HARD rule. New charges are being refused, which the
 *   screen shows as "payments are broken now", not as a note.
 * - `warnings`: soft rules on a state that is otherwise valid.
 *
 * The validator stops at hard errors, so when `errors` is non-empty `warnings` is empty. That is
 * the right order anyway: nothing soft matters until the hard problem is fixed.
 *
 * Exported for `test:admin-payment-settings`.
 */
export function standingIssues(): { errors: SettingsIssue[]; warnings: SettingsIssue[] } {
    const current = getPaymentSettingsSync();
    const verdict = validateSettingsChange(current, current, buildRoutingFacts());
    return verdict.ok ? { errors: [], warnings: verdict.warnings } : { errors: verdict.errors, warnings: [] };
}

export function buildPaymentSettingsRouter(): Router {
    const router = Router();

    /**
     * GET / — the settings, every aggregator's facts, what is offered now, and the standing
     * `errors` / `warnings` (see `standingIssues`).
     *
     * The one surface that NAMES aggregators; `/api/payments/options` never does. `effectiveProviders`
     * therefore keeps its `aggregator` here and nowhere public.
     */
    router.get('/', asyncHandler(async (_req: Request, res: Response) => {
        const settings = getPaymentSettingsSync();
        const facts = buildRoutingFacts();

        res.json({
            success: true,
            data: {
                settings: toPaymentSettingsView(settings),
                aggregators: PAYMENT_GATEWAY_NAMES.map((name) => ({
                    name,
                    configured: facts[name].configured,
                    capabilities: facts[name].capabilities,
                    payoutImplemented: facts[name].payoutImplemented,
                    payoutAvailable: facts[name].payoutAvailable,
                    refundAvailable: gatewaySupportsRefund(name),
                    activeForCollections: name === settings.collection_aggregator,
                    activeForPayouts: name === settings.payout_aggregator,
                })),
                effectiveProviders: effectiveProviders(settings, facts),
                ...standingIssues(),
            },
        });
    }));

    /**
     * PUT / — validate, compare-and-set, and answer with what was replaced.
     *
     * `previous` is the state the compare-and-set was made against (read from storage, not the
     * cache), so wi-admin's audit before/after cannot race a second administrator.
     */
    router.put('/', asyncHandler(async (req: Request, res: Response) => {
        const { expectedVersion, reason, ...patch } = SetPaymentSettingsSchema.parse(req.body ?? {});

        // The mount's guard already refuses a missing actor; this is the type narrowing, and a
        // refusal rather than a placeholder if that guard ever moves.
        const actor = adminCallerActor(req);
        if (!actor) {
            throw createAppError(ERROR_CODES.AUTH_ADMIN_CALLER_ACTOR_MISSING, 400, 'X-Actor-Id must be present');
        }

        const result = await setPaymentSettings(patch, expectedVersion, { id: actor.id, name: actor.name }, reason);

        res.json({
            success: true,
            data: result,
            message: result.changed.length === 0
                ? 'Payment settings were already in that state; nothing changed.'
                : `Payment settings updated (${result.changed.join(', ')}). `
                  + `Other instances converge within ${result.convergenceSeconds}s.`,
        });
    }));

    return router;
}
