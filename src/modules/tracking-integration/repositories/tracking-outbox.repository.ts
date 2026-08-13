import { randomUUID } from 'crypto';
import { currentRequestContext } from '../../../core/logging/request-context';
import {
  AgentActionKind,
  AgentActionOutcome,
  ITrackingOutbox,
  ShipmentTerminalStatus,
  TrackingEventType,
  TrackingOutboxModel,
} from '../models/tracking-outbox.model';

export interface EnqueueInput {
  type: TrackingEventType;
  shipmentId?: string | null;
  agentId?: string | null;
  agencyId?: string | null;
  customerId?: string | null;
  // Per-shipment tracking-session signals: whether THIS shipment is trackable,
  // and its outcome if this change ended it. Together they open and close the
  // shipment's tracking session in geo-tracker.
  shipmentTrackable?: boolean | null;
  shipmentTerminal?: ShipmentTerminalStatus | null;
  // Aggregate backstop: whether the agent has ANY active shipment left.
  agentHasActiveShipment?: boolean | null;
  // Agent-level tracking permission (Phase 9). Gates the LIVE POSITION, not a session.
  trackingAllowed?: boolean | null;
  // Agent-action audit fields (Phase 6).
  action?: AgentActionKind | null;
  outcome?: AgentActionOutcome | null;
  actorRole?: string | null;
  reason?: string | null;
  occurredAt?: Date;
}

/**
 * Data access for the tracking outbox. Enqueue is called by the event
 * subscriber; the claim/mark methods are called by the dispatch worker.
 */
export class TrackingOutboxRepository {
  async enqueue(input: EnqueueInput): Promise<ITrackingOutbox> {
    return TrackingOutboxModel.create({
      event_id: randomUUID(),
      type: input.type,
      shipment_id: input.shipmentId ?? null,
      agent_id: input.agentId ?? null,
      agency_id: input.agencyId ?? null,
      customer_id: input.customerId ?? null,
      shipment_trackable: input.shipmentTrackable ?? null,
      shipment_terminal: input.shipmentTerminal ?? null,
      agent_has_active_shipment: input.agentHasActiveShipment ?? null,
      tracking_allowed: input.trackingAllowed ?? null,
      action: input.action ?? null,
      outcome: input.outcome ?? null,
      actor_role: input.actorRole ?? null,
      reason: input.reason ?? null,
      occurred_at: input.occurredAt ?? new Date(),
      status: 'pending',
      attempts: 0,
      last_error: null,
      /**
       * Read from the ambient request context HERE rather than threaded through every caller
       * (Phase 15).
       *
       * Same reasoning as generating the tracking number inside `ShipmentRepository.create`: a
       * fourth enqueue site added later cannot forget it. It is null for anything a worker
       * enqueues, which is correct — a sweep is not a request.
       */
      request_id: currentRequestContext()?.requestId ?? null,
    });
  }

  /** Oldest pending rows first, bounded by limit. */
  async findPending(limit: number): Promise<ITrackingOutbox[]> {
    return TrackingOutboxModel.find({ status: 'pending' })
      .sort({ created_at: 1 })
      .limit(limit)
      .exec();
  }

  async markSent(id: string): Promise<void> {
    await TrackingOutboxModel.updateOne(
      { _id: id },
      { $set: { status: 'sent' } }
    ).exec();
  }

  /** Record a failed attempt; park the row as `failed` once attempts hit max. */
  async markAttemptFailed(id: string, attempts: number, error: string, maxAttempts: number): Promise<void> {
    await TrackingOutboxModel.updateOne(
      { _id: id },
      {
        $set: {
          attempts,
          last_error: error.slice(0, 500),
          status: attempts >= maxAttempts ? 'failed' : 'pending',
        },
      }
    ).exec();
  }

  /**
   * Queue depth, for `GET /api/internal/admin/system/queues` and the metrics collector.
   *
   * ── Index discipline, which is the part that matters at scale ─────────────
   * The only index on this collection is `{status: 1, created_at: 1}` — see the model. So:
   *
   *  - the status counts and the oldest-pending timestamp come from ONE `$group` on `status`,
   *    which the index prefix covers;
   *  - the per-type breakdown **matches on status first**, so it too rides that prefix.
   *    Grouping on `type` across all statuses would be a collection scan over a collection that
   *    is overwhelmingly `sent` rows.
   *
   * ⚠ Related, and deliberately not fixed here: **nothing ever prunes `sent` rows.** They
   * accumulate forever, so every unbounded scan over this collection gets slower with age. A
   * retention sweep is the right fix and belongs to its own change.
   */
  async depthSummary(maxAttempts: number): Promise<OutboxDepthSummary> {
    const [statusRows, typeRows, stuckPending, exhausted] = await Promise.all([
      TrackingOutboxModel.aggregate<{ _id: string; count: number; oldest: Date | null }>([
        { $group: { _id: '$status', count: { $sum: 1 }, oldest: { $min: '$created_at' } } },
      ]).exec(),

      TrackingOutboxModel.aggregate<{ _id: { type: string; status: string }; count: number }>([
        // `$match` FIRST — this is what keeps the pipeline on the index prefix.
        { $match: { status: { $in: ['pending', 'failed'] } } },
        { $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 } } },
      ]).exec(),

      // Should always be 0. A pending row that has already exhausted its attempts means the
      // dispatcher's parking logic did not run — a different fault from a backlog.
      TrackingOutboxModel.countDocuments({ status: 'pending', attempts: { $gte: maxAttempts } }),
      TrackingOutboxModel.countDocuments({ status: 'failed', attempts: { $gte: maxAttempts } }),
    ]);

    const byStatus: Record<string, number> = { pending: 0, sent: 0, failed: 0 };
    let oldestPendingAt: Date | null = null;
    for (const row of statusRows) {
      byStatus[row._id] = row.count;
      if (row._id === 'pending') oldestPendingAt = row.oldest ?? null;
    }

    const byType = new Map<string, { type: string; pending: number; failed: number }>();
    for (const row of typeRows) {
      const entry = byType.get(row._id.type) ?? { type: row._id.type, pending: 0, failed: 0 };
      if (row._id.status === 'pending') entry.pending = row.count;
      else entry.failed = row.count;
      byType.set(row._id.type, entry);
    }

    return {
      byStatus,
      oldestPendingAt,
      oldestPendingAgeSeconds: oldestPendingAt
        ? Math.floor((Date.now() - oldestPendingAt.getTime()) / 1000)
        : null,
      maxAttempts,
      stuckPending,
      exhausted,
      byType: [...byType.values()].sort((a, b) => b.pending - a.pending),
    };
  }
}

export interface OutboxDepthSummary {
  byStatus: Record<string, number>;
  oldestPendingAt: Date | null;
  oldestPendingAgeSeconds: number | null;
  maxAttempts: number;
  /** Pending AND out of attempts — should be 0; non-zero means the parking logic did not run. */
  stuckPending: number;
  exhausted: number;
  byType: Array<{ type: string; pending: number; failed: number }>;
}
