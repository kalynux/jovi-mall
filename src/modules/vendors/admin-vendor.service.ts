import { ClientSession } from 'mongoose';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { ActorRef, actorStamp } from '../../core/types/actor-source.types';
import { TransactionManager, transactionManager } from '../../core/database/transaction.manager';
import { ProductPlatformSuspensionService } from '../catalog/domain/services/ProductPlatformSuspensionService';
import { IProductRepository } from '../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../catalog/repositories/mongo/variant.repository.mongo';
import { ProductStatusValidationService } from '../catalog/domain/services/ProductStatusValidationService';
import { ProductStatus } from '../catalog/models/product.model';
import { VendorSettingsRepository } from './repositories/vendor-settings.repository';
import { IVendor, VendorStatus } from './vendor.model';
import { VendorRepository } from './vendor.repository';
import { AdminUpdateVendorSettingsInput } from './admin-vendor.validator';
import {
  AdminProductDetailDto,
  AdminProductDetailResolver,
} from './read-models/admin-product-detail.resolver';

/**
 * Vendor administration — the write half of wi-admin's vendor domain.
 *
 * ── Why this lives here and not in wi-admin ───────────────────────────────────
 * wi-admin READS `vendors` directly (there is no invariant a query can break) and writes
 * it only through this service. What makes the write different is everything a
 * suspension touches beyond the column: it takes the vendor's entire catalogue off sale
 * in the same transaction, and the restore has to re-run the activation gate on each
 * listing rather than blindly republish it. A second writer would reproduce the status
 * change and miss all of that — silently. See `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md` D-2.
 *
 * ── What a vendor suspension deliberately does NOT do ─────────────────────────
 * It does not touch `User.status`. A person may hold `vendor` and `customer` on one
 * account, and closing their shop must not sign them out of their own shopping. That is
 * `AdminUserService`'s rule read from the other side: the two are separate axes with
 * separate meanings, and collapsing them makes reinstatement guess which was true before.
 *
 * ── What verification does NOT do, in this phase ──────────────────────────────
 * `kyc_details.legit_verified` gates nothing. It is surfaced to agencies through the
 * browse DTO and it is now settable and explicable, but no vendor behaviour depends on
 * it. Recorded here so nobody later assumes it was already enforced.
 */
export class AdminVendorService {
  constructor(
    private readonly vendorRepo: VendorRepository = new VendorRepository(),
    private readonly settingsRepo: VendorSettingsRepository = new VendorSettingsRepository(),
    private readonly suspensionService: ProductPlatformSuspensionService = new ProductPlatformSuspensionService(),
    private readonly productRepo: IProductRepository = new ProductRepositoryMongo(),
    private readonly statusValidationService: ProductStatusValidationService = new ProductStatusValidationService(
      new ProductRepositoryMongo(),
      new VariantRepositoryMongo(),
    ),
    private readonly txManager: TransactionManager = transactionManager,
    private readonly productDetail: AdminProductDetailResolver = new AdminProductDetailResolver(),
  ) { }

  private async getById(vendorId: string, session?: ClientSession): Promise<IVendor> {
    const vendor = await this.vendorRepo.findById(vendorId, session);
    if (!vendor) throw createAppError(ERROR_CODES.VENDOR_NOT_FOUND, 404, 'Vendor not found');
    return vendor;
  }

  /**
   * One listing, in full — the one READ on this surface.
   *
   * Every other read in this module is deliberately absent because wi-admin can query
   * `vendors`, `stores` and `products` itself. This one cannot be: it resolves file ids
   * to URLs through the storage provider and quotes the agency's storage rate through
   * `storage-fee.calculator.ts`, and neither may be duplicated in a second service. See
   * the header of `admin-product-detail.resolver.ts`.
   *
   * The vendor is checked FIRST so that "no such vendor" and "not this vendor's product"
   * are both 404s at the right moment — the ownership is the authorisation, and a caller
   * who guessed a product id must not learn it exists under somebody else.
   */
  async getProductDetail(vendorId: string, productId: string): Promise<AdminProductDetailDto> {
    await this.getById(vendorId);
    return this.productDetail.resolve(vendorId, productId);
  }

