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

export interface IVendorSettings extends Document {
    vendor_id: mongoose.Types.ObjectId;
    customer_flags: IVendorCustomerFlagSub[];
    /** Days before plan expiry to notify the vendor. Defaults to 7. */
    notify_days_before_expiry: number;
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
        }
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

export const VendorSettingsModel = mongoose.model<IVendorSettings>(MODELS.VENDOR_SETTINGS, VendorSettingsSchema, COLLECTIONS.VENDOR_SETTINGS);
