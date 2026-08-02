import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { Product } from '../../repositories/mappers/product.mapper';
import { Variant } from '../../repositories/mappers/variant.mapper';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { IDeliveryAgency } from '../../../delivery/delivery-agency.model';
import { ConnectionRepository } from '../../../agency-connections/connection.repository';
import { AvailabilityRule } from '../../../booking/models/availability-rule.model';
import { PickupLocationValidationService } from './PickupLocationValidationService';
import { RepositoryOptions } from '../../repositories/types';
import { ProductStatus } from '../../models/product.model';
import { ActivationBlocker } from '../../read-models/product-detail.read-model';

/**
 * A blocker plus the AppError it came from. The error is kept so `validate()`
 * can rethrow the original object (identical code, message, status and details)
 * rather than reconstructing one — that identity is what makes the collector a
 * safe refactor of the throwing path. Strip `.error` before serialising: the
 * wire type is `ActivationBlocker`.
 */
export interface CollectedBlocker extends ActivationBlocker {
    error: AppError;
}

/** Drop the internal AppError so a blocker can be sent over the wire. */
export function toActivationBlocker(blocker: CollectedBlocker): ActivationBlocker {
    return { code: blocker.code, message: blocker.message, details: blocker.details };
}

/**
 * Status transitions a VENDOR may trigger (PATCH /:id/status and the bulk
 * endpoints). Everything absent is reserved:
 *   - `suspended` is a system/admin lock (delivery-agency cascade) — a vendor can
 *     never leave it directly. It clears only via the system restore paths
 *     (agency/connection/default fixed, or the product's own delivery.agencyId
 *     repointed at a working agency), which re-validate before reactivating.
 *   - `pending_review` belongs to admin moderation.
 *   - Activation happens from `draft` only; an `archived` product must be
 *     unarchived to `draft` first.
 * Same-status writes are treated as no-op-allowed by the assert, not listed here.
 */
