import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import { IDeliveryAgent } from '../../models/agent.model';
import { AGENT_CONFIG, ACTIVE_SHIPMENT_STATUSES } from '../../config/agent.config';
import { ShipmentModel } from '../../../shipments/shipment.model';
import { eventBus } from '../../../../core/events/event-bus';

/**
 * AgentCapacityService — how many shipments an agent can hold at once.
 *
 * **Capacity is global, not sub-allocated.** Unlike the COD threshold (a pool
 * agencies draw slices from), capacity is a single agent-level cap shared
 * across every agency. There is no agency-side capacity setting: one agent has
 * one pair of hands, and an agent full with agency A's work cannot absorb
 * agency B's. Only `max_active_shipments` and the current in-use count matter,
 * whoever the shipment came from.
 *
 * ── Why a counter, not a derived count ──────────────────────────────────────
 *
 * The earlier design derived the in-flight count from the shipment collection,
 * on the reasoning that a counter drifts. That reasoning was right about drift
 * and wrong about the priority: you cannot atomically check-and-increment a
 * value you compute. Two concurrent assignments would both count 2 of 3, both
 * conclude there was room, and both commit — over-committing the agent with no
 * error anywhere.
 *
 * So the counter is authoritative for admission control (one conditional
 * `$inc`, see AgentRepository.tryReserveCapacity), and `reconcile()` corrects
 * drift from the shipments themselves. Both properties, in the right order.
 */
export class AgentCapacityService {
  constructor(private readonly agents: AgentRepository = agentRepository) {}

  // ─── Admission control ────────────────────────────────────────────────────

  /**
   * Atomically take a capacity slot. Returns false when the agent is full.
   *
   * MUST be called inside the same transaction as the assignment write. If the
   * assignment later aborts, the reservation rolls back with it; reserving
   * outside the transaction would leak a slot on every failed assignment.
   */
  async tryReserve(agentId: string, session?: ClientSession): Promise<boolean> {
    const reserved = await this.agents.tryReserveCapacity(agentId, session);
    return reserved !== null;
  }

  /**
   * Take a slot or throw, with the numbers that explain the refusal.
   *
   * Note the re-read on failure is only for the error payload — the decision was
   * already made atomically. It is not a second check.
   */
  async reserveOrThrow(agentId: string, session?: ClientSession): Promise<void> {
    const ok = await this.tryReserve(agentId, session);
    if (ok) return;

    const agent = await this.agents.findById(agentId, session);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    throw createAppError(ERROR_CODES.AGENT_AT_CAPACITY, 422, undefined, {
      activeShipmentCount: agent.capacity?.active_shipment_count ?? 0,
      maxActiveShipments: agent.capacity?.max_active_shipments ?? 0,
    });
  }

  /**
   * Give a slot back.
   *
   * Every path that removes a shipment from an agent's active set must call
   * this — delivered, cancelled, failed-and-returned, and reassigned away. A
   * path that forgets doesn't fail loudly; it silently eats a slot of that
   * agent's capacity forever, and the only symptom is an agent who mysteriously
   * stops receiving work. `reconcile()` is the backstop, not the answer.
   */
  async release(agentId: string, reason: CapacityReleaseReason, session?: ClientSession): Promise<void> {
    const released = await this.agents.releaseCapacity(agentId, session);

    if (!released) {
      // Counter already at zero: a double-release, or drift. Not fatal — the
      // guard did its job — but worth surfacing, because it means some path is
      // releasing twice and the counter may be under-reporting.
      console.warn(
        `[AgentCapacityService] release(${reason}) for agent ${agentId} found counter already at 0 — possible double-release or drift`
      );
      return;
    }

    void eventBus
      .publish('agent.capacity_released', {
        eventType: 'agent.capacity_released',
        aggregateId: agentId,
        occurredAt: new Date(),
        payload: {
          agentId,
          reason,
          activeShipmentCount: released.capacity?.active_shipment_count ?? 0,
        },
      })
      .catch((err) => console.error('[AgentCapacityService] capacity emit failed:', err));
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  /**
   * The agent sets their own ceiling.
   *
   * Lowering below what they are already carrying is rejected: those shipments
   * exist, and a cap beneath reality would describe a state the system cannot
   * produce. They finish the work first.
   */
  async setMaxActiveShipments(agentId: string, max: number): Promise<IDeliveryAgent> {
    if (
      !Number.isInteger(max) ||
      max < AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MIN ||
      max > AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX
    ) {
      throw createAppError(ERROR_CODES.AGENT_CAPACITY_OUT_OF_BOUNDS, 422, undefined, {
        requested: max,
        min: AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MIN,
        max: AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX,
      });
    }

    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const inUse = agent.capacity?.active_shipment_count ?? 0;
    if (max < inUse) {
      throw createAppError(ERROR_CODES.AGENT_CAPACITY_BELOW_IN_USE, 422, undefined, {
        requested: max,
        activeShipmentCount: inUse,
        hint: 'Complete or hand back shipments before lowering the limit this far.',
      });
    }

    const updated = await this.agents.setMaxActiveShipments(agentId, max);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    return updated;
  }

  // ─── Reads & reconciliation ───────────────────────────────────────────────

  hasCapacity(agent: IDeliveryAgent): boolean {
    const max = agent.capacity?.max_active_shipments ?? AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_DEFAULT;
    return (agent.capacity?.active_shipment_count ?? 0) < max;
  }

  /**
   * Recount from the shipments themselves and correct the counter.
   *
   * The counter is authoritative for admission control but not for truth: a
   * crash between the shipment write and the release, or a path that forgets to
   * release, leaves it wrong. This restores it. Run it nightly, and after any
   * incident.
   */
  async reconcile(agentId: string): Promise<{ before: number; after: number; drifted: boolean }> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const before = agent.capacity?.active_shipment_count ?? 0;
    const actual = await ShipmentModel.countDocuments({
      agent_id: agentId,
      status: { $in: ACTIVE_SHIPMENT_STATUSES },
    });

    if (actual !== before) {
      await this.agents.setActiveShipmentCount(agentId, actual);
      console.warn(
        `[AgentCapacityService] capacity drift for agent ${agentId}: counter=${before} actual=${actual} — corrected`
      );
    } else {
      await this.agents.setActiveShipmentCount(agentId, actual);
    }

    return { before, after: actual, drifted: actual !== before };
  }

  async reconcileAll(): Promise<{ checked: number; corrected: number }> {
    const ids = await this.agents.listAllIds();
    let corrected = 0;
    for (const id of ids) {
      const result = await this.reconcile(id);
      if (result.drifted) corrected++;
    }
    return { checked: ids.length, corrected };
  }
}

/** Why a slot was given back — every one of these must release. */
export type CapacityReleaseReason =
  | 'delivered'
  | 'cancelled'
  | 'reassigned'
  | 'returned'
  | 'rejected'
  | 'admin_correction';

export const agentCapacityService = new AgentCapacityService();
