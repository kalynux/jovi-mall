import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { auditLogger } from '../../../core/audit/audit-logger';
import { TransactionManager, transactionManager } from '../../../core/database/transaction.manager';
import { DeliveryAgencyRepository } from '../delivery-agency.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { ProductDeliveryAgencySuspensionService } from '../../catalog/domain/services/ProductDeliveryAgencySuspensionService';
import { IProductRepository } from '../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { OrderRepository } from '../../orders/order.repository';
import { AdminAgencyListItemDto, AdminAgencyListMeta, AdminAgencyMapper } from '../dto/admin-agency.dto';
import { ProductStatus } from '../../catalog/models/product.model';

/**
 * AdminAgencyService: admin-facing delivery agency management.
 *
 * Deactivating an agency:
 *  1. Suspends every vendor's physical products (any status) where this agency is
 *     currently their DEFAULT — see ProductDeliveryAgencySuspensionService.
 *  2. Suspends any physical product, across ANY vendor, whose OWN delivery-agency
 *     OVERRIDE points at this agency — independent of that vendor's default.
 *  3. Puts every still pending/assigned order item currently riding this agency on
 *     hold (any vendor, any provenance) — see OrderRepository.holdItemsByAgency.
 *
 * Reactivating reverses all three. All fanned out inside a single transaction.
 */
export class AdminAgencyService {
    constructor(
        private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
        private readonly vendorRepo: VendorRepository = new VendorRepository(),
        private readonly suspensionService: ProductDeliveryAgencySuspensionService = new ProductDeliveryAgencySuspensionService(),
        private readonly txManager: TransactionManager = transactionManager,
        private readonly productRepo: IProductRepository = new ProductRepositoryMongo(),
        private readonly orderRepo: OrderRepository = new OrderRepository(),
    ) { }

    async list(params: {
        status?: 'active' | 'pending_verification' | 'inactive';
        page: number;
        limit: number;
    }): Promise<{ agencies: AdminAgencyListItemDto[]; meta: AdminAgencyListMeta }> {
        const { agencies, total } = await this.agencyRepo.findAllForAdmin(params);
        return {
            agencies: agencies.map(AdminAgencyMapper.toListItemDto),
            meta: {
                total,
                page: params.page,
                limit: params.limit,
                totalPages: Math.ceil(total / params.limit),
            },
        };
    }