  /**
   * Suspend a vendor and take their catalogue off sale, in one transaction.
   *
   * Guarded on the current status: two administrators can hold one vendor's screen open,
   * and the loser of that race must be told the state moved rather than have their reason
   * silently overwrite the winner's.
   *
   * `suspended_from_status` records where to come back to. `Vendor.status` has three
   * values, so restoring is not the boolean flip it is on `User` — a fraudulent signup
   * suspended while still `pending_verification` must be reinstated to
   * `pending_verification`, not promoted past a verification step it never passed.
   */
  async suspend(
    vendorId: string,
    reason: string,
    actor: ActorRef,
  ): Promise<{ vendor: IVendor; suspendedProductIds: string[] }> {
    return this.txManager.runInTransaction(async (session) => {
      const vendor = await this.getById(vendorId, session);

      if (vendor.status === 'inactive') {
        throw createAppError(
          ERROR_CODES.VENDOR_STATUS_CONFLICT,
          409,
          'This vendor is already suspended',
          { expected: 'active or pending_verification', actual: vendor.status }
        );
      }

      const from = vendor.status as Exclude<VendorStatus, 'inactive'>;

      const updated = await this.vendorRepo.applyStatusChangeIfCurrent(
        vendorId,
        from,
        'inactive',
        {
          suspended_at: new Date(),
          suspended_reason: reason,
          suspended_from_status: from,
          ...actorStamp('suspended_by', actor),
        },
        session,
      );

      // The compare-and-set lost — another administrator moved the vendor between our
      // read and our write. Their state stands; ours is refused.
      if (!updated) {
        throw createAppError(
          ERROR_CODES.VENDOR_STATUS_CONFLICT,
          409,
          'This vendor’s status changed while you were working — reload and try again',
          { expected: from }
        );
      }

      const suspendedProductIds = await this.suspensionService.suspendForVendor(vendorId, { session });

      return { vendor: updated, suspendedProductIds };
    });
  }

  /**
   * Lift a vendor suspension and put back the listings this cascade took down.
   *
   * Clears the whole stamp, not part of it: a reason left behind describes a suspension
   * that no longer exists, and the next reader cannot tell that from a current one. The
   * durable record is wi-admin's audit row, which is append-only.
   *
   * A listing that fails the activation gate stays suspended — see
   * `ProductPlatformSuspensionService.restoreEligible`. So `restoredProducts` is
   * routinely SHORTER than the list `suspend` returned, and that is correct rather than
   * a partial failure.
   */
  async restore(vendorId: string): Promise<{
    vendor: IVendor;
    restoredProducts: { productId: string; status: ProductStatus }[];
  }> {
    return this.txManager.runInTransaction(async (session) => {
      const vendor = await this.getById(vendorId, session);

      if (vendor.status !== 'inactive') {
        throw createAppError(
          ERROR_CODES.VENDOR_STATUS_CONFLICT,
          409,
          'This vendor is not suspended',
          { expected: 'inactive', actual: vendor.status }
        );
      }

      // `?? 'active'` covers a row suspended before `suspended_from_status` existed, or
      // one edited by hand. Reinstating to `active` is the safe reading of a missing
      // value — it is where every suspension performed through this service began.
      const target = vendor.suspended_from_status ?? 'active';

      const updated = await this.vendorRepo.applyStatusChangeIfCurrent(
        vendorId,
        'inactive',
        target,
        {
          suspended_at: null,
          suspended_reason: null,
          suspended_from_status: null,
          suspended_by_user_id: null,
          suspended_by_source: 'platform',
          suspended_by_name: null,
        },
        session,
      );

      if (!updated) {
        throw createAppError(
          ERROR_CODES.VENDOR_STATUS_CONFLICT,
          409,
          'This vendor’s status changed while you were working — reload and try again',
          { expected: 'inactive' }
        );
      }

      // AFTER the status write, and inside the same session, so the activation gate
      // reads a vendor that is no longer `inactive`. Reversed, every product would be
      // refused by the very blocker this reinstatement just cleared.
      const restoredProducts = await this.suspensionService.restoreForVendor(vendorId, { session });

      return { vendor: updated, restoredProducts };
    });
  }

  /** Approve a vendor's business verification. */
  async approveKyc(vendorId: string, actor: ActorRef): Promise<IVendor> {
    return this.setKycVerdict(vendorId, 'verified', actor, null);
  }

