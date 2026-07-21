import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import { IDeliveryAgent, IAgentDeviceCapabilities } from '../../models/agent.model';
import { eventBus } from '../../../../core/events/event-bus';

export interface ReportDeviceCapabilitiesInput {
  platform?: IAgentDeviceCapabilities['platform'];
  app_version?: string | null;
  location_permission?: IAgentDeviceCapabilities['location_permission'];
  location_services_enabled?: boolean | null;
  background_location_enabled?: boolean | null;
  battery_optimization_exempt?: boolean | null;
  push_enabled?: boolean | null;
}

/**
 * AgentDeviceService — what the agent's device can do.
 *
 * Two writers, and the difference matters:
 *
 *   the mobile app  — self-reports its own capabilities. Weak evidence: an app
 *                     can claim location is enabled while streaming nothing.
 *   geo-tracker     — reports what it actually observes. Stronger, and the
 *                     reason IAgentDeviceLocationProvider exists.
 *
 * Both land in the same fields, so `reported_at` and the provider name are how
 * a stale or self-serving report is spotted. Capability data is deliberately
 * tri-state throughout: `null` means never reported and must never be coerced
 * to `false` — see the port for why that distinction protects dispatch.
 */
export class AgentDeviceService {
  constructor(private readonly agents: AgentRepository = agentRepository) {}

  /** Self-report from the agent's app. */
  async reportCapabilities(agentId: string, input: ReportDeviceCapabilitiesInput): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const previousLocation = this.readLocationSignal(agent);

    const updated = await this.agents.updateDeviceCapabilities(agentId, input);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    this.emitIfLocationChanged(agentId, previousLocation, this.readLocationSignal(updated), 'self_reported');
    return updated;
  }

  /**
   * Report from geo-tracker. Same storage, distinct source label — a caller
   * inspecting device state should be able to tell who last spoke.
   */
  async reportFromTracker(
    agentId: string,
    input: { locationServicesEnabled?: boolean | null; backgroundLocationEnabled?: boolean | null }
  ): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const previousLocation = this.readLocationSignal(agent);

    const updated = await this.agents.updateDeviceCapabilities(agentId, {
      ...(input.locationServicesEnabled !== undefined
        ? { location_services_enabled: input.locationServicesEnabled }
        : {}),
      ...(input.backgroundLocationEnabled !== undefined
        ? { background_location_enabled: input.backgroundLocationEnabled }
        : {}),
    });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    this.emitIfLocationChanged(agentId, previousLocation, this.readLocationSignal(updated), 'geo_tracker');
    return updated;
  }

  async getCapabilities(agentId: string): Promise<IAgentDeviceCapabilities> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    return agent.device;
  }

  /**
   * The effective location signal, tri-state.
   *
   * A denied OS permission is a definitive "off" whatever the services toggle
   * claims — the app cannot read location either way, so trusting the toggle
   * alone would mark an unusable device as ready.
   */
  readLocationSignal(agent: IDeliveryAgent): boolean | null {
    if (agent.device?.location_permission === 'denied') return false;
    return agent.device?.location_services_enabled ?? null;
  }

  private emitIfLocationChanged(
    agentId: string,
    from: boolean | null,
    to: boolean | null,
    source: string
  ): void {
    if (from === to) return;
    void eventBus
      .publish('agent.device_location_changed', {
        eventType: 'agent.device_location_changed',
        aggregateId: agentId,
        occurredAt: new Date(),
        payload: { agentId, from, to, source },
      })
      .catch((err) => console.error('[AgentDeviceService] device location emit failed:', err));
  }
}

export const agentDeviceService = new AgentDeviceService();
