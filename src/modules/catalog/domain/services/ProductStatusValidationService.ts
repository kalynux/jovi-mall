import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { Product } from '../../repositories/mappers/product.mapper';
import { Variant } from '../../repositories/mappers/variant.mapper';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { AvailabilityRule } from '../../../booking/models/availability-rule.model';

/**
 * ProductStatusValidationService: Validates product status transitions based on business rules.
 *
 * Activation gate for `physical` products: there must be a resolvable delivery agency,
 * either set on the product (product.delivery.agencyId) or on the vendor profile
 * (vendor.default_delivery_agency_id). Without one of these, OrderService.createOrderFromCart
 * would refuse the order at checkout.
 *
 * Activation gate for `service` products: the default variant's serviceConfig must carry a
 * duration (and a seat count for capacity mode), and the product must have at least one active
 * availability rule — without one, the booking availability window is always empty.
 */
export class ProductStatusValidationService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository,
        private readonly vendorRepository: VendorRepository = new VendorRepository(),
    ) { }

    async validate(product: Product, newStatus: string): Promise<void> {
        if (newStatus !== 'active') return;

        if (!product.description?.trim()) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DESCRIPTION, 422);
        }

        const variants = await this.variantRepository.findByProduct(product.id);

        if (variants.length === 0) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS, 422, undefined, { type: product.type });
        }

        for (const variant of variants) {
            if (variant.status !== 'active') continue;
            if (variant.price <= 0) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE, 422, undefined, {
                    variant: variant.name || variant.sku,
                });
            }
        }

        const defaultVariant = variants.find(
            v => v.id === product.defaultVariantId && v.status === 'active'
        );
        if (!defaultVariant) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT, 422, undefined, { type: product.type });
        }

        if (product.type === 'physical') {
            const hasProductAgency = !!product.delivery?.agencyId;
            if (!hasProductAgency) {
                const vendor = await this.vendorRepository.findById(product.vendorId);
                const hasVendorDefault = !!vendor?.default_delivery_agency_id;
                if (!hasVendorDefault) {
                    throw createAppError(
                        ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                        422,
                        'Physical products require a delivery agency. Set one on the product, or configure a default delivery agency on your vendor profile.',
                    );
                }
            }
        }

        if (product.type === 'digital') {
            const activeVariants = variants.filter(v => v.status === 'active');

            if (activeVariants.length > 5) {
                throw createAppError(
                    ERROR_CODES.CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED,
                    422,
                );
            }

            for (const v of activeVariants) {
                if (!v.digitalConfig?.assetId) {
                    throw createAppError(
                        ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET,
                        422,
                        undefined,
                        { variant: v.name || v.sku },
                    );
                }
            }
        }

        if (product.type === 'service') {
            // Service config + price live on the single default variant.
            if (!defaultVariant.serviceConfig?.durationMinutes) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_DURATION, 422);
            }
            // Capacity mode needs a seat count to be bookable.
            if (defaultVariant.serviceConfig.bookingMode === 'capacity'
                && !(defaultVariant.serviceConfig.maxBookings && defaultVariant.serviceConfig.maxBookings >= 1)) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_CAPACITY, 422);
            }
            // A service is only bookable if it has at least one active availability
            // rule defining when customers can book; otherwise availability is empty.
            const activeRules = await AvailabilityRule.countDocuments({
                productId: product.id,
                isActive: true,
                deletedAt: null,
            });
            if (activeRules === 0) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY, 422);
            }
        }
    }

    /**
     * Per-variant activation gate. Mirrors the variant-level rules enforced by
     * `validate()` when promoting a product to active, so vendors can re-activate
     * a single variant (e.g. coming back from a temporary stock shortage) without
     * surprising failures later when the product is recomputed.
     *
     * Rules for activating a variant:
     *   - Variant price must be > 0.
     *   - Digital variants require an uploaded asset (`digitalConfig.assetId`).
     *   - Service variants require a serviceConfig with a duration.
     *
     * Archiving is always allowed and has no preconditions here.
     */
    async validateVariantActivation(product: Product, variant: Variant): Promise<void> {
        if (variant.price <= 0) {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE,
                422,
                undefined,
                { variant: variant.name || variant.sku },
            );
        }

        if (product.type === 'digital' && !variant.digitalConfig?.assetId) {
            throw createAppError(
                ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET,
                422,
                undefined,
                { variant: variant.name || variant.sku },
            );
        }

        if (product.type === 'service' && !variant.serviceConfig?.durationMinutes) {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_DURATION,
                422,
                undefined,
                { variant: variant.name || variant.sku },
            );
        }

        if (product.type === 'service'
            && variant.serviceConfig?.bookingMode === 'capacity'
            && !(variant.serviceConfig.maxBookings && variant.serviceConfig.maxBookings >= 1)) {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_CAPACITY,
                422,
                undefined,
                { variant: variant.name || variant.sku },
            );
        }
    }

    /**
     * If the product is currently `active` but no longer satisfies the activation
     * gate (e.g., a digital variant just had its asset removed, the description
     * was cleared, the default variant was archived, a delivery agency was unset),
     * demote it to `draft`. No-op for products that are not currently active or
     * that still pass validation.
     *
     * Wired into mutation paths that can break the active-state invariant —
     * variant archive/update, digital-asset removal, product update.
     *
     * Returns true if the product was demoted, false otherwise.
     */
    async revalidateActiveStatus(productId: string, vendorId: string): Promise<boolean> {
        const product = await this.productRepository.findById(productId, vendorId);
        if (!product || product.status !== 'active') return false;

        try {
            await this.validate(product, 'active');
            return false;
        } catch (err) {
            if (err instanceof AppError && err.statusCode === 422) {
                await this.productRepository.update(productId, vendorId, { status: 'draft' });
                return true;
            }
            throw err;
        }
    }
}
