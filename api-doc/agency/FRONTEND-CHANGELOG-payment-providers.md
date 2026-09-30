# Agency dashboard — pay with a provider, not a gateway

**Applies to:** the agency dashboard's billing (plan purchase, credit top-up)
**Status:** ✅ merged 2026-09-30; live after the next production deploy (see the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md)).
**Breaks:** paying, almost nothing: a build that still sends `gateway` keeps working; the one exception
is an old body whose `phoneOperator` contradicts the number, now `422 PAYMENT_PROVIDER_PHONE_MISMATCH`.
⚠ **Saving a payment method DOES break** for old builds: see [Saving a payment method](#saving-a-payment-method-2026-09-30).

The agency's billing doors take exactly the vendor's body and give exactly the vendor's answers,
under `/api/agency`. Read the [vendor page](../vendor/FRONTEND-CHANGELOG-payment-providers.md) and
swap the prefix; the full explanation is on the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md).

## In short

1. Build the payment choices from `GET /api/payments/options` (standard envelope). An empty list
   means online payment is off.
2. `POST /api/agency/plans/:planId/purchase` and `POST /api/agency/credits/topups` with
   `{ provider, channel }`. No `gateway`, no `phoneOperator`.
3. `instructions.requiresOtp` → `/api/agency/plan-purchases/:id/authorize` or
   `/api/agency/credits/topups/:id/authorize`, whatever `/options` said.
4. Handle `422 PAYMENT_PROVIDER_PHONE_MISMATCH` and `422 PAYMENT_PROVIDER_UNAVAILABLE`
   (`details.offered`).
5. Card (off today): `publishableKey` from the `CARD` entry. See
   [../vendor/stripe-payments.md](../vendor/stripe-payments.md).
6. Reads: `provider` is new and nullable; `gateway` is a label, typed `string`.

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

**Where to look in the agency dashboard:** `components/billing/billing.constants.ts`
(`MOBILE_MONEY_GATEWAY`, the gateway list, `MYCOOLPAY_BILLING_OTP_ROUTABLE`),
`components/billing/PaymentDialog.tsx`, `components/common/payment-options.ts`,
`services/billing.service.ts`, `types/billing.types.ts`.

Reference: [billing.md](./billing.md) · [../vendor/billing.md § Paying for a plan or a top-up](../vendor/billing.md#paying-for-a-plan-or-a-top-up-providers-not-gateways-2026-09-30) ·
[../payments/routing.md](../payments/routing.md).
