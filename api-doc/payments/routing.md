# Payments: provider routing (ADR-A08)

**Status: CONTRACT, written 2026-09-30 ahead of the code (W0 of the payment-routing
restructure).** This file fixes the names and shapes that the jovi-mall, wi-admin and docs
workstreams build against. The foundation types it names exist in source now; the endpoints and
the settings store land in W1–W5. Until a section says "live", treat it as the target.

Design record: [`docs/ADR-A08-PAYMENT-ROUTING.md`](../../docs/ADR-A08-PAYMENT-ROUTING.md).
Pure logic: `src/modules/payments/domain/payment-provider.ts` and
`src/modules/payments/domain/payment-routing.ts`.

---

## The two layers

| Layer | What it is | Values | Who chooses |
|---|---|---|---|
| **Provider** | what the customer holds and pays with | `MTN` · `ORANGE` · `MOOV` · `CARD` | the **customer**, on the client |
| **Aggregator** (called `gateway` in code and on stored rows) | the company the backend calls to move the money | `NOTCHPAY` · `MYCOOLPAY` · `STRIPE` · `CAMPAY` · `CINETPAY` · `FAPSHI` (later `FLUTTERWAVE`) | an **administrator**, at runtime, in wi-admin dev tools |

A client shows providers and sends `provider`. It never names, chooses or branches on an
aggregator for a **new** charge. Switching aggregator is a settings write, with no deploy and no
app release.

### ⚠ Two different things are called `provider`

