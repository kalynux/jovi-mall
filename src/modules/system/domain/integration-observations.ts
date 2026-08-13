import { integrationCallsTotal, integrationDuration } from '../metrics/metrics';
import { IntegrationKey } from './integration-catalog';

/**
 * What real traffic already learned about each integration.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Most of the providers in `integration-catalog.ts` cannot be safely probed — a health check
 * against Stripe is an authenticated call on a live merchant account, and against WhatsApp it is
 * a message to a person. But "cannot probe" does not have to mean "cannot know": the platform
 * calls every one of these constantly in the course of ordinary work, and each of those calls
 * already knows whether it succeeded.
 *
 * So instead of asking, we remember. Every outbound call reports its outcome here, and
 * `/system/integrations` reports the last one with its timestamp. The operator gets a real
 * answer — "Stripe: ok, 40 seconds ago" — at zero cost and with no side effect, which is
 * strictly better than what a probe could have told them anyway.
 *
 * The tradeoff is honest and is stated on the wire: an integration nothing has called since the
 * process started reports `null`, meaning "no traffic yet", not "down".
 *
 * ── This is also the metrics call site ────────────────────────────────────────
 * One helper feeds both the in-memory map and the Prometheus counters, so a caller cannot
 * instrument one and forget the other.
 */

export type CallOutcome = 'ok' | 'error' | 'timeout';

export interface LastOutcome {
    outcome: CallOutcome;
    at: string;
    latencyMs: number;
    error: string | null;
}

const lastOutcomes = new Map<IntegrationKey, LastOutcome>();

/**
 * Record one outbound call. Call it in a `finally`, so a throw is recorded too.
 *
 * Never throws: an observation that can break the operation it observes is a liability.
 */
export function recordIntegrationCall(
    provider: IntegrationKey,
    startedAt: number,
    error?: unknown,
): void {
    try {
        const latencyMs = Date.now() - startedAt;
        const outcome: CallOutcome = !error
            ? 'ok'
            : isTimeout(error) ? 'timeout' : 'error';

        lastOutcomes.set(provider, {
            outcome,
            at: new Date().toISOString(),
            latencyMs,
            error: error ? messageOf(error) : null,
        });

        integrationCallsTotal.inc({ provider, outcome });
        integrationDuration.observe({ provider }, latencyMs / 1000);
    } catch {
        /* observation must never break the call it observes */
    }
}

export function lastOutcomeFor(provider: IntegrationKey): LastOutcome | null {
    return lastOutcomes.get(provider) ?? null;
}

function isTimeout(error: unknown): boolean {
    const message = messageOf(error).toLowerCase();
    return message.includes('timeout') || message.includes('etimedout') || message.includes('aborted');
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

/** Test seam. */
export function __resetIntegrationObservations(): void {
    lastOutcomes.clear();
}