  /** Reject it, with a reason the vendor can be shown. */
  async rejectKyc(vendorId: string, reason: string, actor: ActorRef): Promise<IVendor> {
    return this.setKycVerdict(vendorId, 'rejected', actor, reason);
  }

  /**
   * Both verdicts through one path, guarded on the current one.
   *
   * The guard is the same compare-and-set reasoning as the suspension's: two reviewers
   * can have the same vendor open, and the second must be told the decision was already
   * made rather than quietly overwrite it with the opposite one.
   */
  private async setKycVerdict(
    vendorId: string,
    verdict: 'verified' | 'rejected',
    actor: ActorRef,
    rejectionReason: string | null,
  ): Promise<IVendor> {
    const vendor = await this.getById(vendorId);
    const current = vendor.kyc_details?.status ?? 'pending';

    if (current === verdict) {
      throw createAppError(
        ERROR_CODES.VENDOR_KYC_STATUS_CONFLICT,
        409,
        verdict === 'verified'
          ? 'This vendor is already verified'
          : 'This vendor’s verification has already been rejected',
        { actual: current }
      );
    }

    const updated = await this.vendorRepo.setKycVerdict(vendorId, verdict, actor, rejectionReason);
    if (!updated) throw createAppError(ERROR_CODES.VENDOR_NOT_FOUND, 404, 'Vendor not found');
    return updated;
  }

  /**
   * Take one of a vendor's listings off sale as platform oversight.
   *
   * Its own suspension reason, not the vendor-level one, so that reinstating the vendor
   * can never republish a product an administrator removed on its merits.
   */
  async suspendProduct(
    vendorId: string,
    productId: string,
    note: string,
  ): Promise<{ productId: string }> {
    await this.getById(vendorId);

    const suspended = await this.suspensionService.suspendOneProduct(vendorId, productId, note);

    // False covers both "not this vendor's product" and "not currently on sale". The
    // second is the common one and the message says so; a 404 here would be wrong,
    // because the caller reached the product through the vendor it belongs to.
    if (!suspended) {
      throw createAppError(
        ERROR_CODES.VENDOR_PRODUCT_NOT_SUSPENDABLE,
        422,
        'That product is not currently on sale, so there is nothing to suspend'
      );
    }

    return { productId };
  }

  /**
   * Put one back.
   *
   * Refuses a product suspended for any other reason — a listing an agency took down
   * over unpaid storage is that agency's to release, and a listing suspended by the
   * vendor-level cascade comes back when the vendor does.
   */
  async restoreProduct(vendorId: string, productId: string): Promise<{ productId: string; status: ProductStatus }> {
    await this.getById(vendorId);

    const product = await this.productRepo.findById(productId, vendorId);
    if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');

    if (product.status !== 'suspended' || product.suspension?.reason !== 'platform_oversight') {
      throw createAppError(
        ERROR_CODES.VENDOR_PRODUCT_NOT_OVERSIGHT_SUSPENDED,
        422,
        'That product was not suspended by platform oversight, so this is not what lifts it',
        { reason: product.suspension?.reason ?? null }
      );
    }

    const result = await this.suspensionService.restoreOneProduct(vendorId, productId);

    // Blocked, not absent: the gate refused it. Report the checklist rather than a bare
    // no-op, because this is an explicit human action and the operator needs to know why.
    if (!result.restored) {
      const blockers = await this.collectBlockers(productId, vendorId);
      throw createAppError(
        ERROR_CODES.VENDOR_PRODUCT_UNSUSPEND_BLOCKED,
        422,
        'That product cannot go back on sale yet',
        { blockers }
      );
    }

    return { productId, status: result.status! };
  }

  /**
   * The checklist behind a refused restore.
   *
   * `collectActivationBlockers` rather than `validate`: an operator fixing a listing
   * needs every unmet requirement at once, not the first one repeatedly. Same choice
   * `INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` makes on the agency side, for the same reason —
   * this is an explicit human action, so silently skipping it would be worse than a 422.
   */
  private async collectBlockers(productId: string, vendorId: string): Promise<unknown[]> {
    const product = await this.productRepo.findById(productId, vendorId);
    if (!product) return [];

    const blockers = await this.statusValidationService.collectActivationBlockers(product);
    return blockers.map((b) => ({ code: b.code, message: b.message, details: b.details }));
  }