The **saved payment methods** (`payment-methods` module, `user_payment_methods.provider`, and
the bot's saved wallets) also have a stored `provider` field, and **since 2026-09-30 it holds two
vocabularies**:

- **Rows saved since 2026-09-30** store the canonical uppercase value itself: `MTN` · `ORANGE` ·
  `MOOV`. A saved method no longer names an aggregator, and no card is saved
  ([customer/payment-methods.md](../customer/payment-methods.md)).
- **Rows saved before** keep their **lowercase** values: `stripe`, `notchpay`, `mycoolpay`,
  `mtn_momo`, `orange_money`, `moov_money`. They are **not rewritten**.

Clients never see the second list: the saved-methods API maps legacy rows to the canonical
vocabulary on read (`mtn_momo` → `MTN`, a card → `CARD`, an aggregator name → `null`). The mixture
exists only in the database, and server code reading `user_payment_methods` directly must still
handle it.

The one server-side bridge is `providerForSavedWallet()` in `payment-provider.ts`, which reads
both:

| Stored value | Charge `provider` |
|---|---|
| `MTN` · `ORANGE` · `MOOV` (new rows, any case) | the same value |
| `mtn_momo` | `MTN` |
| `orange_money` | `ORANGE` |
| `moov_money` | `MOOV` |
| anything else (`CARD`, `stripe`, `notchpay`, `mycoolpay`, unknown, null) | `null`: not a mobile wallet the router can name. The caller decides |

A door that charges a saved wallet maps it with this function. It never compares the stored
string to a provider name itself.

---

## Provider catalogue

`PAYMENT_PROVIDERS = ['MTN', 'ORANGE', 'MOOV', 'CARD']`, in this order everywhere (the order of
`/options`).

| Provider | Kind (`PROVIDER_KIND`) | Enabled by default |
|---|---|---|
| `MTN` | `MOBILE_MONEY` | ✅ |
| `ORANGE` | `MOBILE_MONEY` | ✅ |
| `MOOV` | `MOBILE_MONEY` | ❌ (no Cameroon rail on any current aggregator) |
| `CARD` | `CARD` | ❌ (owner decision: mobile money only for now) |

---

## Capability matrix: declared on each adapter

Every adapter carries a required `capabilities` literal (`GatewayCapabilities` in
`gateway.interface.ts`):

```ts
type CollectFlow = 'PUSH' | 'OTP' | 'CARD_ELEMENT' | 'REDIRECT';
type CollectField = 'phoneNumber' | 'customerEmail' | 'customerName';

interface ProviderCollectCapability {
  flow: CollectFlow;
  requires: readonly CollectField[];   // channel fields that MUST be present
}

interface GatewayCapabilities {
  collect: Partial<Record<PaymentProvider, ProviderCollectCapability>>;  // absent key = cannot collect it
  settlesAsync: boolean;               // true = the final status arrives by webhook / reconciliation
}
```

| Aggregator | MTN | ORANGE | MOOV | CARD | `settlesAsync` | Can send payouts (`createPayout`) |
|---|---|---|---|---|---|---|
| `NOTCHPAY` | `PUSH`, requires `phoneNumber` | `PUSH`, requires `phoneNumber` | — | — | `true` | ✅ (behind `NOTCHPAY_PAYOUTS_ENABLED`) |
| `MYCOOLPAY` | `PUSH`, requires `phoneNumber` | `OTP`, requires `phoneNumber` | — | — | `true` | ✅ (behind `MYCOOLPAY_PAYOUTS_ENABLED`, and the server IP registered with My-CoolPay) |
| `STRIPE` | — | — | — | `CARD_ELEMENT`, requires nothing | `false` | ❌ |
| `CAMPAY` | `PUSH`, requires `phoneNumber` | `PUSH`, requires `phoneNumber` | — | — | `true` | ✅ (behind `CAMPAY_PAYOUTS_ENABLED`, **and** "API withdrawals" allowed in the Campay app) |
| `CINETPAY` | `PUSH`, requires `phoneNumber` | `PUSH`, requires `phoneNumber` | — | — | `true` | ✅ (behind `CINETPAY_PAYOUTS_ENABLED`, and the server IP whitelisted by CinetPay) |
| `FAPSHI` | `PUSH`, requires `phoneNumber` | `PUSH`, requires `phoneNumber` | — | — | `true` | ✅ (behind `FAPSHI_PAYOUTS_ENABLED`, a separate payout service, and payouts enabled on it by Fapshi support) |

Flows, for a client:

| `flow` | What the client does after `initiate` |
|---|---|
| `PUSH` | tell the customer to approve the prompt on their handset; poll `verify` |
| `OTP` | the charge **may** answer `instructions.requiresOtp: true`; then collect the SMS code and `POST /payments/:transactionId/authorize` |
| `CARD_ELEMENT` | mount Stripe's Payment Element with `instructions.clientSecret` (a browser is required) |
| `REDIRECT` | open `instructions.redirectUrl` (reserved for Flutterwave cards, Phase 2) |

⚠ **`CINETPAY` is `PUSH` and may still answer `instructions.redirectUrl`.** It asks CinetPay to
push the PIN prompt; an account without CinetPay's "direct" mode answers that the customer must be
redirected, and the backend then returns CinetPay's hosted payment page as `redirectUrl` (with
no `ussdCode`). A client that ignores `redirectUrl` on a `PUSH` flow leaves that customer waiting
for a prompt that never comes.

⚠ **`flow` is a hint for which screen to prepare, never a promise.** A client must always honour
`instructions.requiresOtp` and `instructions.redirectUrl` on the `initiate` response, whatever
`/options` said. `PaymentInstructions` gains `redirectUrl?: string` for this.

---

## Settings document: `payment_settings`

One document, `_id: 'payments'`, collection `payment_settings` (`COLLECTIONS.PAYMENT_SETTINGS`,
model `MODELS.PAYMENT_SETTINGS = 'PaymentSettings'`). Stored in snake_case:

