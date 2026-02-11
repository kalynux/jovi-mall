import { VendorOrderNoteModel, IVendorOrderNote, IVendorOrderNoteData } from './vendor-order-note.model';

/**
 * Vendor Order Note Repository
 * 
 * Vendor-internal notes with ownership enforcement.
 * 
 * SECURITY:
 * - Notes are vendor-internal ONLY
 * - Never exposed to customers
 * - Ownership enforced via vendorId
 * 
 * IMMUTABILITY:
 * - Append-only (no update or delete methods)
 * - Model enforces immutability at DB level
 */

export interface CreateNoteData {
    orderId: string;
    vendorId: string;
    authorId: string;
    message: string;
}

export class VendorOrderNoteRepository {
    /**
     * Create vendor note
     * 
     * Append-only operation.
     */
    async create(noteData: CreateNoteData): Promise<IVendorOrderNote> {
        const note = await VendorOrderNoteModel.create({
            order_id: noteData.orderId,
            vendor_id: noteData.vendorId,
            author_id: noteData.authorId,
            message: noteData.message
        });

        return note;
    }

    /**
     * Find notes by order with vendor ownership check
     * 
     * Returns notes in chronological order (oldest first).
     * Ownership enforced in query.
     */
    async findByOrder(orderId: string, vendorId: string): Promise<IVendorOrderNoteData[]> {
        return await VendorOrderNoteModel
            .find({
                order_id: orderId,
                vendor_id: vendorId  // CRITICAL: Ownership check
            })
            .sort({ created_at: 1 })  // Chronological order
            .lean()
            .exec();

    }
}
