import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { TransactionManager } from '../../../../core/database/transaction.manager';
import { logger } from '../../../../core/logging';
import { IFileReferenceRepository } from '../../repositories/interfaces/file-reference.repository.interface';
import { FileDeleteService } from './media/FileDeleteService';
import { evaluateProductDeletion, ProductDeleteFacts } from './product-permanent-delete.rule';
import { vectorisationService } from './VectorisationService';

// Models are imported by FILE, never through a module barrel: this service reaches into
// eight modules, and a barrel import is how this codebase has closed require cycles before
// (`modules/agents/index.ts`, "AuthService is not a constructor").
import { ProductModel } from '../../models/product.model';
import { ProductVariantModel } from '../../models/product-variant.model';
import { ProductOptionModel } from '../../models/product-option.model';
import { ProductOptionValueModel } from '../../models/product-option-value.model';
import { ShippingConfigModel } from '../../models/shipping-config.model';
import { ServiceConfigModel } from '../../models/service-config.model';
import { ServiceAvailabilityModel } from '../../models/service-availability.model';
import { DigitalAssetModel } from '../../models/digital-asset.model';
import { StockReservationModel } from '../../models/stock-reservation.model';
import { StockAuditLogModel } from '../../models/stock-audit-log.model';
import { AvailabilityRule } from '../../../booking/models/availability-rule.model';
import { Booking } from '../../../booking/models/booking.model';
import { OrderModel } from '../../../orders/order.model';
import { CustomerDigitalEntitlementModel } from '../../../digital-delivery/models/customer-digital-entitlement.model';
import { ReviewModel } from '../../../reviews/models/review.model';
import { NegotiationSessionModel } from '../../../negotiation/models/negotiation-session.model';
import { AgencyStockLevelModel } from '../../../inventory/models/agency-stock-level.model';
import { StockAdjustmentRequestModel } from '../../../stock-requests/models/stock-adjustment-request.model';
import { CartModel } from '../../../cart/models/cart.model';
import { WishlistItemModel } from '../../../customers/models/wishlist-item.model';
import { RecentlyViewedItemModel } from '../../../customers/models/recently-viewed-item.model';

export interface PermanentDeleteResult {
  productId: string;
  /** Files no longer referenced by anything once the product went — deleted after commit. */
  releasedFileIds: string[];
}

/**
 * Permanently delete a vendor's product — immediately, no soft delete, no `purgeAt`.
 *
 * The decision is `evaluateProductDeletion` (pure, in `product-permanent-delete.rule.ts`):
 * archived, and never ordered, booked, downloaded or reviewed. This class gathers the
 * facts and does the removal, and both happen in ONE transaction — so a checkout that
 * lands between the check and the delete either commits first and is seen, or conflicts
 * and the whole deletion is retried against the new state.
 *
 * ── What goes, and what deliberately stays ─────────────────────────────────────────
 * Goes: the product, its variants, options and option values, shipping and service
 * configuration, service availability and booking rules, its catalogue digital assets,
 * its file references, every cart line / wishlist row / recently-viewed row naming it,
 * finished negotiation sessions, spent or expired stock holds, its stock audit log,
 * resolved stock requests, and the agency inventory rows nobody ever counted.
 *
 * Stays: agency storage invoices and the agency stock movement ledger (the agency's
 * books), support tickets, vectorisation credit transactions and vendor revenue
 * aggregates. Each holds the id as history; none dereferences it to function.
 *
 * ── After the commit, best-effort ──────────────────────────────────────────────────
 * The AI-search index forgets the product (`removeFromIndex`, which needs no row), and
 * every file the product held that NOTHING ELSE references is deleted, bytes included.
 * A file still referenced elsewhere (a duplicated product shares its pictures) is left
 * alone. A failure here leaves the file to the lonely-file sweep, which reaches the same
 * end later; it never fails the request, because the product is already gone.
 */
