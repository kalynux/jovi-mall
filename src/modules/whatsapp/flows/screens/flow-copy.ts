/**
 * The words a WhatsApp form needs, in one language.
 *
 * ⚠ **Every string comes from `inAppCopy(language)`**, the same five-language table the Telegram
 * pages read, so a French customer gets French buttons on both channels and there's only one
 * translation to maintain. The first versions of the three Flow definitions had English literals
 * for every label.
 *
 * This is an interface, not a call, so the adapters stay pure and the suite can hand them any
 * language without importing the copy table.
 */
export interface FlowCopy {
    listingHeading: string;
    listingEmpty: string;
    outOfStock: string;
    detailChoose: string;
    checkoutTotal: string;
    checkoutAddress: string;
    checkoutDigitalDelivery: string;
    checkoutNoAddress: string;
    checkoutPay: string;
    checkoutWatchChat: string;
    expired: string;
    failed: string;
    /** "View product". Footer label, ≤ 35. */
    flowOpenProduct: string;
    /** "Back to chat". Footer label, ≤ 35. */
    flowBackToChat: string;
    /** The phone field's label. ⚠ ≤ 20, which `checkoutPhone` exceeds in pt and es. */
    flowPhoneLabel: string;
    /** Under-field hint: leave empty for the account number, or include the country code. */
    flowPhoneHint: string;
    /**
     * ── THE TWO BOOKING STRINGS A FORM NEEDS AND A PAGE DOES NOT ────────────
     * Every other word on the booking screens comes from `readBookingPicker`'s own `copy`, which
     * the Telegram pages read too — one table, so the two channels cannot word one screen
     * differently. These two are here because **a Flow screen has a footer button and a web page
     * has not**: a page's list rows are tapped directly, so nothing there ever says "Open" or
     * "See times".
     */
    bookingOpen: string;
    bookingSeeTimes: string;
}
