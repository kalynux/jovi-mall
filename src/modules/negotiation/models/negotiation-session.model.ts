import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { NegotiationSessionStatus } from '../domain/negotiation-gate.rule';

/**
 * One haggle over one line.
 *
 * A session is scoped to **(customer, variant, quantity)** — the playbook's iron
 * rule 1 says a new quantity or a different variant is "a new deal", and that is
 * enforced here by it being a different session rather than by a check somebody
 * has to remember. Two sessions may be open for one customer at once.
 *
 * ── It is a LEDGER, not a policy ─────────────────────────────────────────────
 *
 * Nothing on this document decides a price. `current_counter` exists so the gate
 * can enforce non-increasing; `turns` exists so a disagreement about what was
 * offered has an answer. The model decides the numbers (plan D-2/D-9) and this
 * records them.
 *
 * ── `floor_at_open` / `ask_at_open` are AUDIT, never inputs ──────────────────
 *
 * ⚠ The gate re-reads the live window on every turn (invariant 3) and must never
 * judge against these. They are here so "what was the window when this started"
 * is answerable, which is the question asked after a vendor edits a price
 * mid-negotiation and a lock is refused at checkout (D-10). Using them as the
 * gate's input would let a vendor's edit be exploited for the life of the session.
 */
export interface INegotiationTurn {
    at: Date;
    round: number;
    /** What the customer offered this turn, if they named a number. */
    customer_offer?: number | null;
    /** What the model proposed. Always present — the gate refuses a turn without one. */
    agent_proposed_price: number;
    /** Whether the model asked for this price to be locked. */
    lock_requested: boolean;
    /** The sentence the customer read. Stored so a dispute has the actual words. */
    reply: string;
}

export interface INegotiationLock {
    /** The opaque handle the cart presents. Never the session id — see the model header. */
    ref: string;
    /** Per unit, agreed. */
    unit_price: number;
    /** `variant.price` at the moment of agreement — Stream C/E's uplift basis. */
    floor_snapshot: number;
    issued_at: Date;
    expires_at: Date;
    /** Set when the order that spent it was created. Null = still spendable. */
    consumed_at?: Date | null;
    /** The order that spent it. Audit only. */
    consumed_by_order_id?: Types.ObjectId | null;
}

export interface INegotiationSession extends IBaseDocument {
    /** The `users` row. Not interchangeable with `customer_id` — see BotIdentityService. */
    user_id: Types.ObjectId;
    /** The `Customer` profile, which is what cart and orders scope on. */
    customer_id: Types.ObjectId;

    product_id: Types.ObjectId;
    variant_id: Types.ObjectId;
    vendor_id: Types.ObjectId;
    quantity: number;
    currency: string;

    status: NegotiationSessionStatus;
    round: number;

    /** The last price the model quoted. Null before its first turn. */
    current_counter?: number | null;
    /** The last price the customer named. Informational; the gate does not read it. */
    last_customer_offer?: number | null;

    turns: INegotiationTurn[];
    lock?: INegotiationLock | null;

    /** Audit only. NEVER the gate's input — see the header. */
    floor_at_open: number;
    ask_at_open: number;

    expires_at: Date;
}

const TurnSchema = new Schema<INegotiationTurn>(
    {
        at: { type: Date, required: true },
        round: { type: Number, required: true, min: 1 },
        customer_offer: { type: Number, default: null },
        agent_proposed_price: { type: Number, required: true, min: 0 },
        lock_requested: { type: Boolean, required: true, default: false },
        // Capped so a runaway model cannot grow one document without bound. The
        // channels themselves cut well below this (WhatsApp 4096).
        reply: { type: String, required: true, maxlength: 4096 },
    },
    { _id: false },
);

const LockSchema = new Schema<INegotiationLock>(
    {
        ref: { type: String, required: true },
        unit_price: { type: Number, required: true, min: 0 },
        floor_snapshot: { type: Number, required: true, min: 0 },
        issued_at: { type: Date, required: true },
        expires_at: { type: Date, required: true },
        consumed_at: { type: Date, default: null },
        consumed_by_order_id: { type: Schema.Types.ObjectId, default: null },
    },
    { _id: false },
);

const NegotiationSessionSchema = new Schema<INegotiationSession>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
        customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },

        product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true },
        variant_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_VARIANT, required: true },
        vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
        quantity: { type: Number, required: true, min: 1 },
        currency: { type: String, required: true, default: 'XAF' },

        status: {
            type: String,
            enum: ['open', 'agreed', 'closed', 'expired'],
            required: true,
            default: 'open',
            index: true,
        },
        round: { type: Number, required: true, default: 0, min: 0 },

        current_counter: { type: Number, default: null },
        last_customer_offer: { type: Number, default: null },

        turns: { type: [TurnSchema], default: [] },
        lock: { type: LockSchema, required: false, default: undefined },

        floor_at_open: { type: Number, required: true, min: 0 },
        ask_at_open: { type: Number, required: true, min: 0 },

        expires_at: { type: Date, required: true },

        ...BaseSchemaFields,
    },
    BaseSchemaOptions,
);

/**
 * Resume the open session for this line — the lookup `negotiation_context` makes
 * on every turn, so it is the one that has to be indexed.
 */
NegotiationSessionSchema.index({ customer_id: 1, variant_id: 1, quantity: 1, status: 1 });

/**
 * Spend a lock by its handle.
 *
 * ⚠ **Sparse**, because most sessions never mint one and a plain index would treat
 * every lock-less session as sharing the same null key. Not `unique`: uniqueness of
 * a 128-bit random handle is a property of the generator, and a unique index here
 * would additionally refuse the second lock-less session outright.
 */
NegotiationSessionSchema.index({ 'lock.ref': 1 }, { sparse: true, name: 'negotiation_lock_ref' });

/**
 * ⚠ **Deliberately NOT a TTL index.** A TTL would DELETE the session, taking the
 * turn history — the record of what was offered and agreed — with it. Expiry is a
 * STATUS, applied by the gate when it reads a session past `expires_at`; the
 * document survives for audit. Money records in this codebase are never TTL'd for
 * the same reason.
 */
NegotiationSessionSchema.index({ expires_at: 1 });

export const NegotiationSessionModel = model<INegotiationSession>(
    MODELS.NEGOTIATION_SESSION,
    NegotiationSessionSchema,
    COLLECTIONS.NEGOTIATION_SESSION,
);
