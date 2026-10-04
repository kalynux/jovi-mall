/**
 * What the platform can truthfully promise about delivery — and, as importantly, what it
 * cannot.
 *
 * ── THIS TOOL WAS RE-SCOPED, AND THE OLD SCOPE IS NOT A MISSING FEATURE ──────────
 *
 * `quote_delivery` was specified as a fee quote with a waiver to grant, because that is
 * what a market vendor's "I'll deliver it free" normally trades away. **There is no waiver to
 * grant**, and since ADR-A11 (customer-paid delivery, 2026-10-04) there is no blanket
 * "delivery is free" to promise either.
 *
 * ── ⚠ ADR-A11 CHANGED WHAT MAY BE PROMISED — read this before editing ───────────
 *
 * Until 2026-10-04 delivery was free to every customer on every order (BARGAINING-AGENT-PLAN
 * D-7), so this file returned `free: true` unconditionally. Free delivery is now a SHOP
 * setting (`vendor_settings.delivery_terms`, ADR-A11 D-1):
 *
 *     always   the shop pays — delivery is free                       free: true
 *     never    the customer pays a fee shown at checkout             free: false
 *     above    free once THIS shop's part of the order reaches X     free: amount >= X
 *
 * so the promise is DERIVED from the shop's terms (and, for `above`, the deal amount the
 * caller names), through `resolveDeliveryPayer` — the rule checkout applies. The sub-agent may
 * promise free delivery ONLY when `free` is true, and may never quote a fee: the fee depends on
 * the agency, the weight of the whole basket and the drop-off region, which only checkout reads
 * (`customerPays` is `0` or `null`, never a positive number). It still may not present free
 * delivery as a concession it decided to make — the shop's posted terms decided it.
 *
 * ⚠ Even `free: true` carries one honest caveat (`feeBasis`): a very small order on a
 * free-delivery shop can fall back to customer-paid at checkout (the 30% cost cap, D-6).
 * Computing that here would mean pricing the basket through `CartQuoteService`, which this
 * surface deliberately does NOT import: a negotiation turn must not depend on agency pricing,
 * the drop-off region and the whole cart, and a quote it cannot finish must not block a price
 * talk. `test:negotiation-tools` pins that it is not imported.
 *
 * What this file builds is the delivery **promise**: is it deliverable, by whom, when, and is
 * it free on the shop's terms.
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

import { resolveRegionKey } from '../../../core/constants/locations.helper';
import { resolveDeliveryPayer, VendorDeliveryTerms } from '../../vendors/domain/delivery-terms';

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
     * What the CUSTOMER pays for delivery, as far as the shop's terms decide it (ADR-A11):
     * `0` when delivery is free, `null` when a fee applies — shown at checkout and NEVER a
     * number here (the fee depends on the agency, the basket's weight and the drop-off).
     */
    customerPays: 0 | null;
    currency: string;
    /**
     * Free delivery on the shop's terms: always for an `always` shop, for an `above` shop only
     * once `amount` reaches the threshold, never for a `never` shop. `true` for a download or a
     * service — nothing ships, nothing is charged. The ONLY field that licenses "free delivery".
     */
    free: boolean;
    /**
     * The shop's posted delivery terms `{ mode, freeAboveAmount }` — public, the storefront shows
     * them on every product. `null` when nothing ships.
     */
    terms: VendorDeliveryTerms | null;
    /**
     * For an `above` shop asked with an `amount` below the threshold: how much more from THIS
     * shop makes delivery free — a lever ("add one more and delivery is free"). `null` otherwise.
     */
    freeDeliveryShortfall: number | null;
    /** What the sub-agent may say about the fee — a sentence for the model (`FEE_BASIS`). */
    feeBasis: string;
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
    + 'schedule, so any date would be invented. Say delivery is arranged with the agency, '
    + 'and do not name a day.';

/**
 * What may be said about the fee, per case (ADR-A11). Constants, so the tool's response and its
 * documentation cannot drift — `api-doc/n8n/negotiation-tools.md` § 6 quotes them.
 */
