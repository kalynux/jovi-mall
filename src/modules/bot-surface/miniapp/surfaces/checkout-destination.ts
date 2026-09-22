import type { ICustomerSavedAddress } from '../../../customers/customer.model';

/**
 * Where a CHAT checkout sends the basket — the one rule the chat review and the chat place share.
 *
 * ── WHY THIS EXISTS BESIDE `resolveDestination` ─────────────────────────────
 * The checkout SCREEN supports exactly one destination: the default saved address (else the
 * first), and it must be geocoded. It has no address picker by design (`co.html`'s opening
 * comment). A chat has no screen at all, so the customer CHOOSES among their saved addresses in
 * words — "send it to the office" — and the model passes that address's id. Owner's decision,
 * 2026-09-22: the assistant completes a purchase with tools, choosing from the addresses the
 * account already has, and sends a customer with none to the website to add one.
 *
 * ── ⚠ THE CHOSEN ID IS PASSED TO `createOrdersFromCart` EXPLICITLY ───────────
 * Never "the default" by omission. The review tells the customer where the parcel is going; if
 * the place then fell back to whatever the default was at that moment, a default changed on the
 * website between the two would send the delivery somewhere the customer never confirmed —
 * the exact failure the screen's rule exists to avoid, reintroduced through the chat.
 *
 * ── ⚠ "DELIVERABLE" MEANS COORDINATES, NOT MERELY A `geo` OBJECT ─────────────
 * `toBotAddressDto` reports `deliverable: Boolean(geo?.coordinates)`, and that is what the model
 * has already been shown by `addresses_list`. Judging by the bare `geo` object here would let the
 * chat confirm an address that the address book called undeliverable a turn earlier.
 *
 * Pure: no clock, no database, no `await` — `test:inapp-checkout` drives it directly.
 */

/** Why a chat checkout cannot go ahead with the address it has. */
export type ChatDestinationBlocker =
    /** The account has no saved address at all. Remedy: add one on the website. */
    | 'no_saved_address'
    /** The chosen (or default) address was typed by hand and never geocoded. Remedy: pick another. */
    | 'address_not_deliverable'
    /** The id the model passed is not one of this customer's addresses. Remedy: list them again. */
    | 'address_not_found';

export type ChatDestination =
    /** A download: nothing is carried anywhere, so no address is needed or used. */
    | { kind: 'digital' }
    | { kind: 'address'; address: ICustomerSavedAddress }
    | { kind: 'blocked'; blocker: ChatDestinationBlocker };

/** Whether an address can be routed to — the same test the address book reports. */
export function isDeliverableAddress(address: ICustomerSavedAddress): boolean {
    return Boolean(address.geo?.coordinates);
}

/**
 * Resolve the destination for a chat checkout.
 *
 * @param productType The basket's type. A digital basket ignores `requestedId` entirely — a
 *   download has no drop-off, and refusing one over an address would strand every download.
 * @param addresses The customer's saved addresses, in stored order.
 * @param requestedId The address the customer chose, or null for "my default".
 *
 * ⚠ **With no choice, it is the default else the first — the screen's rule exactly — and that
 * address must itself be deliverable.** It does NOT quietly skip to some other geocoded address:
 * the customer's default is a statement of where they want things, and sending the parcel to
 * their second address because the first was typed by hand is a decision for them, not for a
 * fallback. The blocker hands the choice back with the list.
 */
export function resolveChatDestination(
    productType: string | null | undefined,
    addresses: readonly ICustomerSavedAddress[],
    requestedId: string | null,
): ChatDestination {
    if (productType === 'digital') return { kind: 'digital' };

    if (requestedId) {
        const chosen = addresses.find((address) => String(address._id) === requestedId);
        if (!chosen) return { kind: 'blocked', blocker: 'address_not_found' };
        if (!isDeliverableAddress(chosen)) return { kind: 'blocked', blocker: 'address_not_deliverable' };
        return { kind: 'address', address: chosen };
    }

    const fallback = addresses.find((address) => address.is_default) ?? addresses[0] ?? null;
    if (!fallback) return { kind: 'blocked', blocker: 'no_saved_address' };
    if (!isDeliverableAddress(fallback)) return { kind: 'blocked', blocker: 'address_not_deliverable' };
    return { kind: 'address', address: fallback };
}
