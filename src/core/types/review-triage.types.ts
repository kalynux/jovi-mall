import { Schema } from 'mongoose';

/**
 * A reviewer's endorsement — "I have looked at this and I believe it is genuine."
 *
 * ── What this is for ──────────────────────────────────────────────────────────
 * Three records on this platform are decided by an administrator and are worth a second pair
 * of eyes BEFORE that decision: a payout request, an agent's cash deposit to the platform,
 * and an agency's remittance. Each is reviewed by one tier and acted on by another, so this
 * stamp records the first half.
 *
 * ── The two properties that make it safe to attach anywhere ───────────────────
 *
 * **It is a FIELD, never a status.** Every record carrying it has a state machine that was
 * complete before triage existed — `pending → paid | rejected`, `declared → confirmed |
 * rejected` — and those machines are load-bearing: partial unique indexes, compare-and-set
 * guards and deadline workers all key on them. Adding an `endorsed` state to any of them
 * would break something a long way from here. Sitting beside the status means triage changes
 * nothing about how the record behaves.
 *
 * **It gates nothing.** An endorsed record and an un-endorsed one are equally actionable.
 * That is what keeps the reviewing tier off the critical path: a queue nobody has got to yet
 * never blocks the money. The endorsement saves the deciding administrator work; it does not
 * grant them anything and it does not stand in their way.
 *
 * ── Why there is no `rejected` verdict ────────────────────────────────────────
 * Because rejection is terminal on all three records, and terminal outcomes are statuses.
 * A reviewer who rejects performs exactly the same write a decider would — same fields, same
 * code path, same event. Storing a `rejected` verdict beside a `rejected` status would be
 * two fields free to disagree about whether a record is closed, and the interesting question
 * ("who closed it") is already answered by the resolver stamp.
 */
export type TriageVerdict = 'endorsed';

export interface IReviewTriage {
    verdict: TriageVerdict;
    note: string | null;
    /**
     * The wi-admin `admin_accounts._id` of the reviewer.
     *
     * A plain string, not an ObjectId `ref`. It resolves in no collection in THIS database —
     * administrators live in a separate one — and declaring it a ref would invite a
     * `.populate()` that silently yields null. The name beside it is the snapshot, taken at
     * write time, for the same reason `actorStampFields` exists.
     */
    by_admin_id: string | null;
    by_name: string | null;
    at: Date | null;
}

/**
 * The sub-schema, ready to spread into a model as `triage: { type: ReviewTriageSchema,
 * default: null }`.
 *
 * `_id: false` because it is one stamp on one parent, not a collection member.
 */
export const ReviewTriageSchema = new Schema<IReviewTriage>(
    {
        verdict: { type: String, enum: ['endorsed'], required: true },
        note: { type: String, default: null, trim: true, maxlength: 500 },
        by_admin_id: { type: String, default: null, trim: true },
        by_name: { type: String, default: null, trim: true, maxlength: 200 },
        at: { type: Date, default: null },
    },
    { _id: false }
);