```jsonc
{
  "_id": "payments",
  "collection_aggregator": "NOTCHPAY",   // one non-Stripe aggregator for mobile money
  "payout_aggregator": "NOTCHPAY",       // must implement createPayout
  "stripe_enabled": false,               // Stripe's own switch, independent of the above
  "providers": {
    "MTN":    { "enabled": true },
    "ORANGE": { "enabled": true },
    "MOOV":   { "enabled": false },
    "CARD":   { "enabled": false }
  },
  "version": 3,                          // compare-and-set counter; 0 means "no document yet"
  "updated_at": "2026-09-30T10:00:00.000Z",
  "updated_by_id": "admin-account-id",   // the wi-admin administrator, from the admin-caller headers
  "updated_by_name": "Jane Doe",
  "reason": "NotchPay outage, moving collections to MyCoolPay"
}
```

**A missing document means `DEFAULT_PAYMENT_SETTINGS`**: NotchPay for collections and payouts,
Stripe off, MTN and ORANGE on, MOOV and CARD off, `version: 0`. With no document the platform
behaves exactly as it did before this change. No migration, no seed.

Readers get it from a synchronous cache refreshed every 5 s (`PAYMENT_SETTINGS_CACHE_TTL_MS`).
A failed refresh keeps the last known value (the defaults on a cold start). So every server
instance agrees within **5 seconds** of a write, reported as `convergenceSeconds`.

---

## Routing rules (`routeCollection`)

For a **new** charge only. Evaluated in this order:

1. The provider is disabled in settings → **no route** (`PROVIDER_DISABLED`).
2. `CARD`:
   - `stripe_enabled: true` → route to `STRIPE` if Stripe is configured and declares `CARD`.
     Otherwise no route. **CARD through an aggregator is impossible while Stripe is on.**
   - `stripe_enabled: false` → route to the collection aggregator if it is configured and
     declares `CARD`. Otherwise no route.
   - Stripe on with CARD off means no cards (rule 1).
3. A mobile provider → route to `collection_aggregator` if it is configured, is not `STRIPE`, and
   declares that provider. Otherwise no route (`NO_ROUTE`).

"Configured" means the aggregator's credentials are present in the environment (today:
`notchPayEnabled()`, `myCoolPayEnabled()`, `stripeEnabled()`).

`effectiveProviders(settings, facts)` is `routeCollection` applied to every provider in catalogue
order, keeping the ones that route. It is the only source of `/options` and of `details.offered`.

### ⛔ The stored gateway is authoritative after a charge opens

Routing decides **which aggregator opens a new charge, and nothing else**. Verify, refund,
authorize (OTP), webhooks, reconciliation and pay-link sessions read `transaction.gateway` from
the stored row and **never** read the settings. A payment opened on MyCoolPay settles, reconciles
and refunds through MyCoolPay after an administrator has switched to NotchPay.

If a live PENDING attempt already exists for the same order or booking, it is **reused**, not
reopened on the new aggregator. That way a customer who presses Pay again after a switch gets
their live prompt back rather than a second charge.

---

## Request shape: the same on every charging door

Doors: `POST /api/payments/initiate`, `POST /api/bookings/:id/pay`, the booking pay-balance door,
plan purchase, credit top-up, the bot booking pay doors, bot and mini-app checkout, and WhatsApp
Flows (the last three never took a `gateway` from the caller and pick the aggregator on the
server already).

```jsonc
{
  // …the door's own fields (cartId / orderId / planId / amount …)
  "provider": "MTN",                        // 'MTN' | 'ORANGE' | 'MOOV' | 'CARD'
  "channel": {
    "phoneNumber": "+237670000001",         // E.164; required when the route's capability requires it
    "customerEmail": "a@example.com",       // optional
    "customerName": "Awa"                   // optional
    // phoneOperator and cardToken are still accepted, and are legacy
  },
  "gateway": "NOTCHPAY"                     // DEPRECATED. Accepted, ignored; any string
}
```

- **`gateway` is accepted and ignored** (owner decision 4). Old apps keep working, and the
  active aggregator is used. Each use is counted by a deprecation metric labelled by door. It is
  no longer validated against the gateway enum, so an old app naming a switched-off aggregator is
  not refused.
