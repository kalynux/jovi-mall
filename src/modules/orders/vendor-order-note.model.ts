import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

/**
 * VendorOrderNote Model
 * 
 * Vendor-internal notes for order management.
 * 
 * SECURITY RULES:
 * - Notes are VENDOR-INTERNAL ONLY (never exposed to customers)
 * - Ownership enforced via vendorId field
 * - Append-only (no edit or delete capabilities)
 * - Used for internal communication and记录keeping
 * 
 * USE CASES:
 * - Vendor staff leaving processing notes
 * - Recording shipping instructions
 * - Documenting customer communication
 * - Internal order flags or reminders
 */

// Plain data interface (for lean queries)
export interface IVendorOrderNoteData {
    _id: mongoose.Types.ObjectId;
    order_id: mongoose.Types.ObjectId;   // Associated order
    vendor_id: mongoose.Types.ObjectId;  // Vendor ownership (for access control)
    author_id: mongoose.Types.ObjectId;  // Vendor user who created note
    message: string;                     // Note content
    created_at: Date;                    // When note was created
    __v?: number;                        // Version key (optional)
}

// Document interface (for full Mongoose documents)
export interface IVendorOrderNote extends Document {
    order_id: mongoose.Types.ObjectId;   // Associated order
    vendor_id: mongoose.Types.ObjectId;  // Vendor ownership (for access control)
    author_id: mongoose.Types.ObjectId;  // Vendor user who created note
    message: string;                     // Note content
    created_at: Date;                    // When note was created
}

const VendorOrderNoteSchema = new Schema<IVendorOrderNote>({
    order_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.ORDER,
        required: true,
        index: true  // For fetching notes by order
    },
    vendor_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.VENDOR,
        required: true,
        index: true  // For ownership validation
    },
    author_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.USER,  // Points to vendor's user account
        required: true
    },
    message: {
        type: String,
        required: true,
        maxlength: 2000  // Prevent abuse
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: false }  // Append-only
});

// Compound index for chronological note retrieval
VendorOrderNoteSchema.index({ order_id: 1, created_at: 1 });

// APPEND-ONLY ENFORCEMENT: Prevent updates and deletes
VendorOrderNoteSchema.pre('updateOne', function (next) {
    next(new Error('Vendor notes cannot be updated'));
});

VendorOrderNoteSchema.pre('updateMany', function (next) {
    next(new Error('Vendor notes cannot be updated'));
});

VendorOrderNoteSchema.pre('findOneAndUpdate', function (next) {
    next(new Error('Vendor notes cannot be updated'));
});

VendorOrderNoteSchema.pre('deleteOne', function (next) {
    next(new Error('Vendor notes cannot be deleted'));
});

VendorOrderNoteSchema.pre('deleteMany', function (next) {
    next(new Error('Vendor notes cannot be deleted'));
});

export const VendorOrderNoteModel = mongoose.model<IVendorOrderNote>(MODELS.VENDOR_ORDER_NOTE, VendorOrderNoteSchema, COLLECTIONS.VENDOR_ORDER_NOTE);
