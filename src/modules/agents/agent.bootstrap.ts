import {
  setDeviceLocationProvider,
  SelfReportedDeviceLocationProvider,
} from './ports/device-location.port';
import { agentRepository } from './repositories/agent.repository';
import { AGENT_CONFIG } from './config/agent.config';

/**
 * initializeAgentDomain — wires the domain's swappable pieces at startup.
 *
 * This is the composition point for the geo-tracker seam. Today the only
 * device-location signal is the agent's own self-report, so that provider is
 * installed. When geo-tracker ships its reporter, replace the provider HERE —
 * nothing in the eligibility rules, services or controllers changes.
 *
 * Called from server.ts alongside the other startup registrations.
 */
export function initializeAgentDomain(): void {
  setDeviceLocationProvider(
    new SelfReportedDeviceLocationProvider((agentId) => agentRepository.findById(agentId))
  );

  console.log(
    `[AgentDomain] Initialized (device-location: self_reported, require: ${AGENT_CONFIG.REQUIRE_DEVICE_LOCATION}, unknown-policy: ${AGENT_CONFIG.UNKNOWN_DEVICE_LOCATION_POLICY})`
  );

  // A required device-location rule with no observer would deny every agent.
  // Warn loudly rather than let dispatch quietly stop.
  if (AGENT_CONFIG.REQUIRE_DEVICE_LOCATION && AGENT_CONFIG.UNKNOWN_DEVICE_LOCATION_POLICY === 'deny') {
    console.warn(
      '[AgentDomain] AGENT_REQUIRE_DEVICE_LOCATION=true with unknown-policy=deny — agents whose device has never reported location will be INELIGIBLE for assignment. This is only safe once geo-tracker reports device state.'
    );
  }
}
