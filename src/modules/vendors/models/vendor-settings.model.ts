import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * VendorSettings - Per-vendor settings document (one per vendor).
 *
 * A catch-all home for a vendor's configurable settings. Currently it holds the
 * vendor's customer flags (customizable color-coded tags/groups used to segment
 * their customers); future settings are added as sibling fields on this document.
 *
 * Customer flags live here as EMBEDDED subdocuments (each gets its own ObjectId
 * `_id`). VendorCustomer.flag_ids reference those embedded `_id`s. This replaces
 * the former standalone `vendor_customer_flags` collection.
 *
 * SECURITY:
 * - Exactly one document per vendor (unique vendor_id), created lazily.
 * - Flags are soft-deleted via `deletedAt` (never hard-removed) so historical
 *   references remain resolvable; deleting a flag also pulls its id from relations.
 */

export interface IVendorCustomerFlagSub {
    _id: mongoose.Types.ObjectId;
    name: string;               // Display label (e.g. "VIP")
    color: string;              // Hex color (e.g. "#FF8800")
    description: string | null; // Optional explanation
    deletedAt: Date | null;     // Soft-delete marker
    created_at: Date;
    updated_at: Date;
}

export interface IVendorCodTermsSub {
    cod_enabled: boolean;
    /** XAF; `null` = no vendor cap. */
    max_cash_per_agency: number | null;
    updated_at: Date | null;
}

export interface IVendorSettings extends Document {
    vendor_id: mongoose.Types.ObjectId;
    customer_flags: IVendorCustomerFlagSub[];
    /** Days before plan expiry to notify the vendor. Defaults to 7. */
    notify_days_before_expiry: number;
    /**
     * When true, paid physical orders are automatically dispatched to the
     * agency in charge (shipments advance from `pending` → `assigned`) without
     * the vendor having to confirm. When false (default), shipments stay
     * `pending` until the vendor dispatches them manually. Defaults to false.
     */
    auto_redirect_orders_to_agency: boolean;
    /**
     * Max order total (in the order's own currency) for which auto-redirect
     * applies. When set, a paid physical order whose `total_amount` exceeds this
     * cap is NOT auto-dispatched — its shipments stay `pending` for manual
     * dispatch even if `auto_redirect_orders_to_agency` is on. `null` (default)
     * means no cap: every order is auto-dispatched when the toggle is on.
     */
    auto_redirect_threshold_amount: number | null;
    /**
     * Number of days an order may remain unpaid before the daily sweep
     * auto-cancels it. Minimum 1 (cannot be 0). Defaults to 3.
     */
    auto_cancel_unpaid_days: number;
    /**
     * The vendor's COD terms (owner decision 2026-10-02) — whether they accept cash on
     * delivery at all, and how much of THEIR orders' cash one agency may hold
     * un-remitted at once. Absent on legacy documents: read through
     * `vendorCodTermsOf()` (cod/domain/cod-limits.ts), which applies the defaults
     * (`cod_enabled: true`, no cap).
     *
     * ⚠ Deliberately NOT on `Vendor.policies`: editing policies bumps `policy_version`
     * and pauses every agency connection for re-approval, and these terms must be
     * editable without that.
     */
    cod_terms?: IVendorCodTermsSub | null;
    created_at: Date;
    updated_at: Date;
}

const VendorCustomerFlagSubSchema = new Schema<IVendorCustomerFlagSub>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 60
        },
        color: {
            type: String,
            required: true,
            trim: true,
            // Hex color: #RGB or #RRGGBB
            match: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
        },
        description: {
            type: String,
            default: null,
            trim: true,
            maxlength: 200
        },
        deletedAt: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

const VendorSettingsSchema = new Schema<IVendorSettings>(
    {
        vendor_id: {
            type: Schema.Types.ObjectId,
            ref: MODELS.VENDOR,
            required: true,
            unique: true
        },
        customer_flags: {
            type: [VendorCustomerFlagSubSchema],
            default: []
        },
        notify_days_before_expiry: {
            type: Number,
            default: 7,
            min: 0,
            max: 90
        },
        auto_redirect_orders_to_agency: {
            type: Boolean,
            default: false
        },
        auto_redirect_threshold_amount: {
            type: Number,
            default: null,
            min: 0
        },
        auto_cancel_unpaid_days: {
            type: Number,
            default: 3,
            min: 1,
            max: 90
        },
        // No default document: an absent block reads as the defaults through
        // vendorCodTermsOf(), so existing documents need no backfill.
        cod_terms: {
            type: new Schema<IVendorCodTermsSub>(
                {
                    cod_enabled: { type: Boolean, required: true, default: true },
                    max_cash_per_agency: { type: Number, default: null, min: 0 },
                    updated_at: { type: Date, default: null },
                },
                { _id: false }
            ),
            default: null,
        }
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

export const VendorSettingsModel = mongoose.model<IVendorSettings>(MODELS.VENDOR_SETTINGS, VendorSettingsSchema, COLLECTIONS.VENDOR_SETTINGS);
