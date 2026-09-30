# Customer shop — pay with a provider, not a gateway

**Applies to:** the shop on the landing site (checkout, order pages, bookings, `/pay/:token`)
**Status:** ✅ merged 2026-09-30; live after the next production deploy (see the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md)).
**Breaks:** paying, almost nothing: a build that still sends `gateway` keeps working; the one exception
is an old body whose `phoneOperator` contradicts the number, now `422 PAYMENT_PROVIDER_PHONE_MISMATCH`.
⚠ **Saving a payment method DOES break** for old builds: see [Saving a payment method](#saving-a-payment-method-2026-09-30).

> [!WARNING]
> **First, the silent break: `POST` and `DELETE /api/customer/payment-methods` no longer return the
> customer profile.** (The shop's current code saves through `/api/me/payment-methods`; check that
> nothing else calls these two.) They now answer exactly like `/api/me/payment-methods`: `POST` gives `201`
> with the saved method, `DELETE` gives `{ success, message }`. Any screen that replaced its cached
> profile with that answer must re-read `GET /api/customer/profile` (or the list) itself. And the
> profile's `savedPaymentMethods[]` items have the new shape too.

The full explanation, the error table and the re-copy list are on the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md). This page is what the shop has to do.

## What to change

1. **Build the payment choices from `GET /api/payments/options`** (no auth; standard
   `{ success, data }` envelope) each time checkout or a "pay" sheet opens. Today it lists `MTN`
   and `ORANGE`. Delete the hard-coded picker entries (`gateway: "NOTCHPAY"`, `gateway: "STRIPE"`).
2. **An empty `data.providers`** means online payment is switched off. Show *"Online payment is
   unavailable right now"*, and offer cash on delivery where the checkout allows it.
3. **Send `provider`** on every payment you start, never `gateway` or `phoneOperator`:

   | Where | Call | Body |
   |---|---|---|
   | Checkout | `POST /api/payments/initiate` | `{ cartId, provider, channel }` |
   | Pay one order / pay again | `POST /api/payments/initiate` | `{ orderId, provider, channel }` (or `cartId`) |
   | Booking | `POST /api/bookings/:id/pay` | `{ provider, channel }` |
   | Booking balance | `POST /api/customer/bookings/:id/pay-balance` | `{ provider, channel }` |

   `channel` holds the fields the chosen entry lists (`phoneNumber` for mobile money, E.164).
4. **Branch on `instructions`**: `requiresOtp: true` → collect the SMS code →
   `POST /api/payments/:transactionId/authorize`, **even if `/options` said `flow: "PUSH"`**;
   `clientSecret` → card form; `redirectUrl` → open it.
5. **Handle the two new 422s** without losing the form:
   - `PAYMENT_PROVIDER_PHONE_MISMATCH` → *"This number is on {detected}. Choose {detected}, or
     enter a {provider} number."*
   - `PAYMENT_PROVIDER_UNAVAILABLE` → re-render the choices from `details.offered`.
6. **Cards** (off today): when `/options` lists `CARD`, load Stripe.js with its
   `publishableKey`, not `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. The `/pay/:token` page already
   prefers the server's key (`session.publishableKey`). Keep that.
7. **Reads**: every initiate response gains a top-level `provider` (the stored one, possibly
   `null`, when a live attempt was reused), and `GET /api/payments/:transactionId` gains a
   nullable `provider`, as do the booking payment-status view and the `/pay/:token` session.
   `gateway` stays, as a label only; type it as `string`.
8. ⚠ **`lib/shop/cm-operator.ts`** assumes *"a declared operator always beats the number"*. The
   server no longer agrees: a declared provider that contradicts a known MTN or Orange prefix is
   refused with `PAYMENT_PROVIDER_PHONE_MISMATCH`. Align the picker's pre-selection with the
   server's prefix rule, or let the 422 explain it.
9. **Saved wallets** now read `provider` as `MTN`/`ORANGE`/`MOOV` (older rows included), so no
   mapping is needed; pre-select one only if it is listed in `/options`. See below.

## Saving a payment method (2026-09-30)

⚠ **Breaking: a build that still sends the old save body can no longer save a payment method.**
The old keys (`gateway_customer_id`, `gateway_instrument_id`, `method_type`, `display_label`,
`brand`, `last4`, `exp_month`, `exp_year`, `holder_name`, `is_default`) are refused with
`400 VALIDATION_ERROR`. Listing, default and delete still work.

1. **Save** with `POST /api/me/payment-methods` (or the alias `POST /api/customer/payment-methods`,
   which now answers the same way, not with the profile):
   `{ provider: "MTN"|"ORANGE"|"MOOV", phoneNumber: "+237…", label?, isDefault? }`.
2. **Read the new item**: `{ id, provider, kind, label, maskedPhone, last4, isDefault, createdAt, updatedAt }`,
   also inside `GET /api/customer/profile` → `savedPaymentMethods[]`.
3. **Handle** `422 PAYMENT_PROVIDER_PHONE_MISMATCH` and `409 PAYMENT_METHOD_LIMIT_REACHED` on the
   save form, without losing it.
4. **Keep the on-device copy of the number** (`lib/shop/wallet-numbers.ts`): the server still never
   returns it, only `maskedPhone` and `last4`.

Full reference: [payment-methods.md](./payment-methods.md) · summary table and errors:
[cross-role § Saving a payment method](../FRONTEND-CHANGELOG-payment-providers.md#saving-a-payment-method-2026-09-30).

## Reference

- [../payments/README.md](../payments/README.md) — `/options`, `initiate`, `instructions`, refusals
- [orders.md § Paying for a checkout group](./orders.md#payment) · [bookings.md § Pay for a Booking](./bookings.md#pay-for-a-booking)
- [../payments/routing.md](../payments/routing.md) — the contract