export const FEE_BASIS = Object.freeze({
    /** `always`, or `above` with the amount met. */
    free:
        "This shop pays delivery on this order: you may say delivery is free. It is the shop's "
        + 'posted terms, not a concession of yours. On a very small order checkout may ask the '
        + 'customer to pay delivery instead; if so, checkout shows the amount.',
    /** `above`, the amount below the threshold or not given. */
    freeFrom:
        'This shop delivers free once its part of the order reaches terms.freeAboveAmount; below '
        + 'that a delivery fee is added at checkout. You may say "free delivery from" that amount, '
        + 'or use freeDeliveryShortfall as a reason to add to the deal. Never quote a fee amount.',
    /** `never`. */
    customerPays:
        "The customer pays delivery on this shop's orders; the fee is shown at checkout and depends "
        + 'on the delivery company, the weight and the address. Never promise free delivery and '
        + 'never quote or invent a fee amount.',
    /** Digital or service — nothing ships. */
    notShipped: 'Nothing is shipped, so there is no delivery fee.',
});

export interface DeliveryPromiseInput {
    productType: 'physical' | 'digital' | 'service';
    currency: string;
    agency: DeliveryAgencyFacts | null;
    /** The region key the customer asked about, when they named one. */
    region?: string;
    /**
     * The shop's delivery terms with the default applied (`vendorDeliveryTermsOf`). Absent/null
     * reads as the platform default `always` (D-2) — the caller loads them for a physical product.
     */
    terms?: VendorDeliveryTerms | null;
    /**
     * The deal's amount from this shop (price × quantity, XAF), when the sub-agent knows it — it
     * decides an `above` shop's threshold. Absent ⇒ an `above` shop reports `free: false` with
     * its `freeAboveAmount` (never a guess in the customer's favour).
     */
    amount?: number;
}

/**
 * Build the promise.
 *
 * Pure, so `test:negotiation-tools` can walk every branch — including the two that need a
 * misconfigured catalogue to reach — without a database.
 */
export function buildDeliveryPromise(input: DeliveryPromiseInput): DeliveryPromise {
    const timing = { currency: input.currency, eta: null, etaBasis: NO_ETA_BASIS };

    if (input.productType === 'digital' || input.productType === 'service') {
        return {
            ...timing,
            customerPays: 0,
            free: true,
            terms: null,
            freeDeliveryShortfall: null,
            feeBasis: FEE_BASIS.notShipped,
            deliverable: true,
            reason: input.productType === 'digital' ? 'digital_download' : 'not_shipped',
            agency: null,
            coversRegion: null,
        };
    }

    const fee = feeFactsOf(input.terms ?? null, input.amount);
    if (!input.agency) {
        return { ...timing, ...fee, deliverable: false, reason: 'no_agency_resolved', agency: null, coversRegion: null };
    }

    return {
        ...timing,
        ...fee,
        deliverable: true,
        reason: 'agency_assigned',
        agency: input.agency,
        coversRegion: resolveCoverage(input.agency.coverageAreas, input.region),
    };
}

/**
 * The fee half of the promise, from the shop's terms — through `resolveDeliveryPayer`, the rule
 * checkout applies, so the promise and the charge cannot disagree about who pays. An `above` shop
 * asked with no amount is reported NOT free (an unknown amount is read as below the threshold).
 */
function feeFactsOf(
    stored: VendorDeliveryTerms | null,
    amount: number | undefined,
): Pick<DeliveryPromise, 'customerPays' | 'free' | 'terms' | 'freeDeliveryShortfall' | 'feeBasis'> {
    const terms: VendorDeliveryTerms = stored ?? { mode: 'always', freeAboveAmount: null };
    const known = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
    const verdict = resolveDeliveryPayer(terms, known ? amount : 0);
    const free = verdict.payer === 'vendor';

    return {
        customerPays: free ? 0 : null,
        free,
        terms: { mode: terms.mode, freeAboveAmount: terms.freeAboveAmount },
        freeDeliveryShortfall: !free && terms.mode === 'above' && known ? verdict.freeDeliveryShortfall : null,
        feeBasis: free ? FEE_BASIS.free : terms.mode === 'above' ? FEE_BASIS.freeFrom : FEE_BASIS.customerPays,
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
 * Compared through `resolveRegionKey`, because `coverage_areas` holds region KEYS
 * (`normalizeCoverageAreasForCountry`) while the region reaching this tool came out of a
 * chat message or a geocoder — "Centre Region", "Région du Centre" and `centre` are one
 * region. A plain lowercase compare said an agency covering `centre` did not serve
 * "Centre Region".
 */
function resolveCoverage(coverageAreas: string[], region: string | undefined): boolean | null {
    if (!region || coverageAreas.length === 0) return null;
    const needle = resolveRegionKey(region);
    if (needle.length === 0) return null;
    return coverageAreas.some((area) => resolveRegionKey(area) === needle);
}
