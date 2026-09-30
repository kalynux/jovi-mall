import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ActorRef } from '../../../core/types/actor-source.types';
import { EARNINGS_CONFIG } from '../config/earnings.config';
import { manualResolveRefusal } from '../domain/payout-reconciliation';
import { IPayoutRequest } from '../models/payout-request.model';
import { payoutRequestService } from './payout-request.service';

/**
 * The manual exit for a payout whose transfer outcome is UNKNOWN (ADR-024, 2026-09-30).
 *
 * ── The gap it closes ────────────────────────────────────────────────────────
 * A transfer POST that times out or throws after the claim leaves the payout `processing` —
 * deliberately, because the money may have moved (see `sendPayout`). Until now that was a dead
 * end: `markPaid` and `reject` refuse `processing` so that nobody races a transfer, the
 * reconciliation sweep needs the provider's transfer id to ask about it, and the callback may
 * never come. This lets an administrator who has checked the provider's own records decide it.
 *
 * ── One settlement path ──────────────────────────────────────────────────────
 * Both outcomes go through `applyTransferOutcome`, exactly as a transfer callback does:
 *   paid    → the balance is debited and the payout settles, in one transaction
 *   failed  → `failed` with the hold KEPT (ADR-024 D-7), so it can be retried or rejected
 * That method is a compare-and-set on `processing`, so a callback or a sweep landing at the same
 * moment resolves it exactly once, and the loser here gets a 409 rather than a double settlement.
 *
 * ── What this side does NOT decide ───────────────────────────────────────────
 * Who may call it, and whether a large 'paid' needs a second administrator, are wi-admin's —
 * where the tier and the approval queue are. The service token is a full-privilege credential;
 * this side owns the state machine and the timing floor, which are the same for every caller.
 */
export interface ResolveUnknownTransferInput {
    outcome: 'paid' | 'failed';
    reason: string;
    evidence?: string | null;
}

export class PayoutResolutionService {
    constructor(
        private readonly payouts = payoutRequestService,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async resolveUnknownTransfer(
        payoutRequestId: string,
        input: ResolveUnknownTransferInput,
        actor: ActorRef,
    ): Promise<IPayoutRequest> {
        const row = await this.payouts.getById(payoutRequestId);
        if (!row) throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_FOUND, 404);

        const refusal = manualResolveRefusal(row, this.now(), EARNINGS_CONFIG.PAYOUT_RECONCILE_MIN_AGE_MINUTES);
        if (refusal?.kind === 'not_processing') {
            throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_NOT_PROCESSING, 409, undefined, {
                status: refusal.status,
            });
        }
        if (refusal?.kind === 'too_recent') {
            // The sweep's own settling window: a callback may still be on its way.
            throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT, 409, undefined, {
                settleAfter: refusal.settleAfter.toISOString(),
                minAgeMinutes: EARNINGS_CONFIG.PAYOUT_RECONCILE_MIN_AGE_MINUTES,
            });
        }

        const note = input.evidence ? `${input.reason} (evidence: ${input.evidence})` : input.reason;

        /**
         * `source: administrator` changes two things and no money: the ticket names the person
         * and what they relied on, and a settlement stamps THEM on `resolved_by` (source
         * `admin`) rather than the platform — nothing reported this transfer done; a person
         * judged it.
         */
        const applied = await this.payouts.applyTransferOutcome(
            payoutRequestId,
            {
                settled: input.outcome === 'paid',
                gatewayRef: row.transfer_gateway_ref ?? null,
                reason: input.outcome === 'failed'
                    ? `Transfer outcome was unknown; an administrator recorded it as failed: ${input.reason}`
                    : null,
            },
            { kind: 'administrator', actor, note },
        );

        if (!applied) {
            // A callback or the sweep resolved it between the read and the write.
            const current = await this.payouts.getById(payoutRequestId);
            throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_NOT_PROCESSING, 409, undefined, {
                status: current?.status ?? null,
            });
        }
        return applied;
    }
}

export const payoutResolutionService = new PayoutResolutionService();
