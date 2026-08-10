import { IAgencyHeadquartersAddress } from '../models/magazin.model';

/**
 * Resolve WHICH of an agency's depots a pickup refers to.
 *
 * A product fulfilled from agency storage names its depot by id
 * (`delivery.pickup_location.agency_address_id`), and that id is carried onto the
 * order item at checkout. Everything that routes an agent — the shipment detail
 * and list, the `/route` origin, auto-assignment proximity ranking, and the
 * reassignment handover point — has to turn that id back into an address.
 *
 * **This is the only place the fallback lives.** `null` means the primary depot,
 * which is `headquarters_addresses[0]`, and it is the honest answer for three
 * distinct populations: every product written before the depot picker existed,
 * every product whose pickup location was auto-derived (`PickupLocationResolver`
 * never picks a depot), and any product whose chosen depot the agency has since
 * deleted. Reimplementing `?.[0]` at each call site is how those three quietly
 * start disagreeing.
 *
 * Never throws, and returns null only when the agency has no depot on file at
 * all — an agency-side gap that must not break a read.
 */
export function resolveHqAddress(
  addresses: IAgencyHeadquartersAddress[] | null | undefined,
  addressId?: string | { toString(): string } | null,
): IAgencyHeadquartersAddress | null {
  if (!addresses || addresses.length === 0) return null;

  const wanted = addressId?.toString();
  if (wanted) {
    const match = addresses.find((a) => a._id?.toString() === wanted);
    if (match) return match;
    // Dangling id — the depot was deleted out from under the product. Fall back
    // rather than fail: an agent still has to be sent somewhere, and the primary
    // is where this product went before anyone picked a depot.
  }

  return addresses[0] ?? null;
}

/**
 * {@link resolveHqAddress} against the batch map from
 * `MagazinRepository.findHqAddressListsByAgencyIds` — the shape every list view
 * wants, where one query covers a page of shipments spanning many agencies.
 */
export function resolveHqAddressFor(
  byAgency: Map<string, IAgencyHeadquartersAddress[]>,
  agencyId: string | { toString(): string },
  addressId?: string | { toString(): string } | null,
): IAgencyHeadquartersAddress | null {
  return resolveHqAddress(byAgency.get(agencyId.toString()), addressId);
}
