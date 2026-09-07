import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * How this customer bargains — the durable half of the sub-agent's memory.
 *
 * ── Why it is not the chat memory ────────────────────────────────────────────
 *
 * The n8n Redis chat memory holds the last 20 messages with a 1-hour TTL. This
 * holds what the model LEARNED about the person, and it is the answer to the
 * owner's requirement that "the customer can come back after months, when the
 * chat memory is gone, and the sub agent should still be able to sort out the
 * type of his customer". One row per customer, forever.
 *
 * ── The traits are MODEL-AUTHORED, and that is why they are shape-guarded ────
 *
 * jovi-mall does not compute `trust_level` or `negotiation_style`; the sub-agent
 * returns them and they are handed back on the next turn. That makes this column
 * the one place in this module where a language model writes to the database, so
 * `traits` is stored through `NegotiationTraitsSchema` (`../validators/`) which
 * bounds the key count, the key names, the value types and the string lengths.
 *
 * ⚠ **Never widen that guard to accept nested objects or arrays.** A flat map of
 * scalars is all the playbook's state vector needs, and it is what keeps a
 * confused or manipulated model from writing a megabyte of prose into a document
 * that is read on every bargaining turn. The blog's `article-body.validator.ts`
 * holds the identical position for the identical reason: `Mixed` in the schema
 * means the Zod schema IS the only shape check there is.
 *
 * ⚠ **Traits are an INPUT TO PERSUASION, never to price or eligibility.** Nothing
 * outside this module may read them. Letting `price_sensitivity` reach a pricing
 * path would be per-person pricing derived from a model's guess about someone,
 * which is exactly what the playbook's § 3 forbids the agent itself from doing.
 */
export interface INegotiationProfile extends IBaseDocument {
    customer_id: Types.ObjectId;

    /**
     * The model's own judgements, flat scalars only. Replaced wholesale on each
     * write — a merge would keep a trait the model has since stopped believing.
     */
    traits: Record<string, string | number | boolean>;

    /** Counters this service owns. The model never writes these. */
    sessions_started: number;
    sessions_agreed: number;
    last_session_at?: Date | null;
}

const NegotiationProfileSchema = new Schema<INegotiationProfile>(
    {
        customer_id: {
            type: Schema.Types.ObjectId,
            ref: MODELS.CUSTOMER,
            required: true,
            unique: true,
        },

        // `Map` rather than `Mixed`: Mongoose enforces the scalar value type at the
        // schema level, so the Zod guard and the schema agree rather than the schema
        // accepting anything the guard happens to miss.
        traits: { type: Map, of: Schema.Types.Mixed, default: {} },

        sessions_started: { type: Number, required: true, default: 0, min: 0 },
        sessions_agreed: { type: Number, required: true, default: 0, min: 0 },
        last_session_at: { type: Date, default: null },

        ...BaseSchemaFields,
    },
    BaseSchemaOptions,
);

export const NegotiationProfileModel = model<INegotiationProfile>(
    MODELS.NEGOTIATION_PROFILE,
    NegotiationProfileSchema,
    COLLECTIONS.NEGOTIATION_PROFILE,
);
