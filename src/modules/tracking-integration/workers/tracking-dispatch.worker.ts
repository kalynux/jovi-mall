import crypto from 'crypto';
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
export class TrackingDispatchWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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

  /** Drain one batch. Guarded so ticks never overlap. Safe to call manually. */
  async drainOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.outbox.findPending(TRACKING_INTEGRATION_CONFIG.DISPATCH_BATCH_SIZE);
      for (const row of pending) {
        await this.deliver(row);
      }
    } catch (error) {
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

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TRACKING_INTEGRATION_CONFIG.REQUEST_TIMEOUT_MS);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Node-Signature': signature },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (resp.status >= 200 && resp.status < 300) {
        await this.outbox.markSent(row._id.toString());
        return;
      }
      await this.fail(row, `geo-tracker returned ${resp.status}`);
    } catch (error) {
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
    console.error(`[TrackingDispatchWorker] Delivery failed for ${row.event_id} (attempt ${attempts}): ${reason}`);
  }
}

export const trackingDispatchWorker = new TrackingDispatchWorker();
