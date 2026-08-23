import { Router } from 'express';
import { requireAdminCaller } from '../middlewares/admin-caller.middleware';
import { buildAdminCodRouter } from '../../modules/cod/admin-cod.routes';
import { buildAdminUserRouter } from '../../modules/users/admin-user.routes';
import { buildAdminAgentRouter } from '../../modules/agents/routes/admin-agent.routes';
import { buildAdminAgencyRouter } from '../../modules/delivery/admin-agency.routes';
import { buildAdminVendorRouter } from '../../modules/vendors/admin-vendor.routes';
import { buildAdminOrderRouter } from '../../modules/orders/admin-order.routes';
import { buildAdminShipmentRouter } from '../../modules/shipments/admin-shipment.routes';
import { buildAdminBillingRouter } from '../../modules/billing/routes/admin-billing.routes';
import { buildAdminEarningsRouter } from '../../modules/earnings/routes/admin-earnings.routes';
import { buildAdminPayoutRequestsRouter } from '../../modules/earnings/routes/admin-payout-requests.routes';
import { buildAdminDevToolsRouter } from '../../modules/dev-tools/admin-dev-tools.routes';
import { buildAdminSystemRouter } from '../../modules/system/admin-system.routes';
import { buildAdminTicketRouter } from '../../modules/tickets';
import { buildAdminFileRouter } from '../../modules/catalog/routes/admin-file.routes';
import { buildAdminMessagingRouter } from '../../modules/telegram/admin-messaging.routes';
import { buildAdminReviewRouter } from '../../modules/reviews/routes/admin-review.routes';

/**
 * `/api/internal/admin/*` — the service-to-service surface the **wi-admin** backend calls.
 *
 * Consumed by wi-admin only, authenticated by a shared service token
 * (`INTERNAL_ADMIN_SERVICE_TOKEN` here === `JOVI_MALL_SERVICE_TOKEN` there). No user
 * session is involved: wi-admin is a service, and the administrator who asked is carried
 * in headers rather than impersonated. Disabled entirely when the secret is unset — the
 * guard fails closed, so an unconfigured deploy exposes nothing.
 *
 * ── Why this exists rather than wi-admin writing the database ─────────────────
 * The logic behind these operations is shared with the agency, agent, vendor and customer
 * paths and with five background workers, and every write is a transaction paired with a
 * post-commit event emission. A second process could reproduce the transaction and would
 * still miss the events — silently. So wi-admin calls in and lets this service execute,
 * which is also what makes the in-process subscribers fire. See
 * `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md` D-2.
 *
 * ── What is here, and what is coming ──────────────────────────────────────────
 * Phase 4 mounted COD alone — it is the domain whose invariants are hardest to reproduce
 * (FIFO settlement, guarded compare-and-set on cash balances) and therefore the one worth
 * proving the transport against. `/users` follows with the user-management phase, and
 * `/agents` + `/agencies` with the delivery network at Phase 9, and `/orders` +
 * `/shipments` with the commerce phase at Phase 10. Phase 11 added `/billing`,
 * `/earnings` and `/payout-requests`, and the dashboard-request round added `/files`.
 * Phase 17 added `/tickets`, and Phase 5 finished the list: Part A took the blog — which
 * MOVED to wi-admin rather than landing here, so there is deliberately no `/articles`
 * mount — Part B added the two file housekeeping routes to `/files`, and Part C added
 * `/messaging`. **Nothing is still to come.** With `/messaging` mounted, the legacy
 * endpoint map is empty and this is the whole administrative surface.
 *
 * The public `/api/admin/*` mounts stay live alongside these until cutover (Phase 8), so
 * the dashboard keeps working while endpoints migrate one at a time. `/users` is the
 * exception with no public twin — the domain never had one.
 */
const router = Router();

router.use('/cod', buildAdminCodRouter([requireAdminCaller]));

/**
 * Developer tools (Phase 12) — the one mount here that is not a domain.
 *
 * Everything behind it re-runs a side effect against live data: a background worker, a
 * replay of failed outbound events, a rebuild of the catalogue's search vectors. They live
 * on this side because the workers and the outbox are in THIS process, and they are
 * reachable only through the service token — `developer_tools.*` is tier-1-only and that
 * decision is made in wi-admin, which also writes the audit row.
 *
 * There is deliberately no public `/api/admin/dev-tools` twin. These are not dashboard
 * endpoints and must never become reachable from a browser session.
 */
router.use('/dev-tools', buildAdminDevToolsRouter([requireAdminCaller]));

/**
 * System operations (Phase 14) — the READ half of the same idea, deliberately on its own mount.
 *
 * Everything here is a GET and nothing here is audited. The split from `/dev-tools` above is
 * the brief's own rule made structural: read-only diagnostics and dangerous operations are
 * different mounts with different permissions on the wi-admin side, so a route cannot drift
 * from one category into the other by being added to the wrong file.
 *
 * These are delegated rather than read out of `jovi_mall` for the ordinary reason (ADR-009
 * D-1): every answer is a verdict about THIS PROCESS — which cron tasks exist and whether one
 * is mid-sweep, which Redis connections are open, a private in-memory metrics registry, the
 * effective maintenance mode. None of it is in a collection, and none of it would be true if
 * wi-admin recomputed it.
 */
