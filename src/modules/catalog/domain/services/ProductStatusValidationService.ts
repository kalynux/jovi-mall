import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { Product } from '../../repositories/mappers/product.mapper';
import { Variant } from '../../repositories/mappers/variant.mapper';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { ConnectionRepository } from '../../../agency-connections/connection.repository';
import { AvailabilityRule } from '../../../booking/models/availability-rule.model';
import { PickupLocationValidationService } from './PickupLocationValidationService';

/**
 * ProductStatusValidationService: Validates product status transitions based on business rules.
 *
 * Activation gate for `physical` products: the vendor must have an active default delivery
 * agency (vendor.default_delivery_agency_id, resolving to a DeliveryAgency with status
 * === 'active'). A product-level delivery.agencyId override does NOT bypass this requirement —
 * the vendor default is always checked. If the product ALSO has its own override set, that
 * override must independently be active too — both conditions are enforced, not either/or.
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
        private readonly deliveryAgencyRepository: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
        private readonly connectionRepository: ConnectionRepository = new ConnectionRepository(),
        private readonly pickupLocationValidationService: PickupLocationValidationService = new PickupLocationValidationService(),
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
            const vendor = await this.vendorRepository.findById(product.vendorId);
            if (!vendor?.default_delivery_agency_id) {
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                    422,
                    'Physical products require an active default delivery agency on your vendor profile.',
                );
            }

            const agency = await this.deliveryAgencyRepository.findById(vendor.default_delivery_agency_id.toString());
            if (!agency || agency.status !== 'active') {
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                    422,
                    'Your default delivery agency is not currently active. Set an active default delivery agency to activate physical products.',
                );
            }

            const defaultConnection = await this.connectionRepository.findByVendorAndAgency(
                product.vendorId,
                vendor.default_delivery_agency_id.toString(),
            );
            if (!defaultConnection || defaultConnection.status !== 'active') {
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                    422,
                    'Your connection with this delivery agency needs to be approved (or reapproved) before this product can be activated.',
                );
            }

            // A product's own override, if set, must independently be active too —
            // it doesn't replace the vendor-default check above, it's an extra one.
            let effectiveAgency = agency;
            if (product.delivery?.agencyId) {
                const overrideAgency = await this.deliveryAgencyRepository.findById(product.delivery.agencyId);
                if (!overrideAgency || overrideAgency.status !== 'active') {
                    throw createAppError(
                        ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                        422,
                        "This product's own delivery agency is not currently active.",
                    );
                }

                const overrideConnection = await this.connectionRepository.findByVendorAndAgency(
                    product.vendorId,
                    product.delivery.agencyId,
                );
                if (!overrideConnection || overrideConnection.status !== 'active') {
                    throw createAppError(
                        ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                        422,
                        "Your connection with this product's delivery agency needs to be approved (or reapproved) before this product can be activated.",
                    );
                }
                effectiveAgency = overrideAgency;
            }

            // The delivery agency needs to know where to collect this product from.
            // Checked against whichever agency actually ends up handling delivery
            // (the product's own override if set, otherwise the vendor default) —
            // the same resolution order used at order-creation time.
            if (!product.delivery?.pickupLocation) {
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_NO_PICKUP_LOCATION,
                    422,
                    'Physical products require a pickup location before they can be activated.',
                );
            }
            this.pickupLocationValidationService.assertValid(product.delivery.pickupLocation, effectiveAgency, vendor);
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
