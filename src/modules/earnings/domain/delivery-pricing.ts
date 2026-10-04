import type { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import { EARNINGS_CONFIG } from '../config/earnings.config';
import { resolveRegionKey } from '../../../core/constants/locations.helper';

/**
 * THE delivery-fee formula (ADR-A11) — pure, DB-free, and the ONLY definition of it.
 *
 * Every caller that prices a shipment — the cart quote, checkout, the split, the agent's and
 * the agency's quotes, the delivery-cost cap — reaches this file, directly or through
 * `deliveryFeeForPickupMix` / `computeShipmentDeliveryFee` in `EarningsQuoteService`. A fee
 * component is added HERE, never at a call site: one definition is what stops what somebody
 * is quoted drifting from what they are charged. (`test:delivery-pricing` scans `src/` for a
 * second copy of the per-kilogram arithmetic.)
 *
 * ```
 * kg          = max(1, ceil(totalWeightGrams / 1000))
 * pickupPart  = base_rate_first_kg + additional_per_kg × (kg − 1)
 *               + (outOfRegion ? out_of_region_surcharge : 0)
 * storagePart = (outOfRegion ? out_of_region_delivery_fee : local_delivery_fee)
 *               + pick_pack_fee_per_order
 * fee         = (hasPickupBased ? pickupPart : 0) + (hasStorageBased ? storagePart : 0)
 * fee         = min(fee, pricing.max_fee_per_shipment)     // null ⇒ no ceiling
 * ```
 *
 * The unit is ONE shipment (vendor order × agency): same shop + same agency, N items → one
 * fee that grows with weight. The formula is the agency's real cost, so it is used whoever
 * pays (vendor or customer). An approved `shipment.delivery_fee_override` outranks it — that
 * precedence lives in `computeShipmentDeliveryFee`, not here.
 *
 * Deliberately excluded: `peak_season_surcharge` (no season concept exists) and
 * `monthly_storage_fee_per_sku` (a recurring rent, billed by the storage-invoice worker, never
 * per order).
 *
 * All amounts are integers in minor currency units. Weights are GRAMS
 * (`api-doc/vendor/shipping.md`).
 */

/**
 * Which fulfilment modes a delivery covers.
 *
 * A delivery may be both: each product configures its own pickup independently, so one
 * shipment can carry a vendor-collected item and a warehoused one — and is then charged both
 * components, because real distinct fulfilment work happens for each class.
 *
 * Lives here (and is re-exported from `EarningsQuoteService`) so the formula's input type is
 * declared beside the formula, with no import back into the service.
 */
export interface PickupMix {
  hasPickupBased: boolean;
  hasStorageBased: boolean;
}

/** Grams in one billable kilogram. */
const GRAMS_PER_KG = 1000;

/**
 * A policy number as the formula may use it: a non-negative integer. Missing, NaN, infinite
 * and negative all read as 0 — a malformed policy charges nothing for that component rather
 * than poisoning the whole fee with NaN.
 */
function money(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A finite, positive number, or 0. */
function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The billable kilograms of a shipment: whole kilograms, rounded UP, never below 1.
 *
 * 0 g ⇒ 1 (a shipment always costs at least the first kilogram), 1000 g ⇒ 1, 1001 g ⇒ 2.
 * A missing, negative or NaN weight is treated as 0 g, i.e. 1 kg.
 */
export function kgOf(totalWeightGrams: number): number {
  return Math.max(1, Math.ceil(positive(totalWeightGrams) / GRAMS_PER_KG));
}

/** Where an item's per-unit weight came from. `'default'` is the D-4 item-count fallback. */
export type ItemWeightSource = 'variant' | 'shipping_config' | 'default';

export interface ResolvedItemWeight {
  /** Grams for ONE unit. Multiply by quantity for the line. */
  grams: number;
  source: ItemWeightSource;
}

/**
 * The weight, in grams, of ONE unit of an item — for the delivery-fee formula.
 *
 * Precedence, aligned with `ProductShippingService.getEffectiveDimensions` (variant first,
 * then the product's shipping config), with one deliberate narrowing: here the variant's
 * WEIGHT wins on its own whenever it is > 0, whether or not its length/width/height are set.
 * Pricing reads weight only; requiring a full set of dimensions before trusting a weight the
 * vendor did enter would throw that weight away.
 *
 * `0` counts as "not set" on both sources — `api-doc/vendor/shipping.md` documents that the
 * validators accept `weight: 0`, and a weightless unit must not make a shipment free of its
 * per-kilogram cost. In that case the unit counts as `defaultGrams` (ADR-A11 D-4: item count
 * is the fallback for weight), defaulting to `DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS` (1000 g).
 */
export function resolveItemWeightGrams(
  weights: { variantWeight?: number | null; shippingConfigWeight?: number | null },
  defaultGrams: number = EARNINGS_CONFIG.DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS
): ResolvedItemWeight {
  const variant = positive(weights.variantWeight);
  if (variant > 0) return { grams: variant, source: 'variant' };
  const config = positive(weights.shippingConfigWeight);
  if (config > 0) return { grams: config, source: 'shipping_config' };
  return { grams: positive(defaultGrams), source: 'default' };
}

/**
 * The total weight of a shipment's lines, in grams: Σ unitGrams × quantity. Non-positive or
 * non-finite inputs contribute nothing. Feed the result to `computeShipmentFee`.
 */
export function shipmentWeightGrams(lines: ReadonlyArray<{ grams: number; quantity: number }>): number {
  let total = 0;
  for (const line of lines) total += positive(line.grams) * positive(line.quantity);
  return total;
}

/**
 * Whether a delivery leaves the pickup's region — the switch for both out-of-region prices.
 *
 * Both sides are folded through `resolveRegionKey`, so `"Centre"`, `"Centre Region"`,
 * `"Région du Centre"` and `centre` are one region, and `"Extrême-Nord"` equals `"Far North"`.
 *
 * ⚠ **Unknown on EITHER side ⇒ in-region (false).** An order predating the drop-off snapshot,
 * a pickup with no geocoded region, a depot without one: none of them may be guessed against
 * the customer. A surcharge is charged only when both regions are known and differ.
 */
export function isOutOfRegion(
  deliveryRegion: string | null | undefined,
  pickupRegion: string | null | undefined
): boolean {
  const delivery = resolveRegionKey(deliveryRegion);
  const pickup = resolveRegionKey(pickupRegion);
  if (!delivery || !pickup) return false;
  return delivery !== pickup;
}

/**
 * The itemised fee, for display (`shipment.fee_components`) and for tests.
 * `pickupBase + weightExtra + regionSurcharge + storage` is the fee BEFORE the ceiling.
 */
export interface ShipmentFeeComponents {
  /** `base_rate_first_kg` — 0 when the shipment carries no vendor-collected item. */
  pickupBase: number;
  /** `additional_per_kg × (kg − 1)` — 0 for a storage-only or a 1 kg shipment. */
  weightExtra: number;
  /** The pickup part's `out_of_region_surcharge` when out of region, else 0. */
  regionSurcharge: number;
  /**
   * The storage part as charged: (`out_of_region_delivery_fee` when out of region, else
   * `local_delivery_fee`) + `pick_pack_fee_per_order`. 0 when no warehoused item.
   */
  storage: number;
  /** True when `max_fee_per_shipment` lowered the fee. */
  capApplied: boolean;
  /** Billable kilograms (`kgOf`). */
  kg: number;
}

export interface ShipmentFeeResult {
  fee: number;
  components: ShipmentFeeComponents;
}

export interface ShipmentFeeInput {
  mix: PickupMix;
  totalWeightGrams: number;
  outOfRegion: boolean;
}

/**
 * The agency's per-shipment ceiling, or null for none. A ceiling is honoured only when it is
 * a finite number >= 1: null/absent is "no ceiling" by design, and a 0 or garbage value is
 * treated as unset rather than silently making every delivery free (the validator refuses
 * both; this guards rows written around it).
 */
export function maxFeeCeilingOf(policies: IAgencyPolicies | null | undefined): number | null {
  const raw = policies?.pricing?.max_fee_per_shipment;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : null;
}

/**
 * The fee for ONE shipment under one agency's pricing policy. See the file header for the
 * formula. Integer, never negative; missing/NaN policy numbers read as 0.
 */
export function computeShipmentFee(policies: IAgencyPolicies, input: ShipmentFeeInput): ShipmentFeeResult {
  const pricing = policies?.pricing;
  const pickup = pricing?.pickup_based;
  const storageCfg = pricing?.storage_based;
  const kg = kgOf(input.totalWeightGrams);

  let pickupBase = 0;
  let weightExtra = 0;
  let regionSurcharge = 0;
  let storage = 0;

  if (input.mix.hasPickupBased) {
    pickupBase = money(pickup?.base_rate_first_kg);
    weightExtra = money(pickup?.additional_per_kg) * (kg - 1);
    regionSurcharge = input.outOfRegion ? money(pickup?.out_of_region_surcharge) : 0;
  }

  if (input.mix.hasStorageBased) {
    const delivery = input.outOfRegion
      ? money(storageCfg?.out_of_region_delivery_fee)
      : money(storageCfg?.local_delivery_fee);
    storage = delivery + money(storageCfg?.pick_pack_fee_per_order);
  }

  const uncapped = pickupBase + weightExtra + regionSurcharge + storage;
  const ceiling = maxFeeCeilingOf(policies);
  const capApplied = ceiling !== null && uncapped > ceiling;
  const fee = Math.max(0, capApplied ? (ceiling as number) : uncapped);

  return {
    fee,
    components: { pickupBase, weightExtra, regionSurcharge, storage, capApplied, kg },
  };
}
