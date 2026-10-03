import { COD_CONFIG } from '../config/cod.config';

/**
 * ─── The COD limits above the agent: the rules, as pure functions ────────────
 *
 * Owner decisions, 2026-10-02. Two caps sit ABOVE the agent's own exposure gate
 * (`CodExposureService`), both measured on the same quantity:
 *
 *   1. **The agency's limit** — every agency may hold at most
 *      `COD_CONFIG.AGENCY_COD_LIMIT_DEFAULT` (1 000 000) of COD cash that has not
 *      reached the platform, unless an administrator PINNED another amount
 *      (`delivery_agencies.cod_limit_override`). Same shape and same posture as the
 *      agent's pool pin: a separate field nothing else writes, reason required,
 *      releasable.
 *   2. **The vendor's terms** — a vendor may cap how much of THEIR orders' cash one
 *      agency may hold at once (`vendor_settings.cod_terms.max_cash_per_agency`,
 *      `null` = no vendor cap), and may refuse COD altogether (`cod_enabled`).
 *
 * ── What "exposure" is (one definition, both caps) ──────────────────────────
 *
 *   in-flight            the COD amount of every shipment the agency holds in
 *                        `COD_EXPOSURE_SHIPMENT_STATUSES` whose cash is not yet
 *                        collected — the pending collection's `expected_amount`
 *                        when one exists, else Σ item price × qty (a collection
 *                        row only exists once an agent accepted);
 *   collected-unremitted every COLLECTED CashCollection of that agency whose
 *                        `settled_amount < expected_amount` — cash in the hands
 *                        of its agents or the agency that the platform has not
 *                        received. `settled_amount` advances only by a confirmed
 *                        agency remittance or an agent's direct-to-platform
 *                        deposit (both through `CodSettlementService` FIFO), so
 *                        this is exactly "not yet remitted to the platform".
 *
 * `pending` is deliberately NOT an exposure status: a pending shipment has not been
 * handed to the agency yet — dispatch is the moment the cash risk moves, and dispatch
 * is where the gate runs. `failed` / `returned` / `rejected` / `delivered` carry no
 * uncollected cash the agency answers for (a delivered COD shipment's cash is in the
 * collected-unremitted half). `pending_agency_reassignment` is a hold, not custody.
 *
 * Nothing here reads a database. `AgencyCodExposureService` gathers the rows and
 * `CodLimitGateService` decides with these.
 */

/** Shipment statuses whose uncollected COD cash the agency answers for. */
export const COD_EXPOSURE_SHIPMENT_STATUSES = [
  'assigned',
  'handing_over',
  'picked_up',
  'in_transit',
  'agent_delivered',
] as const;

// ─── The agency's limit ─────────────────────────────────────────────────────

export const AGENCY_COD_LIMIT_SOURCES = ['default', 'override'] as const;
export type AgencyCodLimitSource = (typeof AGENCY_COD_LIMIT_SOURCES)[number];

export interface AgencyCodLimit {
  amount: number;
  source: AgencyCodLimitSource;
}

/** The pin wins whenever one is set; otherwise the platform default. */
export function resolveAgencyCodLimit(override: { amount: number } | null | undefined): AgencyCodLimit {
  if (override && Number.isFinite(override.amount) && override.amount >= 0) {
    return { amount: Math.floor(override.amount), source: 'override' };
  }
  return { amount: COD_CONFIG.AGENCY_COD_LIMIT_DEFAULT, source: 'default' };
}

// ─── The vendor's terms ─────────────────────────────────────────────────────

export interface VendorCodTerms {
  /** `false` refuses COD at checkout for any order containing this vendor's items. */
  codEnabled: boolean;
  /** Max of this vendor's COD cash one agency may hold un-remitted at once. `null` = no cap. */
  maxCashPerAgency: number | null;
}

export const DEFAULT_VENDOR_COD_TERMS: VendorCodTerms = Object.freeze({
  codEnabled: true,
  maxCashPerAgency: null,
});

/** Read stored terms (snake_case, possibly absent on legacy documents) with the defaults applied. */
export function vendorCodTermsOf(
  stored: { cod_enabled?: boolean | null; max_cash_per_agency?: number | null } | null | undefined
): VendorCodTerms {
  return {
    codEnabled: stored?.cod_enabled ?? DEFAULT_VENDOR_COD_TERMS.codEnabled,
    maxCashPerAgency:
      typeof stored?.max_cash_per_agency === 'number' && stored.max_cash_per_agency >= 0
        ? stored.max_cash_per_agency
        : null,
  };
}

// ─── Exposure ───────────────────────────────────────────────────────────────

