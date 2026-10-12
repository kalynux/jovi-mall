# Landing (shop + customer account): Wi-Mall Protection, 3 days (2026-10-10)

**Backend built and tested, not deployed yet. The legal documents are already live.**
Shared rule: [../FRONTEND-CHANGELOG-wi-mall-protection.md](../FRONTEND-CHANGELOG-wi-mall-protection.md).

## What changed for the customer

1. **Wi-Mall can settle a problem only for 3 days after delivery.** That is how long it holds
   the seller's payment. After that the customer deals with the seller.
2. **Reporting a problem in time puts the seller's payment on hold** until the request ends.
3. **A delivered order is confirmed automatically after 3 days** (it was 7).

No request body changed. Two fields were added, and one internal field was removed from bookings.

## New: `protection` on the order and on the booking

- **Orders:** `GET /api/customer/orders/:id` and every order of `GET /api/customer/orders/groups/:cartId`.
- **Bookings:** `GET /api/customer/bookings`, `GET /api/customer/bookings/:id`, and the booking returned by
  cancel and reschedule.

Same shape on both, always present. For an order the window opens at **delivery**. For a booking
it opens when the seller marks the **service completed**.

```json
"protection": {
  "days": 3,
  "startsAt": "2026-10-10T09:12:00.000Z",
  "endsAt": "2026-10-13T09:12:00.000Z",
  "status": "active",
  "onHold": false,
  "problemReported": false
}
```

| `status` | `startsAt` | `endsAt` | Meaning |
|---|---|---|---|
| `not_started` | `null` | `null` | not delivered yet |
| `active` | date | date | delivered, the customer can still report a problem to Wi-Mall |
| `active` | date | **`null`** | the money is on hold (`onHold: true`): no deadline to show |
| `ended` | date | date | the 3 days are over |

- `problemReported: true` means the hold comes from this customer's own request.
- `onHold: true` with `problemReported: false` means another reason (a refund in progress, a
  card dispute). Show nothing special.
- ⛔ Never write "3" in the UI. Use `days` and `endsAt`.
- A booking completed before 2026-10-10 may read `not_started` with no dates: show nothing.

### Removed from bookings: `earningsPause`

The booking reads used to carry a raw `earningsPause` object. It was an internal record (who
paused the money, their note) and was never documented. It is no longer sent to customers. If
your code read it, use `protection.onHold` and `protection.problemReported` instead.

## New: `holds_earnings` on a ticket

On the ticket returned by `POST /api/customer/tickets`, the list and the detail.
`true`: this request is keeping the seller's payment on hold.

It becomes `true` only when all of these hold:

- the ticket is about the customer's **own** order, shipment or booking
  (`entityType`: `ORDER`, `SHIPMENT` or `BOOKING`);
- its `type` is a problem type: `ORDER_ISSUE`, `ORDER_CANCELLATION`, `ORDER_REFUND`,
  `ORDER_DISPUTE`, `ORDER_FULFILLMENT`, `PAYMENT_ISSUE`, `CHARGEBACK`, `BOOKING_ISSUE`,
  `BOOKING_CANCELLATION`, `PRODUCT_ISSUE`, `SHIPPING_ISSUE`, `DELIVERY_DELAY`,
  `DELIVERY_CONFIRMATION`, `GENERAL_SUPPORT`, `OTHER`;
- the seller's payment has not been released yet.

Otherwise the ticket is created exactly as before, with `holds_earnings: false`. Same status
code, no error.

**Closing or resolving the ticket as the customer releases the hold.** Warn before it.

## What to build

1. **Order detail (delivered) and booking detail (service completed), `status: "active"` with an
   `endsAt`:** a notice with the deadline and a "Report a problem" button that opens the ticket
   form with `entityType: "ORDER"` and the order id, or `entityType: "BOOKING"` and the booking id.
2. **`problemReported: true`:** replace the notice with the on-hold message. Link to the ticket.
3. **`status: "ended"`:** the after-protection message. Keep the "Report a problem" button; the
   request still reaches the seller and support.
4. **Ticket form:** when it is opened from an order or a booking, default the type to a problem
   type (never `INVOICE_REQUEST` or `ADDRESS_CHANGE` for a complaint).
5. **After creating a ticket:** read `holds_earnings` and show the matching confirmation.
6. **Ticket detail:** a banner while `holds_earnings` is `true`. Confirm before
   `POST /api/customer/tickets/:id/close` and before setting `resolved` or `closed`.
7. **Replace every "7 days"** about automatic confirmation with the deadline from `protection`.
8. **Product page and checkout (optional but recommended):** one line about the protection,
   linked to the Returns policy.

## Copy

| Where | EN | FR |
|---|---|---|
| Notice, active | Wi-Mall Protection: report any problem with this order before **{endsAt}**. Until then we hold the seller's payment and can settle it for you. | Protection Wi-Mall : signalez tout problème concernant cette commande avant le **{endsAt}**. D'ici là, nous conservons le paiement du vendeur et pouvons régler le problème pour vous. |
| Notice, on hold | You reported a problem. The seller's payment is on hold until your request is closed. | Vous avez signalé un problème. Le paiement du vendeur est suspendu jusqu'à la clôture de votre demande. |
| Notice, ended | Wi-Mall Protection ended on {endsAt}. The seller has been paid, so we can no longer refund this order ourselves. Contact the seller first; you can still send us a request. | La Protection Wi-Mall a pris fin le {endsAt}. Le vendeur a été payé : nous ne pouvons plus rembourser cette commande nous-mêmes. Contactez d'abord le vendeur ; vous pouvez toujours nous envoyer une demande. |
| After create, `holds_earnings: true` | Request sent. The seller's payment is on hold while we look into it. | Demande envoyée. Le paiement du vendeur est suspendu pendant que nous l'examinons. |
| After create, `false`, order `ended` | Request sent. The protection period for this order is over, so the seller has already been paid. We will pass your request on. | Demande envoyée. La période de protection de cette commande est terminée : le vendeur a déjà été payé. Nous transmettons votre demande. |
| Ticket banner | The seller's payment for this order is on hold while this request is open. | Le paiement du vendeur pour cette commande est suspendu tant que cette demande est ouverte. |
| Confirm close | Close this request? The seller's payment will be released. | Clôturer cette demande ? Le paiement du vendeur sera libéré. |
| Auto-confirmation | If you report nothing, this order is confirmed automatically on {endsAt}. | Sans signalement de votre part, cette commande sera confirmée automatiquement le {endsAt}. |
| Product page / checkout | Wi-Mall Protection: {days} days after delivery to report a problem. | Protection Wi-Mall : {days} jours après la livraison pour signaler un problème. |

⛔ Do not promise a refund after the protection has ended. The Terms say Wi-Mall has no
obligation then, and may act only at its own discretion in serious cases.

## Legal pages

Same URLs, new content (Terms 2.2 § 19, Returns 1.2 § 10). Nothing to change in the links.

## Done when

- A delivered order and a completed booking each show the right notice for the four states above.
- The deadline shown equals `protection.endsAt`. "3" and "7" appear nowhere in code.
- Creating a problem ticket on an order inside the window returns `holds_earnings: true` and the
  order then reads `onHold: true`, `problemReported: true`.
- Closing that ticket returns the order to `onHold: false`.
