import { ClientSession } from 'mongoose';
import { ShipmentStatus } from '../../shipments/shipment.model';
import { TrackingOutboxRepository } from '../repositories/tracking-outbox.repository';
import { visibleAgentsService } from './visible-agents.service';

/**
 * TrackingOutboxEmitter — turns a domain fact into a tracking outbox row, inside the
 * transaction that produced the fact.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE EVENT BUS (plan step 3.A.1, X-1) ──────────────
 * This logic used to live in `TrackingEventSubscriber`, reached over the in-memory event bus.
 * Two properties of that route made the outbox's crash-durability promise false:
 *
 *   1. The bus **cannot carry a Mongo session**, so the row was necessarily written after the
 *      state change had already committed. A crash in that window lost the event permanently.
 *   2. `EventBus.publish` **catches and logs every handler error**, so a failed enqueue was
 *      invisible — the one hop with no retry was also the one hop with no alarm.
 *
 * So the write sites now call these methods directly, passing their session. The
 * `eventBus.publish` calls stay exactly where they were: `shipment.status_changed` has two
 * other consumers (customer notifications, assignment) that are genuinely best-effort, and
 * nothing about them changes.
 *
 * ── THE VERDICTS ARE COMPUTED HERE, IN THE SOURCE OF TRUTH ────────────────────────────
 * Each event carries three tracking verdicts, computed here because geo-tracker has no
 * shipment model and must never grow one:
 *
 *   shipmentTrackable      — is THIS shipment being tracked? OPENS/CLOSES its tracking
 *                            session (one session per shipment).
 *   shipmentTerminal       — did THIS shipment end, and how? Closes its session with the
 *                            outcome stamped.
 *   agentHasActiveShipment — does the agent have ANY? A backstop that can close everything
 *                            but open nothing, since it names no shipment.
 *
 * geo-tracker also re-evaluates each watcher on receipt and only drops those who no longer
 * qualify, so emitting on every status change is safe (and keeps caches fresh) — the terminal
 * states are what actually revoke access.
 *
 * ── NOT HERE: `agent.action` ──────────────────────────────────────────────────────────
 * The Phase 6 agent-action audit is deliberately NOT one of these methods. It is a different
 * kind of row — it goes to a different geo-tracker endpoint (`/webhooks/agent-actions`), it
 * carries no session verdicts, and it has its own status→action mapping. It lives in
 * `AgentActionAuditService`, which took the same `session` parameter in the same change.
 */
export class TrackingOutboxEmitter {
  constructor(private readonly outbox: TrackingOutboxRepository = new TrackingOutboxRepository()) {}

  /**
   * A shipment changed status.
   *
   * `status` is the status the change was made FOR — not a re-read of the shipment. A burst of
   * transitions must produce one honest verdict each, or geo-tracker would see (say) `assigned`
   * reported as already delivered.
   */
  async emitShipmentStatusChanged(
    input: {
      shipmentId: string;
      agentId: string | null;
      agencyId: string | null;
      customerId: string | null;
      status: ShipmentStatus;
      occurredAt?: Date;
    },
    session?: ClientSession
  ): Promise<void> {
    const trackability = visibleAgentsService.shipmentTrackability(input.status);
    await this.outbox.enqueue(
      {
        type: 'shipment.status_changed',
        shipmentId: input.shipmentId,
        agentId: input.agentId,
        agencyId: input.agencyId,
        customerId: input.customerId,
        shipmentTrackable: trackability.trackable,
        shipmentTerminal: trackability.terminal,
        agentHasActiveShipment: await this.agentHasActiveShipment(input.agentId, session),
        occurredAt: input.occurredAt ?? new Date(),
      },
      session
    );
  }

  /**
   * Cash was collected on a COD shipment.
   *
   * A COD collection event says cash was taken, not what that made the shipment — so unlike
   * the status-changed path there is no status to pass and it has to be read back. The read
   * takes the session, so it sees the `delivered` this collection caused rather than the
   * status from before it.
   */
  async emitCodCollectionRecorded(
    input: {
      shipmentId: string;
      agentId: string | null;
      agencyId: string | null;
      customerId: string | null;
      occurredAt?: Date;
    },
    session?: ClientSession
  ): Promise<void> {
    const status = await visibleAgentsService.shipmentStatus(input.shipmentId, session);
    const trackability = visibleAgentsService.shipmentTrackability(status);
    await this.outbox.enqueue(
      {
        type: 'cod.collection.recorded',
        shipmentId: input.shipmentId,
        agentId: input.agentId,
        agencyId: input.agencyId,
        customerId: input.customerId,
        shipmentTrackable: trackability.trackable,
        shipmentTerminal: trackability.terminal,
        agentHasActiveShipment: await this.agentHasActiveShipment(input.agentId, session),
        occurredAt: input.occurredAt ?? new Date(),
      },
      session
    );
  }