/** Σ order-item price × shipment-item qty. An unmatched item counts 0 (it cannot be priced). */
export function expectedCodAmount(
  orderItems: Array<{ _id?: unknown; price: number }>,
  shipmentItems: Array<{ order_item_id: unknown; quantity: number }>
): number {
  const priceById = new Map(orderItems.map((i) => [String(i._id), i.price]));
  let total = 0;
  for (const si of shipmentItems) {
    const price = priceById.get(String(si.order_item_id));
    if (typeof price === 'number' && Number.isFinite(price)) total += price * si.quantity;
  }
  return total;
}

/** One shipment the agency holds, already filtered to COD and to `COD_EXPOSURE_SHIPMENT_STATUSES`. */
export interface ExposureShipmentRow {
  shipmentId: string;
  vendorId: string;
  /** The pending collection's `expected_amount`, or the computed amount when no row exists. */
  amount: number;
  /** The shipment's collection status, `null` when no collection row exists yet. */
  collectionStatus: 'pending' | 'collected' | 'cancelled' | null;
}

/** One COLLECTED collection of the agency. */
export interface ExposureCollectionRow {
  collectionId: string;
  vendorId: string;
  expectedAmount: number;
  settledAmount: number;
}

export interface CodExposureTotals {
  /** Uncollected cash of in-custody COD shipments. */
  inFlight: number;
  inFlightCount: number;
  /** Collected cash not yet remitted to the platform. */
  collectedUnremitted: number;
  collectedCount: number;
  /** `inFlight + collectedUnremitted` — the figure both caps bound. */
  total: number;
}

/**
 * Sum the two halves. `vendorId` narrows both to one vendor's orders (the vendor-terms
 * cap); omit it for the agency-wide figure.
 *
 * A shipment whose collection is already `collected` is skipped on the in-flight side —
 * its cash is counted, once, on the collected side.
 */
export function sumCodExposure(
  shipments: ExposureShipmentRow[],
  collections: ExposureCollectionRow[],
  vendorId: string | null = null
): CodExposureTotals {
  let inFlight = 0;
  let inFlightCount = 0;
  for (const s of shipments) {
    if (vendorId !== null && s.vendorId !== vendorId) continue;
    if (s.collectionStatus === 'collected') continue;
    const amount = Math.max(0, s.amount);
    if (amount === 0) continue;
    inFlight += amount;
    inFlightCount++;
  }

  let collectedUnremitted = 0;
  let collectedCount = 0;
  for (const c of collections) {
    if (vendorId !== null && c.vendorId !== vendorId) continue;
    const outstanding = Math.max(0, c.expectedAmount - c.settledAmount);
    if (outstanding === 0) continue;
    collectedUnremitted += outstanding;
    collectedCount++;
  }

  return {
    inFlight,
    inFlightCount,
    collectedUnremitted,
    collectedCount,
    total: inFlight + collectedUnremitted,
  };
}

// ─── The decision ───────────────────────────────────────────────────────────

export const COD_LIMIT_HOLD_KINDS = ['agency_limit', 'vendor_terms'] as const;
export type CodLimitHoldKind = (typeof COD_LIMIT_HOLD_KINDS)[number];

/** Why a shipment may not be handed to an agency without `force`. Mirrors the 422's `details`. */
export interface CodLimitBreach {
  kind: CodLimitHoldKind;
  currentExposure: number;
  additionalAmount: number;
  limit: number;
}

export interface CodLimitInputs {
  /** The COD amount this hand-off would ADD to the agency's custody. */
  additionalAmount: number;
  agency: { exposure: number; limit: number };
  /** `null` when the vendor sets no cap — or when the caller has nothing vendor-scoped to test. */
  vendor: { exposure: number; cap: number | null } | null;
}

/**
 * The first cap the hand-off would breach, or `null`.
 *
 * The AGENCY's limit is tested first: it is the platform's own risk rule, and a vendor
 * reading "your terms" on a refusal the platform would have made anyway would go and
 * loosen their terms for nothing. A zero-value hand-off (a prepaid order, an unpriceable
 * shipment) is never refused — it adds no cash, so it cannot push anybody over.
 *
 * "Over" means strictly greater: holding exactly the limit is allowed.
 */
export function evaluateCodLimits(input: CodLimitInputs): CodLimitBreach | null {
  const additional = Math.max(0, input.additionalAmount);
  if (additional === 0) return null;

  if (input.agency.exposure + additional > input.agency.limit) {
    return {
      kind: 'agency_limit',
      currentExposure: input.agency.exposure,
      additionalAmount: additional,
      limit: input.agency.limit,
    };
  }

  const vendor = input.vendor;
  if (vendor && vendor.cap !== null && vendor.exposure + additional > vendor.cap) {
    return {
      kind: 'vendor_terms',
      currentExposure: vendor.exposure,
      additionalAmount: additional,
      limit: vendor.cap,
    };
  }

  return null;
}
