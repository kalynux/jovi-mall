import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { UserRole } from '../../users/user.model';

/**
 * UserPaymentMethod — a saved way to pay, for any user role.
 *
 * Role-agnostic, keyed by (owner_role, owner_id) where owner_id is the role
 * profile id (`req.auth.role_entity._id`). Mirrors the owner-keyed pattern used
 * by the billing credit wallet so a single collection serves every role.
 *
 * ── A SAVED METHOD NAMES NO AGGREGATOR (ADR-A08, owner decision 2026-09-30) ──
 * Rows written since 2026-09-30 are mobile-money WALLETS only: `provider` is the canonical
 * provider the customer holds (`MTN` · `ORANGE` · `MOOV`) and `phone_number` is the wallet's
 * E.164 number. Which aggregator eventually charges it is decided at checkout by the payment
 * settings, so nothing here may bind a method to NotchPay, My-CoolPay or Stripe. Cards are not
 * saved until card payments exist.
 *
 * ── LEGACY ROWS ARE READ, NEVER REWRITTEN (pre-production, no data migration) ──
 * Older rows carry a lowercase `provider` (`mtn_momo`, `orange_money`, `moov_money`, or an
 * aggregator name such as `stripe`), the wallet number in `gateway_customer_id`, and possibly
 * card display fields. Those columns stay OPTIONAL so the rows still load; nothing writes them
 * any more. `providerForSavedWallet` and `PaymentMethodMapper` translate on read.
 *
 * SECURITY:
 * - Full card numbers (PAN) and CVV are NEVER stored here.
 * - The wallet number is never returned in full on any endpoint — only masked and its last
 *   four. Checkout reads it server-side to charge.
 */

export type PaymentMethodType = 'card' | 'mobile_money' | 'bank_transfer';

export interface IUserPaymentMethod extends Document {
    owner_role: UserRole;
    owner_id: mongoose.Types.ObjectId;
    /** `MTN` · `ORANGE` · `MOOV` on new rows; a legacy lowercase value on old ones. */
    provider: string;
    /** The wallet's E.164 number. Null on legacy rows, which kept it in `gateway_customer_id`. */
    phone_number: string | null;
    /** @deprecated legacy rows only (the wallet number, or an aggregator's customer id). */
    gateway_customer_id: string | null;
    /** @deprecated legacy rows only. */
    gateway_instrument_id: string | null;
    method_type: PaymentMethodType;
    display_label: string;            // e.g. "MTN Mobile Money · ••••4417"
    brand: string | null;             // legacy card rows only
    last4: string | null;             // the wallet number's tail (or a legacy card's)
    exp_month: number | null;         // legacy card rows only
    exp_year: number | null;          // legacy card rows only
    holder_name: string | null;       // legacy card rows only
    is_default: boolean;
    created_at: Date;
    updated_at: Date;
}

const UserPaymentMethodSchema = new Schema<IUserPaymentMethod>(
    {
        owner_role: {
            type: String,
            required: true,
            enum: ['admin', 'vendor', 'agency', 'agent', 'customer'],
        },
        owner_id: {
            type: Schema.Types.ObjectId,
            required: true,
        },
        provider: { type: String, required: true, trim: true },
        phone_number: { type: String, default: null, trim: true },
        gateway_customer_id: { type: String, default: null, trim: true },
        gateway_instrument_id: { type: String, default: null, trim: true },
        method_type: {
            type: String,
            required: true,
            enum: ['card', 'mobile_money', 'bank_transfer'],
        },
        display_label: { type: String, required: true, trim: true },
        brand: { type: String, default: null, trim: true },
        last4: { type: String, default: null, trim: true },
        exp_month: { type: Number, default: null, min: 1, max: 12 },
        exp_year: { type: Number, default: null },
        holder_name: { type: String, default: null, trim: true },
        is_default: { type: Boolean, default: false },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// All queries are owner-scoped.
UserPaymentMethodSchema.index({ owner_role: 1, owner_id: 1 });

export const UserPaymentMethodModel = mongoose.model<IUserPaymentMethod>(
    MODELS.USER_PAYMENT_METHOD,
    UserPaymentMethodSchema,
    COLLECTIONS.USER_PAYMENT_METHOD
);
