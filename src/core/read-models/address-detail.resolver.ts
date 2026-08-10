import { IGeoAddress } from '../types/geo-address.types';
import { IGeoPoint } from '../types/geo.types';

/**
 * The canonical wire shape for ANY address this API returns — customer
 * drop-offs, vendor pickups, agency HQs, reassignment handover points.
 *
 * This exists for the same reason `FileDetail` does: an address was previously
 * shaped ad-hoc at every call site (three mutually inconsistent shapes inside
 * `ShipmentService._buildDetail` alone), each dropping different fields and all
 * of them dropping coordinates. Anything that surfaces an address should go
 * through this resolver.
 *
 * `coordinates` is the ONE place GeoJSON's `[lng, lat]` ordering is flipped to
 * the `{ lat, lng }` that map clients expect. Never flip it anywhere else.
 */
export interface AddressDetail {
  label: string | null;
  /**
   * The provider's one-line rendering when the address was geocoded; otherwise
   * a readable line composed from the stored loose fields, so a client always
   * has something displayable. Null only when the address is entirely empty.
   */
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  /** Null on legacy addresses that were never geocoded — clients must handle it. */
  coordinates: { lat: number; lng: number } | null;
}

/** The loose, per-entity address fields that sit alongside a `geo` sub-document. */
interface LooseAddressFields {
  label?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  /** The deprecated bare `location` point, used only when `geo` is absent. */
  fallbackPoint?: IGeoPoint | null;
}

/** Extract `{ lat, lng }` from a GeoJSON point, rejecting malformed/partial data. */
function toLatLng(point: IGeoPoint | null | undefined): { lat: number; lng: number } | null {
  const coords = point?.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lat, lng };
}

/** Join the non-empty parts of an address into one readable line. */
function composeFormatted(parts: Array<string | null | undefined>): string | null {
  const line = parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join(', ');
  return line.length > 0 ? line : null;
}

/**
 * Build an {@link AddressDetail} from a `GeoAddress` and/or the loose fields
 * stored beside it. `geo` supplies the coordinates and the formatted line; the
 * loose fields win for city/state/country (they are the entity's own record),
 * falling back to the provider's parsed components where absent.
 *
 * Returns null when there is nothing to show at all.
 */
export function toAddressDetail(
  geo: IGeoAddress | null | undefined,
  loose: LooseAddressFields = {},
): AddressDetail | null {
  const components = geo?.components;

  const detail: AddressDetail = {
    label: loose.label ?? null,
    addressLine1: loose.addressLine1 ?? components?.street ?? null,
    addressLine2: loose.addressLine2 ?? null,
    city: loose.city ?? components?.city ?? null,
    state: loose.state ?? components?.region ?? null,
    country: loose.country ?? components?.country ?? null,
    coordinates: toLatLng(geo?.coordinates) ?? toLatLng(loose.fallbackPoint),
    formattedAddress: null,
  };

  detail.formattedAddress =
    geo?.formatted_address ??
    composeFormatted([detail.addressLine1, detail.addressLine2, detail.city, detail.state, detail.country]);

  // Nothing displayable and nothing mappable — report absence rather than an
  // object of nulls the client has to special-case anyway.
  if (!detail.formattedAddress && !detail.coordinates && !detail.label) return null;

  return detail;
}

// ─── Per-site adapters ───────────────────────────────────────────────────────
// Each stored address shape differs (different field names, different subsets).
// These keep that knowledge here rather than at every call site.

/** A customer's saved address (`customer.saved_addresses[]`). */
export function fromSavedAddress(
  addr:
    | {
        label?: string | null;
        address_line1?: string | null;
        address_line2?: string | null;
        city?: string | null;
        state?: string | null;
        country?: string | null;
        location?: IGeoPoint | null;
        geo?: IGeoAddress | null;
      }
    | null
    | undefined,
): AddressDetail | null {
  if (!addr) return null;
  return toAddressDetail(addr.geo, {
    label: addr.label,
    addressLine1: addr.address_line1,
    addressLine2: addr.address_line2,
    city: addr.city,
    state: addr.state,
    country: addr.country,
    fallbackPoint: addr.location,
  });
}

/**
 * The pickup snapshot taken at order creation
 * (`order.items[].delivery.pickup_location.address_snapshot`). It has no
 * `country` field — the geocoded components supply it when present.
 */
export function fromPickupSnapshot(
  snapshot:
    | {
        label?: string | null;
        address_line1?: string | null;
        address_line2?: string | null;
        city?: string | null;
        state?: string | null;
        geo?: IGeoAddress | null;
      }
    | null
    | undefined,
): AddressDetail | null {
  if (!snapshot) return null;
  return toAddressDetail(snapshot.geo, {
    label: snapshot.label,
    addressLine1: snapshot.address_line1,
    addressLine2: snapshot.address_line2,
    city: snapshot.city,
    state: snapshot.state,
  });
}

/**
 * A vendor's business address (`vendor.business_addresses[]`) — the source a
 * product's `pickup_location.vendor_address_id` points at. Field-for-field the
 * same shape as a customer's saved address, but kept as its own adapter because
 * the two are separate stored shapes that are free to diverge, and a call site
 * naming the wrong one would still compile.
 */
export function fromVendorBusinessAddress(
  addr:
    | {
        label?: string | null;
        address_line1?: string | null;
        address_line2?: string | null;
        city?: string | null;
        state?: string | null;
        country?: string | null;
        location?: IGeoPoint | null;
        geo?: IGeoAddress | null;
      }
    | null
    | undefined,
): AddressDetail | null {
  if (!addr) return null;
  return toAddressDetail(addr.geo, {
    label: addr.label,
    addressLine1: addr.address_line1,
    addressLine2: addr.address_line2,
    city: addr.city,
    state: addr.state,
    country: addr.country,
    fallbackPoint: addr.location,
  });
}

/**
 * An agency's headquarters address (`magazin.headquarters_addresses[]`). Its
 * street line is `address_description` and its state is `region`.
 */
export function fromHqAddress(
  hq:
    | {
        label?: string | null;
        address_description?: string | null;
        city?: string | null;
        region?: string | null;
        location?: IGeoPoint | null;
        geo?: IGeoAddress | null;
      }
    | null
    | undefined,
): AddressDetail | null {
  if (!hq) return null;
  return toAddressDetail(hq.geo, {
    label: hq.label,
    addressLine1: hq.address_description,
    city: hq.city,
    state: hq.region,
    fallbackPoint: hq.location,
  });
}

/**
 * A reassignment handover pickup (`shipment.handover.pickup`). Its loose fields
 * live one level down under `address`, with `line1`/`line2` rather than
 * `address_line1`/`address_line2`.
 */
export function fromHandoverPickup(
  pickup:
    | {
        label?: string | null;
        address?: {
          line1?: string | null;
          line2?: string | null;
          city?: string | null;
          state?: string | null;
          country?: string | null;
        } | null;
        location?: IGeoPoint | null;
        geo?: IGeoAddress | null;
      }
    | null
    | undefined,
): AddressDetail | null {
  if (!pickup) return null;
  return toAddressDetail(pickup.geo, {
    label: pickup.label,
    addressLine1: pickup.address?.line1,
    addressLine2: pickup.address?.line2,
    city: pickup.address?.city,
    state: pickup.address?.state,
    country: pickup.address?.country,
    fallbackPoint: pickup.location,
  });
}
