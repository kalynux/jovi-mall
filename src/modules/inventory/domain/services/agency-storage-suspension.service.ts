import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../../catalog/repositories/mongo/variant.repository.mongo';
import { Product } from '../../../catalog/repositories/mappers/product.mapper';
import {
  ProductStatusValidationService,
  toActivationBlocker,
} from '../../../catalog/domain/services/ProductStatusValidationService';
import { emitStorageProductEvent } from './storage-product.events';

const AGENCY_STORAGE_REASON = 'agency_storage_suspended' as const;

export interface SuspensionResult {
  productId: string;
  status: string;
  note: string | null;
}

/**
 * The agency's manual lever over a product it warehouses.
 *
 * ## Why this exists, and what it is not
 *
 * The platform does **not** track storage payment (see
 * `storage-fee.calculator.ts`) and nothing here is automatic. Rent going unpaid is
 * settled out-of-band; what the agency needed was a way to act on it. Suspending
 * takes the product off the storefront — a real consequence, not a badge — and only
 * the agency that suspended can lift it.
 *
 * ## How it coexists with the delivery-agency cascade
 *
 * Both use `Product.status = 'suspended'` and the same `suspension` sub-document,
 * distinguished only by `reason`. Two properties keep them from interfering, and
 * both are load-bearing:
 *
 *   1. `ProductDeliveryAgencySuspensionService`'s restore paths are scoped to
 *      `DELIVERY_AGENCY_REASONS`, a closed list that does **not** include
 *      `agency_storage_suspended`. So a vendor fixing their default agency can never
 *      silently un-suspend a product an agency switched off over unpaid rent.
 *      **Do not widen that list.**
 *   2. `suspendVendorPhysicalProducts` only touches `status: 'active'`, so an
 *      already-storage-suspended product is skipped by that cascade — and if the
 *      vendor's agency breaks in the meantime, the unsuspend below re-runs the
 *      activation gate and correctly refuses. Correct by construction.
 */
export class AgencyStorageSuspensionService {
  constructor(
    private readonly products: IProductRepository = new ProductRepositoryMongo(),
    private readonly statusValidation: ProductStatusValidationService = new ProductStatusValidationService(
      new ProductRepositoryMongo(),
      new VariantRepositoryMongo(),
    ),
  ) { }

  /**
   * Take the product off the storefront.
   *
   * `vendorId` comes from the caller's stock row, which is how ownership was already
   * established — this service does not re-authorise.
   */
  async suspend(
    agencyId: string,
    productId: string,
    vendorId: string,
    note: string | null,
  ): Promise<SuspensionResult> {
    const suspended = await this.products.suspendProduct(
      productId,
      vendorId,
      AGENCY_STORAGE_REASON,
      undefined,
      { agencyId, note },
    );

    // `suspendProduct` compare-and-sets on `status: 'active'`, so a false return
    // means the product was draft, archived, already suspended, or mid-vectorisation.
    // Non-active products are deliberately left alone (the same rule the cascade
    // follows): they are not on sale, so suspending them would only block editing.
    if (!suspended) {
      throw createAppError(
        ERROR_CODES.INVENTORY_PRODUCT_NOT_SUSPENDABLE,
        422,
        'Only a published product can be suspended. This one is not currently active.',
      );
    }

    emitStorageProductEvent('storage.product_suspended', {
      productId,
      vendorId,
      agencyId,
      note,
    });

    return { productId, status: 'suspended', note };
  }

  /**
   * Put it back — but only if it can actually go back.
   *
   * The activation gate is re-run rather than trusted, exactly as
   * `ProductDeliveryAgencySuspensionService.restoreEligible` does: the product may
   * have gone stale while it was off sale (the vendor's connection lapsed, a variant
   * was archived, a variant was flipped to unlimited stock). Unlike that cascade,
   * which silently skips, this is an explicit human action — so a failure comes back
   * as a 422 carrying the whole blocker checklist rather than a silent no-op the
   * agency would read as "the button is broken".
   */
  async unsuspend(agencyId: string, productId: string, vendorId: string): Promise<SuspensionResult> {
    const product = await this.products.findById(productId, vendorId);
    if (!product) {
      throw createAppError(
        ERROR_CODES.INVENTORY_PRODUCT_NOT_STORED_HERE,
        404,
        'No agency-storage arrangement was found for this product.',
      );
    }

    this.assertOwnSuspension(product, agencyId);

    const previousStatus = product.suspension!.previousStatus;

    // Only a product that was ACTIVE has to clear the gate. One that was suspended
    // out of `draft` (a legacy row, before the active-only rule) simply goes back —
    // a draft has nothing to be blocked from.
    if (previousStatus === 'active') {
      const blockers = await this.statusValidation.collectActivationBlockers(product);
      if (blockers.length > 0) {
        throw createAppError(
          ERROR_CODES.INVENTORY_PRODUCT_UNSUSPEND_BLOCKED,
          422,
          'This product cannot go back on sale yet — the vendor has to resolve the issues below first.',
          { blockers: blockers.map(toActivationBlocker) },
        );
      }
    }

    await this.products.update(productId, vendorId, {
      status: previousStatus,
      suspension: null,
    } as Partial<Product>);

    emitStorageProductEvent('storage.product_unsuspended', {
      productId,
      vendorId,
      agencyId,
      note: null,
    });

    return { productId, status: previousStatus, note: null };
  }

  /**
   * Only the agency that suspended may lift it, and only its own kind of suspension.
   *
   * Both halves matter. Without the reason check, an agency could clear a
   * delivery-agency cascade suspension and put a product back on sale whose
   * fulfilment is genuinely broken. Without the agency-id check, agency B could lift
   * agency A's leverage over a vendor they both serve.
   */
  private assertOwnSuspension(product: Product, agencyId: string): void {
    const suspension = product.suspension;
    const isOwn =
      product.status === 'suspended' &&
      suspension?.reason === AGENCY_STORAGE_REASON &&
      suspension.suspendedByAgencyId === agencyId;

    if (!isOwn) {
      throw createAppError(
        ERROR_CODES.INVENTORY_PRODUCT_NOT_AGENCY_SUSPENDED,
        422,
        product.status !== 'suspended'
          ? 'This product is not suspended.'
          : 'This suspension was not applied by you, so it is not yours to lift.',
        { status: product.status, reason: suspension?.reason ?? null },
      );
    }
  }
}

export const agencyStorageSuspensionService = new AgencyStorageSuspensionService();
