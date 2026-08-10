import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IAgencyHeadquartersAddress } from '../../../magazin/models/magazin.model';
import { AgencyStockLevelRepository } from '../../repositories/agency-stock-level.repository';

/**
 * Which existing depots a magazin write is about to drop.
 *
 * **Compared against the PERSISTABLE array, not the raw request.** An incoming
 * entry may carry no `id` and still keep an existing `_id`, because
 * `toPersistableHeadquarters` content-matches it (same address text + same
 * geocoded place) as a safety net for clients that have not shipped the id echo.
 * Diffing the raw payload's ids would report every one of those as a removal —
 * so a legacy dashboard saving an unchanged list would 409 on every request.
 *
 * Deriving the answer from the very array that is about to be written makes the
 * two impossible to disagree.
 *
 * Pure.
 */
export function findRemovedDepotIds(
  current: IAgencyHeadquartersAddress[] | undefined,
  persistable: Array<{ _id?: { toString(): string } }>,
): string[] {
  const surviving = new Set(
    persistable.map(e => e._id?.toString()).filter((id): id is string => !!id),
  );
  return (current ?? [])
    .map(d => d._id?.toString())
    .filter((id): id is string => !!id && !surviving.has(id));
}

/**
 * Refuse to drop a depot that still holds stock.
 *
 * The magazin write is a whole-array replace with no reference check, so before
 * this guard a removed depot silently orphaned every stock row pointing at it —
 * and, because routing falls back to the primary on a dangling id, the goods
 * would quietly appear to be in a different building.
 *
 * ## What "holds stock" means in Phase 1
 *
 * Row EXISTENCE, not quantity. Every derived quantity is currently 0, so a
 * `quantity > 0` test would never fire and this guard would be decorative. The
 * true statement this phase can make is "products are configured to be stored
 * here", and that is exactly what deleting the depot would orphan. When Phase 2
 * makes counts real, tighten `countByLocations` to
 * `quantity_on_hand > 0 || quantity_reserved > 0` — the call site here does not
 * change.
 *
 * ## Why not MAGAZIN_CONFLICT
 *
 * That code means "your view is stale, refresh and retry", and retrying changes
 * nothing here. This needs its own remedy — move the stock first — so it gets
 * its own code, mirroring `VENDOR_BUSINESS_ADDRESS_IN_USE` on the vendor side.
 *
 * ## Accepted race
 *
 * `MagazinRepository.updateByAgencyId` is not session-aware, so this is a
 * check-then-write: a vendor could point a product at a depot between the check
 * and the write. The magazin's `version` compare-and-set narrows the window.
 * Closing it means making the magazin write session-aware, which is its own
 * change.
 */
export async function assertRemovedDepotsAreEmpty(
  agencyId: string,
  removedIds: string[],
  current: IAgencyHeadquartersAddress[] | undefined,
  stockLevels: AgencyStockLevelRepository = new AgencyStockLevelRepository(),
): Promise<void> {
  if (removedIds.length === 0) return;

  const counts = await stockLevels.countByLocations(agencyId, removedIds);
  if (counts.size === 0) return;

  const labelsById = new Map(
    (current ?? []).map(d => [d._id?.toString() ?? '', d.label ?? d.address_description ?? null]),
  );

  const locations = [...counts.entries()].map(([id, skuCount]) => ({
    id,
    label: labelsById.get(id) ?? null,
    skuCount,
  }));

  throw createAppError(
    ERROR_CODES.MAGAZIN_LOCATION_IN_USE,
    409,
    'One or more locations you removed still hold stored products. Move or clear their stock before removing them.',
    { locations },
  );
}
