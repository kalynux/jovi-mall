import { IProductRepository } from '../../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../../catalog/repositories/mongo/product.repository.mongo';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';
import {
  AgencyStockLevelRepository,
  DerivedStockRow,
} from '../../repositories/agency-stock-level.repository';

/**
 * Where a stored product's stock is recorded, given the depot it names.
 *
 * **This is the rule that separates inventory from routing, and it is why the
 * inventory module must not call `resolveHqAddress`.**
 *
 * | the product names | routing sends the agent to | stock is recorded at |
 * |---|---|---|
 * | nothing (`null`) | the primary | **the primary** — it genuinely is there |
 * | a live depot | that depot | that depot |
 * | a **deleted** depot | the primary (graceful) | **nowhere (`null`)** |
 *
 * The first two agree; the third is the whole point. Falling back to the primary
 * is the right answer when the job is to send a courier *somewhere* — an agent
 * with no address is a failed delivery. It is the wrong answer when the job is
 * to say how much is in a building, because it would move goods between
 * warehouses on paper and hand an agency a number nobody can go and count.
 * Unresolved rows surface on the screen as "unassigned" so a human can move them.
 *
 * Pure — no I/O — so the distinction is testable without a database.
 *
 * @param agencyAddressId the depot the product names, raw and unresolved
 * @param liveDepotIds    the agency's current depot ids, in stored order
 */
export function resolveStockLocationId(
  agencyAddressId: string | null | undefined,
  liveDepotIds: string[],
): string | null {
  // No depot on file at all — nothing to attribute stock to, even a default.
  if (liveDepotIds.length === 0) return null;

  // No choice made: the primary is where this product is actually collected
  // from, so it is honestly where it sits.
  if (!agencyAddressId) return liveDepotIds[0] ?? null;

  // Named a depot that still exists.
  if (liveDepotIds.includes(agencyAddressId)) return agencyAddressId;

  // Named a depot that is gone. Deliberately NOT the primary.
  return null;
}

/**
 * Builds and refreshes the agency's stored-SKU roster from the catalog.
 *
 * Phase 1 has no intake flow and no movement events, so the only thing the
 * platform truthfully knows is *configuration*: which products a vendor has
 * pointed at this agency's warehouse. This service turns that into rows, and
 * every row it writes is stamped `source: 'derived'` with zero quantities so the
 * API can say plainly that these are not counted numbers.
 *
 * Reconciliation is **mark-and-sweep**: one shared timestamp is written onto
 * every row the pass touches, then any older derived row is retired. That avoids
 * building a set difference over a potentially large roster, and it is naturally
 * correct for the three ways a row stops being derivable — the product was
 * archived or deactivated, the vendor switched off `agency_storage`, or the
 * product was repointed at another agency. A product moved to a *different
 * depot* needs no special case either: the old `(variant, location)` key stops
 * being marked and is swept, the new one is upserted.
 */
export class AgencyInventoryReconciler {
  constructor(
    private readonly products: IProductRepository = new ProductRepositoryMongo(),
    private readonly magazins: MagazinRepository = new MagazinRepository(),
    private readonly stockLevels: AgencyStockLevelRepository = new AgencyStockLevelRepository(),
  ) { }

  /**
   * Rebuild the roster for one agency. Returns what changed, for logging.
   *
   * Not transactional: it upserts, then sweeps. A crash between the two leaves
   * rows that are stale but not wrong — they still describe configuration that
   * was true moments ago — and the next pass corrects them. That is an
   * acceptable trade for a derived read model; it would not be for Phase 2's
   * counted quantities, which is why those get event-driven writes instead.
   */
  async reconcile(agencyId: string): Promise<{ upserted: number; retired: number }> {
    const reconciledAt = new Date();

    const [stored, liveDepotIds] = await Promise.all([
      this.products.findAgencyStoredVariants(agencyId),
      this.magazins.findHqAddressIdsByAgencyId(agencyId),
    ]);

    const depots = liveDepotIds ?? [];
    const rows: DerivedStockRow[] = stored.map(s => ({
      agencyId,
      locationId: resolveStockLocationId(s.agencyAddressId, depots),
      vendorId: s.vendorId,
      productId: s.productId,
      variantId: s.variantId,
    }));

    // A product with several variants at one depot yields several rows; two
    // products sharing a variant cannot happen (a variant belongs to one
    // product), so the natural key is already unique across this set. Dedupe
    // anyway — a bulkWrite with two upserts on the same filter would have the
    // second silently no-op, and that is a bug worth not depending on.
    const deduped = dedupeByKey(rows);

    const upserted = await this.stockLevels.bulkUpsertDerived(deduped, reconciledAt);
    const retired = await this.stockLevels.retireDerivedBefore(agencyId, reconciledAt);

    return { upserted, retired };
  }

  /**
   * Reconcile unless it ran recently.
   *
   * Called on the read path rather than from a cron, deliberately: Phase 1
   * quantities are derived, so a stale roster costs nothing worth scheduling a
   * job for, and an agency that has just onboarded a vendor sees the change
   * immediately instead of at 3am. Phase 2, where quantities move with real
   * events, is where a worker starts to earn its place.
   */
  async reconcileIfStale(agencyId: string, maxAgeMs = RECONCILE_DEBOUNCE_MS): Promise<void> {
    const last = await this.stockLevels.findLastReconciledAt(agencyId);
    if (last && Date.now() - last.getTime() < maxAgeMs) return;
    await this.reconcile(agencyId);
  }
}

/** How long a roster is considered fresh enough to serve without re-deriving. */
export const RECONCILE_DEBOUNCE_MS = 60_000;

/** One row per `(variant, location)` — the collection's natural key. */
export function dedupeByKey(rows: DerivedStockRow[]): DerivedStockRow[] {
  const seen = new Map<string, DerivedStockRow>();
  for (const row of rows) {
    seen.set(`${row.variantId}:${row.locationId ?? ''}`, row);
  }
  return [...seen.values()];
}

export const agencyInventoryReconciler = new AgencyInventoryReconciler();
