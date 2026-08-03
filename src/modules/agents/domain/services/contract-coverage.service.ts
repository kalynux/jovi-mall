import { IContractCoverage } from '../../models/agent-agency-membership.model';
import { resolveRegionKey } from '../../../../core/constants/locations.helper';

/**
 * The two contract terms that constrain WHICH shipments an agent may be given,
 * as opposed to what they are paid for one.
 *
 * Both were stored, validated and mapped to DTOs for a long time without a
 * single reader. These predicates are what make them real, and they live
 * together because they are enforced at the same two points (the auto-assignment
 * candidate filter and every command path in shipment-assignment) and share one
 * governing rule.
 *
 * ── That rule: FAIL OPEN, always ────────────────────────────────────────────
 *
 * Every "unknown" here means "no restriction", never "blocked". A coverage term
 * exists to narrow where an agent works — it is not an authorization gate, and
 * treating missing data as a denial would take working deliveries away from
 * agents to enforce a rule nobody wrote:
 *
 *  - `coverage.regions` defaults to `[]` on every contract ever created. If an
 *    empty list meant "covers nowhere", switching this on would make EVERY
 *    existing contract undispatchable at once.
 *  - `order.delivery_address` was only snapshotted from a certain point on, so
 *    older orders have no region at all. They must stay deliverable.
 *  - `shipment_value_ceiling` defaults to null, and a shipment's value can fail
 *    to compute (see `resolveShipmentValue`). Neither is grounds to refuse.
 *
 * Both functions are pure and DB-free so the ts-node harness covers them.
 */

/**
 * Does this contract cover the region a shipment is being delivered to?
 *
 * Matching is by canonical region key, so the agency's free-text
 * `coverage.regions` ("Littoral", "littoral", "Extrême-Nord") and whatever the
 * geocoder put in `components.region` ("Far North") resolve to the same thing.
 *
 * Deliberately ignores `coverage.area`, the optional polygon. Nothing has ever
 * populated it, point-in-polygon is a different kind of test from a name match,
 * and half-implementing it would be worse than leaving it visibly inert. If it
 * is ever enforced, it belongs beside this function, not inside it.
 */
export function contractCoversRegion(
  coverage: IContractCoverage | null | undefined,
  deliveryRegion: string | null | undefined,
  countryCode?: string | null
): boolean {
  const regions = coverage?.regions ?? [];
  if (regions.length === 0) return true; // no declared coverage = no restriction

  const target = resolveRegionKey(deliveryRegion, countryCode);
  if (!target) return true; // no region on the order = nothing to test against

  return regions.some((r) => resolveRegionKey(r, countryCode) === target);
}

/**
 * Is a shipment worth little enough for this contract to carry it?
 *
 * Independent of the COD threshold: a high-value parcel can sit comfortably
 * inside an agent's cash headroom and still be more than this agency wants to
 * hand them. Prepaid shipments are in scope too — the risk is the goods, not
 * the cash.
 *
 * `null` ceiling = no cap. `null` value = value could not be computed, which
 * fails open.
 */
export function contractAllowsShipmentValue(
  ceiling: number | null | undefined,
  shipmentValue: number | null | undefined
): boolean {
  if (ceiling === null || ceiling === undefined) return true;
  if (shipmentValue === null || shipmentValue === undefined) return true;
  // `<=`, not `<`: a shipment worth exactly the ceiling is within it.
  return shipmentValue <= ceiling;
}