router.use('/system', buildAdminSystemRouter([requireAdminCaller]));

/**
 * Users — writes only. wi-admin reads `users` directly (ADR-004 D-2); what it cannot do
 * directly is suspend an account, because a suspension is only real by virtue of the
 * checks in `requireAuth`, `login` and the refresh rotation, which live here.
 */
router.use('/users', buildAdminUserRouter([requireAdminCaller]));

/**
 * The delivery network (Phase 9) — every write, plus the three reads whose answer is a
 * VERDICT rather than a record.
 *
 * wi-admin reads `delivery_agents`, `delivery_agencies`, `agent_agency_contracts`,
 * `agent_membership_events` and `agency_magazins` directly; what it delegates is
 * `tracking-policy`, `cod-allocation` and `eligibility`, because those are answers the
 * platform itself acts on and a second implementation would drift from this one. The full
 * rule is ADR-008 D-1.
 *
 * Both routers carry their reads as well, so `attachRoutes` stays the single declaration —
 * unused internal surface is cheaper than a second copy of the route table.
 */
router.use('/agents', buildAdminAgentRouter([requireAdminCaller]));
router.use('/agencies', buildAdminAgencyRouter([requireAdminCaller]));

/**
 * Vendors — writes only, for the same reason as users. What wi-admin cannot do directly
 * is suspend one: that takes the vendor's whole catalogue off sale inside the transaction
 * that moves their status, and the restore has to re-run the activation gate on every
 * listing rather than blindly republish it. A second writer would reproduce the status
 * change and miss all of it.
 */
router.use('/vendors', buildAdminVendorRouter([requireAdminCaller]));

/**
 * Orders (Phase 10) — the two legacy dispute endpoints plus four new capabilities.
 *
 * The only router here that keeps a PUBLIC twin: `/api/admin/orders` still serves the
 * dispute queue to a live dashboard. The `'internal'` scope is what adds cancel, dispatch,
 * refund and refund-eligibility, and they are deliberately absent from the public mount —
 * a refund moves money through a payment gateway, and `requireRole(['admin'])` on a
 * platform `users` row is a credential that predates wi-admin's permission catalog and
 * knows nothing about `orders.refund` being tier-2-only.
 *
 * wi-admin reads `orders` and `order_timelines` directly; these four are delegated because
 * each is a transaction paired with post-commit effects — a cancellation notifies the
 * customer and the vendor, a dispatch mints shipments and notifies the agency, a refund
 * calls a gateway and reverses escrow.
 */
router.use('/orders', buildAdminOrderRouter([requireAdminCaller], 'internal'));

/**
 * Shipments (Phase 10) — writes only, and net-new: there has never been an
 * `/api/admin/shipments` surface at all.
 *
 * Both operations resolve the owning agency FROM THE SHIPMENT and then run the ordinary
 * agency-scoped path, so the assignment rules, the compare-and-set and the geo-tracker
 * outbox emission are the same code the agency desk runs. That is also why these cannot
 * be done from wi-admin directly: a reassignment closes a tracking session through an
 * outbox row, and a second writer would move the agent and leave the session open.
 */
router.use('/shipments', buildAdminShipmentRouter([requireAdminCaller]));

/**
 * Money (Phase 11) — billing, earnings and payouts, the three routers that still had no
 * internal mount. All keep their public twin until cutover.
 *
 * ── The read split here is finer than anywhere else on this router ────────────
 * wi-admin reads the finance RECORDS directly out of `jovi_mall`: the earnings ledger and
 * allocations, payout request rows, plan and subscription rows, credit transactions, the
 * COD cash ledger, gateway settlements. Append-only rows are records, and a second reader
 * of a record costs nothing.
 *
 * What it delegates is the DERIVATIONS, and there are only three:
 *
 *   /earnings/balances/:ownerType/:ownerId   four sub-balances only this service's
 *                                            transactions move
 *   /earnings/accounts                       the same, ranked across owners
 *   /billing/entitlements/:ownerType/:ownerId what an owner's plan actually permits
 *
 * Each is a number the platform itself branches on, and a copy of the arithmetic in
 * wi-admin would be a second opinion about how much money exists or what a vendor may do.
 * That is ADR-009 D-1 — delegate a verdict, read a record — applied to money, and it
 * amends ADR-004's Money and Billing rows, which said "HTTP" for reads across the board.
 *
 * Every WRITE is delegated as before: assigning a plan emits `plan.activated`, which
 * resizes agent capacity in-process; marking a payout paid debits `requested_balance`
 * under a guarded compare-and-set, resolves a ticket and emits `payout.paid`. A second
 * writer would reproduce the balance move and miss all of it.
 */
