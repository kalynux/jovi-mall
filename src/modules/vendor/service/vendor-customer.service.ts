import { Types } from 'mongoose';
import { OrderModel } from '../../orders/order.model';
import { CustomerModel } from '../../customers/customer.model';
import { VendorCustomerRepository } from '../../vendors/repositories/vendor-customer.repository';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { Page } from '../../../core/repositories/base.repository';
import {
    FlagDto,
    toFlagDto,
    VendorCustomerListItemDto,
    VendorCustomerDetailDto
} from '../dto/vendor-customer.dto';

/**
 * VendorCustomerService
 *
 * Business logic for the vendor "Customer Management" tab.
 *
 * The vendor↔customer relationship is a FIRST-CLASS RECORD (VendorCustomer): a row
 * is created automatically the first time a customer orders (and, in future, when a
 * vendor adds a customer manually — so a customer may exist with zero orders). The
 * customer LIST is read from that relation table; ORDER-related detail is read live
 * from the orders collection (scoped by vendor_id + customer_id). Vendor-private
 * annotations (name override + flags) live on the relation; flag DEFINITIONS live in
 * the vendor's settings document (VendorSettings.customer_flags).
 *
 * Stats semantics (per product decision):
 * - orderCount: ALL orders with this vendor, regardless of status.
 * - totalSpent: sum of total_amount for orders with payment_status === 'paid'.
 * The list uses denormalized stats on the relation; the detail recomputes them live.
 *
 * SECURITY: every query is scoped by vendor_id; mutations validate that the customer
 * is a customer of the vendor (a relation exists) and that flags belong to the vendor.
 */
export class VendorCustomerService {
    private relationRepo: VendorCustomerRepository;
    private settingsRepo: VendorSettingsRepository;

    constructor() {
        this.relationRepo = new VendorCustomerRepository();
        this.settingsRepo = new VendorSettingsRepository();
    }

    // ─── Flag CRUD (vendor-defined tags) ──────────────────────────────────────

    async listFlags(vendorId: string): Promise<FlagDto[]> {
        const flags = await this.settingsRepo.listFlags(vendorId);
        return flags.map(toFlagDto);
    }

    async createFlag(
        vendorId: string,
        input: { name: string; color: string; description?: string | null }
    ): Promise<FlagDto> {
        const flag = await this.settingsRepo.createFlag(vendorId, {
            name: input.name,
            color: input.color,
            description: input.description ?? null
        });
        return toFlagDto(flag);
    }

    async updateFlag(
        vendorId: string,
        flagId: string,
        updates: { name?: string; color?: string; description?: string | null }
    ): Promise<FlagDto> {
        const flag = await this.settingsRepo.updateFlag(vendorId, flagId, updates);
        if (!flag) {
            throw createAppError(ERROR_CODES.VENDOR_CUSTOMER_FLAG_NOT_FOUND, 404, 'Flag not found');
        }
        return toFlagDto(flag);
    }

    async deleteFlag(vendorId: string, flagId: string): Promise<void> {
        const deleted = await this.settingsRepo.softDeleteFlag(vendorId, flagId);
        if (!deleted) {
            throw createAppError(ERROR_CODES.VENDOR_CUSTOMER_FLAG_NOT_FOUND, 404, 'Flag not found');
        }
        // Detach the flag from any customer relations that referenced it.
        await this.relationRepo.pullFlagFromAll(vendorId, flagId);
    }

    // ─── Customer listing ─────────────────────────────────────────────────────

    async listCustomers(
        vendorId: string,
        query: {
            search?: string;
            flagId?: string;
            page: number;
            limit: number;
            sortBy: 'lastOrderAt' | 'totalSpent' | 'orderCount';
            sortOrder: 'asc' | 'desc';
        }
    ): Promise<Page<VendorCustomerListItemDto>> {
        const { page, limit, sortBy, sortOrder } = query;
        const skip = (page - 1) * limit;
        const sortDir: 1 | -1 = sortOrder === 'asc' ? 1 : -1;
        const sortField =
            sortBy === 'totalSpent'
                ? 'total_spent'
                : sortBy === 'orderCount'
                  ? 'order_count'
                  : 'last_order_at';

        const [{ rows, total }, flagMap] = await Promise.all([
            this.relationRepo.paginateForList(vendorId, {
                search: query.search,
                flagId: query.flagId,
                sortField,
                sortDir,
                skip,
                limit
            }),
            this.buildFlagMap(vendorId)
        ]);

        const data: VendorCustomerListItemDto[] = rows.map((row) => {
            const realName = row.customer?.name ?? 'Unknown';
            const override = row.display_name_override ?? null;
            return {
                customerId: row.customer_id.toString(),
                displayName: override ?? realName,
                realName,
                hasNameOverride: !!override,
                email: row.customer?.email ?? null,
                avatar: row.customer?.avatar_url ?? null,
                orderCount: row.order_count ?? 0,
                totalSpent: row.total_spent ?? 0,
                lastOrderAt: row.last_order_at ?? null,
                flags: this.resolveFlags(row.flag_ids, flagMap)
            };
        });

        return {
            data,
            meta: { total, page, limit, pages: Math.ceil(total / limit) }
        };
    }

