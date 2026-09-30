import { PaymentGatewayName, PayoutVerifyPayload, PayoutVerifyResult } from '../../payments/gateways/gateway.interface';
import { storedPayoutGateway } from './payout-gateway';

/**
 * The payout reconciliation sweep's decisions, with no I/O — the worker supplies the rows and
 * the two effects. Exported for `test:payout-reconciliation`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A payout in `processing` settles through exactly two paths: the gateway's transfer callback
 * and an administrator. Collections have had a sweep for a dropped callback since Phase 1;
 * payouts had none, so a lost or refused callback (an IP allowlist, a confirm that threw with
 * no retry) left the payout `processing` forever with its hold intact — safe, and stuck. For
 * My-CoolPay, which sends each callback ONCE, that is not an edge case.
 *
 * ── THE THREE RULES ──────────────────────────────────────────────────────────
 * 1. **The STORED gateway, never the settings** (`storedPayoutGateway`). A payout outlives an
 *    administrator switching the payout aggregator; only the gateway that sent it can say what
 *    happened to it. A null means sent before the stamp existed, i.e. through NotchPay.
 * 2. **`verifyPayout` only — never `verifyPayment`.** A collection lookup is the wrong question
 *    on every provider here (see the interface). A gateway without `verifyPayout` is skipped
 *    and counted, never guessed at.
 * 3. **Only a sure verdict moves anything.** SUCCEEDED settles, FAILED / CANCELLED fails — both
 *    through `applyTransferOutcome`, the ONE settlement path the callback also uses, so a
 *    callback landing after the sweep (or before it) resolves the payout exactly once: that
 *    method is a compare-and-set on `processing` and answers null to the loser. Everything else
 *    — PENDING, a transport failure, a record that is not this payout's — leaves the row alone.
 *
 * A FAILED verdict parks the payout in `failed` with the hold KEPT (ADR-024 D-5), exactly like a
 * failed callback: an administrator retries or rejects. Nothing here releases money.
 */

export interface StuckPayout {
    id: string;
    transfer_gateway: PaymentGatewayName | null;
    transfer_reference: string | null;
    /** Required: a payout without the provider's transfer id cannot be asked about. */
    transfer_gateway_ref: string;
}

export interface PayoutVerifier {
    verifyPayout?(payload: PayoutVerifyPayload): Promise<PayoutVerifyResult>;
}

export interface PayoutTransferOutcome {
    settled: boolean;
    gatewayRef: string | null;
    reason: string | null;
}

export interface PayoutReconcileDeps {
    /** The registered adapter for a gateway name, or null when this deployment has none. */
    gatewayFor(name: PaymentGatewayName): PayoutVerifier | null;
    /** `PayoutRequestService.applyTransferOutcome` — null when the row was no longer `processing`. */
    applyTransferOutcome(payoutId: string, outcome: PayoutTransferOutcome): Promise<unknown | null>;
    log?(line: string): void;
}

export interface PayoutReconcileTally {
    checked: number;
    /** Moved to `paid`. */
    settled: number;
    /** Moved to `failed` (hold kept). */
    failed: number;
    /** The gateway gave no sure verdict — left `processing`. */
    pending: number;
    /** A verdict arrived, but the row was already resolved (the callback won the race). */
    alreadyResolved: number;
    /** The row's gateway is unregistered or has no `verifyPayout`. */
    unsupported: number;
    errors: number;
}

export function emptyTally(): PayoutReconcileTally {
    return { checked: 0, settled: 0, failed: 0, pending: 0, alreadyResolved: 0, unsupported: 0, errors: 0 };
}

