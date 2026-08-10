import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IProductRepository } from '../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { mergeDeliveryConfig } from '../../catalog/domain/services/delivery-config.merge';
import { Product } from '../../catalog/repositories/mappers/product.mapper';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { AgencyStockLevelRepository } from '../repositories/agency-stock-level.repository';
import {
  AgencyInventoryReconciler,
  agencyInventoryReconciler,
} from '../domain/services/agency-inventory-reconciler';
import {
  AgencyStorageSuspensionService,
  agencyStorageSuspensionService,
  SuspensionResult,
} from '../domain/services/agency-storage-suspension.service';
import { emitStorageProductEvent } from '../domain/services/storage-product.events';

export interface DepotChangeResult {
  productId: string;
  locationId: string | null;
  locationLabel: string | null;
  /** How many stock rows moved with it — one per active variant. */
  affectedRows: number;
}

/**
 * The agency's write surface over a product it warehouses.
 *
 * Three actions, all **product-level** even though the inventory screen is
 * row-level, because that is where the data lives: the depot is named once on
 * `product.delivery.pickup_location`, and suspension is a product status. Acting on
 * a row id would invite the reading that one variant could sit in a different
 * building from its siblings, which the model cannot express.
 *
 * ## Ownership
 *
 * All three authorise the same way: **the agency must hold stock rows for this
 * product.** That predicate is the arrangement itself, it avoids a cross-vendor
 * product query, and it yields the `vendorId` every write needs for its scoped
 * update. A product this agency does not warehouse is a 404, never a 403 — whether
 * a given product id exists is not information the caller is owed.
 */
export class AgencyStoredProductService {
  constructor(
    private readonly stockLevels: AgencyStockLevelRepository = new AgencyStockLevelRepository(),
    private readonly products: IProductRepository = new ProductRepositoryMongo(),
    private readonly magazins: MagazinRepository = new MagazinRepository(),
    private readonly reconciler: AgencyInventoryReconciler = agencyInventoryReconciler,
    private readonly suspensions: AgencyStorageSuspensionService = agencyStorageSuspensionService,
  ) { }

  /**
   * Move a stored product to another of the agency's own depots.
   *
   * Applies immediately, with no vendor confirmation — and that asymmetry with the
   * stock flow is deliberate. A depot's *address* is already the agency's own record
   * (which is exactly why checkout snapshots only the depot **choice** for
   * `agency_storage` and resolves the address live on every read), so which of its
   * buildings holds the goods is the agency's to state. The vendor is told.
   *
   * `null` means "track my primary depot" — a real steady state, not a missing
   * value: `agency_address_id: null` already resolves to `headquarters_addresses[0]`
   * and keeps following it if the agency reorders.
   */
  async changeDepot(
    agencyId: string,
    productId: string,
    locationId: string | null,
  ): Promise<DepotChangeResult> {
    const { product, vendorId, rowCount } = await this.loadStored(agencyId, productId);

    const depots = (await this.magazins.findHqAddressListsByAgencyIds([agencyId])).get(agencyId) ?? [];
    const named = locationId ? depots.find(d => d._id.toString() === locationId) : null;

    if (locationId && !named) {
      throw createAppError(
        ERROR_CODES.INVENTORY_LOCATION_UNKNOWN,
        422,
        'That depot is not one of yours. Choose a location from your magazin.',
        { locationId },
      );
    }

    // ALWAYS through `mergeDeliveryConfig`. The repository `$set`s the whole
    // `delivery` sub-document, so writing it by hand would silently wipe
    // `agency_id` and `free_delivery` — and it also normalises `vendor_address_id`
    // to null for `agency_storage` rather than trusting the caller.
    const merged = mergeDeliveryConfig(product.delivery, {
      pickupLocation: { source: 'agency_storage', agencyAddressId: locationId },
    });

    // `merged` is the snake_case PERSISTENCE shape, not the camelCase domain one —
    // the same cast `ProductUpdateService` uses at its own delivery write.
    const updates: Partial<Product> = {};
    (updates as Record<string, unknown>).delivery = merged;
    await this.products.update(productId, vendorId, updates);

    // No activation re-check: the only pickup rule a depot can break is
    // depot-membership, which the guard above just enforced.

    // Reconcile now rather than waiting out the 60s read-path debounce, so the row
    // has moved by the time the agency's screen refreshes. Mark-and-sweep handles it
    // with no special case — the old (variant, location) key stops being marked and
    // is retired; the new one is upserted.
    await this.reconciler.reconcile(agencyId);

    emitStorageProductEvent('storage.depot_changed', {
      productId,
      vendorId,
      agencyId,
      note: null,
      locationLabel: named?.label ?? null,
    });

    return {
      productId,
      locationId,
      locationLabel: named?.label ?? null,
      affectedRows: rowCount,
    };
  }

  /** Take a warehoused product off the storefront. See the suspension service. */
  async suspend(agencyId: string, productId: string, note: string | null): Promise<SuspensionResult> {
    const { vendorId } = await this.loadStored(agencyId, productId);
    return this.suspensions.suspend(agencyId, productId, vendorId, note);
  }

  /** Put it back, if the activation gate still passes. */
  async unsuspend(agencyId: string, productId: string): Promise<SuspensionResult> {
    const { vendorId } = await this.loadStored(agencyId, productId);
    return this.suspensions.unsuspend(agencyId, productId, vendorId);
  }

  /**
   * The shared ownership check: rows exist ⇒ this agency warehouses this product.
   *
   * Note it reads the product with `findById(productId, vendorId)` — vendor-scoped,
   * using the vendor id the ROW carries. The agency is authorised by the row, and
   * the product read stays scoped, so neither side of the pair is a cross-tenant
   * query.
   */
  private async loadStored(
    agencyId: string,
    productId: string,
  ): Promise<{ product: Product; vendorId: string; rowCount: number }> {
    const rows = await this.stockLevels.findRowsForAgencyAndProduct(agencyId, productId);
    if (rows.length === 0) {
      throw createAppError(
        ERROR_CODES.INVENTORY_PRODUCT_NOT_STORED_HERE,
        404,
        'You do not warehouse this product.',
      );
    }

    const vendorId = rows[0].vendorId;
    const product = await this.products.findById(productId, vendorId);
    if (!product) {
      // A row survived its product — possible between a hard delete and the next
      // reconcile pass. Report it as not stored rather than as a server error.
      throw createAppError(
        ERROR_CODES.INVENTORY_PRODUCT_NOT_STORED_HERE,
        404,
        'You do not warehouse this product.',
      );
    }

    return { product, vendorId, rowCount: rows.length };
  }
}

export const agencyStoredProductService = new AgencyStoredProductService();
