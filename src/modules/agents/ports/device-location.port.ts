import { IDeliveryAgent } from '../models/agent.model';

/**
 * Device-location signal — the one assignment input jovi-mall cannot observe.
 *
 * Whether an agent's phone actually has location services on is knowable only
 * to something talking to that phone. Today nothing does; when geo-tracker
 * lands it will report device state (see the internal API), and later it may
 * answer live from its own connection registry.
 *
 * This port exists so the eligibility rule never learns which of those is true.
 * The rule asks the port; the composition root decides who answers. Swapping in
 * geo-tracker must not touch AgentEligibilityService.
 *
 * ── The tri-state contract ──────────────────────────────────────────────────
 *
 *   true  — reported ON
 *   false — reported OFF
 *   null  — UNKNOWN: never reported, or the provider is unreachable
 *
 * `null` is not `false`, and conflating them is the trap this interface exists
 * to prevent: defaulting unknown→false would make every agent ineligible the
 * moment geo-tracker went down, halting dispatch platform-wide. How `null` is
 * treated is a policy decision that belongs to config
 * (AGENT_CONFIG.UNKNOWN_DEVICE_LOCATION_POLICY), never to a provider.
 */
export interface IAgentDeviceLocationProvider {
  /** Stable name for diagnostics and eligibility explanations. */
  readonly name: string;

  /** Tri-state. Must resolve `null` rather than throw when unreachable. */
  isDeviceLocationEnabled(agentId: string): Promise<boolean | null>;

  /**
   * Batch form for dispatch screens resolving many agents at once.
   * Implementations without a batch API may loop; callers must not assume
   * every requested id appears in the result.
   */
  isDeviceLocationEnabledBatch(agentIds: string[]): Promise<Map<string, boolean | null>>;
}

/**
 * Default provider: the agent's own last self-report, persisted on the agent
 * document by the mobile app.
 *
 * Self-reported data is weaker evidence than geo-tracker's observation — an app
 * can claim location is on while sending nothing — which is exactly why this is
 * a provider and not inlined logic. Replacing it later is a wiring change.
 */
export class SelfReportedDeviceLocationProvider implements IAgentDeviceLocationProvider {
  readonly name = 'self_reported';

  constructor(private readonly loadAgent: (agentId: string) => Promise<IDeliveryAgent | null>) {}

  async isDeviceLocationEnabled(agentId: string): Promise<boolean | null> {
    const agent = await this.loadAgent(agentId);
    if (!agent) return null;
    return this.readSignal(agent);
  }

  async isDeviceLocationEnabledBatch(agentIds: string[]): Promise<Map<string, boolean | null>> {
    const result = new Map<string, boolean | null>();
    await Promise.all(
      agentIds.map(async (id) => {
        result.set(id, await this.isDeviceLocationEnabled(id));
      })
    );
    return result;
  }

  /**
   * A denied OS permission is a definitive "off" regardless of what the
   * services toggle says — the app cannot read location either way.
   */
  private readSignal(agent: IDeliveryAgent): boolean | null {
    if (agent.device?.location_permission === 'denied') return false;
    return agent.device?.location_services_enabled ?? null;
  }
}

/**
 * Always-unknown provider. Use where no signal source exists at all; keeps the
 * eligibility rule on its documented `null` path rather than special-casing a
 * missing provider.
 */
export class NullDeviceLocationProvider implements IAgentDeviceLocationProvider {
  readonly name = 'null';

  async isDeviceLocationEnabled(): Promise<boolean | null> {
    return null;
  }

  async isDeviceLocationEnabledBatch(agentIds: string[]): Promise<Map<string, boolean | null>> {
    return new Map(agentIds.map((id) => [id, null]));
  }
}

/**
 * Registry holding the active provider.
 *
 * Mirrors the storage module's factory/singleton approach rather than
 * introducing a DI container the codebase does not use. When geo-tracker ships
 * its reporter, call `setDeviceLocationProvider()` once at startup — no rule,
 * service, or controller changes.
 */
let activeProvider: IAgentDeviceLocationProvider = new NullDeviceLocationProvider();

export function setDeviceLocationProvider(provider: IAgentDeviceLocationProvider): void {
  activeProvider = provider;
}

export function getDeviceLocationProvider(): IAgentDeviceLocationProvider {
  return activeProvider;
}
