import { ShipmentAssignmentOfferModel } from '../models/shipment-assignment-offer.model';
import { ShipmentAssignmentSessionModel } from '../models/shipment-assignment-session.model';

/**
 * How far behind the assignment sweep is.
 *
 * ── Why this is worth an endpoint at all ──────────────────────────────────────
 * `AssignmentSweepWorker` is the ONLY thing that advances an auto-assignment session to the
 * next candidate and the only thing that expires a manual offer nobody answered. If it stops,
 * nothing throws and nothing logs: shipments simply sit on offer forever and agencies wonder
 * why nobody is picking anything up. Until this phase that state was invisible from every angle
 * in the system — the worker was not even in the registry.
 *
 * `dueSessions` is the number that matters. A session whose `frontier_at` has passed and which
 * is still `active` is one the sweep should already have advanced. In a healthy system it is
 * near zero on any given tick; sustained non-zero means the sweep is dead, wedged, or slower
 * than its own interval.
 *
 * This lives in the shipment-assignment module rather than in `system/` on purpose — the system
 * module must not reach into another module's collections, and "due" is this module's notion.
 */

export interface AssignmentBacklog {
    /** `active` sessions whose frontier window has elapsed and which have not advanced. */
    dueSessions: number;
    /** How long the most overdue one has been waiting. Null when nothing is due. */
    oldestDueSessionAgeSeconds: number | null;
    activeSessions: number;
    /** Manual offers past `expires_at` that are still `pending`. */
    dueManualOffers: number;
    oldestDueOfferAgeSeconds: number | null;
    pendingOffers: number;
}

export class AssignmentBacklogRepository {
    async summary(now: Date = new Date()): Promise<AssignmentBacklog> {
        const [dueSessions, oldestDueSession, activeSessions, dueOffers, oldestDueOffer, pendingOffers] =
            await Promise.all([
                ShipmentAssignmentSessionModel.countDocuments({
                    status: 'active',
                    frontier_at: { $ne: null, $lte: now },
                }),
                ShipmentAssignmentSessionModel.findOne({
                    status: 'active',
                    frontier_at: { $ne: null, $lte: now },
                })
                    .sort({ frontier_at: 1 })
                    .select('frontier_at')
                    .lean<{ frontier_at: Date } | null>(),
                ShipmentAssignmentSessionModel.countDocuments({ status: 'active' }),

                // Manual only. Auto offers deliberately never expire on timeout — an ignored
                // agent keeps an acceptable offer and the session drives the broadcast — so
                // counting them here would report a permanent, meaningless backlog.
                ShipmentAssignmentOfferModel.countDocuments({
                    status: 'pending',
                    origin: 'manual',
                    expires_at: { $lte: now },
                }),
                ShipmentAssignmentOfferModel.findOne({
                    status: 'pending',
                    origin: 'manual',
                    expires_at: { $lte: now },
                })
                    .sort({ expires_at: 1 })
                    .select('expires_at')
                    .lean<{ expires_at: Date } | null>(),
                ShipmentAssignmentOfferModel.countDocuments({ status: 'pending' }),
            ]);

        return {
            dueSessions,
            oldestDueSessionAgeSeconds: oldestDueSession
                ? Math.floor((now.getTime() - oldestDueSession.frontier_at.getTime()) / 1000)
                : null,
            activeSessions,
            dueManualOffers: dueOffers,
            oldestDueOfferAgeSeconds: oldestDueOffer
                ? Math.floor((now.getTime() - oldestDueOffer.expires_at.getTime()) / 1000)
                : null,
            pendingOffers,
        };
    }
}

export const assignmentBacklogRepository = new AssignmentBacklogRepository();
