import crypto from 'crypto';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { recordIntegrationCall } from '../../system/domain/integration-observations';
import { outboxDispatchedTotal, recordWorkerRun } from '../../system/metrics/metrics';
import { TrackingOutboxRepository } from '../repositories/tracking-outbox.repository';
import { ITrackingOutbox } from '../models/tracking-outbox.model';
import { TRACKING_INTEGRATION_CONFIG, trackingIntegrationEnabled } from '../config/tracking-integration.config';

/**
 * TrackingDispatchWorker drains the tracking outbox and delivers each event to
 * geo-tracker's webhook, HMAC-signed, with at-least-once semantics (geo-tracker
 * dedups on event_id). It polls on a short interval — unlike the daily
 * escrow/cleanup sweeps, revocation must propagate in seconds — but is inert
 * when no geo-tracker endpoint is configured.
 *
 * Uses setInterval rather than node-cron because the cadence is sub-minute.
 */
export class TrackingDispatchWorker implements ObservableWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  get schedules(): WorkerSchedule[] {
    return [{
      kind: 'interval',
      everyMs: TRACKING_INTEGRATION_CONFIG.DISPATCH_INTERVAL_MS,
      source: 'GEO_TRACKER_DISPATCH_INTERVAL_MS',
    }];
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  /**
   * Here `running` genuinely means "a pass is in flight" — the opposite of what the same field
   * name means in the two booking sweeps. That collision is why nothing reports a bare
   * `running` any more. See `ObservableWorker`.
   */
  get executing(): boolean {
    return this.running;
  }

  /**
   * Inert with `GEO_TRACKER_BASE_URL` unset — the outbox still fills and nothing dispatches,
   * which is the intended local default. Reporting it is the point: without this an operator
   * reads "Tracking outbox dispatch — every 2 seconds" on a deploy where it has never run once.
   */
  get enabled(): boolean {
    return trackingIntegrationEnabled();
  }

  constructor(private readonly outbox: TrackingOutboxRepository = new TrackingOutboxRepository()) {}

