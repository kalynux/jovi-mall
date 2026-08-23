import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { AgencyStockLevelRepository } from '../repositories/agency-stock-level.repository';
import {
  AgencyInventoryReconciler,
  agencyInventoryReconciler,
} from '../domain/services/agency-inventory-reconciler';
import {
  InventoryRowResolver,
  inventoryRowResolver,
  InventoryRowDto,
  InventoryDetailDto,
} from '../read-models/inventory-row.resolver';
import { InventoryQueryInput, INVENTORY_SORT_FIELDS } from '../validators/inventory.validator';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { IStorageBasedPricing } from '../../delivery/delivery-agency.model';
import { StockLevelSummary } from '../repositories/agency-stock-level.repository';

export interface InventoryListResult {
  data: InventoryRowDto[];
  meta: { total: number; page: number; limit: number; totalPages: number };
  /**
   * TRUE when **every row in this response** is derived — configured to be stored here,
   * never counted.
   *
   * ⚠ It used to be the hardcoded literal `true`, which was honest while nothing could
   * count. Step 14 makes it computed, and the consequence is that a mixed page reports
   * `false` while still containing derived rows: **the per-row `source` is the precise
   * answer and the flag is the shortcut**, not the other way round. A client that renders a
   * whole screen off this flag will mislabel a mixed page — read `source`.
   */
  countsAreDerived: boolean;
}

/**
 * The agency's stored-SKU screen.
 *
 * Reads reconcile first (debounced), so an agency that has just connected a
 * vendor sees their SKUs without waiting for a scheduled job. See
 * `AgencyInventoryReconciler.reconcileIfStale` for why that is on the read path
 * rather than in a worker.
 */
export class AgencyInventoryService {
  constructor(
    private readonly stockLevels: AgencyStockLevelRepository = new AgencyStockLevelRepository(),
    private readonly reconciler: AgencyInventoryReconciler = agencyInventoryReconciler,
    private readonly rows: InventoryRowResolver = inventoryRowResolver,
    private readonly storage: IStorageProvider = getStorageProvider(),
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
  ) { }

  async list(agencyId: string, query: InventoryQueryInput): Promise<InventoryListResult> {
    // No reconcile here. Rebuilding the roster on a read was right while it was pure
    // configuration; it now also walks the movement ledger, which is not work to hang off a
    // page load. `AgencyInventoryReconcileWorker` owns it — INVENTORY_CONFIG says why.

    const [page, pricing] = await Promise.all([
      this.stockLevels.paginateForAgency(
        agencyId,
        { locationId: query.locationId, vendorId: query.vendorId, search: query.search },
        {
          page: query.page,
          limit: query.limit,
          sort: { [INVENTORY_SORT_FIELDS[query.sortBy]]: query.sortDir === 'asc' ? 1 : -1 },
        },
      ),
      this.loadStoragePricing(agencyId),
    ]);

    return {
      data: await this.rows.toRows(page.data, agencyId, this.storage, pricing),
      meta: {
        total: page.total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(page.total / query.limit),
      },
      countsAreDerived: page.data.every(row => row.source !== 'counted'),
    };
  }

  /**
   * The whole-magazine roll-up for the screen header.
   *
   * A separate endpoint rather than a field on the list, deliberately: the totals
   * span the entire filtered set, so folding them into the list would make every
   * page load pay for a second full-collection aggregation it usually does not need.
   */
  async summary(agencyId: string, query: InventoryQueryInput): Promise<StockLevelSummary> {

    const pricing = await this.loadStoragePricing(agencyId);
    return this.stockLevels.summaryForAgency(
      agencyId,
      { locationId: query.locationId, vendorId: query.vendorId, search: query.search },
      pricing?.enabled ? pricing.monthly_storage_fee_per_sku : 0,
    );
  }

  /**
   * The agency's storage rate — one read per request, not per row.
   *
   * Null (rather than a throw) when the agency or its policies are missing: the
   * screen's job is to show what is stored, and a half-configured policy should
   * degrade to "no fee quoted", not to a 500 over an inventory list.
   */
  private async loadStoragePricing(agencyId: string): Promise<IStorageBasedPricing | null> {
    const agency = await this.agencies.findById(agencyId);
    return agency?.policies?.pricing?.storage_based ?? null;
  }

  /**
   * One stock row. `id` is the ROW, not a variant — the same SKU at two depots is
   * two rows, and this screen drills into one shelf.
   *
   * Scoped to the agency in the query itself, so another agency's row 404s rather
   * than 403s: whether a given id exists is not information this caller is owed.
   */
  async getById(agencyId: string, id: string): Promise<InventoryDetailDto & { countsAreDerived: boolean }> {
    const row = await this.stockLevels.findByIdForAgency(id, agencyId);
    if (!row) {
      throw createAppError(ERROR_CODES.INVENTORY_STOCK_LEVEL_NOT_FOUND, 404, 'Inventory record not found.');
    }
    const pricing = await this.loadStoragePricing(agencyId);
    const detail = await this.rows.toDetail(row, agencyId, this.storage, pricing);
    return { ...detail, countsAreDerived: row.source !== 'counted' };
  }
}

export const agencyInventoryService = new AgencyInventoryService();
