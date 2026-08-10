import { IProductRepository } from '../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { Product } from '../../catalog/repositories/mappers/product.mapper';
import { isWarehousedBy, resolveEffectiveAgencyId } from '../../catalog/domain/services/effective-delivery-agency';
import { VendorRepository } from '../../vendors/vendor.repository';

import { StockRequestDto } from '../dto/stock-adjustment-request.dto';
import { StockRequestService, stockRequestService } from './stock-request.service';

/** A vendor's attempt to move stock, before we know whether they may. */
export interface StockChangeIntent {
  productId: string;
  variantId: string;
  vendorId: string;
  userId: string | null;
  /** Absolute target. Omitted when only `isInfiniteStock` is being changed. */
  quantity?: number;
  isInfiniteStock?: boolean;
  note?: string | null;
}

/**
 * The gate every VENDOR stock write passes through.
 *
 * ## Why interception rather than a new endpoint
 *
 * The requirement is that a vendor's stock change on an agency-warehoused SKU take
 * effect only once the agency confirms it. Leaving the three existing write paths
 * — variant PATCH, simple-product PATCH, `PATCH /api/vendor/inventory/bulk-update`
 * — writing directly and adding a request flow beside them would make the rule
 * advisory: the old endpoints keep working and the gate is bypassed by not using
 * it. So the gate lives here and those three call it, which means there is no
 * "unguarded" spelling of the operation left to find.
 *
 * ## The contract
 *
 * `intercept` returns `null` when the product is **not** agency-warehoused — the
 * caller then writes stock as it always did. It returns a pending request when it
 * **is**, and the caller must write nothing. Callers surface it as
 * `meta.stockAdjustment` on an otherwise-normal `200`; see the api-doc for why one
 * status code rather than a 202 the client would have to branch on.
 *
 * ## What is deliberately NOT gated
 *
 * Creating a variant, creating a simple product, and duplicating a product write
 * stock directly. An initial quantity is a *declaration*, not an adjustment —
 * gating it would strand a brand-new SKU at 0 awaiting approval, and the agency
 * sees the row on its roster within the reconcile window and can propose a
 * correction from there.
 */
export class StockChangeGate {
  constructor(
    private readonly products: IProductRepository = new ProductRepositoryMongo(),
    private readonly vendors: VendorRepository = new VendorRepository(),
    private readonly requests: StockRequestService = stockRequestService,
  ) { }

  /**
   * Does this product's stock need the agency's countersignature?
   *
   * Exposed separately from `intercept` for the bulk path, which has to partition a
   * batch into "apply now" and "propose" before it opens its transaction.
   */
  async requiresApproval(
    productId: string,
    vendorId: string,
  ): Promise<{ required: boolean; agencyId: string | null; product: Product | null }> {
    const product = await this.products.findById(productId, vendorId);
    if (!product) return { required: false, agencyId: null, product: null };

    // Cheap structural check first — most products are not agency-stored, and this
    // avoids a vendor read for them.
    if (product.type !== 'physical' || product.delivery?.pickupLocation?.source !== 'agency_storage') {
      return { required: false, agencyId: null, product };
    }

    const vendor = await this.vendors.findById(vendorId);
    const agencyId = resolveEffectiveAgencyId(product, vendor?.default_delivery_agency_id?.toString() ?? null);

    // Configured for agency storage but with no agency resolvable at all — the
    // product cannot be active in that state (the activation gate refuses it), and
    // there is nobody to ask. Let the write through rather than deadlock the vendor.
    if (!agencyId) return { required: false, agencyId: null, product };

    return {
      required: isWarehousedBy(product, vendor?.default_delivery_agency_id?.toString() ?? null, agencyId),
      agencyId,
      product,
    };
  }

  /**
   * `null` ⇒ the caller writes stock itself. A request ⇒ the caller writes nothing.
   *
   * A no-op change (target equals current) raises `STOCK_REQUEST_NO_CHANGE` from the
   * service rather than quietly returning `null`, because returning `null` would let
   * the caller write — and "the write was a no-op anyway" is only true until
   * somebody else changes the number between the read and the write.
   */
  async intercept(intent: StockChangeIntent): Promise<StockRequestDto | null> {
    if (intent.quantity === undefined && intent.isInfiniteStock === undefined) return null;

    const { required } = await this.requiresApproval(intent.productId, intent.vendorId);
    if (!required) return null;

    return this.requests.raise(
      { role: 'vendor', ownerId: intent.vendorId, userId: intent.userId },
      {
        productId: intent.productId,
        variantId: intent.variantId,
        // Passed through as `undefined` when the PATCH touched only the infinite
        // flag: the service then keeps the SKU's current quantity, rather than the
        // gate having to read the variant just to restate a number it isn't changing.
        quantity: intent.quantity,
        isInfiniteStock: intent.isInfiniteStock,
        note: intent.note ?? null,
      },
    );
  }
}

export const stockChangeGate = new StockChangeGate();