export const VENDOR_STATUS_TRANSITIONS: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
    draft: ['active', 'archived'],
    active: ['draft', 'archived'],
    archived: ['draft'],
    pending_review: [],
    suspended: [],
};

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

    /**
     * Gate on WHERE a vendor-triggered status change may start from — see
     * VENDOR_STATUS_TRANSITIONS. `validate()` below checks the requirements of
     * the TARGET status; this checks the transition itself. System restore paths
     * deliberately bypass this (they reactivate FROM 'suspended', which no vendor
     * transition allows).
     */
    assertVendorTransition(product: Product, newStatus: ProductStatus): void {
        if (product.status === newStatus) return; // idempotent no-op
        if (!VENDOR_STATUS_TRANSITIONS[product.status].includes(newStatus)) {
            const message = product.status === 'suspended'
                ? 'This product was suspended by the system (delivery-agency issue). It cannot be reactivated manually — it is restored automatically once the underlying agency/connection problem is resolved.'
                : `A ${product.status} product cannot be moved to ${newStatus} directly.`;
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, message, {
                status: product.status,
                requested: newStatus,
            });
        }
    }

    /**
     * `options.session` matters when this runs inside a transaction that ALSO
     * wrote the state being validated (e.g. a restore cascade that just set a
     * new default agency, flipped a connection to 'active', or reactivated an
     * agency in the same transaction). Without the session, these reads see the
     * pre-transaction snapshot and the gate fails against stale state.
     *
     * Throws the FIRST unmet requirement. That is the same error, in the same
     * order, that this method has always thrown — it now delegates to
     * `collectActivationBlockers` so the rule list exists in exactly one place.
     * Callers that want the whole checklist (the simple-product endpoints) call
     * the collector directly instead of catching one 422 at a time.
     */
    async validate(product: Product, newStatus: string, options?: RepositoryOptions): Promise<void> {
        if (newStatus !== 'active') return;

        const blockers = await this.collectActivationBlockers(product, options);
        if (blockers.length > 0) {
            throw blockers[0].error;
        }
    }

    /**
     * Every unmet requirement between this product and `status: 'active'`, in the
     * order `validate()` would have thrown them — so `blockers[0].error` is
     * exactly the AppError the throwing path produces.
     *
     * Not a flat list: some checks are chains, and evaluating a dependent check
     * against unresolved state would report a second, misleading blocker. The
     * rules are:
     *   - the four product-level checks are independent and always evaluated;
     *   - the vendor-default agency chain (set → exists+active → connected) stops
     *     at its first failure, because the later links have nothing to read;
     *   - the product-override chain is separate and runs even if the default
     *     chain failed — they are independent requirements, not alternatives;
     *   - pickup-location VALIDITY is skipped unless a location is present and an
     *     effective agency was actually resolved.
     */
    async collectActivationBlockers(product: Product, options?: RepositoryOptions): Promise<CollectedBlocker[]> {
        const session = options?.session;
        const blockers: CollectedBlocker[] = [];
        const add = (error: AppError): void => { blockers.push({ code: error.code, message: error.message, details: error.details, error }); };

        if (!product.description?.trim()) {
            add(createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DESCRIPTION, 422));
        }

        const variants = await this.variantRepository.findByProduct(product.id, options);

        if (variants.length === 0) {
            add(createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS, 422, undefined, { type: product.type }));
        }

        for (const variant of variants) {
            if (variant.status !== 'active') continue;
            if (variant.price <= 0) {
                add(createAppError(ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE, 422, undefined, {
                    variant: variant.name || variant.sku,
                }));
            }
        }

        const defaultVariant = variants.find(
            v => v.id === product.defaultVariantId && v.status === 'active'
        );
        if (!defaultVariant) {
            add(createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT, 422, undefined, { type: product.type }));
        }

        if (product.type === 'physical') {
            const vendor = await this.vendorRepository.findById(product.vendorId, session);

            // Vendor-default agency chain. Each link needs the previous one's
            // result, so a failure ends the chain rather than cascading.
            let effectiveAgency: IDeliveryAgency | null = null;
            if (!vendor?.default_delivery_agency_id) {
                add(createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                    422,
                    'Physical products require an active default delivery agency on your vendor profile.',
                ));
            } else {
                const agency = await this.deliveryAgencyRepository.findById(vendor.default_delivery_agency_id.toString(), session);
                if (!agency || agency.status !== 'active') {
                    add(createAppError(
                        ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                        422,
                        'Your default delivery agency is not currently active. Set an active default delivery agency to activate physical products.',
                    ));
                } else {
                    const defaultConnection = await this.connectionRepository.findByVendorAndAgency(
                        product.vendorId,
                        vendor.default_delivery_agency_id.toString(),
                        session,
                    );
                    if (!defaultConnection || defaultConnection.status !== 'active') {
                        add(createAppError(
                            ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                            422,
                            'Your connection with this delivery agency needs to be approved (or reapproved) before this product can be activated.',
                        ));
                    } else {
                        effectiveAgency = agency;
                    }
                }
            }

            // A product's own override, if set, must independently be active too —
            // it doesn't replace the vendor-default check above, it's an extra one.
            if (product.delivery?.agencyId) {
                const overrideAgency = await this.deliveryAgencyRepository.findById(product.delivery.agencyId, session);
                if (!overrideAgency || overrideAgency.status !== 'active') {
                    add(createAppError(
                        ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                        422,
                        "This product's own delivery agency is not currently active.",
                    ));
                } else {
                    const overrideConnection = await this.connectionRepository.findByVendorAndAgency(
                        product.vendorId,
                        product.delivery.agencyId,
                        session,
                    );
                    if (!overrideConnection || overrideConnection.status !== 'active') {
                        add(createAppError(
                            ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
                            422,
                            "Your connection with this product's delivery agency needs to be approved (or reapproved) before this product can be activated.",
                        ));
                    } else {
                        // The override is what actually handles delivery when set —
                        // so it, not the vendor default, is what pickup is validated against.
                        effectiveAgency = overrideAgency;
                    }
                }
            }

            // The delivery agency needs to know where to collect this product from.
            // Checked against whichever agency actually ends up handling delivery
            // (the product's own override if set, otherwise the vendor default) —
            // the same resolution order used at order-creation time.
            if (!product.delivery?.pickupLocation) {
                add(createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_NO_PICKUP_LOCATION,
                    422,
                    'Physical products require a pickup location before they can be activated.',
                ));
            } else if (effectiveAgency && vendor) {
                // Skipped when no agency resolved: "is this pickup location compatible
                // with your agency" is unanswerable without one, and reporting it would
                // just restate the agency blocker in more confusing words.
                try {
                    this.pickupLocationValidationService.assertValid(product.delivery.pickupLocation, effectiveAgency, vendor);
                } catch (err) {
                    if (!(err instanceof AppError)) throw err;
                    add(err);
                }
            }
        }

        if (product.type === 'digital') {
            const activeVariants = variants.filter(v => v.status === 'active');

            if (activeVariants.length > 5) {
                add(createAppError(ERROR_CODES.CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED, 422));
            }

            for (const v of activeVariants) {
                if (!v.digitalConfig?.assetId) {
                    add(createAppError(
                        ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET,
                        422,
                        undefined,
                        { variant: v.name || v.sku },
                    ));
                }
            }
        }

        if (product.type === 'service') {
            // Service config + price live on the single default variant. Without a
            // default variant there is no config to check, so these are skipped —
            // the missing-default-variant blocker above already says what to fix.
            if (defaultVariant && !defaultVariant.serviceConfig?.durationMinutes) {
                add(createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_DURATION, 422));
            }
            // Capacity mode needs a seat count to be bookable.
            if (defaultVariant?.serviceConfig?.bookingMode === 'capacity'
                && !(defaultVariant.serviceConfig.maxBookings && defaultVariant.serviceConfig.maxBookings >= 1)) {
                add(createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_CAPACITY, 422));
            }
            // A service is only bookable if it has at least one active availability
            // rule defining when customers can book; otherwise availability is empty.
            const activeRules = await AvailabilityRule.countDocuments({
                productId: product.id,
                isActive: true,
                deletedAt: null,
            }).session(session ?? null);
            if (activeRules === 0) {
                add(createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY, 422));
            }
        }

        return blockers;
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
