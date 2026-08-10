import { IGeoPoint } from '../../../../core/types/geo.types';
import { IGeoAddress } from '../../../../core/types/geo-address.types';
import {
  IShipment,
  IShipmentHandoverPickup,
  ShipmentStatus,
} from '../../../shipments/shipment.model';
import { IOrder } from '../../../orders/order.model';
import { AgentRepository, agentRepository } from '../../../agents';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';
import { resolveHqAddress } from '../../../magazin/domain/hq-address.resolver';

/**
 * The agency's manual override of the automatic pickup location (Part 3). Any
 * subset may be provided; a coordinate and/or an address is enough. All optional.
 */
export interface HandoverPickupOverride {
  label?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  note?: string;
}

/**
 * HandoverPickupService — determines WHERE a replacement agent collects a
 * reassigned shipment.
 *
 * The default is derived from the shipment's status at the moment of
 * reassignment (the requirement's three rules), and the agency may always
 * override it (Part 3):
 *
 *   picked_up / in_transit → the previous agent's last known location — the
 *                            expected handover point between the two agents.
 *   returned               → the shipment's ORIGINAL pickup (the vendor's
 *                            business address or the agency warehouse it shipped
 *                            from).
 *   failed                 → the responsible agency's business (HQ) location.
 *   assigned (pre-pickup)  → none (the parcel never left the agency; the new
 *                            agent uses the order's normal per-item pickups).
 *   manual override        → whatever the agency provided.
 *
 * It never throws for a missing input: if the automatic source cannot be
 * resolved (e.g. the previous agent never streamed a position), it falls back to
 * the agency business location and flags `is_fallback`, so the agency sees a
 * sensible default to accept or override rather than an error.
 */
