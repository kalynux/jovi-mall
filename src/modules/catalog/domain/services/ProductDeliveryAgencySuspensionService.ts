import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../repositories/mongo/variant.repository.mongo';
import { Product } from '../../repositories/mappers/product.mapper';
import { ProductStatus } from '../../models/product.model';
import { RepositoryOptions } from '../../repositories/types';
import { ProductStatusValidationService } from './ProductStatusValidationService';

const DEFAULT_AGENCY_REASON = 'default_delivery_agency_removed' as const;
const PRODUCT_AGENCY_REASON = 'product_delivery_agency_removed' as const;
// Both reasons are delivery-agency-related and can each independently block or
// unblock the SAME product — a product suspended under one reason must still be
// discoverable when the OTHER reason's fix runs, otherwise it can get stuck
// suspended forever even after both underlying issues are resolved. Restoration
// itself stays safe either way, since restoreEligible always re-validates before
// flipping to 'active'.
const DELIVERY_AGENCY_REASONS = [DEFAULT_AGENCY_REASON, PRODUCT_AGENCY_REASON] as const;

/**
 * Suspends/restores physical products in response to a delivery agency becoming
 * unusable/usable again — either the vendor's default agency (suspends every
 * physical product of that vendor) or a single product's own delivery.agencyId
 * override (suspends just that product).
 *
 * A product can be suspended for either reason independently, so restoring to
 * 'active' is never blind: it re-runs the (agency-aware) activation gate first,
 * and only flips status if it passes — otherwise the product stays suspended,
 * since the OTHER reason could still be broken. Non-'active' previous statuses
 * (draft/archived/pending_review) restore directly; they don't need agency
 * validation.
 */
export class ProductDeliveryAgencySuspensionService {
    constructor(
        private readonly productRepository: IProductRepository = new ProductRepositoryMongo(),
        private readonly statusValidationService: ProductStatusValidationService = new ProductStatusValidationService(
            new ProductRepositoryMongo(),
            new VariantRepositoryMongo(),
        ),
    ) { }

    /** Suspends all of the vendor's physical products, capturing each one's current status. */
    async suspendForVendor(vendorId: string, options?: RepositoryOptions): Promise<string[]> {
        return this.productRepository.suspendVendorPhysicalProducts(vendorId, DEFAULT_AGENCY_REASON, options);
    }

    /**
     * Restores the vendor's products suspended for either delivery-agency reason,
     * where eligible. Swept together (not just DEFAULT_AGENCY_REASON) because a
     * product suspended for its OWN override could equally be unblocked by this
     * vendor-default fix if its own override happens to be fine now too — the
     * re-validation in restoreEligible is what actually decides, this just makes
     * sure such a product isn't skipped outright.
     */
    async restoreForVendor(
        vendorId: string,
        options?: RepositoryOptions,
    ): Promise<{ productId: string; status: ProductStatus }[]> {
        const candidates = await this.productRepository.findSuspendedByVendorAndReasons(vendorId, [...DELIVERY_AGENCY_REASONS], options);
        return this.restoreEligible(candidates, options);
    }

    /** Suspends a single product because ITS OWN delivery-agency override went inactive. */
    async suspendProductOwnAgency(productId: string, vendorId: string, options?: RepositoryOptions): Promise<boolean> {
        return this.productRepository.suspendProduct(productId, vendorId, PRODUCT_AGENCY_REASON, options);
    }

    /**
     * Restores a single product suspended for either delivery-agency reason, if
     * eligible (see restoreForVendor for why both reasons are considered here).
     */
    async restoreProductOwnAgency(
        productId: string,
        vendorId: string,
        options?: RepositoryOptions,
    ): Promise<{ restored: boolean; status?: ProductStatus }> {
        const product = await this.productRepository.findById(productId, vendorId, options);
        if (!product || product.status !== 'suspended' || !product.suspension || !(DELIVERY_AGENCY_REASONS as readonly string[]).includes(product.suspension.reason)) {
            return { restored: false };
        }

        const results = await this.restoreEligible([product], options);
        return results.length > 0 ? { restored: true, status: results[0].status } : { restored: false };
    }

    /**
     * Restores every product in `candidates` (already known to be suspended) whose
     * previousStatus isn't 'active', unconditionally; for ones whose previousStatus
     * IS 'active', re-validates the activation gate first and skips (leaves
     * suspended) any that still fail — e.g. the other agency reason is still broken.
     */
    private async restoreEligible(
        candidates: Product[],
        options?: RepositoryOptions,
    ): Promise<{ productId: string; status: ProductStatus }[]> {
        const restored: { productId: string; status: ProductStatus }[] = [];

        for (const product of candidates) {
            if (!product.suspension) continue;
            const targetStatus = product.suspension.previousStatus;

            if (targetStatus === 'active') {
                try {
                    await this.statusValidationService.validate(product, 'active');
                } catch {
                    continue; // Still blocked by something else — leave suspended.
                }
            }

            await this.productRepository.update(
                product.id,
                product.vendorId,
                { status: targetStatus, suspension: null } as Partial<Product>,
                options,
            );
            restored.push({ productId: product.id, status: targetStatus });
        }

        return restored;
    }
}