  start(): void {
    if (this.timer) {
      console.log('[TrackingDispatchWorker] Already started');
      return;
    }
    if (!trackingIntegrationEnabled()) {
      console.log('[TrackingDispatchWorker] GEO_TRACKER_BASE_URL not set — dispatcher inert');
      return;
    }
    this.timer = setInterval(() => {
      if (maintenanceBlocksWorkers()) return;
      void this.drainOnce();
    }, TRACKING_INTEGRATION_CONFIG.DISPATCH_INTERVAL_MS);
    console.log(
      `[TrackingDispatchWorker] Started (every ${TRACKING_INTEGRATION_CONFIG.DISPATCH_INTERVAL_MS}ms → ${TRACKING_INTEGRATION_CONFIG.GEO_TRACKER_BASE_URL})`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drain one batch. Guarded so ticks never overlap — now across INSTANCES too (F-19).
   *
   * This worker already had the in-process half of the guard, which is why it was not in the
   * finding. What it did not have is the other half: `findPending` is a plain read with no atomic
   * claim on the rows it returns, so two instances draining concurrently both fetch the same
   * outbox rows and both POST them. geo-tracker dedups on `eventId` so nothing breaks, but the
   * webhook traffic doubles and a failure count is attributed twice.
   *
   * Short TTL, deliberately: at a 2-second cadence a lock stranded by a hard kill must not stall
   * dispatch for the default ten minutes — a stalled dispatcher is the one whose silent death
   * leaves geo-tracker broadcasting a delivered shipment's position.
   */
  async drainOnce(): Promise<boolean> {
    const outcome = await withWorkerLock('tracking-dispatch', () => this.drain(), { ttlMs: 60_000 });
    return outcome !== SWEEP_SKIPPED;
  }

  private async drain(): Promise<void> {
    this.running = true;
    // Phase 15: `worker_last_success_timestamp_seconds` was declared in Phase 14 and never set,
    // so the documented staleness alert could not fire for the one worker whose silent death
    // leaves geo-tracker broadcasting a delivered shipment's position.
    const startedAt = Date.now();
    let drained = 0;
    try {
      const pending = await this.outbox.findPending(TRACKING_INTEGRATION_CONFIG.DISPATCH_BATCH_SIZE);
      for (const row of pending) {
        await this.deliver(row);
        drained += 1;
      }
      recordWorkerRun('tracking-dispatch', 'scheduled', 'success', (Date.now() - startedAt) / 1000, drained);
    } catch (error) {
      recordWorkerRun('tracking-dispatch', 'scheduled', 'failure', (Date.now() - startedAt) / 1000, drained);
      console.error('[TrackingDispatchWorker] Drain failed:', error);
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: ITrackingOutbox): Promise<void> {
    // Phase 6: agent-action audit events go to their own endpoint with an
    // action-shaped body; everything else is a tracking-permission event on the
    // node webhook. Both are HMAC-signed with the same secret.
    const isAgentAction = row.type === 'agent.action';
    const body = isAgentAction
      ? JSON.stringify({
          eventId: row.event_id,
          agentId: row.agent_id,
          shipmentId: row.shipment_id,
          action: row.action,
          outcome: row.outcome,
          actorRole: row.actor_role,
          reason: row.reason,
          occurredAt: row.occurred_at,
        })
      : JSON.stringify({
          eventId: row.event_id,
          type: row.type,
          shipmentId: row.shipment_id,
          agentId: row.agent_id,
          agencyId: row.agency_id,
          customerId: row.customer_id,
          // Per-shipment tracking-session signals: these open and close the
          // shipment's tracking session in geo-tracker, which has no shipment
          // model of its own. shipmentTerminal is omitted rather than sent as
          // null when absent — geo-tracker reads "" as "did not end".
          shipmentTrackable: row.shipment_trackable,
          ...(row.shipment_terminal ? { shipmentTerminal: row.shipment_terminal } : {}),
          // Aggregate backstop: closes every open session when false.
          agentHasActiveShipment: row.agent_has_active_shipment,
          // Agent-level tracking permission (Phase 9). OMITTED rather than sent as null
          // when absent, for the same reason as shipmentTerminal above: geo-tracker's
          // field is a *bool, and an explicit null on every shipment event would be
          // indistinguishable at the wire from a decision, forcing it to guess. Only the
          // one event type that actually carries a decision sends the key.
          ...(row.tracking_allowed === null ? {} : { trackingAllowed: row.tracking_allowed }),
          occurredAt: row.occurred_at,
        });

    const signature = crypto
      .createHmac('sha256', TRACKING_INTEGRATION_CONFIG.WEBHOOK_HMAC_SECRET)
      .update(body)
      .digest('hex');

    const path = isAgentAction
      ? TRACKING_INTEGRATION_CONFIG.AGENT_ACTIONS_PATH
      : TRACKING_INTEGRATION_CONFIG.WEBHOOK_PATH;
    const url = TRACKING_INTEGRATION_CONFIG.GEO_TRACKER_BASE_URL + path;

    // Feeds `/system/integrations` reachability for geo-tracker and the
    // `jovimall_integration_*` counters. This is the highest-volume outbound call in the
    // service, so it is also the most truthful source of "is geo-tracker answering".
    const startedAt = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TRACKING_INTEGRATION_CONFIG.REQUEST_TIMEOUT_MS);
      const resp = await fetch(url, {
        method: 'POST',
        /**
         * `X-Request-Id` (Phase 15) — one correlation id spanning all three services.
         *
         * Safe and one-repo by construction: the HMAC above is computed over `body` alone, so a
         * header changes no signature, and geo-tracker's router ignores headers it does not
         * name. No Go file is touched.
         *
         * The dispatcher runs on a timer with no ambient request, so the value is the row's own
         * correlation — the request that CAUSED the event, falling back to the event id so the
         * header is never absent.
         */
        headers: {
          'Content-Type': 'application/json',
          'X-Node-Signature': signature,
          'X-Request-Id': row.request_id ?? row.event_id,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (resp.status >= 200 && resp.status < 300) {
        await this.outbox.markSent(row._id.toString());
        recordIntegrationCall('geo_tracker', startedAt);
        outboxDispatchedTotal.inc({ type: row.type, outcome: 'sent' });
        return;
      }
      recordIntegrationCall('geo_tracker', startedAt, new Error(`HTTP ${resp.status}`));
      await this.fail(row, `geo-tracker returned ${resp.status}`);
    } catch (error) {
      recordIntegrationCall('geo_tracker', startedAt, error);
      await this.fail(row, error instanceof Error ? error.message : String(error));
    }
  }

  private async fail(row: ITrackingOutbox, reason: string): Promise<void> {
    const attempts = row.attempts + 1;
    await this.outbox.markAttemptFailed(
      row._id.toString(),
      attempts,
      reason,
      TRACKING_INTEGRATION_CONFIG.MAX_ATTEMPTS
    );
    // `failed` means the row is parked and will not be retried without an operator replaying
    // it; `retry` means the backoff will pick it up. A dashboard that cannot tell those apart
    // cannot tell a transient blip from a permanent stall.
    outboxDispatchedTotal.inc({
      type: row.type,
      outcome: attempts >= TRACKING_INTEGRATION_CONFIG.MAX_ATTEMPTS ? 'failed' : 'retry',
    });
    console.error(`[TrackingDispatchWorker] Delivery failed for ${row.event_id} (attempt ${attempts}): ${reason}`);
  }
}

export const trackingDispatchWorker = new TrackingDispatchWorker();
