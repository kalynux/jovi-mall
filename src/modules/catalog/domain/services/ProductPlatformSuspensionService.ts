import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../repositories/mongo/variant.repository.mongo';
import { Product } from '../../repositories/mappers/product.mapper';
import { ProductStatus, ProductType } from '../../models/product.model';
import { RepositoryOptions } from '../../repositories/types';
import { ProductStatusValidationService } from './ProductStatusValidationService';

/** Every type. A vendor suspension is not about delivery — see the class header. */
const ALL_TYPES: ProductType[] = ['physical', 'digital', 'service'];

const VENDOR_SUSPENDED_REASON = 'vendor_suspended' as const;
const PLATFORM_OVERSIGHT_REASON = 'platform_oversight' as const;

/**
 * Suspends and restores products on behalf of the PLATFORM — wi-admin's two vendor
 * oversight levers, as opposed to the delivery-agency cascades next door.
 *
 * ── Two reasons, not one, and they are deliberately disjoint ──────────────────
 * `vendor_suspended` is a system cascade: it follows the vendor's own status and is
 * reversed by reinstating them. `platform_oversight` is a human act on ONE listing —
 * a counterfeit, say — and nothing automatic may ever clear it, including the vendor
 * restore. Sharing a reason would mean suspending and reinstating a vendor silently
 * republished a product an administrator had taken down on its merits.
 *
 * That gives the codebase four disjoint reason sets, and none may be widened to
 * include another's members:
 *
 *   DELIVERY_AGENCY_REASONS   3 members   ProductDeliveryAgencySuspensionService
 *   agency_storage_suspended  1 member    AgencyStorageSuspensionService
 *   vendor_suspended          1 member    here
 *   platform_oversight        1 member    here
 *
 * ── Why this one covers every product type ────────────────────────────────────
 * The delivery-agency cascade is physical-only because it is about delivery, and a
 * digital download has no agency to break. A vendor suspension is about the vendor, so
 * a "suspended" vendor whose downloads and bookable services kept selling would not be
 * suspended in any sense a customer could observe.
 *
 * ── What keeps a restore honest ───────────────────────────────────────────────
 * `restoreEligible` re-runs the activation gate before flipping anything back to
 * `active`, exactly as its delivery-agency counterpart does: a product can go stale
 * while it is off sale, and a blind restore would publish one the gate would refuse.
 * The gate now also refuses while the VENDOR is suspended
 * (`collectActivationBlockers`), which is what stops the other cascades republishing a
 * suspended vendor's listings behind this service's back.
 */
export class ProductPlatformSuspensionService {
    constructor(
        private readonly productRepository: IProductRepository = new ProductRepositoryMongo(),
        private readonly statusValidationService: ProductStatusValidationService = new ProductStatusValidationService(
            new ProductRepositoryMongo(),
            new VariantRepositoryMongo(),
        ),
    ) { }

    /**
     * Take every one of a vendor's on-sale products off sale, capturing each one's own
     * status so it can be restored to exactly that.
     *
     * Non-active products are left alone — the same rule the agency cascade states:
     * they cannot reach `active` without passing the activation gate anyway, and
     * suspending them would only lock the vendor out of editing them.
     */
    async suspendForVendor(vendorId: string, options?: RepositoryOptions): Promise<string[]> {
        return this.productRepository.suspendAllVendorProducts(vendorId, VENDOR_SUSPENDED_REASON, options);
    }

    /**
     * Put back the products THIS cascade took down, and only those.
     *
     * Scoped to `vendor_suspended` alone: a product suspended by its agency over unpaid
     * storage, or by a broken delivery agency, is that other party's to release. Anything
     * still blocked by the activation gate stays suspended.
     */
    async restoreForVendor(
        vendorId: string,
        options?: RepositoryOptions,
    ): Promise<{ productId: string; status: ProductStatus }[]> {
        const candidates = await this.productRepository.findSuspendedByVendorAndReasons(
            vendorId,
            [VENDOR_SUSPENDED_REASON],
            options,
            ALL_TYPES,
        );
        return this.restoreEligible(candidates, options);
    }

    /**
     * Take ONE listing off sale as platform oversight.
     *
     * Returns false when the product is not currently `active` — which is a real answer,
     * not a failure: a draft is not on sale, and a product already suspended for another
     * reason is already off it. The caller turns that into
     * `VENDOR_PRODUCT_NOT_SUSPENDABLE`.
     */
    async suspendOneProduct(
        vendorId: string,
        productId: string,
        note: string | null,
        options?: RepositoryOptions,
    ): Promise<boolean> {
        return this.productRepository.suspendProduct(
            productId,
            vendorId,
            PLATFORM_OVERSIGHT_REASON,
            options,
            // No agency id: there is no agency. The record of WHICH administrator did
            // this is the wi-admin audit row — `note` is what the vendor is shown.
            { note },
            ALL_TYPES,
        );
    }

    /**
     * Lift a platform-oversight suspension.
     *
     * Refuses anything suspended for a different reason, mirroring the guard in
     * `ProductDeliveryAgencySuspensionService.restoreProductOwnAgency`. The reason IS
     * the authorisation here: it is what stops this endpoint releasing a product an
     * agency suspended over unpaid storage.
     *
     * `blocked` distinguishes "the gate refused it" from "there was nothing to restore",
     * so the caller can return the blocker checklist rather than a bare no-op.
     */
    async restoreOneProduct(
        vendorId: string,
        productId: string,
        options?: RepositoryOptions,
    ): Promise<{ restored: boolean; blocked: boolean; status?: ProductStatus }> {
        const product = await this.productRepository.findById(productId, vendorId, options);

        if (
            !product
            || product.status !== 'suspended'
            || product.suspension?.reason !== PLATFORM_OVERSIGHT_REASON
        ) {
            return { restored: false, blocked: false };
        }

        const results = await this.restoreEligible([product], options);
        return results.length > 0
            ? { restored: true, blocked: false, status: results[0].status }
            : { restored: false, blocked: true };
    }

    /**
     * Restore every candidate whose previous status was not `active` unconditionally;
     * for the ones that WERE active, re-run the activation gate first and leave anything
     * that still fails suspended.
     *
     * Lifted from `ProductDeliveryAgencySuspensionService.restoreEligible` rather than
     * shared, because the two differ in the reasons they sweep and nothing else — and a
     * shared helper parameterised on the reason set would be one edit away from letting
     * one cascade lift the other's suspensions.
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
                    // `options` carries the session: a restore runs inside the same
                    // transaction that just reinstated the vendor, and the gate must see
                    // that in-session write — otherwise it reads the pre-transaction
                    // snapshot, still finds the vendor `inactive`, and refuses every
                    // product the reinstatement was supposed to bring back.
                    await this.statusValidationService.validate(product, 'active', options);
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
