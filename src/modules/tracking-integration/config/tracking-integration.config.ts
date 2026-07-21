/**
 * Configuration for the live-tracking integration with the geo-tracker
 * service (Project B). This module is the ONLY outbound bridge from jovi-mall
 * to geo-tracker: it emits shipment-lifecycle events so geo-tracker can
 * revoke an agency's/customer's live-location access the moment a shipment
 * finishes.
 *
 * When GEO_TRACKER_BASE_URL is unset the integration is inert — the outbox is
 * still written but the dispatcher no-ops, so a deployment without geo-tracker
 * runs unaffected.
 */
export const TRACKING_INTEGRATION_CONFIG = Object.freeze({
  /** geo-tracker base URL, e.g. http://localhost:8090. Empty ⇒ integration disabled. */
  GEO_TRACKER_BASE_URL: process.env.GEO_TRACKER_BASE_URL || '',

  /** Path geo-tracker exposes for inbound tracking webhooks. */
  WEBHOOK_PATH: '/webhooks/node',

  /** Path geo-tracker exposes for the agent-action audit (Phase 6). A sibling of
   *  WEBHOOK_PATH; `agent.action` outbox rows are POSTed here instead. */
  AGENT_ACTIONS_PATH: '/webhooks/agent-actions',

  /** Shared secret used to HMAC-sign every outbound webhook body. Must match
   *  geo-tracker's WEBHOOK_HMAC_SECRET. */
  WEBHOOK_HMAC_SECRET: process.env.GEO_TRACKER_WEBHOOK_SECRET || '',

  /** Dispatcher poll interval (ms) and batch size. */
  DISPATCH_INTERVAL_MS: parseInt(process.env.GEO_TRACKER_DISPATCH_INTERVAL_MS || '2000'),
  DISPATCH_BATCH_SIZE: parseInt(process.env.GEO_TRACKER_DISPATCH_BATCH_SIZE || '50'),

  /** Max delivery attempts before an outbox row is parked as `failed`. */
  MAX_ATTEMPTS: parseInt(process.env.GEO_TRACKER_MAX_ATTEMPTS || '10'),

  /** Per-request timeout (ms) for the webhook POST. */
  REQUEST_TIMEOUT_MS: parseInt(process.env.GEO_TRACKER_REQUEST_TIMEOUT_MS || '5000'),
});

/** True when a geo-tracker endpoint is configured to receive events. */
export function trackingIntegrationEnabled(): boolean {
  return TRACKING_INTEGRATION_CONFIG.GEO_TRACKER_BASE_URL !== '';
}