    async getCustomerDetail(vendorId: string, customerId: string): Promise<VendorCustomerDetailDto> {
        if (!Types.ObjectId.isValid(customerId)) {
            throw createAppError(ERROR_CODES.VENDOR_CUSTOMER_NOT_FOUND, 404, 'Customer not found');
        }

        // The relation is the source of truth for "is this a customer of the vendor".
        const relation = await this.relationRepo.findByVendorAndCustomer(vendorId, customerId);
        if (!relation) {
            throw createAppError(ERROR_CODES.VENDOR_CUSTOMER_NOT_FOUND, 404, 'Customer not found');
        }

        const [customer, statsAgg, flagMap] = await Promise.all([
            CustomerModel.findById(customerId)
                .select('name email phone avatar_url saved_addresses')
                .lean()
                .exec() as Promise<any>,
            // Live order stats (source of truth for displayed detail numbers).
            OrderModel.aggregate([
                {
                    $match: {
                        customer_id: new Types.ObjectId(customerId),
                        vendor_id: new Types.ObjectId(vendorId)
                    }
                },
                {
                    $group: {
                        _id: null,
                        orderCount: { $sum: 1 },
                        totalSpent: {
                            $sum: {
                                $cond: [{ $eq: ['$payment_status', 'paid'] }, '$total_amount', 0]
                            }
                        },
                        lastOrderAt: { $max: '$created_at' }
                    }
                }
            ]),
            this.buildFlagMap(vendorId)
        ]);

        const stats = statsAgg[0] ?? { orderCount: 0, totalSpent: 0, lastOrderAt: null };

        const realName = customer?.name ?? 'Unknown';
        const override = relation.display_name_override ?? null;

        const defaultAddr =
            customer?.saved_addresses?.find((a: any) => a.is_default) ??
            customer?.saved_addresses?.[0] ??
            null;

        return {
            customerId,
            displayName: override ?? realName,
            realName,
            hasNameOverride: !!override,
            email: customer?.email ?? null,
            phone: customer?.phone ?? null,
            avatar: customer?.avatar_url ?? null,
            orderCount: stats.orderCount ?? 0,
            totalSpent: stats.totalSpent ?? 0,
            lastOrderAt: stats.lastOrderAt ?? null,
            flags: this.resolveFlags(relation.flag_ids, flagMap),
            shippingAddress: defaultAddr
                ? {
                      street: defaultAddr.address_line1,
                      city: defaultAddr.city,
                      state: defaultAddr.state ?? null,
                      country: defaultAddr.country
                  }
                : null
        };
    }

    // ─── Mutations ─────────────────────────────────────────────────────────────

    async updateCustomerName(
        vendorId: string,
        customerId: string,
        displayName: string | null
    ): Promise<VendorCustomerDetailDto> {
        await this.assertCustomerOfVendor(vendorId, customerId);
        const normalized = displayName && displayName.trim().length > 0 ? displayName.trim() : null;
        await this.relationRepo.upsertOverride(vendorId, customerId, normalized);
        return this.getCustomerDetail(vendorId, customerId);
    }

    async setCustomerFlags(
        vendorId: string,
        customerId: string,
        flagIds: string[]
    ): Promise<VendorCustomerDetailDto> {
        await this.assertCustomerOfVendor(vendorId, customerId);

        // De-duplicate, then validate every flag belongs to this vendor.
        const unique = [...new Set(flagIds)];
        if (unique.length > 0) {
            const owned = await this.settingsRepo.findOwnedFlagIds(vendorId, unique);
            if (owned.length !== unique.length) {
                throw createAppError(
                    ERROR_CODES.VENDOR_CUSTOMER_FLAG_NOT_FOUND,
                    400,
                    'One or more flags do not exist or do not belong to you'
                );
            }
        }

        await this.relationRepo.setFlags(vendorId, customerId, unique);
        return this.getCustomerDetail(vendorId, customerId);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Ensure a relation exists for this customer before allowing vendor-local
     * annotations. Guards against annotating arbitrary customer ids.
     */
    private async assertCustomerOfVendor(vendorId: string, customerId: string): Promise<void> {
        if (!Types.ObjectId.isValid(customerId)) {
            throw createAppError(ERROR_CODES.VENDOR_CUSTOMER_NOT_FOUND, 404, 'Customer not found');
        }
        const relation = await this.relationRepo.findByVendorAndCustomer(vendorId, customerId);
        if (!relation) {
            throw createAppError(ERROR_CODES.VENDOR_CUSTOMER_NOT_FOUND, 404, 'Customer not found');
        }
    }

    /**
     * Build a Map<flagId, FlagDto> of the vendor's (non-deleted) flag definitions,
     * for O(1) hydration of relations.
     */
    private async buildFlagMap(vendorId: string): Promise<Map<string, FlagDto>> {
        const flags = await this.settingsRepo.listFlags(vendorId);
        const map = new Map<string, FlagDto>();
        for (const f of flags) {
            map.set(f._id.toString(), toFlagDto(f));
        }
        return map;
    }

    private resolveFlags(
        flagIds: { toString(): string }[] | undefined,
        flagMap: Map<string, FlagDto>
    ): FlagDto[] {
        if (!flagIds || flagIds.length === 0) return [];
        const result: FlagDto[] = [];
        for (const id of flagIds) {
            const dto = flagMap.get(id.toString());
            // Skip ids that no longer resolve (e.g. flag deleted after assignment).
            if (dto) result.push(dto);
        }
        return result;
    }
}