/**
 * Support tickets (Phase 17) — the first mount here with **no public twin**.
 *
 * Every other router on this file runs beside a live `/api/admin/*` mount that keeps the
 * legacy dashboard working until cutover. Tickets could not: the old mount's only admin
 * access control was the `assigned_admin_id` exclusivity lock — auto-set on an
 * administrator's first action, then 403 to everybody else including Developers — and that
 * lock is deleted. Keeping the mount without it would leave a second admin ticket surface
 * with no access rules, and it could not be given the new ones either, because the tier
 * matrix needs a tier and a legacy `admin` is a platform user without one.
 *
 * Delegated rather than written directly by wi-admin for the ordinary reason (ADR-004 D-2),
 * and here the reason is unusually concrete: jovi-mall creates tickets in-process from the
 * payout, dispute and booking-refund paths, and every ticket write publishes on the
 * in-process event bus (`ticket.created`, `ticket.assigned`, `ticket.status_changed`,
 * `ticket.priority_changed`). A second writer would move the row and notify nobody.
 */
router.use('/tickets', buildAdminTicketRouter([requireAdminCaller]));

router.use('/billing', buildAdminBillingRouter([requireAdminCaller]));
router.use('/earnings', buildAdminEarningsRouter([requireAdminCaller]));
router.use('/payout-requests', buildAdminPayoutRequestsRouter([requireAdminCaller]));

/**
 * Files — three routes now, and they answer two different questions.
 *
 * `POST /resolve` exists because a URL cannot cross the service boundary as an id.
 * wi-admin ships `logoFileId` / `avatarFileId` / `bannerFileId` / `deliveryProofFileId`
 * as opaque ids and states that it "resolves no file URLs" (ADR-009 D-6), which is the
 * right call — building one means `storage.getPublicUrl(key)`, and that means a second
 * copy of `STORAGE_PROVIDER` in a second deployment. But its contract then told the
 * dashboard to resolve them "against jovi-mall", and the dashboard talks to wi-admin
 * and to nothing else. So every avatar and logo on the admin surface rendered as a
 * placeholder. This is the door that was missing, on the side that owns the provider.
 * Batch and bounded at 100, matching wi-admin's page ceiling. It resolves ids the
 * caller already holds; it does not enumerate.
 *
 * `GET /orphans` and `DELETE /:id/permanent` are the housekeeping pair, moved here from
 * the public `/api/files` router at Phase 5 Part B — they were its only two
 * `requireRole(['admin'])` routes. **The handlers did not move**, and their in-handler
 * `role !== 'admin'` checks are satisfied by `requireAdminCaller` rather than made wrong
 * by it, so they stay as a second lock on an unrecoverable delete. wi-admin gates them
 * on `files.orphans.read` and `files.delete`, both tier-1-only, and adds the
 * confirmation and the key-withholding projection on its own side.
 */
router.use('/files', buildAdminFileRouter([requireAdminCaller]));

/**
 * Messaging (Phase 5 Part C) — one route, and the last legacy admin endpoint anywhere.
 *
 * `POST /api/webhooks/telegram/send` was an admin-only capability sitting on a
 * public-looking webhook prefix, guarded by `requireRole(['admin'])` on a platform `users`
 * row. It is gone; this is where it lives now, behind the service token and wi-admin's
 * `messaging.telegram.send`. The family was renamed from `broadcast` there because nothing
 * about it fans out: one message, one recipient, no delivery record.
 *
 * ⚠ Two side effects of the move that are invisible in a diff (Phase 5 C-6), stated at the
 * factory in full: the send became **unconditionally** maintenance-exempt by landing on
 * this prefix — losing the per-window `blockWebhooks` off switch it used to have — and
 * this service's rate limiter stopped applying to it, because `internal_service` is exempt
 * in both policies. wi-admin's identity-scoped limiter is what bounds an operator now.
 */
router.use('/messaging', buildAdminMessagingRouter([requireAdminCaller]));

/**
 * Review moderation (Phase 6 Step 10) — net-new, and the second mount here with no
 * public twin (after `/tickets`) because the surface it moderates did not exist
 * before the cutover.
 *
 * Delegated rather than written directly by wi-admin for the ordinary reason
 * (ADR-004 D-2), and here it is unusually concrete: a moderation verdict is a
 * compare-and-set on `pending` **plus** a recompute of every aggregate the review
 * contributes to **plus**, for a delivery review, an immediate trust recompute of the
 * agent — which after Phase 6 Step 11 moves that agent's COD cash limit. A second
 * writer would flip `status` in `reviews` and leave all of that unfired, silently,
 * with the storefront's rating and the agent's trust score both stale and nothing
 * anywhere reporting it.
 *
 * wi-admin may read `reviews` and `review_aggregates` directly for a report; it calls
 * in to decide one. Same read-a-record / delegate-a-verdict split as ADR-009 D-1.
 */
router.use('/reviews', buildAdminReviewRouter([requireAdminCaller]));

export default router;
