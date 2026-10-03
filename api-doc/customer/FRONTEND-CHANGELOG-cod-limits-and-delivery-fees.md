# Customer app & storefront checkout — a shop may refuse cash on delivery

**Backend change: 2026-10-02 · Not deployed yet.** Deploy prerequisite (for the release as a
whole, not for anything on this page): the index migration
`npm run migrate:delivery-fee-proposal-indexes`. Decision record:
[ADR-A09](../../docs/ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md).

The signed-in half of the shop. Its unauthenticated half (landing, catalogue, plan cards) is
[`../public/`](../public/README.md) — the only public-side change of the day is that agent plan cards
must stop advertising `max_cod_pool`
([public/FRONTEND-CHANGELOG-cod-pool.md](../public/FRONTEND-CHANGELOG-cod-pool.md), banner of 2026-10-02).

---

## ⛔ One new checkout refusal

A vendor can now switch cash on delivery **off** for their shop (`codEnabled: false` in their COD
terms). A cash-on-delivery checkout containing any of that shop's items is refused:

| | |
|---|---|
| **Where** | `POST /api/customer/orders/checkout` with `paymentMethod: "cash_on_delivery"` (also the bot's `POST /checkout` and the Telegram Mini App — same order-creation code) |
| **Status / code** | `422 COD_VENDOR_NOT_ACCEPTED` (category `business_rule`, so `details` reach you) |
| **`details`** | `{ vendorId: string }` |
| **Order** | **checked first**, before every agency rule (`COD_AGENCY_NOT_SUPPORTED`, `COD_ORDER_AMOUNT_EXCEEDS_LIMIT`) and before the delivery minimum |
| **Effect** | nothing is created and no stock is held — the check runs inside the checkout transaction, which rolls the whole group back (`OrderService.buildVendorOrder` → `CodEligibilityService.assertVendorOrderEligible`) |

**What the UI should do:** treat it like `COD_AGENCY_NOT_SUPPORTED` — tell the customer that this
shop does not accept cash on delivery, name the shop from `details.vendorId` (your cart already
carries each line's vendor and store name), and offer **pay online** for the basket (or removing that
shop's items to keep cash for the rest). Do not retry COD unchanged; the answer will not change
until the vendor changes their terms. Add the code to your error map; the server message is
"This seller does not accept cash on delivery" (`core/errors.ts`).

Reference: [orders.md § Errors](./orders.md#errors) (row added today),
[errors/README.md](../errors/README.md) (`COD_VENDOR_NOT_ACCEPTED`).

## Telegram Mini App and the chat checkout

These doors **already ask before drawing the button**:

- `GET /api/bot/miniapp/s/co/:handle/data` answers `cashOnDelivery: boolean` — `true` only when every
  pay-on-delivery rule passes, **including the vendor's `codEnabled`**
  (`cashOnDeliveryRefusal` → `assertVendorOrderEligible`, `miniapp/surfaces/checkout.controller.ts`).
  The page draws **Pay on delivery** only when it is `true`.
- `POST /api/bot/miniapp/s/co/:handle/place-cod` re-asks before creating orders (a shop may change its
  terms in between). From the **screen** the refusal arrives with `details.spent: true` (the handle was
  consumed); from the **chat** door (`precheckChatDoor`) it arrives with `details.spent: false`, so
  "Pay now" still works from the same checkout.

## ✅ The web storefront now knows before checkout — `cashOnDelivery` on the cart quote (2026-10-03)

**Closed 2026-10-03 (ADR-A09 G-10). Not deployed yet.** Until then the refusal could only be
*handled* at the checkout POST; now it can be *prevented*.

`POST /api/customer/cart/quote` answers, on **every** quote whatever `paymentMethod` was sent:

```jsonc
"cashOnDelivery": {
  "available": false,
  "reason": "vendor_not_accepted",   // | "agency_not_supported" | "order_amount_exceeds_limit"
                                     // | "digital_items" | null (could not be checked; checkout decides)
  "vendorIds": ["507f…aaa"]          // every shop that refuses; [] for digital_items
}
```

| `reason` | = checkout's code |
|---|---|
| `vendor_not_accepted` | `COD_VENDOR_NOT_ACCEPTED` |
| `agency_not_supported` | `COD_AGENCY_NOT_SUPPORTED` |
| `order_amount_exceeds_limit` | `COD_ORDER_AMOUNT_EXCEEDS_LIMIT` |
| `digital_items` | `COD_NOT_AVAILABLE_FOR_DIGITAL` |

It is checkout's own rule (`assertVendorOrderEligible`) run per shop against the agencies the items
would ship with — the **same** verdict the Mini App's `cashOnDelivery` boolean now reads, so the bot
and the website cannot disagree. Exposure **holds** are not part of it (they never refuse a customer),
and nor is the delivery minimum (`meetsDeliveryMinimum` on a `cash_on_delivery` quote). The bot's
`POST /cart/quote` carries the same field.

**What the UI should do:** hide or disable the cash-on-delivery option while `available` is `false`,
with a line keyed on `reason` (name the shops from `vendorIds` if useful). **Keep handling the four
`422`s at checkout** — terms can change between the quote and the POST. Full contract:
[cart.md § `cashOnDelivery`](./cart.md#can-this-basket-be-paid-on-delivery--cashondelivery).

The public product, variant and store reads still carry **no** COD flag, deliberately: whether cash is
possible depends on the agencies the basket would ship with, which only the basket knows.

## What else changed on 2026-10-02, and why you see none of it

| Change | Customer-visible? |
|---|---|
| Agency COD cash limit (1 000 000) and the vendor's `maxCashPerAgency` | **Not on the wire.** The order is still placed. If the agency is over its limit, that parcel is not handed to the agency yet (vendor-side "hold") — the shipment simply stays at its pre-dispatch status until the vendor dispatches it. No new field, status or code. |
| Per-shipment delivery-fee proposals (agency ↔ vendor) | No. The **vendor** pays the delivery fee; the customer's total and the COD amount to hand the agent never change. |
| Monthly-salary agent contracts | No. |
| Agent COD pool now 500 000 for everyone | No (landing plan cards only — see `public/`). |
| New notifications | None for customers. |

## Checklist

- [ ] Map `422 COD_VENDOR_NOT_ACCEPTED` on web / app checkout → "this shop doesn't accept cash on delivery" + pay online
- [ ] Web / app checkout: hide or disable cash on delivery while the quote's `cashOnDelivery.available` is `false`, with copy per `reason` (2026-10-03)
- [ ] Mini App: nothing to build (`cashOnDelivery` already reflects it); handle the code on `place-cod` as you handle `COD_AGENCY_NOT_SUPPORTED`
