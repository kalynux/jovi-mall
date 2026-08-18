import { WebhookRefusal } from './webhook-verification';

/**
 * What happened to a gateway callback, and what we answer.
 *
 * ── WHY THE STATUS CODE IS A DESIGN DECISION AND NOT A DETAIL ────────────────
 * Every branch of both mobile-money routes used to answer **200**, including
 * the catch. To a gateway, 200 means "handled, stop retrying" — so a
 * confirmation dropped by a database blip, a bug, or a restart mid-request was
 * acknowledged as delivered and never sent again. The customer's money moved
 * and their order stayed unpaid, with no error anywhere.
 *
 * The retry is not a nuisance to be suppressed; for mobile money it is the
 * primary healing mechanism, because a USSD confirmation arrives minutes after
 * the request that started it and the customer has usually closed the page.
 *
 * ── STRIPE'S 200-AFTER-VERIFICATION DOES NOT GENERALISE ──────────────────────
 * The Stripe route answers 200 when a *verified* event fails to process, with a
 * written justification: the signature passed, so the event is authentic, and a
 * poison payload would otherwise retry forever.
 *
 * That reasoning applies to a payload we can never process, not to one that
 * failed today. So the split here is on the ERROR, not on the gateway: a 4xx
 * (business-rule, malformed, already-settled) is permanent and answers 2xx; a
 * 5xx or an unrecognised throw is transient and answers 500 so the gateway
 * comes back. Answering 200 to a transient fault is the exact bug above.
 *
 * This module is pure so `test:payments` can assert the whole table without
 * standing up HTTP.
 */
export type WebhookOutcome =
  /** Verified, matched a transaction or billing row, applied. */
  | { kind: 'processed'; detail?: string }
  /** Verified, and this exact event id has been seen before. */
  | { kind: 'duplicate' }
  /** Verified, and names nothing we hold. Possibly another system's. */
  | { kind: 'unknown_transaction' }
  /** Verified, and carries no status or event type we act on. */
  | { kind: 'ignored'; detail?: string }
  /**
   * Verified, and the reported money disagrees with our snapshot.
   * Not retryable — the gateway resending the same figures changes nothing —
   * so it answers 2xx, and it is logged loudly because it is a security event.
   */
  | { kind: 'amount_mismatch'; detail?: string }
  /** Failed authentication. */
  | { kind: 'refused'; reason: WebhookRefusal }
  /** Verified, and processing threw. `retryable` decides 2xx vs 5xx. */
  | { kind: 'processing_failed'; retryable: boolean; detail?: string };

export interface WebhookResponse {
  status: number;
  body: { success: boolean; message: string };
}

/**
 * The whole status-code policy, in one place.
 *
 * Note the response body uses `message`, never a key named `error`: the
 * `no-restricted-syntax` ESLint selector matches `error` anywhere in a
 * `res.json()` object literal, and these handlers deliberately answer
 * themselves rather than delegating to the global error handler — because the
 * exact status is what drives the gateway's retry, and the global handler does
 * not know that.
 */
export function decideWebhookResponse(outcome: WebhookOutcome): WebhookResponse {
  switch (outcome.kind) {
    case 'processed':
      return { status: 200, body: { success: true, message: outcome.detail ?? 'Webhook processed' } };

    case 'duplicate':
      // A genuine redelivery. Retrying changes nothing, so acknowledge it.
      return { status: 200, body: { success: true, message: 'Webhook already processed (duplicate)' } };

    case 'unknown_transaction':
      // Deliberately 2xx. Sandbox keys are shared across environments and one
      // gateway account can serve several deployments, so a callback for
      // somebody else's transaction is expected traffic — not an error, and
      // certainly not something to make the gateway retry forever.
      return {
        status: 200,
        body: { success: true, message: 'Transaction not found (may be from a different system)' },
      };

    case 'ignored':
      return { status: 200, body: { success: true, message: outcome.detail ?? 'Event ignored' } };

    case 'amount_mismatch':
      return {
        status: 200,
        body: { success: false, message: 'Reported amount does not match the recorded payment' },
      };

    case 'refused':
      return refusalResponse(outcome.reason);

    case 'processing_failed':
      return outcome.retryable
        ? {
            status: 500,
            // 5xx so the gateway retries. This is the branch that used to be a
            // 200 and silently ate confirmations.
            body: { success: false, message: 'Temporary failure processing webhook — please retry' },
          }
        : {
            status: 200,
            // Permanent. Retrying sends the same bytes and gets the same answer,
            // so acknowledging it is the honest response; the failure is in our
            // logs and the reconciliation sweep is the safety net.
            body: { success: false, message: 'Webhook verified but could not be applied' },
          };
  }
}

function refusalResponse(reason: WebhookRefusal): WebhookResponse {
  switch (reason) {
    case 'missing_secret':
      // 503, not 401: the caller did nothing wrong — WE are not configured to
      // verify anyone. It is deliberately not "skip verification when
      // unconfigured", which is precisely the shape of the bug this replaced.
      return {
        status: 503,
        body: { success: false, message: 'Gateway webhook verification is not configured' },
      };

    case 'unparsable':
      return { status: 400, body: { success: false, message: 'Malformed webhook body' } };

    case 'missing_signature':
      return { status: 401, body: { success: false, message: 'Missing webhook signature' } };

    case 'bad_signature':
    case 'wrong_application':
      // One answer for both, on purpose. Telling an unauthenticated caller
      // which of the two checks they failed tells them whether they guessed our
      // application id correctly, which is free information for the next try.
      return { status: 401, body: { success: false, message: 'Invalid webhook signature' } };

    case 'untrusted_source':
      return { status: 403, body: { success: false, message: 'Webhook source not permitted' } };
  }
}
