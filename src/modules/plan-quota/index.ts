/**
 * plan-quota — enforcing plan limits after the fact, not only at creation time.
 *
 * Plan limits used to bind on two `POST` endpoints and nowhere else, so a downgrade
 * changed nothing: a vendor dropping from unlimited products and 100 GB to fifteen and
 * 1 GB kept every product live and every byte served. This module is the recount.
 *
 * **Nothing is deleted.** Products past the allowance are suspended
 * (`plan_quota_exceeded`, the fifth disjoint suspension reason) and files past it are
 * blocked (`File.quotaBlockedAt` → `access: 'quota_blocked'`, `url: null`). Both are
 * reversible and both come back, unchanged, oldest-first, when the owner upgrades or
 * frees room.
 *
 * ── Where this module sits, and why it is its own module ─────────────────────────
 * It reaches into billing (for the limits) AND catalog (for products and files), which
 * is a direction neither of those may take: catalog already imports billing for
 * `assertCanAddProduct`, so putting the sweep in billing would close a cycle. Nothing
 * imports this module except `lifecycle.ts`, which is what keeps the graph acyclic.
 *
 * The gates that REFUSE a write (create, duplicate, unarchive, bulk activate) are not
 * here — they stay in catalog, calling billing's `assertCanAddProducts`. This module
 * only ever reacts; it never sits on a request path.
 */
export { PLAN_QUOTA_CONFIG } from './config/plan-quota.config';
export { PlanQuotaStateModel, IPlanQuotaState } from './models/plan-quota-state.model';
export {
    PlanQuotaEnforcementService,
    planQuotaEnforcementService,
    PlanQuotaOutcome,
} from './domain/services/plan-quota-enforcement.service';
export { PlanQuotaReconcileWorker, planQuotaReconcileWorker } from './workers/plan-quota-reconcile.worker';
export { registerPlanQuotaConsumer } from './events/plan-quota.consumer';
export {
    QuotaCandidate,
    QuotaPlan,
    planCountCutoff,
    planSizeCutoff,
} from './domain/quota-cutoff';
