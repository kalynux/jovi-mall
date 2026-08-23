import { IProductRepository } from '../../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../../catalog/repositories/mongo/product.repository.mongo';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';
import { Types } from 'mongoose';
import {
  AgencyStockLevelRepository,
  DerivedStockRow,
} from '../../repositories/agency-stock-level.repository';
import {
  AgencyStockMovementRepository,
  agencyStockMovementRepository,
} from '../../repositories/agency-stock-movement.repository';

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
    private readonly movements: AgencyStockMovementRepository = agencyStockMovementRepository,
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
   * ⚠ **No longer called from the read path** (Step 14). It survives for the two places
   * that legitimately want the roster fresh *now* — `changeDepot`, and a manual worker
   * trigger — and it keeps the debounce so those cannot become an accidental hot loop.
   * The scheduled pass is `AgencyInventoryReconcileWorker`; see `INVENTORY_CONFIG` for
   * why a customer-facing GET is the wrong place to do this work now.
   */
  async reconcileIfStale(agencyId: string, maxAgeMs = RECONCILE_DEBOUNCE_MS): Promise<void> {
    const last = await this.stockLevels.findLastReconciledAt(agencyId);
    if (last && Date.now() - last.getTime() < maxAgeMs) return;
    await this.reconcile(agencyId);
  }

  /**
   * Every row whose counters disagree with its own movement ledger.
   *
   * **The ledger is the authority, and nothing else is.** Both are written in one
   * transaction by `AgencyStockMovementRepository`, so a disagreement is a bug or a
   * half-applied write — never a legitimate difference. It is deliberately NOT compared
   * against `ProductVariant.stock`: that is the vendor's catalogue number across every
   * channel, D-6 makes the depot count independent of it, and "correcting" one to the
   * other would erase exactly the variance an agency needs to see. P-14 is the same
   * lesson from the COD ledger — assert the invariant the application maintains, never a
   * re-derivation from another collection.
   *
   * A row with no movements at all is not in drift; it is simply uncounted.
   */
  async findDrift(agencyId: string): Promise<StockDrift[]> {
    const rows = await this.stockLevels.findAllRawForAgency(agencyId);
    if (rows.length === 0) return [];

    const sums = await this.movements.sumByStockLevels(
      rows.map(r => r._id as Types.ObjectId),
    );

    const drifted: StockDrift[] = [];
    for (const row of rows) {
      const id = (row._id as Types.ObjectId).toString();
      const ledger = sums.get(id);
      if (!ledger) {
        // No movements. A counter that is nonetheless non-zero IS drift — it means
        // something wrote the row without writing the ledger, which is the exact
        // failure this check exists for.
        if (row.quantity_on_hand !== 0 || row.quantity_reserved !== 0) {
          drifted.push({
            stockLevelId: id,
            onHand: row.quantity_on_hand,
            reserved: row.quantity_reserved,
            ledgerOnHand: 0,
            ledgerReserved: 0,
          });
        }
        continue;
      }
      if (row.quantity_on_hand !== ledger.onHand || row.quantity_reserved !== ledger.reserved) {
        drifted.push({
          stockLevelId: id,
          onHand: row.quantity_on_hand,
          reserved: row.quantity_reserved,
          ledgerOnHand: ledger.onHand,
          ledgerReserved: ledger.reserved,
        });
      }
    }
    return drifted;
  }

  /**
   * Set every drifted counter back to what its ledger says, and report what moved.
   *
   * Idempotent by construction: a second pass finds nothing, because the correction sets
   * the counter TO the ledger sum rather than adjusting it by a difference.
   *
   * ⚠ **The correction writes no movement row**, and that is the one judgement call here.
   * A movement would balance the books and destroy the evidence — the ledger would then
   * agree with the counter and nobody could ever tell that it once had not. The counter is
   * the derived value; the ledger is the record; a repair restores the derived value and
   * leaves the record alone. It is logged loudly instead, because a non-empty result here
   * means a bug somewhere upstream and there is no other way to learn that.
   */
  async correctDrift(agencyId: string): Promise<StockDrift[]> {
    const drifted = await this.findDrift(agencyId);
    for (const drift of drifted) {
      await this.stockLevels.setCounters(
        agencyId,
        drift.stockLevelId,
        drift.ledgerOnHand,
        drift.ledgerReserved,
      );
    }
    return drifted;
  }
}

/** A row whose counters and whose ledger disagree. The ledger side is the truth. */
export interface StockDrift {
  stockLevelId: string;
  onHand: number;
  reserved: number;
  ledgerOnHand: number;
  ledgerReserved: number;
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
