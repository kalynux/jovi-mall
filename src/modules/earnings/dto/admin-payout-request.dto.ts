import { IPayoutRequest } from '../models/payout-request.model';
import { PayoutMethodMasked, maskPayoutMethod } from '../../../core/types/payout.types';

/**
 * The admin queue's view of a payout request.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * The admin payout endpoints used to return `r.toObject()` and the raw Mongoose
 * document. `payout_method_snapshot` is a full `IPayoutMethod`, so every response
 * carried the beneficiary's **plaintext mobile-money number or bank account number**.
 * Every owner-facing payout response in this module already maps named fields and
 * emits neither (`payout-request.controller.ts`); the administrator's did not, which
 * is the wrong way round — an operator sees every beneficiary on the platform, not
 * just their own.
 *
 * So: named-field mapping, and the destination goes through `maskPayoutMethod`. The
 * mapper is the lock. There is no branch here that can emit an unmasked value, and no
 * spread of the document that could reintroduce one when a field is added upstream.
 *
 * ── What an administrator loses, and where it went ────────────────────────────
 * Masking to the last four digits is enough to *recognise* a destination and not
 * enough to *send money to* one. The full value is deliberately not on this shape: it
 * is served by wi-admin's `GET /api/v1/money/payouts/:id/destination`, gated on its
 * own permission and written to the audit trail on every read. A disclosure that
 * nobody records is one nobody can investigate.
 *
 * `payout_method_snapshot` is frozen at request time on purpose, so a later profile
 * edit never redirects money already in flight. That property is unaffected by
 * masking — what is masked is the reading, not the record.
 */
export interface AdminPayoutRequestDto {
    id: string;
    ownerType: string;
    ownerId: string;
    /** Snapshot resolved per page, so a row reads without a join. `null` if the owner is gone. */
    ownerName: string | null;
    amount: number;
    currency: string;
    status: string;
    origin: string;
    /** Last-4 only. The full destination is not reachable from this endpoint. */
    destination: PayoutMethodMasked | null;
    ticketId: string | null;
    requestedByUserId: string | null;
    resolvedAt: string | null;
    /**
     * Who resolved it. `source` says which database `id` resolves in — `'admin'` ids
     * resolve in neither, which is why `name` is snapshotted beside them.
     */
    resolvedBy: { id: string | null; source: string; name: string | null };
    paidReference: string | null;
    rejectionReason: string | null;
    createdAt: string;
    updatedAt: string;
}

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toAdminPayoutRequestDto(
    row: IPayoutRequest,
    ownerName: string | null
): AdminPayoutRequestDto {
    return {
        id: row.id,
        ownerType: row.owner_type,
        ownerId: row.owner_id.toString(),
        ownerName,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        origin: row.origin,
        // A snapshot has no position in a list, and it *was* the preferred method when
        // it was frozen — see `maskPayoutMethod`. Legacy rows predating the snapshot
        // carry nothing, and `null` says so rather than an empty object that reads as
        // "a destination with no details".
        destination: row.payout_method_snapshot
            ? maskPayoutMethod(row.payout_method_snapshot, true)
            : null,
        ticketId: row.ticket_id ? row.ticket_id.toString() : null,
        requestedByUserId: row.requested_by_user_id ? row.requested_by_user_id.toString() : null,
        resolvedAt: toIso(row.resolved_at),
        resolvedBy: {
            id: row.resolved_by ? row.resolved_by.toString() : null,
            // Rows written before the admin split carry neither companion field and ARE
            // platform rows, so the default is the truth rather than a fallback.
            source: row.resolved_by_source ?? 'platform',
            name: row.resolved_by_name ?? null,
        },
        paidReference: row.paid_reference,
        rejectionReason: row.rejection_reason,
        createdAt: toIso(row.created_at) as string,
        updatedAt: toIso(row.updated_at) as string,
    };
}
