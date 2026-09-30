# Vendor dashboard — pay with a provider, not a gateway

**Applies to:** the vendor dashboard's billing (plan purchase, credit top-up)
**Status:** ✅ merged 2026-09-30; live after the next production deploy (see the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md)).
**Breaks:** paying, almost nothing: a build that still sends `gateway` keeps working; the one exception
is an old body whose `phoneOperator` contradicts the number, now `422 PAYMENT_PROVIDER_PHONE_MISMATCH`.
⚠ **Saving a payment method DOES break** for old builds: see [Saving a payment method](#saving-a-payment-method-2026-09-30).

The full explanation, the error table and the re-copy list are on the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md). This page is what the vendor
dashboard has to do.

## What to change

1. **Replace the gateway selector with a provider choice** built from `GET /api/payments/options`
   (no auth; standard `{ success, data }` envelope), fetched when the payment dialog opens. Today
   it lists `MTN` and `ORANGE`. Remove `MOBILE_MONEY_GATEWAY`, the NotchPay / My-CoolPay / Stripe
   options, and any "is My-CoolPay OTP routable" switch: `/options` answers that now
   (`flow: "OTP"`).
2. **An empty `data.providers`** means online payment is switched off: show *"Online payment is
   unavailable right now"* instead of the pay button.
3. **Send `{ provider, channel }`**, never `gateway` or `phoneOperator`:
   - `POST /api/vendor/plans/:planId/purchase`
   - `POST /api/vendor/credits/topups` (with `packCode`)
4. **Branch on `instructions`**: `requiresOtp: true` → `POST /api/vendor/plan-purchases/:id/authorize`
   or `/credits/topups/:id/authorize`, **even if `/options` said `PUSH`**; `clientSecret` → card;
   otherwise approve on the handset. Then poll `/verify` as today.
5. **Handle the two new 422s** (`PAYMENT_PROVIDER_PHONE_MISMATCH`, `PAYMENT_PROVIDER_UNAVAILABLE`)
   without closing the dialog. Drop the `PAYMENT_GATEWAY_NOT_SUPPORTED` branch: billing no longer
   raises it.
6. **Cards** (off today): when `/options` lists `CARD`, load Stripe.js with that entry's
   `publishableKey` and remove `VITE_STRIPE_PUBLISHABLE_KEY`. Full rewrite:
   [stripe-payments.md](./stripe-payments.md).
7. **Reads**: `purchase.provider` / `topup.provider` are new and nullable; `gateway` stays as a
   label only. Widen `PaymentGateway` on read types (including `transactions.types.ts`) to
   `string`, so a new aggregator renders instead of breaking the transactions tab.
8. **Saved wallets**: the saved method's `provider` now reads `MTN`/`ORANGE`/`MOOV` directly, older
   rows included. See below.

## Saving a payment method (2026-09-30)

⚠ **Breaking: a build that still sends the old save body can no longer save a payment method.**
The old keys (`gateway_customer_id`, `gateway_instrument_id`, `method_type`, `display_label`,
`brand`, `last4`, `exp_month`, `exp_year`, `holder_name`, `is_default`) are refused with
`400 VALIDATION_ERROR`. Listing, default and delete still work.

1. **Save wallets only**: `POST /api/me/payment-methods` with
   `{ provider: "MTN"|"ORANGE"|"MOOV", phoneNumber: "+237…", label?, isDefault? }`. Remove the
   card tab and `StripeCardField` from the add dialog: saving a card is refused (`400`).
2. **Read the new item**: `{ id, provider, kind, label, maskedPhone, last4, isDefault, createdAt, updatedAt }`.
   `provider` is `MTN`/`ORANGE`/`MOOV`, `CARD` for a card saved earlier, `null` for an old row
   naming only a payment company. `brand`, `exp_*` and `holder_name` are gone.
3. **Handle** `422 PAYMENT_PROVIDER_PHONE_MISMATCH` (`details.detected`: the number's real network)
   and `409 PAYMENT_METHOD_LIMIT_REACHED` in the dialog, without closing it.
4. **The number is never returned** (only `maskedPhone` and `last4`).

Full reference: [payment-methods.md](./payment-methods.md) · summary table and errors:
[cross-role § Saving a payment method](../FRONTEND-CHANGELOG-payment-providers.md#saving-a-payment-method-2026-09-30).

## Reference

- [billing.md § Paying for a plan or a top-up](./billing.md#paying-for-a-plan-or-a-top-up-providers-not-gateways-2026-09-30)
- [stripe-payments.md](./stripe-payments.md) — the card path
- [../payments/routing.md](../payments/routing.md) — the contract