  /**
   * Change the platform-governed slice of a vendor's settings.
   *
   * Delegates to the vendor's own setters rather than writing the document, so the
   * vendor-facing path stays the single definition of how each field is persisted.
   * Which fields are reachable at all is decided by the validator, not here — see
   * `AdminUpdateVendorSettingsSchema` for the rule and for why commission is not among them.
   */
  async updateSettings(vendorId: string, input: AdminUpdateVendorSettingsInput): Promise<{
    autoCancelUnpaidDays: number;
    autoRedirectOrdersToAgency: boolean;
    autoRedirectThresholdAmount: number | null;
  }> {
    await this.getById(vendorId);

    if (input.autoCancelUnpaidDays !== undefined) {
      await this.settingsRepo.setAutoCancelUnpaidDays(vendorId, input.autoCancelUnpaidDays);
    }
    if (input.autoRedirectOrdersToAgency !== undefined) {
      await this.settingsRepo.setAutoRedirectOrdersToAgency(vendorId, input.autoRedirectOrdersToAgency);
    }
    if (input.autoRedirectThresholdAmount !== undefined) {
      await this.settingsRepo.setAutoRedirectThresholdAmount(vendorId, input.autoRedirectThresholdAmount);
    }

    const settings = await this.settingsRepo.getOrCreate(vendorId);
    return {
      autoCancelUnpaidDays: settings.auto_cancel_unpaid_days ?? 3,
      autoRedirectOrdersToAgency: settings.auto_redirect_orders_to_agency ?? false,
      autoRedirectThresholdAmount: settings.auto_redirect_threshold_amount ?? null,
    };
  }
}

/**
 * What a vendor looks like on the internal admin API.
 *
 * A named projection, never the document. `payout_details` and
 * `kyc_details.national_id_number` are on `IVendor`, and a handler that returned the
 * vendor directly would ship a bank account number and a national identity number to a
 * dashboard that has no business holding either. Naming the fields is the lock that
 * survives somebody adding a sensitive field to the schema next year.
 */
export interface AdminVendorDto {
  id: string;
  userId: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  status: string;
  suspension: {
    at: string | null;
    reason: string | null;
    fromStatus: string | null;
    by: { id: string | null; source: string; name: string | null };
  } | null;
  verification: {
    status: string;
    verified: boolean;
    rejectionReason: string | null;
    verifiedAt: string | null;
    reviewedBy: { id: string | null; source: string; name: string | null } | null;
  };
  onboardingStep: number;
  createdAt: string;
  updatedAt: string;
}

export function toAdminVendorDto(vendor: IVendor): AdminVendorDto {
  const suspended = vendor.status === 'inactive';
  const kyc = vendor.kyc_details;
  const reviewed = (kyc?.status ?? 'pending') !== 'pending';

  return {
    id: vendor.id,
    userId: vendor.user_id.toString(),
    displayName: vendor.display_name ?? null,
    email: vendor.email ?? null,
    phone: vendor.phone ?? null,
    country: vendor.country ?? null,
    status: vendor.status,
    // Present only while suspended. An active vendor carrying a stale reason reads as
    // suspended on any screen that renders the block without checking status first.
    suspension: suspended
      ? {
          at: vendor.suspended_at ? vendor.suspended_at.toISOString() : null,
          reason: vendor.suspended_reason ?? null,
          fromStatus: vendor.suspended_from_status ?? null,
          by: {
            id: vendor.suspended_by_user_id ? vendor.suspended_by_user_id.toString() : null,
            source: vendor.suspended_by_source ?? 'platform',
            name: vendor.suspended_by_name ?? null,
          },
        }
      : null,
    verification: {
      status: kyc?.status ?? 'pending',
      verified: kyc?.legit_verified === true,
      rejectionReason: kyc?.rejection_reason ?? null,
      verifiedAt: kyc?.verified_at ? kyc.verified_at.toISOString() : null,
      reviewedBy: reviewed
        ? {
            id: kyc?.reviewed_by_user_id ? kyc.reviewed_by_user_id.toString() : null,
            source: kyc?.reviewed_by_source ?? 'platform',
            name: kyc?.reviewed_by_name ?? null,
          }
        : null,
    },
    onboardingStep: vendor.onboarding_step,
    createdAt: vendor.created_at.toISOString(),
    updatedAt: vendor.updated_at.toISOString(),
  };
}