export async function reconcileStuckPayouts(
    rows: readonly StuckPayout[],
    deps: PayoutReconcileDeps
): Promise<PayoutReconcileTally> {
    const tally = emptyTally();
    const log = deps.log ?? (() => undefined);

    for (const row of rows) {
        tally.checked += 1;
        const gatewayName = storedPayoutGateway(row);
        try {
            const adapter = deps.gatewayFor(gatewayName);
            if (!adapter?.verifyPayout) {
                tally.unsupported += 1;
                log(`payout ${row.id}: ${gatewayName} cannot be asked about a payout (no verifyPayout) — left processing`);
                continue;
            }

            const verdict = await adapter.verifyPayout({
                gatewayRef: row.transfer_gateway_ref,
                reference: row.transfer_reference,
            });

            const outcome = outcomeFor(verdict, row, gatewayName);
            if (!outcome) {
                tally.pending += 1;
                if (verdict.inconclusive) log(`payout ${row.id}: left processing — ${verdict.inconclusive}`);
                continue;
            }

            const applied = await deps.applyTransferOutcome(row.id, outcome);
            if (!applied) {
                tally.alreadyResolved += 1;
                continue;
            }
            if (outcome.settled) tally.settled += 1;
            else tally.failed += 1;
        } catch (error) {
            // One bad row must not stop the batch.
            tally.errors += 1;
            log(`payout ${row.id}: reconcile failed — ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return tally;
}

// ─────────────────────────────────────────────────────────────────────────────
// The manual exit — an administrator resolves a transfer nobody can ask about
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May an administrator resolve this payout's transfer by hand, right now? Pure; exported for
 * `test:payout-reconciliation`.
 *
 * The case it exists for: the transfer POST timed out or threw after the claim, so the payout
 * is `processing` with no provider transfer id — the sweep cannot ask about it (My-CoolPay has
 * no lookup by our reference) and `markPaid` / `reject` refuse `processing` by design. Without
 * this, such a payout had no exit at all. It is not limited to rows without a transfer id: a
 * row whose gateway cannot be asked (no `verifyPayout`) or keeps answering inconclusively needs
 * the same way out.
 *
 * Two refusals, and the second is the one that matters:
 *   - `not_processing` — anything else already has an exit (`markPaid`, `reject`, a retry).
 *   - `too_recent` — quieter than the sweep's MIN_AGE. A callback may still be in flight, and
 *     an administrator racing it is how a payout gets decided twice. The floor is the SAME
 *     setting the sweep uses, so "the sweep would not ask yet" and "you may not decide yet"
 *     cannot drift apart. Measured from `updated_at`, as the sweep's own filter is: the claim
 *     into `processing` sets it, and every later write while `processing` (the gateway ref,
 *     the "outcome unknown" note) only moves it LATER — never from `created_at`, which would
 *     let a payout requested days ago be resolved a second after its transfer was sent.
 */
export type ManualResolveRefusal =
    | { kind: 'not_processing'; status: string }
    | { kind: 'too_recent'; settleAfter: Date };

export function manualResolveRefusal(
    row: { status: string; updated_at: Date },
    now: Date,
    minAgeMinutes: number
): ManualResolveRefusal | null {
    if (row.status !== 'processing') return { kind: 'not_processing', status: row.status };
    const settleAfter = new Date(row.updated_at.getTime() + minAgeMinutes * 60_000);
    if (now < settleAfter) return { kind: 'too_recent', settleAfter };
    return null;
}

/**
 * A verdict → the outcome `applyTransferOutcome` takes, or null for "leave it".
 *
 * Only SUCCEEDED, FAILED and CANCELLED are verdicts. Every other status — PENDING, INITIATED, a
 * REFUNDED that has no meaning for a transfer — is not, and an unrecognised one is ignorance
 * rather than failure. Pure; exported for the test.
 */
export function outcomeFor(
    verdict: PayoutVerifyResult,
    row: Pick<StuckPayout, 'transfer_gateway_ref'>,
    gatewayName: PaymentGatewayName
): PayoutTransferOutcome | null {
    const gatewayRef = verdict.gatewayRef ?? row.transfer_gateway_ref;
    if (verdict.status === 'SUCCEEDED') {
        return { settled: true, gatewayRef, reason: null };
    }
    if (verdict.status === 'FAILED' || verdict.status === 'CANCELLED') {
        return {
            settled: false,
            gatewayRef,
            reason: verdict.reason || `${gatewayName} reported the transfer ${verdict.status.toLowerCase()} (reconciliation sweep)`,
        };
    }
    return null;
}
