import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { logger } from '../../../core/logging';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../../billing/billing.types';
import { PlanQuotaEnforcementService, planQuotaEnforcementService } from '../domain/services/plan-quota-enforcement.service';

/**
 * Brings an owner's catalog and media library in line the moment their plan changes.
 *
 * `plan.activated` is published by `SubscriberPlanService` on every path that makes a
 * plan the owner's active one — a purchase, an administrator's assignment, a queued plan
 * being promoted at expiry, a lapse down to the free tier, and a chargeback reversal. So
 * one subscription covers every transition, upgrade and downgrade alike, and there is no
 * list of entry points to keep in step.
 *
 * ⚠ **This is the FAST path, not the guarantee.** The bus is in-process, unpersisted and
 * un-retried, and `publish` swallows handler errors — so a restart at the wrong instant,
 * or one throw in here, loses the enforcement with no symptom. `PlanQuotaReconcileWorker`
 * is what makes it correct; this is what makes it immediate. Do not remove the worker on
 * the grounds that this consumer exists, and do not remove this on the grounds that the
 * worker does: without it a downgraded vendor keeps selling until the small hours.
 *
 * ⚠ **Deliberately NOT moved into the plan-change transaction**, which is the usual
 * remedy for a durable write reached through the bus. Suspending a hundred products and
 * blocking ten thousand files is not work to hold a billing transaction open across, and
 * failing a purchase because the sweep that follows it fell over would take money from an
 * owner and then refuse them the plan. The state document plus the worker give the same
 * durability without either cost.
 *
 * The enforcement service reads the plan itself rather than trusting the payload — the
 * event carries only the shipment-cap fields, and re-reading is one indexed lookup
 * against a value that is already committed.
 */
export function registerPlanQuotaConsumer(
    enforcement: PlanQuotaEnforcementService = planQuotaEnforcementService,
): void {
    eventBus.subscribe(
        'plan.activated',
        async (event: DomainEvent) => {
            const ownerType = event.payload.ownerType as BillingOwnerType;
            const ownerId = event.payload.ownerId as string;
            if (!BILLING_OWNER_TYPES.includes(ownerType) || !ownerId) return;

            const outcome = await enforcement.reconcileOwner(ownerType, ownerId);
            if (!outcome.enforced) return;

            // Logged at info rather than debug: this is the only per-owner record that a
            // downgrade took products off sale, and it is the first thing anyone will look
            // for when a vendor asks why their listing disappeared.
            logger().info(
                {
                    ownerType,
                    ownerId,
                    planCode: event.payload.planCode,
                    productsSuspended: outcome.productsSuspended,
                    productsRestored: outcome.productsRestored,
                    filesBlocked: outcome.filesBlocked,
                    filesReleased: outcome.filesReleased,
                },
                'plan quota: enforced after plan change',
            );
        },
        // Named because the bus cannot infer one from an inline arrow, and this handler
        // WRITES — an enforcement that silently failed is invisible everywhere else until
        // the nightly sweep catches it.
        'PlanQuotaConsumer.onPlanActivated',
    );

    /**
     * The other direction: room reappearing without the plan changing.
     *
     * An owner over cap is told their remedy is to archive or delete something older, at
     * which point the next-oldest suspended product (or blocked file) comes back. That is
     * only true if something recomputes — and `plan.activated` does not fire, because the
     * plan did not change. `PlanQuotaReconcileWorker` covers it durably by also sweeping
     * everyone currently holding quota state, but only on its nightly cadence; this makes
     * the promised remedy take effect while the owner is still looking at the screen.
     *
     * ⚠ Published by catalog, consumed here, precisely so **catalog never imports
     * plan-quota**. This module reaches into catalog for products and files; an import the
     * other way would close the cycle. Same shape as billing → agents via `plan.activated`.
     *
     * Lossy by nature, and that is acceptable here in a way it is not for the enforcement
     * itself: dropping this event costs latency, never correctness, because the worker
     * still picks the owner up.
     */
    eventBus.subscribe(
        'quota.capacity_freed',
        async (event: DomainEvent) => {
            const ownerType = event.payload.ownerType as BillingOwnerType;
            const ownerId = event.payload.ownerId as string;
            if (!BILLING_OWNER_TYPES.includes(ownerType) || !ownerId) return;

            const outcome = await enforcement.reconcileOwner(ownerType, ownerId);
            if (!outcome.enforced) return;
            if (outcome.productsRestored === 0 && outcome.filesReleased === 0) return;

            logger().info(
                {
                    ownerType,
                    ownerId,
                    productsRestored: outcome.productsRestored,
                    filesReleased: outcome.filesReleased,
                },
                'plan quota: released after capacity was freed',
            );
        },
        'PlanQuotaConsumer.onCapacityFreed',
    );

    logger().info('plan-quota enforcement consumer registered');
}