    async getById(agencyId: string): Promise<AdminAgencyListItemDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');
        return AdminAgencyMapper.toListItemDto(agency);
    }

    /**
     * Deactivate an agency. Idempotent — no-op if the agency is already inactive.
     */
    async deactivate(agencyId: string, actorUserId: string): Promise<{
        agency: AdminAgencyListItemDto;
        affectedProductIds: string[];
        heldOrderItemCount: number;
    }> {
        return this.txManager.runInTransaction(async (session) => {
            const agency = await this.agencyRepo.findById(agencyId, session);
            if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');

            if (agency.status === 'inactive') {
                return { agency: AdminAgencyMapper.toListItemDto(agency), affectedProductIds: [], heldOrderItemCount: 0 };
            }

            const updated = await this.agencyRepo.updateStatusById(agencyId, 'inactive', session);

            const defaultAgencyProductIds = await this.suspendVendorDefaultProducts(agencyId, session);
            const ownAgencyProductIds = await this.suspendProductOverrides(agencyId, session);
            const affectedProductIds = [...defaultAgencyProductIds, ...ownAgencyProductIds];

            const heldItems = await this.orderRepo.holdItemsByAgency(agencyId, session);

            await auditLogger.log({
                actor: { userId: actorUserId, role: 'admin' },
                action: 'DELIVERY_AGENCY_DEACTIVATED',
                resource: { type: 'DeliveryAgency', id: agencyId },
                changes: {
                    status: { from: agency.status, to: 'inactive' },
                    suspendedProductCount: affectedProductIds.length,
                    heldOrderItemCount: heldItems.length,
                },
                timestamp: new Date(),
            });

            return { agency: AdminAgencyMapper.toListItemDto(updated!), affectedProductIds, heldOrderItemCount: heldItems.length };
        });
    }

    /**
     * Reactivate an agency. Idempotent — no-op if already active.
     */
    async reactivate(agencyId: string, actorUserId: string): Promise<{
        agency: AdminAgencyListItemDto;
        restoredProducts: { productId: string; status: ProductStatus }[];
        unheldOrderItemCount: number;
    }> {
        return this.txManager.runInTransaction(async (session) => {
            const agency = await this.agencyRepo.findById(agencyId, session);
            if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');

            if (agency.status === 'active') {
                return { agency: AdminAgencyMapper.toListItemDto(agency), restoredProducts: [], unheldOrderItemCount: 0 };
            }

            const updated = await this.agencyRepo.updateStatusById(agencyId, 'active', session);

            const defaultAgencyRestored = await this.restoreVendorDefaultProducts(agencyId, session);
            const ownAgencyRestored = await this.restoreProductOverrides(agencyId, session);
            const restoredProducts = [...defaultAgencyRestored, ...ownAgencyRestored];

            const unheldItems = await this.orderRepo.unholdItemsForAgency(agencyId, session);

            await auditLogger.log({
                actor: { userId: actorUserId, role: 'admin' },
                action: 'DELIVERY_AGENCY_REACTIVATED',
                resource: { type: 'DeliveryAgency', id: agencyId },
                changes: {
                    status: { from: agency.status, to: 'active' },
                    restoredProductCount: restoredProducts.length,
                    unheldOrderItemCount: unheldItems.length,
                },
                timestamp: new Date(),
            });

            return { agency: AdminAgencyMapper.toListItemDto(updated!), restoredProducts, unheldOrderItemCount: unheldItems.length };
        });
    }

    private async suspendVendorDefaultProducts(agencyId: string, session: ClientSession): Promise<string[]> {
        const vendorIds = await this.vendorRepo.findVendorIdsByDefaultAgency(agencyId, session);
        const affectedProductIds: string[] = [];
        for (const vendorId of vendorIds) {
            const ids = await this.suspensionService.suspendForVendor(vendorId, { session });
            affectedProductIds.push(...ids);
        }
        return affectedProductIds;
    }

    private async restoreVendorDefaultProducts(agencyId: string, session: ClientSession): Promise<{ productId: string; status: ProductStatus }[]> {
        const vendorIds = await this.vendorRepo.findVendorIdsByDefaultAgency(agencyId, session);
        const restoredProducts: { productId: string; status: ProductStatus }[] = [];
        for (const vendorId of vendorIds) {
            const results = await this.suspensionService.restoreForVendor(vendorId, { session });
            restoredProducts.push(...results);
        }
        return restoredProducts;
    }

    /** Suspends every physical product (any vendor) whose OWN override points at this agency. */
    private async suspendProductOverrides(agencyId: string, session: ClientSession): Promise<string[]> {
        const products = await this.productRepo.findPhysicalByOwnDeliveryAgency(agencyId, { session });
        const affectedProductIds: string[] = [];
        for (const product of products) {
            const suspended = await this.suspensionService.suspendProductOwnAgency(product.id, product.vendorId, { session });
            if (suspended) affectedProductIds.push(product.id);
        }
        return affectedProductIds;
    }

    /** Restores every physical product (any vendor) suspended because its OWN override was this agency. */
    private async restoreProductOverrides(agencyId: string, session: ClientSession): Promise<{ productId: string; status: ProductStatus }[]> {
        const products = await this.productRepo.findPhysicalByOwnDeliveryAgency(agencyId, { session });
        const restored: { productId: string; status: ProductStatus }[] = [];
        for (const product of products) {
            const result = await this.suspensionService.restoreProductOwnAgency(product.id, product.vendorId, { session });
            if (result.restored && result.status) {
                restored.push({ productId: product.id, status: result.status });
            }
        }
        return restored;
    }
}
