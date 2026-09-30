# Agent app — pay with a provider, not a gateway

**Applies to:** the agent app's billing (plan purchase, credit top-up)
**Status:** ✅ merged 2026-09-30; live after the next production deploy (see the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md)).
**Breaks:** almost nothing. A build that still sends `gateway` keeps working; the one exception is an
old body whose `phoneOperator` contradicts the number, now `422 PAYMENT_PROVIDER_PHONE_MISMATCH`. That matters most here, because installed app
versions stay in the field for months.

The agent's billing doors take exactly the vendor's body and give exactly the vendor's answers,
under `/api/agent`. Read the [vendor page](../vendor/FRONTEND-CHANGELOG-payment-providers.md) and
swap the prefix; the full explanation is on the
[cross-role page](../FRONTEND-CHANGELOG-payment-providers.md).

## In short

1. Build the checkout sheet's choices from `GET /api/payments/options` (standard
   `{ success, data }` envelope). An empty list means online payment is off: show that, not a
   pay button.
2. `POST /api/agent/plans/:planId/purchase` and `POST /api/agent/credits/topups` with
   `{ provider, channel }`. No `gateway`, no `phoneOperator`.
3. `instructions.requiresOtp` → `/api/agent/plan-purchases/:id/authorize` or
   `/api/agent/credits/topups/:id/authorize`, whatever `/options` said.
4. Handle `422 PAYMENT_PROVIDER_PHONE_MISMATCH` and `422 PAYMENT_PROVIDER_UNAVAILABLE`
   (`details.offered`) in the sheet, without closing it. Add both messages to every ARB locale.
5. Cards need a browser (Stripe Payment Element). If the app offers `CARD` at all, it does so only
   when `/options` lists it.
6. Reads: `provider` is new and nullable. `gateway` is a label only, and **new values will
   appear** (`CAMPAY`, `FLUTTERWAVE`): the enum parse must fall back instead of throwing.

**Where to look in the agent app:** `features/billing/domain/entities/payment_gateway.dart` (the
enum and its wire parse), `features/billing/data/datasources/billing_remote_datasource.dart`
(`'gateway': gateway.wireValue` on both initiates), `features/billing/presentation/providers/checkout_controller.dart`,
`features/billing/presentation/widgets/checkout_sheet.dart`.

Reference: [billing.md](./billing.md) · [../vendor/billing.md § Paying for a plan or a top-up](../vendor/billing.md#paying-for-a-plan-or-a-top-up-providers-not-gateways-2026-09-30) ·
[../payments/routing.md](../payments/routing.md).
