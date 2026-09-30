# Frontend changelog — pay with a provider, not a gateway

**Verified against source on 2026-09-30, at jovi-mall `39254e2` (after C1) and wi-admin `08d32e2`.**

**Applies to:** customer shop (landing) · vendor dashboard · agency dashboard · agent app · admin dashboard
**Status:** ✅ merged 2026-09-30 (payment-routing restructure, ADR-A08). **Live after the next production deploy** of jovi-mall, then wi-admin ([RUNBOOK § Payment routing](../../docs/RUNBOOK.md#payment-routing-adr-a08-deploy-notes)).
**Wire changes:** one **new** endpoint (`GET /api/payments/options`), one **new** request field
(`provider`) on every charging door, one **deprecated** request field (`gateway`, accepted and
ignored), three **new** error codes, and a **new nullable** `provider` on payment, top-up,
plan-purchase and pay-session reads. **Almost nothing breaks**: a build that still sends `gateway`
keeps working, and the aggregator it names is simply ignored. **One old-build case now fails:** a
body whose `channel.phoneOperator` contradicts the number's prefix (e.g. `MTN` with a `+23769…`
Orange number) used to go through on My-CoolPay, which ignored the operator. It is now refused
with `422 PAYMENT_PROVIDER_PHONE_MISMATCH` before anything is written. And until a build moves to
`provider`, an administrator cannot switch aggregators without that build showing choices the
server may refuse.

Contract: [payments/routing.md](./payments/routing.md) · reference:
[payments/README.md](./payments/README.md) · design record:
[ADR-A08](../docs/ADR-A08-PAYMENT-ROUTING.md). Per-app pages:
[customer](./customer/FRONTEND-CHANGELOG-payment-providers.md) ·
[vendor](./vendor/FRONTEND-CHANGELOG-payment-providers.md) ·
[agency](./agency/FRONTEND-CHANGELOG-payment-providers.md) ·
[agent](./agent/FRONTEND-CHANGELOG-payment-providers.md) ·
[admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-payment-providers.md).

> [!WARNING]
> **A second change landed the same day and it DOES break old builds: saving a payment method.**
> See [Saving a payment method](#saving-a-payment-method-2026-09-30) just below.

---

## Saving a payment method (2026-09-30)

**Verified against source at jovi-mall `290c2c8`.**

⚠ **Breaking: an app build that still uses the old save body can no longer save a payment
method.** `POST /api/me/payment-methods` (and its customer alias `POST /api/customer/payment-methods`)
used to take a free-text `provider` plus `gateway_customer_id`, `gateway_instrument_id` and display
fields. **Every one of those keys is now refused with `400 VALIDATION_ERROR`.** Listing, setting
the default and deleting keep working in old builds, and so does paying. Only saving stops.

⚠ **The customer shop is hit twice.** `POST` and `DELETE /api/customer/payment-methods` also
**stopped returning the customer profile**: they answer exactly like `/api/me` now. A screen that
refreshed its profile from that answer must re-read it.

What replaced it, and why: a saved method used to name a payment company, which is exactly what
the rest of this page takes away from apps. It now names only what the user holds.

| | Before | Now |
|---|---|---|
| **What can be saved** | cards, wallets, bank transfers | **mobile-money wallets only**: `MTN`, `ORANGE`, `MOOV`. **Saving a card is refused for now** |
| **Request** | `{ provider: "mtn_momo"\|"stripe"…, gateway_customer_id, gateway_instrument_id, method_type, display_label, brand?, last4?, exp_month?, exp_year?, holder_name?, is_default? }` | `{ provider: "MTN"\|"ORANGE"\|"MOOV", phoneNumber: "+237…", label?, isDefault? }`, strict |
| **Response item** | `{ id, provider, method_type, display_label, brand, last4, exp_month, exp_year, holder_name, is_default }` | `{ id, provider, kind, label, maskedPhone, last4, isDefault, createdAt, updatedAt }` |
| **`provider` values read back** | lowercase (`mtn_momo`, `stripe`…) | `MTN` · `ORANGE` · `MOOV` · `CARD` · `null`. Older rows are mapped on read |
| **The phone number** | never returned | still never returned; `maskedPhone` (`"+2376••••4417"`) and `last4` are |
| **Label** | written by the app | optional; the server writes `MTN Mobile Money · ••••4417` when absent |
| **Wrong network** | not checked | `422 PAYMENT_PROVIDER_PHONE_MISMATCH`, `details: { provider, detected }`, nothing saved |
| **`/api/customer/payment-methods` POST · DELETE** | answered with the whole customer profile | answer exactly like `/api/me` (`201` + the method; `{ success, message }`) |
| **`GET /api/customer/profile` → `savedPaymentMethods[]`** | `{ id, provider, display_label, method_type, is_default }` | the new response item |

Errors to handle on save:

| Status | Code | When | Suggested UI |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | a card, a bad or missing number, a blank `label`, any old key | show the field message from `error.details.fields[]`; keep the form |
| `422` | `PAYMENT_PROVIDER_PHONE_MISMATCH` | the number belongs to `details.detected`, not `details.provider` | *"This number is on {detected}. Choose {detected}, or enter a {provider} number."*; keep the form |
| `409` | `PAYMENT_METHOD_LIMIT_REACHED` | 10 methods already saved | *"You can save up to 10. Remove one first."* |

No error code was added; all of these already existed. There is no duplicate check: saving the
same number twice makes two rows.

Full reference: [customer/payment-methods.md](./customer/payment-methods.md) (the four other role
folders carry the same page).

---

## What changed on the platform

Until now every app **named the company that moves the money**: `gateway: "NOTCHPAY"`,
`"MYCOOLPAY"` or `"STRIPE"`, on seven doors. So when NotchPay had an outage, every app had to be
rebuilt and re-released to point somewhere else.

Payment now has two layers:

| Layer | What it is | Values | Who chooses |
|---|---|---|---|
| **Provider** | what the customer holds | `MTN` · `ORANGE` (on) · `MOOV` · `CARD` (off) | the **customer**, in your app |
| **Aggregator** | who the backend calls | `NOTCHPAY` · `MYCOOLPAY` · `STRIPE`, later `CAMPAY` · `FLUTTERWAVE` | an **administrator**, at runtime, with no release |

Your app shows **providers** and sends `provider`. It never names, chooses or branches on an
aggregator. Everything below follows from that.

---

## 1. Ask what can be paid with: `GET /api/payments/options`

**New.** No auth. `Cache-Control: no-store`. **Standard `{ success, data }` envelope**, unlike
the flat `initiate` / `verify` / `authorize` responses. Call it each time the payment screen or
dialog opens.

```jsonc
// 200 — today's production answer
{
  "success": true,
  "data": {
    "providers": [
      { "provider": "MTN",    "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false },
      { "provider": "ORANGE", "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false }
    ]
  }
}
```

| Field | Use it to |
|---|---|
| `provider` | render one choice per entry, **in the order given**, and send it back as `provider` |
| `kind` | `MOBILE_MONEY` → ask for a number; `CARD` → prepare the card form |
| `flow` | prepare the right screen: `PUSH` (approve on the handset) · `OTP` (an SMS code may be asked for) · `CARD_ELEMENT` (Stripe Payment Element) · `REDIRECT` (open a page; reserved, unused today) |
| `fields` | know which `channel` fields to collect (`["phoneNumber"]`, or `[]` for a card) |
| `mayRequireOtp` | warn the customer up front that an SMS code may follow (`true` exactly when `flow` is `OTP`) |
| `publishableKey` | **only on a `CARD` / `CARD_ELEMENT` entry**: load Stripe.js with **this** key. It replaces `VITE_STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |

Three rules:

- **Show only what is listed.** Delete hard-coded gateway or provider lists.
- **An empty `providers` array is valid.** An administrator can switch online payment off. Show
  *"Online payment is unavailable right now"* (and cash on delivery where that checkout allows
  it). It is not an error; do not show a retry.
- **`flow` is a hint.** The `initiate` response's `instructions` are the truth (§ 3).

The body never names an aggregator and holds nothing secret.

**Every listed provider is payable.** If CARD routes through Stripe but no valid publishable key
is configured, CARD is not listed. So a `CARD` entry always carries a usable `publishableKey`.

---

## 2. Send `provider`, stop sending `gateway`

The same body on **every** charging door:

```jsonc
{
  // …the door's own fields (cartId / orderId / packCode …)
  "provider": "MTN",                    // from /options
  "channel": {
    "phoneNumber": "+237670000001",     // the fields /options listed; E.164
    "customerEmail": "a@example.com",   // optional
    "customerName": "Awa"               // optional
  }
}
```

| Door | Who |
|---|---|
| `POST /api/payments/initiate` (`cartId` or `orderId`) | customer shop |
| `POST /api/bookings/:id/pay` | customer shop |
| `POST /api/customer/bookings/:id/pay-balance` | customer shop |
| `POST /api/{vendor,agency,agent}/plans/:planId/purchase` | vendor · agency · agent |
| `POST /api/{vendor,agency,agent}/credits/topups` | vendor · agency · agent |

- **Stop sending `gateway`.** It is accepted and **ignored**, whatever its value, and it will be
  removed from the request in a later release (announced separately).
- **Stop sending `channel.phoneOperator`.** The provider *is* the operator. It is still accepted,
  as legacy.
- **Never send `cardToken`.** Cards are confirmed client-side with `clientSecret`.
- **Old builds keep working.** With no `provider`, the server derives one: `gateway: "STRIPE"` →
  `CARD` (refused while cards are off, and **never** pushed to a phone), then
  `channel.phoneOperator`, then the number's prefix. If all fail: `400 PAYMENT_PROVIDER_REQUIRED`.
  A current build always sends `provider` and never relies on this.

---

## 3. Act on the answer by what it contains, never by aggregator

| `instructions` has… | Do this |
|---|---|
| `ussdCode` (or nothing special) | "Approve the prompt on your phone"; poll verify |
| `requiresOtp: true` (no `ussdCode`) | Collect the SMS code and send it to the door's **authorize** route (below). Nothing is charged until you do |
| `clientSecret` (+ `chargedAmount` / `chargedCurrency`) | Mount Stripe's Payment Element with the `/options` `publishableKey`; show the USD amount |
| `redirectUrl` | Open it; resume polling when the customer comes back (reserved; no aggregator uses it yet) |

⚠ **Honour `requiresOtp` even when `/options` said `flow: "PUSH"`.** An administrator can switch
aggregators between the two calls, and the charge follows the aggregator active at `initiate`.

OTP routes, unchanged:

| Charge | Authorize route |
|---|---|
| order / cart / booking payment | `POST /api/payments/:transactionId/authorize` |
| plan purchase | `POST /api/{role}/plan-purchases/:id/authorize` |
| credit top-up | `POST /api/{role}/credits/topups/:id/authorize` |

Anything already opened keeps the aggregator that opened it: verify, authorize, the webhook and
refunds all follow the stored row, not the current setting. A customer who presses Pay again
while a prompt is live gets **that** payment back rather than a second charge.

---

## 4. Three new refusals, all before anything is written

| Code | Status | `details` | Show |
|---|---|---|---|
| `PAYMENT_PROVIDER_PHONE_MISMATCH` | 422 | `{ provider, detected, spent: false }` | *"This number is on MTN. Choose MTN, or enter an Orange number."* — use `detected` (`MTN` or `ORANGE`). Keep the form filled in |
| `PAYMENT_PROVIDER_UNAVAILABLE` | 422 | `{ provider, offered }` | The choice was switched off after the screen loaded. Re-render the choices from `details.offered` (the fresh list) and keep everything else. An empty `offered` means online payment is now unavailable |
| `PAYMENT_PROVIDER_REQUIRED` | 400 | none | Only an old-style body can get this. A current build should never see it; treat it as a bug in the build |

Both 422s are `category: "business_rule"`, so `details` reaches you in every environment.
`spent: false` means nothing was charged or written: the customer can simply fix and retry.

**The mismatch rule, exactly:** the server reads the number's **prefix**. MTN prefix with
`provider: "ORANGE"` (or the reverse, or either with `MOOV`) is refused. A prefix it does not know
(Nexttel `66x`, Camtel `62x`, a ported or foreign number) is **accepted**: the customer's choice
wins. `CARD` does not look at the number. Pre-selecting the provider from the typed number is
fine; silently flipping the customer's explicit choice is not. Show the mismatch message instead.

`400 PAYMENT_GATEWAY_NOT_SUPPORTED` is **no longer raised** on any charging door. It survives only
on pay-link minting (`POST /api/payments/:transactionId/pay-link`). Remove the branch that
re-rendered a gateway list from its `details.offered` (aggregator names); the new
`PAYMENT_PROVIDER_UNAVAILABLE` carries provider names instead.

---

## 5. Reads: `gateway` stays, `provider` is new

- **Every initiate response gains a top-level `provider`** (`POST /api/payments/initiate` flat;
  the booking pay and pay-balance routes, plan purchase and credit top-up under `data`, beside
  `instructions`): the provider this attempt is charged on.
  On a reused live attempt it is the **stored** one, which can differ from what you sent, or be
  `null` on an attempt opened before this change. These responses still carry no `gateway`.
- **Payment transactions** (`GET /api/payments/:transactionId`) gain `provider`: `MTN` · `ORANGE`
  · `MOOV` · `CARD`, or **`null`** on rows written before this change (no backfill) or opened from
  an old-style body whose provider could not be derived. Use it to label "Paid with MTN Mobile
  Money", and handle `null`.
- **The booking payment-status view** (`GET /api/bookings/:id/payment-status`) and **the pay-link
  session** (`GET /api/payments/session/:token`) gain a nullable `provider` beside `gateway`.
- **Plan purchases and credit top-ups** gain `provider` on the row too (`purchase.provider`,
  `topup.provider`; nullable on rows made before this change). Their `verify` and `authorize`
  routes are unchanged and follow the aggregator stored on the row.

Stored rows (transactions, the booking payment-status view, plan purchases, top-ups, pay-link
sessions) **keep `gateway`**, now **informational only**: which aggregator carried the money.
**Never branch on it.** And **widen its type to `string`**: `CAMPAY` and `FLUTTERWAVE` will appear on
  new rows with no warning, and a closed union (`'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE'`) or a Dart
  `switch` with no default will break on them.


---

## 6. ⚠ Two different things are called `provider`

**Resolved by [Saving a payment method](#saving-a-payment-method-2026-09-30): it is now one
vocabulary.** Saved payment methods (`/api/me/payment-methods`) used to answer a lowercase
`provider` (`mtn_momo`, `stripe`…), which had to be mapped before a charge. Since 2026-09-30 the
saved method's `provider` reads as `MTN` · `ORANGE` · `MOOV` · `CARD` · `null`, **older rows
included** (the server maps them on read). So:

| Saved `provider` | Use on a charge |
|---|---|
| `MTN` · `ORANGE` · `MOOV` | the same value, if it is listed in `/options` |
| `CARD` | don't pre-select (no card is payable from a saved method) |
| `null` | an old row naming only a payment company: don't pre-select; let the customer choose |

Delete any `mtn_momo` → `MTN` mapping table in your app: the API no longer returns those values.
If you keep one for safety, make it accept the uppercase values unchanged.

---

## 7. Per app

The file lists under "where to look" come from a read of each repository on 2026-09-30. They are
**pointers, not a patch**: each team owns its code.

### Customer shop (landing) — [customer page](./customer/FRONTEND-CHANGELOG-payment-providers.md)

- **Doors:** checkout (`initiate` with `cartId`), pay a single order, pay again from an order
  group, booking pay, booking balance.
- **Card page `/pay/:token`:** already prefers `session.publishableKey` over the build key. Keep
  that. It is the pattern `/options` now generalises.
- **Where to look:** `lib/shop/payments.api.ts` (`PaymentGateway` type, `gateway` field),
  `components/shop/PaymentMethodPicker.tsx` (hard-coded options with `gateway: "NOTCHPAY"` /
  `"STRIPE"`, and a `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` read), `app/[locale]/shop/checkout/page.tsx`
  and `components/shop/account/PayGroupSheet.tsx` (`gateway: option.gateway`),
  `components/shop/account/PayLinkShare.tsx` (`gateway: "STRIPE"`), `lib/shop/bookings.api.ts`
  (`gateway` union on pay and pay-balance), `lib/shop/pay-link.api.ts` (read type).
- ⚠ **`lib/shop/cm-operator.ts` must agree with the server's mismatch rule.** Its header says *"a
  declared operator always beats the number"*. The server now **refuses** a declared provider
  that contradicts a known MTN or Orange prefix. If the picker lets a shopper pick ORANGE for a
  `67…` number, they will now get `422 PAYMENT_PROVIDER_PHONE_MISMATCH` rather than a charge.
  Either check the prefix client-side with the same table (`payments/domain/cm-operator.ts` on the
  server) or rely on the 422, but do not assume the declared choice is accepted.
- **Saving a wallet** (breaking): `app/[locale]/shop/account/payment-methods/page.tsx` sends the
  old body (`gateway_customer_id`/`gateway_instrument_id` = the number, `display_label`, `last4`,
  `method_type`). Send `{ provider, phoneNumber, label?, isDefault? }` instead. Update the types in
  `lib/shop/customer.types.ts` (`SavedPaymentMethod`, `AddPaymentMethodPayload`,
  `ProfilePaymentMethod`) and `lib/shop/payment-methods.api.ts`. `lib/shop/wallet-numbers.ts`
  (the on-device copy of the number) is still needed: the server still never returns it.

### Vendor dashboard — [vendor page](./vendor/FRONTEND-CHANGELOG-payment-providers.md)

- **Doors:** plan purchase, credit top-up, and their `authorize` / `verify`.
- **Where to look:** `types/billing.types.ts` (`PaymentGateway` union, also on reads),
  `components/billing/billing.constants.ts` (`MOBILE_MONEY_GATEWAY = 'NOTCHPAY'`, the gateway
  option list), `components/billing/PaymentDialog.tsx` (`initiate(gateway, channel)`),
  `components/billing/StripeCardField.tsx` and `lib/stripe.ts` (`VITE_STRIPE_PUBLISHABLE_KEY`),
  `services/billing.service.ts`, `components/transactions/TransactionsTab.tsx` (renders
  `tx.gateway`: fine, as a label, if unknown values fall through).
- **Saving a method** (breaking): `components/billing/AddPaymentMethodDialog.tsx` (`buildPayload()`
  sends the old body, and a card tab through `StripeCardField.tsx`, which must go: saving a card is
  refused), `services/payment-methods.service.ts`, `types/payment-method.types.ts`,
  `components/billing/SavedPaymentMethodsCard.tsx`.
- Card specifics: [vendor/stripe-payments.md](./vendor/stripe-payments.md), rewritten for `CARD`.

### Agency dashboard — [agency page](./agency/FRONTEND-CHANGELOG-payment-providers.md)

- **Doors:** the same billing doors under `/api/agency`.
- **Where to look:** `components/billing/billing.constants.ts` (`MOBILE_MONEY_GATEWAY`, the
  gateway list, `MYCOOLPAY_BILLING_OTP_ROUTABLE`, which `/options` makes unnecessary),
  `components/billing/PaymentDialog.tsx`, `components/common/payment-options.ts`,
  `services/billing.service.ts`, `types/billing.types.ts`.
- **Saving a method** (breaking): the same files as the vendor dashboard
  (`AddPaymentMethodDialog.tsx`, `StripeCardField.tsx`, `services/payment-methods.service.ts`,
  `types/payment-method.types.ts`, `SavedPaymentMethodsCard.tsx`).

### Agent app (Flutter) — [agent page](./agent/FRONTEND-CHANGELOG-payment-providers.md)

- **Doors:** the same billing doors under `/api/agent`.
- **Where to look:** `features/billing/domain/entities/payment_gateway.dart` (the gateway enum and
  its wire parse; give it a fallback for unknown values), `features/billing/data/datasources/billing_remote_datasource.dart`
  (`'gateway': gateway.wireValue` on both initiates), `features/billing/presentation/providers/checkout_controller.dart`,
  `features/billing/presentation/widgets/checkout_sheet.dart`.
- **Saved wallets** (read only, the app saves none): `getDefaultSavedWallet()` in
  `billing_remote_datasource.dart` filters on `method_type == 'mobile_money'` and reads `provider`.
  Both changed: filter on `kind == 'MOBILE_MONEY'` and read `isDefault`; `provider` is now `MTN`…,
  so the mapping in `checkout_controller.dart` must accept the uppercase value as it is.

### Admin dashboard — [admin page](../../admin/api-doc/FRONTEND-CHANGELOG-payment-providers.md)

No charging doors, and it saves no payment method (nothing to change for the save). **New:** a developer-tools screen that switches aggregators. **Changed:** the
money pages show `provider` beside `gateway`. Details on the admin page.

---

## 8. Re-copy these into each app's `api-doc/`

Each frontend keeps its own copy of the backend docs, and the copies do not update themselves.

| App | Re-copy |
|---|---|
| landing | `payments/README.md`, `payments/routing.md` (new), `customer/orders.md`, `customer/bookings.md`, `customer/payment-methods.md`, `customer/profile.md`, `customer/FRONTEND-CHANGELOG-payment-providers.md` (new), this file (new), `error-codes.ts` |
| vendor-dash | `payments/README.md`, `payments/routing.md` (new), `vendor/billing.md`, `vendor/billing-overview.md`, `vendor/stripe-payments.md`, `vendor/payment-methods.md`, `vendor/FRONTEND-CHANGELOG-payment-providers.md` (new), `billing-plans-across-roles.md`, this file (new), `error-codes.ts` |
| agency-dash | `payments/README.md`, `payments/routing.md` (new), `agency/billing.md`, `agency/payment-methods.md`, `agency/FRONTEND-CHANGELOG-payment-providers.md` (new), `billing-plans-across-roles.md`, this file (new), `error-codes.ts` |
| agent_app | `payments/README.md`, `payments/routing.md` (new), `agent/billing.md`, `agent/payment-methods.md`, `agent/FRONTEND-CHANGELOG-payment-providers.md` (new), `billing-plans-across-roles.md`, this file (new), `error-codes.ts` |
| admin-dash | `jovi-mall/payments/README.md`, `jovi-mall/payments/routing.md` (new), `jovi-mall/admin/payment-methods.md`, `jovi-mall/error-codes.ts`, and from wi-admin: `FRONTEND-CHANGELOG-payment-providers.md` (new) plus the dev-tools reference |

`error-codes.ts` gains `PAYMENT_PROVIDER_REQUIRED`, `PAYMENT_PROVIDER_UNAVAILABLE`,
`PAYMENT_PROVIDER_PHONE_MISMATCH`, `PAYMENT_SETTINGS_INVALID` and
`PAYMENT_SETTINGS_VERSION_CONFLICT`. The last two never reach a customer or business app; they
reach the admin dashboard only, relayed by wi-admin as `details.platformCode` under
`PLATFORM_OPERATION_REJECTED`. Add copy for the first three to each app's error messages, in
every locale it ships.

---

## 9. Checklist

- [ ] Payment screen calls `GET /api/payments/options` (standard envelope) and renders from `data.providers`
- [ ] Empty `providers` → "online payment unavailable", no pay button
- [ ] Every charge sends `provider` + the listed `fields`; no `gateway`, no `phoneOperator`, no `cardToken`
- [ ] Card: Stripe.js loaded with the `CARD` entry's `publishableKey`; build-time key removed
- [ ] `instructions.requiresOtp` → authorize route, **whatever `/options` said**; `redirectUrl` → open it
- [ ] `422 PAYMENT_PROVIDER_PHONE_MISMATCH` → network message from `details.detected`, form kept
- [ ] `422 PAYMENT_PROVIDER_UNAVAILABLE` → re-render from `details.offered`
- [ ] Read types: `gateway` is `string` (unknown values render), `provider` is nullable
- [ ] Saved wallets: `provider` read as `MTN`/`ORANGE`/`MOOV`/`CARD`/`null`; only a listed mobile provider is pre-selected
- [ ] Save sends `{ provider, phoneNumber, label?, isDefault? }`; no old key; no card tab
- [ ] Save handles `400 VALIDATION_ERROR`, `422 PAYMENT_PROVIDER_PHONE_MISMATCH`, `409 PAYMENT_METHOD_LIMIT_REACHED`
- [ ] Saved-method types use `kind`, `label`, `maskedPhone`, `last4`, `isDefault`, `createdAt`, `updatedAt`
- [ ] Docs and `error-codes.ts` re-copied (§ 8); new codes translated