export class ProductPermanentDeleteService {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly fileReferenceRepository: IFileReferenceRepository,
    private readonly fileDeleteService: FileDeleteService,
  ) { }

  async execute(productId: string, vendorId: string): Promise<PermanentDeleteResult> {
    if (!Types.ObjectId.isValid(productId)) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    const { vectorisedId, releasedFileIds } = await this.transactionManager.runInTransactionWithRetry(
      (session) => this.deleteInSession(productId, vendorId, session),
    );

    // ⚠ After the commit, never inside it: a rolled-back deletion must not leave the
    // index without a product that still exists.
    if (vectorisedId) void vectorisationService.removeFromIndex(productId, vectorisedId);

    const deletedFileIds = await this.deleteUnreferencedFiles(productId, releasedFileIds);
    return { productId, releasedFileIds: deletedFileIds };
  }

  private async deleteInSession(
    productId: string,
    vendorId: string,
    session: ClientSession,
  ): Promise<{ vectorisedId: string | null; releasedFileIds: string[] }> {
    const pid = new Types.ObjectId(productId);

    const product = await ProductModel.findOne({ _id: pid, vendorId, deletedAt: null })
      .select('status vectorisedDataId')
      .session(session)
      .lean();
    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    // Every variant, archived and soft-deleted ones included — they all go.
    const variantIds: Types.ObjectId[] = await ProductVariantModel.find({ productId: pid })
      .distinct('_id')
      .session(session);

    const blockers = evaluateProductDeletion(await this.gatherFacts(pid, product.status, variantIds, session));
    if (blockers.length > 0) {
      throw createAppError(
        ERROR_CODES.CATALOG_PRODUCT_DELETE_BLOCKED,
        422,
        undefined,
        { productId, blockers },
      );
    }

    // ── File references first, while the owning rows still name them ───────────────
    const assetIds: Types.ObjectId[] = await DigitalAssetModel.find({ productId: pid })
      .distinct('_id')
      .session(session);

    const released = new Set<string>();
    const release = async (entityType: 'product' | 'variant' | 'digital_asset', id: Types.ObjectId) => {
      const fileIds = await this.fileReferenceRepository.removeAllForEntity(entityType, id.toString(), { session });
      for (const fileId of fileIds) released.add(fileId);
    };
    await release('product', pid);
    for (const id of variantIds) await release('variant', id);
    for (const id of assetIds) await release('digital_asset', id);

    // ── The product's own configuration ─────────────────────────────────────────────
    const optionIds: Types.ObjectId[] = await ProductOptionModel.find({ productId: pid })
      .distinct('_id')
      .session(session);
    const serviceConfigIds: Types.ObjectId[] = await ServiceConfigModel.find({ productId: pid })
      .distinct('_id')
      .session(session);

    // Sequential, not Promise.all: operations sharing one transaction session must not
    // run concurrently.
    await ProductOptionValueModel.deleteMany({ optionId: { $in: optionIds } }, { session });
    await ProductOptionModel.deleteMany({ productId: pid }, { session });
    await ServiceAvailabilityModel.deleteMany({ serviceConfigId: { $in: serviceConfigIds } }, { session });
    await ServiceConfigModel.deleteMany({ productId: pid }, { session });
    await ShippingConfigModel.deleteMany({ productId: pid }, { session });
    await AvailabilityRule.deleteMany({ productId: pid }, { session });
    await DigitalAssetModel.deleteMany({ productId: pid }, { session });
    await StockAuditLogModel.deleteMany({ productId: pid }, { session });
    // Only spent, released or lapsed holds remain — a live one is a blocker above.
    await StockReservationModel.deleteMany({ productId: pid }, { session });

    // ── Other parties' pointers at it ───────────────────────────────────────────────
    // Only finished sessions remain — a live one is a blocker above.
    await NegotiationSessionModel.deleteMany({ product_id: pid }, { session });
    // Only resolved requests remain — a pending one is a blocker above.
    await StockAdjustmentRequestModel.deleteMany({ variant_id: { $in: variantIds } }, { session });
    // Only `derived` rows remain — a counted one is a blocker above. Derived rows carry
    // no movements, so the ledger invariant the reconciler checks cannot be disturbed.
    await AgencyStockLevelModel.deleteMany({ variant_id: { $in: variantIds }, source: 'derived' }, { session });
    await WishlistItemModel.deleteMany({ product_id: pid }, { session });
    await RecentlyViewedItemModel.deleteMany({ product_id: pid }, { session });
    await this.removeFromCarts(pid, session);

    // ── Last: the rows everything above pointed at ─────────────────────────────────
    await ProductVariantModel.deleteMany({ productId: pid }, { session });
    await ProductModel.deleteOne({ _id: pid, vendorId }, { session });

    return { vectorisedId: product.vectorisedDataId ?? null, releasedFileIds: [...released] };
  }

  private async gatherFacts(
    pid: Types.ObjectId,
    status: ProductDeleteFacts['status'],
    variantIds: Types.ObjectId[],
    session: ClientSession,
  ): Promise<ProductDeleteFacts> {
    const now = new Date();

    // ⚠ Every count below is ANY status and ANY `deletedAt`, on purpose: the bar is
    // "never sold", so a cancelled order or a deleted review still counts.
    const orderCount = await OrderModel.countDocuments({ 'items.product_id': pid }, { session });
    const bookingCount = await Booking.countDocuments({ productId: pid }, { session });
    const digitalEntitlementCount = await CustomerDigitalEntitlementModel.countDocuments({ productId: pid }, { session });
    const reviewCount = await ReviewModel.countDocuments(
      { $or: [{ subject_type: 'product', subject_id: pid }, { target_product_id: pid }] },
      { session },
    );
    const activeReservationCount = await StockReservationModel.countDocuments(
      { productId: pid, status: 'active', expiresAt: { $gt: now } },
      { session },
    );
    const liveNegotiationCount = await NegotiationSessionModel.countDocuments(
      {
        product_id: pid,
        $or: [
          { status: 'open', expires_at: { $gt: now } },
          { 'lock.consumed_at': null, 'lock.expires_at': { $gt: now } },
        ],
      },
      { session },
    );
    const countedAgencyStockRowCount = await AgencyStockLevelModel.countDocuments(
      { variant_id: { $in: variantIds }, source: 'counted' },
      { session },
    );
    const pendingStockRequestCount = await StockAdjustmentRequestModel.countDocuments(
      { variant_id: { $in: variantIds }, status: 'pending' },
      { session },
    );

    return {
      status,
      orderCount,
      bookingCount,
      digitalEntitlementCount,
      reviewCount,
      activeReservationCount,
      liveNegotiationCount,
      countedAgencyStockRowCount,
      pendingStockRequestCount,
    };
  }

  /**
   * Pull the product's lines out of every basket, then clear `productType` on any basket
   * that is now empty — the same document an emptied cart is everywhere else
   * (`CartService.removeFromCart`). Scoped to the carts that held it, so no unrelated
   * basket's `updatedAt` moves (the abandoned-cart sweep reads it).
   */
  private async removeFromCarts(pid: Types.ObjectId, session: ClientSession): Promise<void> {
    const cartIds: Types.ObjectId[] = await CartModel.find({ 'items.productId': pid })
      .distinct('_id')
      .session(session);
    if (cartIds.length === 0) return;

    await CartModel.updateMany({ _id: { $in: cartIds } }, { $pull: { items: { productId: pid } } }, { session });
    await CartModel.updateMany(
      { _id: { $in: cartIds }, items: { $size: 0 } },
      { $unset: { productType: 1 } },
      { session },
    );
  }

  /** After commit: delete every released file nothing references any more. Never throws. */
  private async deleteUnreferencedFiles(productId: string, fileIds: string[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const fileId of fileIds) {
      try {
        if ((await this.fileReferenceRepository.countByFile(fileId)) > 0) continue;
        await this.fileDeleteService.execute({ fileId });
        deleted.push(fileId);
      } catch (err) {
        logger().warn(
          { err, productId, fileId },
          'product permanent delete: file left to the lonely-file sweep',
        );
      }
    }
    return deleted;
  }
}