  /**
   * An agent → agent reassignment released `agentId` from this shipment.
   *
   * It is a per-shipment RELEASE, scoped to the OLD agent and independent of the shipment's
   * resulting status (which may be `handing_over` or a reset `assigned`, both trackable in the
   * abstract but not for this agent any more). So the verdict is forced:
   * `shipmentTrackable=false` (→ geo-tracker `ReleaseShipment(agent, shipment)`),
   * `shipmentTerminal=null` (a release, not a terminal — a fresh session opens when the
   * replacement agent accepts). The aggregate backstop is still computed honestly for the
   * released agent.
   *
   * Note the row's `type` stays `shipment.status_changed`: geo-tracker branches on the
   * verdicts, not on a release-specific event type, and inventing one would be an event-shape
   * change for no gain.
   */
  async emitAgentReleased(
    input: {
      shipmentId: string;
      agentId: string;
      agencyId: string | null;
      customerId: string | null;
      occurredAt?: Date;
    },
    session?: ClientSession
  ): Promise<void> {
    await this.outbox.enqueue(
      {
        type: 'shipment.status_changed',
        shipmentId: input.shipmentId,
        agentId: input.agentId,
        agencyId: input.agencyId,
        customerId: input.customerId,
        shipmentTrackable: false,
        shipmentTerminal: null,
        agentHasActiveShipment: await this.agentHasActiveShipment(input.agentId, session),
        occurredAt: input.occurredAt ?? new Date(),
      },
      session
    );
  }

  /**
   * An administrator changed `tracking.allowed` (Phase 9).
   *
   * ── Why this event exists at all ──────────────────────────────────────────
   * It was published from the day the flag was, and nothing subscribed to it. So the admin
   * switch was enforced on ONE side: `assertEligible` refused to dispatch a new shipment,
   * while geo-tracker — which had never been told — went on recording the agent's position and
   * broadcasting it to every watcher. Nothing else covered the gap: `visible-agents` does not
   * consult the flag either, so even geo-tracker's revocation sweep would have kept every
   * watcher on re-check. An administrator pressing "disable tracking" changed strictly less
   * than the button claimed.
   *
   * ── Why it carries no shipment verdicts ───────────────────────────────────
   * All three are left null, and that is the point rather than an omission. This event says
   * nothing about any shipment, and geo-tracker treats a null verdict as "not reported" — so
   * revoking tracking suppresses the agent's GPS without closing a delivery that jovi-mall
   * still considers in flight. Ending a shipment is a decision only jovi-mall makes, and it is
   * not the decision that was made here.
   *
   * ── Why the caller checks `previous !== allowed`, not this method ──────────
   * The write site emits only on a real change, so a repeated write of the same value does not
   * enqueue. The reconcile sweep (`TrackingAllowReconcileWorker`, plan step 3.A.3) is the one
   * deliberate exception — it re-emits an UNCHANGED value on purpose, because its whole job is
   * to re-deliver a decision that may never have arrived.
   */
  async emitTrackingAllowChanged(
    input: {
      agentId: string;
      allowed: boolean;
      reason?: string | null;
      actorRole?: string | null;
      occurredAt?: Date;
    },
    session?: ClientSession
  ): Promise<void> {
    if (!input.agentId) return;
    await this.outbox.enqueue(
      {
        type: 'agent.tracking_allow_changed',
        agentId: input.agentId,
        trackingAllowed: input.allowed,
        reason: input.reason ?? null,
        actorRole: input.actorRole ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      },
      session
    );
  }

  /**
   * The agent's aggregate active-shipment verdict — geo-tracker's backstop against a lost
   * per-shipment terminal event. Computed from the same trackable-status policy that drives
   * agency visibility, so the rule lives once, in the source of truth. null when the event has
   * no agent — there is nothing to attribute it to.
   *
   * The session is what makes this honest inside a transaction: see the note on
   * `VisibleAgentsService.agentHasActiveShipment`.
   */
  private async agentHasActiveShipment(
    agentId: string | null,
    session?: ClientSession
  ): Promise<boolean | null> {
    if (!agentId) return null;
    return visibleAgentsService.agentHasActiveShipment(agentId, session);
  }
}

export const trackingOutboxEmitter = new TrackingOutboxEmitter();