- **`provider` is optional only while old apps are in use.** When it is missing, it is derived in
  this order (`deriveProvider()`):
  1. `gateway === 'STRIPE'` → `CARD`;
  2. `channel.phoneOperator` (`MTN` / `ORANGE` / `MOOV`);
  3. the phone number's prefix (the Cameroon prefix table in `payments/domain/cm-operator.ts`);
  4. otherwise **`400 PAYMENT_PROVIDER_REQUIRED`**.

  An explicit `provider` always wins, and derivation never runs. `STRIPE` comes **first**
  because an old STRIPE body means card intent. With cards off it answers `422
  PAYMENT_PROVIDER_UNAVAILABLE`. It is never pushed to whatever phone number happens to be in
  the body.

### Pre-routing checks (`checkChargeRequest`): no I/O, before anything is written

Run **first**, before idempotency, live-attempt reuse or the routing decision:

1. **Required fields.** Against the route's `capability.requires` when the route is known.
   Otherwise the baseline for the provider's kind: mobile money requires `phoneNumber`; CARD
   requires nothing. A missing field is refused with the door's existing refusal: HTTP doors
   answer `400 VALIDATION_ERROR` on `channel.phoneNumber` (unchanged); bot and mini-app doors
   answer `422 PAYMENT_PAYER_NUMBER_REQUIRED` (unchanged).
2. **Provider/number mismatch** (owner decision 7), mobile providers only. The number's operator
   is detected **by prefix alone**. A declared `phoneOperator` is deliberately **not**
   consulted here, because it would hide the mismatch:

   | Declared `provider` | Number's prefix says | Result |
   |---|---|---|
   | `ORANGE` | `MTN` (e.g. `+23767…`) | **`422 PAYMENT_PROVIDER_PHONE_MISMATCH`**, nothing written |
   | `MTN` | `ORANGE` (e.g. `+23769…`) | **`422 PAYMENT_PROVIDER_PHONE_MISMATCH`** |
   | `MTN` | `MTN` | ok |
   | `MTN` | unknown (Nexttel `66x`, Camtel `62x`, ported, non-Cameroon) | ok: **the declared provider wins** |
   | `MOOV` | `MTN` or `ORANGE` | **`422 PAYMENT_PROVIDER_PHONE_MISMATCH`** |
   | `CARD` | anything | ok: the number is not checked |

Then routing: a provider with no route answers **`422 PAYMENT_PROVIDER_UNAVAILABLE`**, also
before anything is written.

---

## `GET /api/payments/options`

- **Auth**: none. **`Cache-Control: no-store`**. The server caches the computed answer for 5 s.
- Mounted **before** `/:transactionId` in `payment.routes.ts`.
- Standard envelope (**not** one of the four flat payment routes).

```jsonc
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

With MyCoolPay active, ORANGE reads `"flow": "OTP", "mayRequireOtp": true`. With CARD on and
routed through Stripe, a CARD entry appears:

```jsonc
{ "provider": "CARD", "kind": "CARD", "flow": "CARD_ELEMENT", "fields": [], "mayRequireOtp": false,
  "publishableKey": "pk_live_…" }
