import mongoose, { Schema, Document } from 'mongoose';

/**
 * VendorCustomer - First-class vendor↔customer relationship record.
 *
 * This is the canonical "who are my customers" record for a vendor and the SOURCE
 * OF TRUTH for the customer list. A row is created automatically the first time a
 * customer orders from the vendor (source: 'order'), and will also be creatable
 * directly by the vendor in future (source: 'manual') — hence a customer may exist
 * here with zero orders. Order-related details are read from the orders collection
 * (scoped by vendor_id + customer_id).
 *
 * It also stores the vendor's PRIVATE annotations for the customer:
 * - display_name_override: a vendor-local name. This is NEVER written back to the
 *   customer's real profile (Customer.name). It only affects what THIS vendor sees.
 * - flag_ids: vendor-defined tags/groups (embedded in VendorSettings.customer_flags)
 *   assigned to the customer. A customer may carry multiple flags.
 *
 * Denormalized stats (order_count / total_spent / last_order_at) are maintained on
 * write by VendorCustomerSyncService so the list can sort/paginate at the DB level.
 *
 * SECURITY:
 * - Ownership enforced via vendor_id on every query.
 * - Unique on (vendor_id, customer_id) so there is exactly one relation per pair.
 */

export interface IVendorCustomer extends Document {
    vendor_id: mongoose.Types.ObjectId;
    customer_id: mongoose.Types.ObjectId;
    display_name_override: string | null;       // Vendor-local name; never touches Customer profile
    flag_ids: mongoose.Types.ObjectId[];         // refs VendorSettings.customer_flags[]._id
    source: 'order' | 'manual';                  // How the relation came to exist
    order_count: number;                         // Denormalized: all orders with this vendor
    total_spent: number;                         // Denormalized: sum of paid order totals
    last_order_at: Date | null;                  // Denormalized: most recent order timestamp
    deletedAt: Date | null;
    created_at: Date;
    updated_at: Date;
}

const VendorCustomerSchema = new Schema<IVendorCustomer>(
    {
        vendor_id: {
            type: Schema.Types.ObjectId,
            ref: 'Vendor',
            required: true,
            index: true
        },
        customer_id: {
            type: Schema.Types.ObjectId,
            ref: 'Customer',
            required: true,
            index: true
        },
        display_name_override: {
            type: String,
            default: null,
            trim: true,
            maxlength: 120
        },
        flag_ids: {
            type: [Schema.Types.ObjectId],
            default: []
        },
        source: {
            type: String,
            enum: ['order', 'manual'],
            default: 'order'
        },
        order_count: {
            type: Number,
            default: 0,
            min: 0
        },
        total_spent: {
            type: Number,
            default: 0,
            min: 0
        },
        last_order_at: {
            type: Date,
            default: null
        },
        deletedAt: {
            type: Date,
            default: null,
            index: true
        }
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

// Exactly one relation per vendor↔customer pair
VendorCustomerSchema.index({ vendor_id: 1, customer_id: 1 }, { unique: true });

// Sort/pagination indexes for the vendor customer list (driven off denormalized stats)
VendorCustomerSchema.index({ vendor_id: 1, last_order_at: -1 });
VendorCustomerSchema.index({ vendor_id: 1, total_spent: -1 });
VendorCustomerSchema.index({ vendor_id: 1, order_count: -1 });

export const VendorCustomerModel = mongoose.model<IVendorCustomer>(
    'VendorCustomer',
    VendorCustomerSchema
);
