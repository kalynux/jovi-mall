import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { UserRole } from '../../users/user.model';

/**
 * UserPaymentMethod — a single saved payment instrument for any user role.
 *
 * Role-agnostic, keyed by (owner_role, owner_id) where owner_id is the role
 * profile id (`req.auth.role_entity._id`). Mirrors the owner-keyed pattern used
 * by the billing credit wallet so a single collection serves every role.
 *
 * SECURITY:
 * - Only gateway-managed tokens and non-sensitive display metadata are stored.
 *   The payment gateway owns tokenization and PCI compliance.
 * - Full card numbers (PAN) and CVV are NEVER stored here.
 * - `gateway_customer_id` / `gateway_instrument_id` are never returned to clients.
 */

export type PaymentMethodType = 'card' | 'mobile_money' | 'bank_transfer';

export interface IUserPaymentMethod extends Document {
    owner_role: UserRole;
    owner_id: mongoose.Types.ObjectId;
    provider: string;                 // "stripe", "notchpay", "mtn_momo"
    gateway_customer_id: string;      // Gateway's customer/wallet id (secret)
    gateway_instrument_id: string;    // Gateway's card/instrument id (secret)
    method_type: PaymentMethodType;
    display_label: string;            // e.g. "VISA •••• 8947"
    brand: string | null;            // e.g. "visa", "mastercard", "MTN"
    last4: string | null;            // last 4 digits / msisdn tail
    exp_month: number | null;        // 1-12
    exp_year: number | null;         // 4-digit year
    holder_name: string | null;
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
        gateway_customer_id: { type: String, required: true, trim: true },
        gateway_instrument_id: { type: String, required: true, trim: true },
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