```

| Field | Meaning |
|---|---|
| `provider` | the value to send back as `provider` |
| `kind` | `MOBILE_MONEY` or `CARD` |
| `flow` | which screen to prepare. See [Flows](#capability-matrix-declared-on-each-adapter) |
| `fields` | the `channel` fields the charge requires (the route's `requires`) |
| `mayRequireOtp` | `true` exactly when `flow` is `OTP` |
| `publishableKey` | only on a `CARD_ELEMENT` entry: the Stripe publishable key (never an `sk_`/`rk_` key; the pay-link guard is reused) |

Guarantees:
- Lists only providers that are **enabled and routable** right now, in catalogue order. An empty
  `providers` array is a valid answer (nothing can be paid online).
- **Never names an aggregator.** No `gateway` key, no aggregator name, no secret, anywhere in the
  body. This is the only aggregator-free surface. See [Read side](#read-side-stored-rows-keep-gateway).
- A stale copy is harmless: charging a provider that has since dropped out answers `422
  PAYMENT_PROVIDER_UNAVAILABLE` with `details.offered`, which is the fresh list.
- **Every listed provider is payable.** If CARD routes through Stripe but no valid publishable key
  is configured, CARD is not listed.

---

## Read side: stored rows keep `gateway`

Stored rows and their responses (payment transactions, credit top-ups, plan purchases, pay-link
sessions, payout requests) **keep `gateway` as an informational field**. It says which aggregator
actually carried that money. **Clients must never branch on it.** Branch on `status` and
`instructions`.

They gain a nullable **`provider`** (`MTN` · `ORANGE` · `MOOV` · `CARD` · `null`). It is `null` on
rows written before this change. No backfill.

Payout requests gain **`transfer_gateway`**, stamped on the first transfer attempt. Retries,
verification and callbacks use it. A legacy `null` means `NOTCHPAY`.

---

## Error codes

| Code | Status | Category | `details` | When |
|---|---|---|---|---|
| `PAYMENT_PROVIDER_REQUIRED` | 400 | `validation` | none | no `provider`, and derivation found none |
| `PAYMENT_PROVIDER_UNAVAILABLE` | 422 | `business_rule` | `{ provider, offered: PaymentProvider[] }` | the provider is disabled, or no aggregator can route it right now |
| `PAYMENT_PROVIDER_PHONE_MISMATCH` | 422 | `business_rule` | `{ provider, detected, spent: false }` | the number's prefix belongs to a different operator than `provider` |
| `PAYMENT_SETTINGS_INVALID` | 422 | `business_rule` | `{ errors: SettingsIssue[] }` | a settings write broke a hard rule |
| `PAYMENT_SETTINGS_VERSION_CONFLICT` | 409 | `conflict` | none | `expectedVersion` is not the stored `version`. Reload and retry |

`detected` is `'MTN'` or `'ORANGE'`. `spent: false` states that nothing was charged or written.
It is the same flag the chat checkout uses, so a bot can say "try again" rather than "start
over". All five are client-safe categories, so `details` reaches the caller (and wi-admin
forwards it).

The old `400 PAYMENT_GATEWAY_NOT_SUPPORTED` stays for doors that still take an aggregator name
(pay-link minting). It is no longer raised for an ignored legacy `gateway`.

---

## Settings validation (`validateSettingsChange`)

Input: the **merged** candidate (the current document with the patch applied), the current
document, and the per-aggregator facts. Output: hard `errors` (the write is refused with
`PAYMENT_SETTINGS_INVALID`) and soft `warnings` (the write is accepted, and they are returned).

```ts
interface SettingsIssue {
  code: SettingsIssueCode;
  message: string;                 // English, operator-facing
  provider?: PaymentProvider;
  aggregator?: string;
}
```

**Hard errors: the write is refused**

| `code` | Rule |
|---|---|
| `COLLECTION_AGGREGATOR_UNKNOWN` | `collection_aggregator` is not a registered gateway name |
| `COLLECTION_AGGREGATOR_IS_STRIPE` | `collection_aggregator` is `STRIPE` (Stripe has its own switch) |
| `COLLECTION_AGGREGATOR_NOT_CONFIGURED` | its credentials are absent from the environment |
| `COLLECTION_AGGREGATOR_NO_ENABLED_PROVIDER` | at least one mobile provider is enabled, and the aggregator can serve **none** of them. Turning every mobile provider off is allowed (the "stop taking mobile money" lever) and only warns |
| `STRIPE_NOT_CONFIGURED` | `stripe_enabled` is being turned **on** (off → on) without Stripe credentials. Leaving an already-on Stripe unconfigured is not an error, so an emergency switch is never blocked by it |
| `PAYOUT_AGGREGATOR_UNKNOWN` | `payout_aggregator` is not a registered gateway name |
| `PAYOUT_AGGREGATOR_NOT_IMPLEMENTED` | it has no `createPayout` (today only `STRIPE`: `NOTCHPAY`, `MYCOOLPAY`, `CAMPAY`, `CINETPAY` and `FAPSHI` all have one) |
| `PROVIDER_UNKNOWN` | a key of `providers` is not in the catalogue |

**Soft warnings: the write is accepted**

| `code` | Rule |
|---|---|
| `PROVIDER_UNROUTABLE` | an enabled mobile provider cannot be served by the new route. It silently drops out of `/options` |
| `CARD_UNROUTABLE` | CARD is enabled but nothing can route it (Stripe off and the aggregator has no CARD, or Stripe on and unconfigured) |
| `PAYOUT_UNAVAILABLE` | the payout aggregator's `payoutAvailable()` is false (env flag off, or its IP allowlist is not set up) |
| `NO_MOBILE_PROVIDER_ENABLED` | every mobile provider is disabled: no mobile money will be offered |

A known provider missing from `providers` is treated as disabled.

---

## Administrator surface (W4a / W4b)

**jovi-mall, internal:** `GET` / `PUT /api/internal/admin/dev-tools/payments`, behind
`requireAdminCaller`. It is **not** gated by `dev_tools.enabled` (owner decision 5, ADR-014 D-7:
the maintenance-mode precedent).

`PUT` body, `.strict()`:

```jsonc
{
  "collectionAggregator": "MYCOOLPAY",     // optional
  "payoutAggregator": "NOTCHPAY",          // optional
  "stripeEnabled": false,                  // optional
  "providers": { "ORANGE": { "enabled": true } },   // optional, partial: merged per provider
  "expectedVersion": 3,                    // required; 0 when no document exists yet
  "reason": "NotchPay outage"              // required, non-empty
}
```

The actor comes from the admin-caller headers, never from the body.

`PUT` success is `200` with `data` = the result of `setPaymentSettings`:

```jsonc
{
  "previous": { /* the settings view as it stood before the compare-and-set; the defaults if there was no document */ },
  "settings": { /* the settings view after */ },
  "changed": ["collectionAggregator"],     // top-level keys whose value differs
  "warnings": [ { "code": "PROVIDER_UNROUTABLE", "message": "…", "provider": "MOOV" } ],
  "convergenceSeconds": 5
}
```

The **settings view** is the camelCase projection of the document:

```jsonc
{
  "collectionAggregator": "NOTCHPAY",
  "payoutAggregator": "NOTCHPAY",
  "stripeEnabled": false,
  "providers": { "MTN": { "enabled": true }, "ORANGE": { "enabled": true }, "MOOV": { "enabled": false }, "CARD": { "enabled": false } },
  "version": 3,
  "updatedAt": "2026-09-30T10:00:00.000Z",  // null when no document
  "updatedBy": { "id": "…", "name": "…" },  // null when no document
  "reason": "…"                             // null when no document
}
```

`GET` returns `{ settings, aggregators, effectiveProviders, errors, warnings }`, where each
`aggregators[]` row is `{ name, configured, capabilities, payoutImplemented, payoutAvailable,
refundAvailable, activeForCollections, activeForPayouts }`. This is the one surface that names
aggregators. It is administrator-only.

`errors` and `warnings` are the stored settings' **standing** problems, computed at read time by
validating the current settings against themselves (not the warnings from the last write).
`errors` holds hard-rule failures, for example the active aggregator's credentials having been
removed after the switch: new charges are being refused now. When `errors` is non-empty,
`warnings` is `[]`. Both are always present (jovi-mall `0b58bb7`).

**wi-admin:** `GET` / `PUT /api/v1/dev-tools/payments`, permissions
`developer_tools.payments.read` / `developer_tools.payments.set` (tier 1 only), audited as
`developer_tools.payments.set` with target type `payment_settings`, fail-closed. The audit's
before/after comes from `previous` / `settings` in the write result, not from a separate `GET`,
which would race. A `404` from jovi-mall means "platform too old", never success.

---

## Payouts

`payout_aggregator` is a separate switch (owner decision 3). Only an aggregator with
`createPayout` may be chosen (a hard rule). One whose account cannot send right now is accepted
with `PAYOUT_UNAVAILABLE`. The payout service resolves it at the first transfer attempt and stamps
`transfer_gateway`; everything after that reads the stamp.

Payout capability per aggregator (`createPayout`, and `payoutAvailable()` for "can send right
now"):

| Aggregator | Can pay out | Available when |
|---|---|---|
| `NOTCHPAY` | ✅ | `NOTCHPAY_PAYOUTS_ENABLED=true` and the server's egress IP on NotchPay's payout allowlist |
| `CAMPAY` | ✅ | `CAMPAY_PAYOUTS_ENABLED=true` **and** "allow withdrawals through the API" on in the Campay app settings. The second is invisible to the server: a refusal for it comes back per call as `unsupported` |
| `MYCOOLPAY` | ✅ (jovi-mall `83e8535`) | `MYCOOLPAY_PAYOUTS_ENABLED=true` (the service refuses to boot with it on unless `MYCOOLPAY_PUBLIC_KEY` and `MYCOOLPAY_PRIVATE_KEY` are both set), and the server's egress IP registered with My-CoolPay. The second is invisible to `payoutAvailable()`: an unregistered IP surfaces per payout as a retryable `FAILED` ("Nothing was sent") |
| `CINETPAY` | ✅ | `CINETPAY_PAYOUTS_ENABLED=true` and the server's egress IP whitelisted by CinetPay. An unlisted IP is refused per call as `NOT_ALLOWED` (2011) and surfaces as `unsupported`; nothing is sent |
| `FAPSHI` | ✅ | `FAPSHI_PAYOUTS_ENABLED=true` and the payout service's own pair (`FAPSHI_PAYOUT_API_USER` / `_KEY`): a Fapshi service that pays out can no longer collect. Live payouts are off until Fapshi support enables them for that service. Fapshi documents no idempotency, so a resend first reads `GET /transaction/{reference}` and sends nothing when an earlier attempt succeeded or is still pending |
| `STRIPE` | ❌ | — |

My-CoolPay payouts are `POST {base}/{public_key}/payout` with `X-PRIVATE-KEY`; our `jm_po_…`
reference travels as `app_transaction_ref`, the operator (`CM_MOMO` / `CM_OM`) is derived from the
number, and XAF only. Two properties matter to operations:

- **Callbacks are sent once, with no retry.** A lost payout callback is recovered only by the
  payout reconciliation sweep. A payout callback's signature does not cover the status either, so
  it is confirmed with `checkStatus`, as for collections.
- **An unknown outcome stays `processing`.** A timeout, a `5xx`, a `409` or an unreadable `2xx` on
  the payout call leaves the payout `processing` with a `transfer_failure_reason` that begins
  "Outcome unknown … check … dashboard for reference jm_po_…". If My-CoolPay never returned its
  own reference, the sweep cannot ask about it (`checkStatus` is keyed on their reference only),
  so it needs an administrator.

**Open questions, not documented by My-CoolPay** (owner actions: ask their support): whether a
repeated `app_transaction_ref` is refused (the idempotency question), the payout fees, and the
minimum and maximum amounts.

The owner ops for each (allowlists, toggles, float) are in the workspace
[`docs/RUNBOOK.md` § Enabling payouts per aggregator](../../../docs/RUNBOOK.md#enabling-payouts-per-aggregator).
