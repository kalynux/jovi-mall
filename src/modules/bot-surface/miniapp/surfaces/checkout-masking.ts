import { ICustomer, ICustomerSavedAddress } from '../../../customers/customer.model';
import { maskPhone } from '../../dto/bot-projections';

/**
 * What the checkout screen is allowed to say about where a basket is going.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE AND NOT TWO FUNCTIONS IN THE CONTROLLER ──────
 * It is **protection 3** of the four that keep a `co` handle safe — the reason a forwarded
 * checkout URL cannot read out where somebody lives — and it is the only one of the four that
 * a source scan cannot verify. A scan sees that *something* was dropped; only driving the
 * function shows *what*. So `test:inapp-checkout` § 2 drives both of these against fixtures.
 *
 * ⚠ **And it cannot do that through the controller.** `checkout.controller.ts` imports
 * `orders/order.service` and `payments/`, both of which do work at import time and never
 * return in a bare `ts-node` process — the suites on this surface are DB-free and run exactly
 * that way. Importing the controller to reach two pure functions would hang the suite, and the
 * repair somebody would reach for is deleting the assertions.
 *
 * Everything here is pure: no clock, no database, no `await`.
 */

/**
 * `Home · Akwa, Douala` — enough to recognise, not enough to arrive at.
 *
 * ── ⚠ A `co` URL IS FORWARDABLE AND THE ADDRESS MUST SURVIVE THAT ───────────
 * The `maskPhone` precedent is head-and-tail, which works because a phone number has a shape.
 * An address does not, so the rule here is about *kind* rather than position: what is dropped
 * is everything that gets a stranger to a door — the street line, the second line, the postcode
 * and the coordinates — and what is kept is the label the customer chose plus a locality.
 *
 * A stranger who opens a forwarded checkout learns a neighbourhood. The owner reads their own
 * address and recognises it instantly, which is the only question this line has to answer:
 * *"is this the right place?"*
 *
 * ⚠ **`components` is read before the flat columns**, because the geocoder's breakdown is what
 * is actually populated on a picked address — the flat `city` is a legacy field that an address
 * captured through the chat's map pin may never have been given.
 */
export function maskAddress(address: ICustomerSavedAddress): string {
    const parts = address.geo?.components;
    const locality = [
        parts?.neighbourhood,
        parts?.city ?? address.city,
        parts?.region ?? address.state,
    ]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter((part) => part.length > 0);

    /**
     * De-duplicated because `neighbourhood` and `city` legitimately repeat in the small
     * localities this platform serves, and `Akwa, Akwa` reads as a bug in the address rather
     * than as a coarse one.
     */
    const seen = new Set<string>();
    const coarse = locality.filter((part) => {
        const key = part.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    /**
     * ⚠ **The label alone when the geocoder gave us no locality — NEVER the street line.** That
     * fallback is the one a later reader is most likely to "improve", because an address with
     * only a label looks unhelpful. It is the whole point: an address with no usable locality
     * is one where the only remaining text is precisely what must not be shown.
     */
    return coarse.length > 0 ? `${address.label} · ${coarse.join(', ')}` : address.label;
}

/**
 * Where a DIGITAL purchase lands: the account, named by something its owner recognises.
 *
 * ⚠ **A digital basket has no delivery address at all**, so without this the checkout screen
 * would park every download purchase in the no-address state — telling a customer to send an
 * address for something that is never carried anywhere.
 *
 * ⚠ **Masked, and language-free.** A masked email or phone reads correctly under the screen's
 * "Deliver to" heading in all five languages without a copy key, which is what lets this state
 * exist at all in a file that owns no copy table.
 *
 * The name is the last resort rather than the first because it is the least specific: two
 * people in a household share a surname far more often than an inbox.
 */
export function accountIdentifier(customer: ICustomer): string {
    if (customer.email) return maskEmail(customer.email);
    if (customer.phone) return maskPhone(customer.phone);
    return customer.name;
}

/**
 * `jean.dupont@example.com` → `j••••t@example.com`.
 *
 * ⚠ **Deliberately the same shape as the private helper in `bot-projections.ts`**, which masks
 * the same field for `profile_get_summary` and `contact_get_state`. It is copied rather than
 * imported because that one is not exported — and the rule those two files already state
 * applies here too: a customer must not meet their own address masked two different ways
 * depending on which surface answered. `test:inapp-checkout` § 2 drives this one; the shared
 * shape is pinned by `test:bot-surface`.
 */
function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '••••';
    if (local.length <= 2) return `${local[0] ?? '•'}••••@${domain}`;
    return `${local[0]}••••${local[local.length - 1]}@${domain}`;
}