export class HandoverPickupService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly magazins: MagazinRepository = new MagazinRepository()
  ) {}

  async resolve(params: {
    shipment: IShipment;
    order: IOrder;
    previousStatus: ShipmentStatus;
    previousAgentId: string;
    agencyId: string;
    override?: HandoverPickupOverride | null;
  }): Promise<IShipmentHandoverPickup | null> {
    const { shipment, order, previousStatus, previousAgentId, agencyId, override } = params;

    // Part 3 — a manual override always wins.
    if (override && this.hasOverrideContent(override)) {
      return this.fromOverride(override);
    }

    switch (previousStatus) {
      case 'picked_up':
      case 'in_transit':
        return await this.fromPreviousAgent(previousAgentId, agencyId);
      case 'returned':
        return await this.fromOriginalPickup(shipment, order, agencyId);
      case 'failed':
        return await this.fromAgencyBusiness(agencyId, false);
      default:
        // `assigned` (pre-pickup): the parcel is still at the agency, so there is
        // no special handover point — the new agent uses the normal per-item pickups.
        return null;
    }
  }

  // ─── Rule 1: previous agent's last known location ──────────────────────────

  private async fromPreviousAgent(previousAgentId: string, agencyId: string): Promise<IShipmentHandoverPickup> {
    const agent = await this.agents.findById(previousAgentId);
    const position = agent?.last_known_tracking_state?.last_position ?? null;

    if (!position) {
      // No position on record — fall back to the agency so the agency still gets a
      // usable default to accept or override.
      const fallback = await this.fromAgencyBusiness(agencyId, true);
      fallback.note = 'The previous agent\'s last location is unavailable — collect from the agency or set a handover point.';
      return fallback;
    }

    const name = agent?.name ?? 'the previous agent';
    return {
      source: 'previous_agent_location',
      label: `Handover with ${name} (last known location)`,
      address: null,
      location: position,
      // A raw live coordinate, not a geocoded place — no GeoAddress.
      geo: null,
      note: null,
      is_fallback: false,
    };
  }

  // ─── Rule 2: the shipment's original pickup location ───────────────────────

  private async fromOriginalPickup(shipment: IShipment, order: IOrder, agencyId: string): Promise<IShipmentHandoverPickup> {
    const itemIds = new Set(shipment.items.map((i) => i.order_item_id.toString()));
    const orderItem = (order.items as any[]).find(
      (oi) => itemIds.has(oi._id.toString()) && oi.delivery?.pickup_location
    );
    const pickup = orderItem?.delivery?.pickup_location ?? null;

    // Storage-based pickup resolves to the agency's own depot — the one the order
    // item names, or the primary when it names none. The address is resolved live
    // rather than snapshotted (only the CHOICE is snapshotted), same rule as the
    // shipment detail view.
    if (!pickup || pickup.source === 'agency_storage') {
      const agencyPickup = await this.fromAgencyBusiness(agencyId, false, pickup?.agency_address_id);
      agencyPickup.source = 'original_pickup';
      agencyPickup.label = agencyPickup.label ? `${agencyPickup.label} (original pickup — warehouse)` : 'Agency warehouse (original pickup)';
      return agencyPickup;
    }

    // Vendor-address pickup uses the snapshot taken at order creation. Legacy
    // snapshots carried no coordinates; newer ones include the geocoded `geo`
    // (formatted address + coordinates), which we pass straight through.
    const snap = pickup.address_snapshot;
    const snapGeo: IGeoAddress | null = snap?.geo ?? null;
    return {
      source: 'original_pickup',
      label: snap?.label ?? 'Original pickup — vendor address',
      address: snap
        ? {
            line1: snap.address_line1 ?? null,
            line2: snap.address_line2 ?? null,
            city: snap.city ?? null,
            state: snap.state ?? null,
            country: snapGeo?.components.country ?? null,
          }
        : null,
      location: snapGeo?.coordinates ?? null,
      geo: snapGeo,
      note: null,
      is_fallback: false,
    };
  }

  // ─── Rule 3 (and the fallbacks): the agency's business/HQ location ─────────

  /**
   * `agencyAddressId` names which depot, when the caller knows one (the original
   * pickup of a storage-based item). The rule-3 `failed` case and every fallback
   * pass nothing and get the primary — the agency's front desk is where a failed
   * parcel is handed back, regardless of which depot it originally left.
   */
  private async fromAgencyBusiness(
    agencyId: string,
    isFallback: boolean,
    agencyAddressId?: string | { toString(): string } | null
  ): Promise<IShipmentHandoverPickup> {
    // Business name + HQ addresses both live on the Magazin (source of truth).
    const magazin = await this.magazins.findByAgencyIdOrNull(agencyId);
    const hq = resolveHqAddress(magazin?.headquarters_addresses, agencyAddressId);
    const hqGeo: IGeoAddress | null = hq?.geo ?? null;
    const agencyName = magazin?.name ?? null;
    const label = agencyName
      ? `${agencyName}${hq?.city ? ` — ${hq.city}` : ''}`
      : hq?.city ?? 'Agency business location';

    return {
      source: 'agency_business',
      label,
      address: hq
        ? { line1: hq.address_description ?? null, line2: null, city: hq.city ?? null, state: hq.region ?? null, country: hqGeo?.components.country ?? null }
        : null,
      // Prefer the geocoded coordinate; fall back to the legacy bare `location`.
      location: hqGeo?.coordinates ?? hq?.location ?? null,
      geo: hqGeo,
      note: null,
      is_fallback: isFallback,
    };
  }

  // ─── Part 3: the agency's manual override ──────────────────────────────────

  private hasOverrideContent(o: HandoverPickupOverride): boolean {
    return (
      o.label != null ||
      o.addressLine1 != null ||
      o.city != null ||
      o.note != null ||
      (o.latitude != null && o.longitude != null)
    );
  }

  private fromOverride(o: HandoverPickupOverride): IShipmentHandoverPickup {
    const location: IGeoPoint | null =
      o.latitude != null && o.longitude != null
        ? { type: 'Point', coordinates: [o.longitude, o.latitude] }
        : null;

    const hasAddress = o.addressLine1 != null || o.addressLine2 != null || o.city != null || o.state != null || o.country != null;

    return {
      source: 'manual',
      label: o.label ?? null,
      address: hasAddress
        ? {
            line1: o.addressLine1 ?? null,
            line2: o.addressLine2 ?? null,
            city: o.city ?? null,
            state: o.state ?? null,
            country: o.country ?? null,
          }
        : null,
      location,
      // The manual override is loose fields + an optional raw coordinate, not a
      // selected geocoding result — so no structured GeoAddress here.
      geo: null,
      note: o.note ?? null,
      is_fallback: false,
    };
  }

  /** Deep-copy a resolved pickup into an offer/shipment sub-doc (plain object). */
  static toObject(pickup: IShipmentHandoverPickup): IShipmentHandoverPickup {
    return {
      source: pickup.source,
      label: pickup.label,
      address: pickup.address
        ? {
            line1: pickup.address.line1,
            line2: pickup.address.line2,
            city: pickup.address.city,
            state: pickup.address.state,
            country: pickup.address.country,
          }
        : null,
      location: pickup.location
        ? { type: 'Point', coordinates: [pickup.location.coordinates[0], pickup.location.coordinates[1]] as [number, number] }
        : null,
      // GeoAddress is an immutable value object — copy the reference (never
      // mutated in place), matching how the rest of the sub-doc is snapshotted.
      geo: pickup.geo ?? null,
      note: pickup.note,
      is_fallback: pickup.is_fallback,
    };
  }
}

export const handoverPickupService = new HandoverPickupService();
