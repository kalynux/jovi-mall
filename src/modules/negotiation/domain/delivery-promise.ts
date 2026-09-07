/**
 * What the platform can truthfully promise about delivery — and, as importantly, what it
 * cannot.
 *
 * ── THIS TOOL WAS RE-SCOPED, AND THE OLD SCOPE IS NOT A MISSING FEATURE ──────────
 *
 * `quote_delivery` was specified as a fee quote with a waiver to grant, because that is
 * what a market vendor's "I'll deliver it free" normally trades away. **There is no fee to
 * quote and no waiver to grant.** BARGAINING-AGENT-PLAN.md D-7: `order.total_amount` is
 * the item subtotal, the agency's fee comes out of the vendor's net inside `splitOrder`,
 * and `cart-quote.service.ts` already reports the customer's delivery charge as a literal
 * `0`. Delivery is *already* free to every customer on every order.
 *
 * So the sub-agent may promise free delivery truthfully — it just may not present it as a
 * concession it decided to make, because it is not one. What this file builds is the
 * delivery **promise**: is it deliverable, by whom, and when.
 *
 * ⚠ **`absorbedByVendor` MUST NEVER APPEAR IN ANYTHING THIS FILE PRODUCES.** It is what the
 * vendor pays the agency, it exists on `CartQuote` for the storefront's benefit, and it is
 * the one number on that quote that a customer must not see. Nothing here reads it, nothing
 * here computes it, and `test:negotiation-tools` asserts by source scan that no file on
 * this surface mentions it.
 *
 * ── "WHEN", AND WHY THE ANSWER IS `null` ────────────────────────────────────────
 *
 * The plan said to report a delivery date *"if the agency policy model supports it"* and to
 * confirm what it actually supports rather than inventing an ETA. It supports none.
 * `IAgencyPolicies` (`delivery/delivery-agency.model.ts`) carries exactly four blocks —
 * `pricing`, `returns`, `damage`, `cod` — plus `documents`. There is no delivery-time
 * field, no SLA, no working-hours schedule and no per-region lead time anywhere on the
 * agency or on its Magazin; `coverage_areas` is a list of region keys and nothing more.
 * Verified against the source, 2026-09-07.
 *
 * `eta` is therefore a hardcoded `null` beside an `etaBasis` that says why, rather than an
 * omitted key. An absent field invites a model to fill the gap from the product page or
 * from what delivery usually takes; a present `null` with a stated reason does not. The
 * playbook's own rule is the same one — *"Quote real terms from the tool; never invent
 * delivery promises."*
 *
 * When a lead time does become a field on the policy model, `etaBasis` is the single place
 * that has to change, and the `null` becomes a real value at one call site.
 */

/** Why this product is or is not deliverable, in a closed set the caller can branch on. */
export type DeliverabilityReason =
    /** Physical, an agency resolves, and it is the agency's to carry. */
    | 'agency_assigned'
    /** Digital — nothing ships; the customer downloads it after payment. */
    | 'digital_download'
    /** A service or booking — fulfilled in person, not delivered. */
    | 'not_shipped'
    /**
     * Physical, but neither the product nor the vendor names an agency. Checkout raises
     * `ORDER_NO_DELIVERY_AGENCY` on this, so the honest answer is "I cannot promise
     * delivery on this one", not a silent yes.
     */
    | 'no_agency_resolved';

export interface DeliveryAgencyFacts {
    id: string;
    /** The agency's BUSINESS name, from its Magazin — `DeliveryAgency` carries no `name`. */
    name: string | null;
    /** Region keys the agency serves. `[]` when it has published none. */
    coverageAreas: string[];
}

export interface DeliveryPromise {
    deliverable: boolean;
    reason: DeliverabilityReason;
    /**
     * What the CUSTOMER pays for delivery. Always `0`, and stated as a number rather than a
     * boolean so the sub-agent can quote it in a sentence without a lookup.
     */
    customerPays: 0;
    currency: string;
    /** `true` whenever `customerPays` is 0. Restated because that is the sentence. */
    free: true;
    agency: DeliveryAgencyFacts | null;
    /**
     * Whether `agency` serves the region the caller named. `null` when no region was named,
     * or when the agency has published no coverage list — deliberately distinct from
     * `false`, which is a real "they do not go there".
     */
    coversRegion: boolean | null;
    /** Always `null` today. See `etaBasis` and this file's header. */
    eta: null;
    /** Why `eta` is what it is. A sentence for the model, not a code. */
    etaBasis: string;
}

/**
 * The one sentence explaining the `null` ETA, held as a constant so it cannot drift
 * between the tool's response and its documentation.
 */
export const NO_ETA_BASIS =
    'No delivery date is available: the agency policy model carries no lead time, SLA or '
    + 'schedule, so any date would be invented. Say delivery is arranged with the agency '
    + 'and free, and do not name a day.';

export interface DeliveryPromiseInput {
    productType: 'physical' | 'digital' | 'service';
    currency: string;
    agency: DeliveryAgencyFacts | null;
    /** The region key the customer asked about, when they named one. */
    region?: string;
}

/**
 * Build the promise.
 *
 * Pure, so `test:negotiation-tools` can walk every branch — including the two that need a
 * misconfigured catalogue to reach — without a database.
 */
export function buildDeliveryPromise(input: DeliveryPromiseInput): DeliveryPromise {
    const base = {
        customerPays: 0 as const,
        currency: input.currency,
        free: true as const,
        eta: null,
        etaBasis: NO_ETA_BASIS,
    };

    if (input.productType === 'digital') {
        return { ...base, deliverable: true, reason: 'digital_download', agency: null, coversRegion: null };
    }
    if (input.productType === 'service') {
        return { ...base, deliverable: true, reason: 'not_shipped', agency: null, coversRegion: null };
    }
    if (!input.agency) {
        return { ...base, deliverable: false, reason: 'no_agency_resolved', agency: null, coversRegion: null };
    }

    return {
        ...base,
        deliverable: true,
        reason: 'agency_assigned',
        agency: input.agency,
        coversRegion: resolveCoverage(input.agency.coverageAreas, input.region),
    };
}

/**
 * Three-valued on purpose.
 *
 * `null` when there is nothing to compare — no region named, or an agency that has
 * published no coverage list at all. Collapsing that to `false` would have the sub-agent
 * telling a customer their town is not served, on the strength of an empty array that means
 * the agency never filled the field in.
 *
 * The comparison is case-insensitive because `coverage_areas` holds region KEYS
 * (`normalizeCoverageAreasForCountry`) while the region reaching this tool came out of a
 * chat message.
 */
function resolveCoverage(coverageAreas: string[], region: string | undefined): boolean | null {
    if (!region || coverageAreas.length === 0) return null;
    const needle = region.trim().toLowerCase();
    if (needle.length === 0) return null;
    return coverageAreas.some((area) => area.trim().toLowerCase() === needle);
}
