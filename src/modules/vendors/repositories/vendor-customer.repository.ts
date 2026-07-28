import { Types, PipelineStage } from 'mongoose';
import { VendorCustomerModel, IVendorCustomer } from '../models/vendor-customer.model';
import { COLLECTIONS } from '../../../core/database/collections';

function escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface VendorCustomerListRow extends IVendorCustomer {
    customer?: {
        _id: Types.ObjectId;
        name?: string;
        email?: string;
        avatar_file_id?: Types.ObjectId | null;
        avatar_url?: string | null;
    } | null;
}

/**
 * VendorCustomerRepository - Persistence for the first-class vendor↔customer relation.
 *
 * The relation is the source of truth for the vendor customer list. Stat fields
 * (order_count / total_spent / last_order_at) are maintained by
 * VendorCustomerSyncService. All queries are scoped by vendor_id and exclude
 * soft-deleted docs.
 */
export class VendorCustomerRepository {
    async findByVendorAndCustomer(
        vendorId: string,
        customerId: string
    ): Promise<IVendorCustomer | null> {
        if (!Types.ObjectId.isValid(customerId)) return null;
        return await VendorCustomerModel.findOne({
            vendor_id: vendorId,
            customer_id: customerId,
            deletedAt: null
        }).exec();
    }

    /**
     * Paginated customer list driven off the relation table. Joins the customer
     * profile (for name/email/avatar + search) and sorts on denormalized stats.
     * Returns the page rows (relation + joined `customer`) and the total count.
     */
    async paginateForList(
        vendorId: string,
        opts: {
            search?: string;
            flagId?: string;
            sortField: 'last_order_at' | 'total_spent' | 'order_count';
            sortDir: 1 | -1;
            skip: number;
            limit: number;
        }
    ): Promise<{ rows: VendorCustomerListRow[]; total: number }> {
        const match: Record<string, unknown> = {
            vendor_id: new Types.ObjectId(vendorId),
            deletedAt: null
        };

        if (opts.flagId && Types.ObjectId.isValid(opts.flagId)) {
            match.flag_ids = new Types.ObjectId(opts.flagId);
        }

        const pipeline: PipelineStage[] = [
            { $match: match },
            {
                $lookup: {
                    from: COLLECTIONS.CUSTOMER,
                    localField: 'customer_id',
                    foreignField: '_id',
                    as: 'customer'
                }
            },
            { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } }
        ];

        // Search against the resolved customer profile (name or email).
        if (opts.search) {
            const rx = new RegExp(escapeRegex(opts.search), 'i');
            pipeline.push({
                $match: { $or: [{ 'customer.name': rx }, { 'customer.email': rx }] }
            });
        }

        pipeline.push({
            $facet: {
                data: [
                    { $sort: { [opts.sortField]: opts.sortDir, _id: 1 } },
                    { $skip: opts.skip },
                    { $limit: opts.limit }
                ],
                totalCount: [{ $count: 'count' }]
            }
        });

        const agg = await VendorCustomerModel.aggregate(pipeline);
        const facet = agg[0] ?? { data: [], totalCount: [] };
        return {
            rows: (facet.data ?? []) as VendorCustomerListRow[],
            total: facet.totalCount?.[0]?.count ?? 0
        };
    }

    /**
     * Set/clear the vendor-local display name override. Upserts the relation.
     */
    async upsertOverride(
        vendorId: string,
        customerId: string,
        displayNameOverride: string | null
    ): Promise<IVendorCustomer> {
        const result = await VendorCustomerModel.findOneAndUpdate(
            { vendor_id: vendorId, customer_id: customerId },
            {
                $set: { display_name_override: displayNameOverride, deletedAt: null },
                $setOnInsert: {
                    vendor_id: new Types.ObjectId(vendorId),
                    customer_id: new Types.ObjectId(customerId)
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        return result!;
    }

    /**
     * Replace the customer's assigned flags. Upserts the relation.
     * Caller is responsible for validating flag ownership beforehand.
     */
    async setFlags(
        vendorId: string,
        customerId: string,
        flagIds: string[]
    ): Promise<IVendorCustomer> {
        const result = await VendorCustomerModel.findOneAndUpdate(
            { vendor_id: vendorId, customer_id: customerId },
            {
                $set: {
                    flag_ids: flagIds.map((id) => new Types.ObjectId(id)),
                    deletedAt: null
                },
                $setOnInsert: {
                    vendor_id: new Types.ObjectId(vendorId),
                    customer_id: new Types.ObjectId(customerId)
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        return result!;
    }

    /**
     * Remove a flag id from every relation of a vendor (called when a flag is deleted).
     */
    async pullFlagFromAll(vendorId: string, flagId: string): Promise<void> {
        if (!Types.ObjectId.isValid(flagId)) return;
        await VendorCustomerModel.updateMany(
            { vendor_id: vendorId, flag_ids: new Types.ObjectId(flagId) },
            { $pull: { flag_ids: new Types.ObjectId(flagId) } }
        ).exec();
    }
}
