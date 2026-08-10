import { IContractCoverage } from '../../models/agent-agency-membership.model';
import {
  getRegionKeysForCountry,
  resolveRegionKey,
} from '../../../../core/constants/locations.helper';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';

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
 * ── Writing coverage is the strict half ─────────────────────────────────────
 *
 * `normalizeContractRegions` is the one exception to the paragraph above, and
 * the asymmetry is deliberate: reading an unrecognised region must never take a
 * delivery away, but WRITING one is a typo nobody will ever notice. A contract
 * naming "Douala" (a city) or "Litoral" (misspelt) reads as covering nowhere
 * real — the predicate above then quietly refuses every shipment in Littoral,
 * and the agency sees only that their agent is never offered work. So the write
 * paths validate against the country's region catalogue, exactly as the
 * agency's own `coverage_areas` are validated on its location tab, while the
 * read path keeps failing open for the free-text rows written before this.
 *
 * All three functions are pure and DB-free so the ts-node harness covers them.
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

/**
 * Canonicalise a PROPOSED `coverage.regions` list against the agency's country.
 *
 * The counterpart of `normalizeCoverageAreasForCountry`, which does the same job
 * for the agency's own `coverage_areas` on its location tab. Both sides of a
 * contract negotiation now pick from that same catalogue instead of typing, so
 * what lands in `coverage.regions` is what `contractCoversRegion` compares
 * against — region KEYS of one known country, not three vocabularies meeting by
 * luck.
 *
 * Lenient in, canonical out. An entry is accepted if it RESOLVES to a region of
 * the country, so `"Littoral"`, `"littoral"` and the French `"Extrême-Nord"`
 * all pass and are stored as `littoral` / `far_north`. A city (`"Douala"`) or a
 * misspelling resolves to nothing in the catalogue and is rejected — that is the
 * whole point of the check. Duplicates that collapse onto one key are deduped.
 *
 * Two things deliberately do NOT throw:
 *
 *  - an **empty list**, which is the schema default on every contract and means
 *    "no restriction" (see the header). Clearing coverage is legitimate.
 *  - an **unknown or unset country** — legacy agencies predate the field, and
 *    there is no catalogue to validate against. The inputs pass through
 *    untouched, exactly as `normalizeCoverageAreasForCountry` does.
 *
 * The picker is scoped to the country, not to the agency's own coverage areas:
 * an agency may legitimately contract an agent for a region it is expanding into
 * before it declares it. The agency's declared areas are exposed alongside so a
 * client can mark them, but they are a hint, never a bound.
 *
 * @throws `CONTRACT_COVERAGE_REGION_INVALID` (400) listing every unresolvable
 *   entry plus the country's full region list, so a client can repair its picker
 *   without a second round-trip.
 */
export function normalizeContractRegions(
  regions: string[],
  countryCode: string | null | undefined
): string[] {
  const trimmed = regions.map((r) => r.trim()).filter((r) => r.length > 0);
  if (trimmed.length === 0) return [];

  const allowed = getRegionKeysForCountry(countryCode);
  if (allowed.length === 0) return [...new Set(trimmed)];

  const allowedKeys = new Set(allowed);
  const invalid: string[] = [];
  const resolved: string[] = [];

  for (const raw of trimmed) {
    const key = resolveRegionKey(raw, countryCode);
    if (!allowedKeys.has(key)) {
      invalid.push(raw);
      continue;
    }
    if (!resolved.includes(key)) resolved.push(key);
  }

  if (invalid.length > 0) {
    const country = (countryCode as string).toUpperCase();
    throw createAppError(
      ERROR_CODES.CONTRACT_COVERAGE_REGION_INVALID,
      400,
      `Coverage regions must be regions of the agency's country (${country}).`,
      { invalid, requiredCountry: country, allowedRegions: allowed }
    );
  }

  return resolved;
}
