import { createSubscriberBillingController } from './subscriber-billing.controller';

/**
 * Agent billing endpoints — plan discovery, current plan (the active plan drives
 * the agent's `capacity.max_active_shipments`), credit balance, top-ups, settings.
 * Mounted at `/api/agent`. The agent's live active-shipment count is served by the
 * agent domain (working state), so no usage block is merged here.
 */
export const AgentBillingController = createSubscriberBillingController('agent');
