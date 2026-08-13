import { TRACKING_INTEGRATION_CONFIG } from '../../tracking-integration/config/tracking-integration.config';
import {
    OutboxDepthSummary,
    TrackingOutboxRepository,
} from '../../tracking-integration/repositories/tracking-outbox.repository';
import {
    AssignmentBacklog,
    assignmentBacklogRepository,
} from '../../shipment-assignment/repositories/assignment-backlog.repository';

/**
 * `GET /api/internal/admin/system/queues`.
 *
 * ── There are exactly two queues, and one of them is the interesting one ──────
 * The **tracking outbox** is the obvious one: a durable buffer with a status column and a
 * dispatcher draining it. wi-admin can already read it directly out of `jovi_mall`, so the
 * value added here is the derived part — oldest-pending age, the per-type split, and the
 * `stuckPending` count that should always be zero.
 *
 * The **assignment backlog** is the one nothing reported before, and it is more operationally
 * urgent: a stalled assignment sweep leaves shipments sitting on offer indefinitely with no
 * error anywhere. See `shipment-assignment/repositories/assignment-backlog.repository.ts`.
 *
 * Nothing else in this service qualifies. The event bus is in-process with no depth (it awaits
 * its handlers inline), and notifications are written directly rather than queued.
 */

const outboxRepository = new TrackingOutboxRepository();

export interface QueueReport {
    trackingOutbox: OutboxDepthSummary & {
        /** Inert with `GEO_TRACKER_BASE_URL` unset: the outbox fills and nothing drains it. */
        dispatcherEnabled: boolean;
    };
    assignment: AssignmentBacklog;
    note: string;
}

export async function describeQueues(): Promise<QueueReport> {
    const [outbox, assignment] = await Promise.all([
        outboxRepository.depthSummary(TRACKING_INTEGRATION_CONFIG.MAX_ATTEMPTS),
        assignmentBacklogRepository.summary(),
    ]);

    return {
        trackingOutbox: {
            ...outbox,
            dispatcherEnabled: Boolean(TRACKING_INTEGRATION_CONFIG.GEO_TRACKER_BASE_URL),
        },
        assignment,
        // Said on the wire because it matters exactly when this endpoint is unreachable.
        note:
            'wi-admin also reads the tracking outbox directly from jovi_mall at '
            + 'GET /api/v1/system/outbox. That read keeps working when this service does not — '
            + 'use it when this endpoint is the thing that is down.',
    };
}

/** The narrow slice the Prometheus collector needs. Kept separate so a scrape stays cheap. */
export async function outboxDepthForMetrics(): Promise<{
    byStatus: Record<string, number>;
    oldestPendingAgeSeconds: number | null;
}> {
    const summary = await outboxRepository.depthSummary(TRACKING_INTEGRATION_CONFIG.MAX_ATTEMPTS);
    return {
        byStatus: summary.byStatus,
        oldestPendingAgeSeconds: summary.oldestPendingAgeSeconds,
    };
}
