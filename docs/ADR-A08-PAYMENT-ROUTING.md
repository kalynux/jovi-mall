# ADR-A08 — Customers choose a payment provider; the backend chooses the aggregator

**Date:** 2026-09-30
**Status:** Accepted. Owner decisions locked 2026-09-29. Foundation (W0) implemented 2026-09-30;
the settings store, doors, `/options`, admin surface and payout switch land in W1–W5.
**Scope:** jovi-mall and wi-admin. No geo-tracker change, no outbox event shape, no webhook body.
**Contract:** [`api-doc/payments/routing.md`](../api-doc/payments/routing.md)
**Code:** `src/modules/payments/domain/payment-provider.ts` (the catalogue) ·
`src/modules/payments/domain/payment-routing.ts` (every decision, pure) ·
`src/modules/payments/gateways/gateway.interface.ts` (`PAYMENT_GATEWAY_NAMES`,
`GatewayCapabilities`) · the three adapters' `capabilities` literals
**Test:** `npm run test:payment-routing` (the decision table), later `test:payment-settings`,
`test:payment-options`, `test:payout-routing`

---

## Context

A client named the **aggregator** on seven doors: `gateway: NOTCHPAY | MYCOOLPAY | STRIPE` on
payment initiate, booking pay and pay-balance, plan purchase, credit top-up and the two bot
booking pays. The consequence is that leaving an aggregator (an outage, a fee change, a better
provider) meant rebuilding and redeploying every app.

What the map of the code showed:

- **Only Stripe was actually off**, and only because its keys are absent. My-CoolPay was still
  offered on every client-named door.
- **The server already picked the aggregator** on the chat, mini-app and WhatsApp Flows doors
  (`mobileMoneyGateway()` in `bot-surface/miniapp/surfaces/checkout-payer.ts`, NotchPay first
  by env). The pattern existed; it just was not the rule.
- **Billing skipped the "is this aggregator offered" check** (`credit-topup.service.ts`,
  `plan-purchase.service.ts`).
- **Payouts were hardcoded** to `PAYOUT_GATEWAY = 'NOTCHPAY'`, and a payout row did not record
  which aggregator sent it.
- **jovi-mall had no administrator-settable settings store.** The maintenance singleton
  (`system/models/system-state.model.ts`, `system/services/maintenance.service.ts`) is the one
  precedent.
- **Nothing told a client which payment methods exist.**
- **The gateway list was hand-copied** into six model enums, three validators and
  `billing/domain/gateway-otp.ts`. Adding an aggregator meant finding all ten.

## Owner decisions (locked 2026-09-29)

1. Exactly one non-Stripe aggregator is active for collections at a time. Stripe has its own
   independent switch and stays off for now.
2. CARD has its own toggle. With Stripe on, CARD goes through Stripe, and CARD through an
   aggregator is impossible. With Stripe off, CARD goes through the active aggregator if that
   aggregator supports it. Stripe on with CARD off means no cards.
3. Payouts get their own switch. Only aggregators that can send money are selectable.
4. Apps still sending `gateway` keep working: accepted, ignored, the active aggregator is used.
5. Developer tier only, audited, and always available: the switch bypasses `dev_tools.enabled`,
   like maintenance mode (ADR-014 D-7).
6. Failover is manual. The admin screen shows recent per-aggregator outcomes to help decide.
7. Provider/number mismatch: ORANGE chosen with an MTN-prefix number is refused with a clear
   message before anything is written. An unknown prefix lets the declared provider win.
8. NotchPay stays active through the restructure. Campay becomes active after its adapter passes
   a live-money test. Only MTN and ORANGE are enabled for now.

---

## D-1 · Two layers

A **provider** is what the customer holds: `MTN`, `ORANGE`, `MOOV`, `CARD`
(`PAYMENT_PROVIDERS`, with `PROVIDER_KIND` = `MOBILE_MONEY` or `CARD`). An **aggregator** is who
the backend calls: `PaymentGatewayName`. Clients show and send providers. Only the backend and
administrators ever see aggregators.

The word `provider` was already taken: saved payment methods store lowercase values
(`mtn_momo`, `orange_money`, `stripe`…). **They are not renamed.** `providerForSavedWallet()` is
the single bridge (three wallet values map to `MTN` / `ORANGE` / `MOOV`; anything else maps to
null), so no caller compares the two vocabularies by hand.

## D-2 · Capabilities live on each adapter, and the gateway list lives in one place

Every adapter declares a required `capabilities` literal: for each provider it can collect,
the `flow` (`PUSH` · `OTP` · `CARD_ELEMENT` · `REDIRECT`) and the channel fields it `requires`,
plus `settlesAsync`. It is a fact about the integration, so it is code, not configuration.
Required rather than optional for the reason `verifyWebhook` is: a new adapter cannot compile
without answering.

`PAYMENT_GATEWAY_NAMES` (an `as const` tuple in `gateway.interface.ts`) is now the only gateway
list. `PaymentGatewayName` is derived from it, and the model enums and validators spread it.
`registry.ts` re-exports the same tuple under its existing name, so no importer changed.
`test:payment-routing` § 1 asserts that the registry Map, every model enum and every validator
equal it, and scans the ten former copies for a hand-written list. Adding Campay is one tuple
entry plus its adapter.

## D-3 · A `payment_settings` singleton

One document, `_id: 'payments'`: `collection_aggregator`, `payout_aggregator`,
`stripe_enabled`, `providers.{MTN,ORANGE,MOOV,CARD}.enabled`, plus `version`, `updated_at`,
`updated_by_id`, `updated_by_name` and `reason`. **A missing document means
`DEFAULT_PAYMENT_SETTINGS`**, which reproduces today exactly, so deploying the code changes
nothing until an administrator writes.

It copies the maintenance singleton: a synchronous cached read, a 5 s background refresh, the
last known value kept on a failed refresh, and a compare-and-set on `version` for writes
(`PAYMENT_SETTINGS_VERSION_CONFLICT`). Instances converge within 5 s, reported to the
administrator as `convergenceSeconds`. The write returns `previous` alongside `settings`, so
wi-admin's audit row records a true before/after without a racing read.

## D-4 · Routing rules, and the CARD/Stripe rule

`routeCollection(provider, settings, facts)` is pure. It returns no route for a disabled
provider. For CARD with Stripe on, it routes to Stripe or nothing. Otherwise it routes to the
collection aggregator if that aggregator is configured, is not Stripe, and declares the
provider. `effectiveProviders()` applies it across the catalogue and is the only source of
`/api/payments/options` and of `details.offered`. So "what the client is shown" and "what the
server will accept" cannot disagree.

The request checks (`checkChargeRequest`: required fields, then the mismatch of D-8) are a
**separate** pure export. A door runs them first, then its idempotency and live-attempt reuse,
and only then routes. That way a customer re-pressing Pay after a switch gets their live prompt
back instead of a refusal.

Validation (`validateSettingsChange`) splits hard errors from soft warnings. A hard error means
the configuration cannot work: an unknown or Stripe collection aggregator; one without
credentials; one that serves none of the enabled mobile providers; Stripe turned on without
credentials; a payout aggregator without `createPayout`; an unknown provider. A soft warning is
something an operator should see but must be able to do anyway, above all in an emergency: an
enabled provider the new route cannot serve (it drops out of `/options`), CARD with nothing to
route it, a payout aggregator whose account cannot send right now, and **every mobile provider
off**, which is the deliberate "stop taking mobile money" lever. Stripe is checked on the off→on
transition only, so an already-on Stripe whose keys vanished can never block a switch.

## D-5 · A separate payout aggregator

`payout_aggregator` is chosen independently of collections, because the two capabilities come
apart: today only NotchPay implements `createPayout`, and NotchPay transfers also need an
allowlisted egress IP. The payout row gains `transfer_gateway`, stamped on the first transfer
attempt. Retry, verify and callback settlement read the stamp, and a legacy null means NotchPay.

## D-6 · After a charge opens, the stored gateway is authoritative

Routing chooses who opens a **new** charge and nothing else. Verify, refund, OTP authorize,
webhooks, reconciliation and pay-link sessions read `transaction.gateway`; they never read the
settings. A payment opened on My-CoolPay settles, reconciles and refunds through My-CoolPay after
a switch to NotchPay. Webhook routes stay mounted for every registered adapter, and the
reconciliation sweep's scope comes from `capabilities.settlesAsync`, not from settings. A live
PENDING attempt is reused rather than duplicated on the new aggregator.

Stored rows keep `gateway` in responses as an informational field that clients must never
branch on, and they gain a nullable `provider`. Only `/options` is aggregator-free.

## D-7 · The legacy `gateway` field

`gateway` is accepted on every door as any string, and ignored. A missing `provider` is derived
in this order: `gateway === 'STRIPE'` → CARD, then `channel.phoneOperator`, then the number's
prefix, then `400 PAYMENT_PROVIDER_REQUIRED`. **STRIPE comes first** because an old STRIPE body
expresses card intent. With cards off it must reach `422 PAYMENT_PROVIDER_UNAVAILABLE`, never a
mobile-money push to whatever number happens to be in the body. A deprecation metric labelled by
door shows when the field can be removed.

## D-8 · A provider/number mismatch is refused before any write

For a mobile provider, the number's operator is detected **by prefix alone**:
`resolveCameroonOperator(phone)` is called without the declared operator, because inside that
function a declared operator wins, and passing it would hide exactly the mismatch being
checked. A known, different operator is refused with `422 PAYMENT_PROVIDER_PHONE_MISMATCH`
(`{ provider, detected, spent: false }`). An unknown prefix (Nexttel, Camtel, a ported or
foreign number) lets the declared provider win. Refusing up front is better than letting an
aggregator decline a wrong-network charge, which the customer reads as "payment declined".

## D-9 · Failover is manual

Nothing switches aggregator automatically. An automatic switch on error rates would move live
customers between providers on a signal (a burst of FAILED from customers typing wrong numbers,
say) that does not mean an outage. wi-admin instead shows per-aggregator outcomes over 24 h and
7 days: counts by status, success rate, p50/p90 time to settle, the last success, and stale
PENDING rows. A developer decides.

## D-10 · The switch is developer-tier and always available

`developer_tools.payments.read` / `.set` sit in the `developer_tools` family, which confines
them to tier 1. Every write is audited, fail-closed, with the before/after of D-3. The switch
does **not** call `assertDevToolsEnabled()`, for the reason maintenance mode does not (ADR-014
D-7): it is an incident lever, and an incident is exactly when someone may have turned dev tools
off. The jovi-mall route lives under `modules/dev-tools/`, not `modules/system/` (ADR-015 D-8).

## D-11 · NotchPay is the default until Campay passes its live test

`DEFAULT_PAYMENT_SETTINGS.collection_aggregator` and `.payout_aggregator` are `NOTCHPAY`. When
the Campay adapter (Phase 2) passes a live-money test, an administrator switches to it at
runtime, with no deploy. After a soak period, the default changes in code and this ADR gains an
addendum.

## Transition (W1 → C1) — closed

From W1 until C1, `gatewayAcceptsNewPayments` (the gate behind `assertGatewayOffered`) applied the
ADR-A08 rule **only once a `payment_settings` document existed**. While there was none
(`version` 0), it answered "configured" alone, as before this ADR. The client-named doors still
took a `gateway` until W2a made it ignored, and the strict rule would have refused `MYCOOLPAY` on
them the moment W1 deployed.

**C1 removed the bridge.** The rule is now the same with or without a document; with none, the
defaults apply (NotchPay only, Stripe off). The one remaining reader is the pay-link mint.
`test:payment-settings` § 4 and `test:payments` § 14 pin it.

C1 also removed the other scaffolding the restructure added "beside" the old forms: the
orchestrator's and billing's bare-gateway-name selections, the gateway-enum request schemas
(`InitiatePaymentSchema`, `InitiateBookingPaymentSchema`, `InitiateTopupSchema`,
`InitiatePlanPurchaseSchema`) and the `PAYMENT_GATEWAYS` validator alias, the bot's env-picked
`mobileMoneyGateway` and `assertNetworkChargeable`, and billing's copies of the provider schema and
the missing-field error. **The request field `gateway` was NOT removed** from any door (owner
decision 4): old apps and the live n8n MCP still send it, and it stays accepted and ignored.
`PAYMENT_GATEWAY_NOT_CONFIGURED` stays in the error registry, raised by nothing today.

---

## Error codes

| Code | Status | Category |
|---|---|---|
| `PAYMENT_PROVIDER_UNAVAILABLE` | 422 | `business_rule` |
| `PAYMENT_PROVIDER_PHONE_MISMATCH` | 422 | `business_rule` |
| `PAYMENT_PROVIDER_REQUIRED` | 400 | `validation` |
| `PAYMENT_SETTINGS_INVALID` | 422 | `business_rule` (`details.errors[]`) |
| `PAYMENT_SETTINGS_VERSION_CONFLICT` | 409 | `conflict` |

All five are client-safe, so `details` reaches the caller, and wi-admin forwards it only for
client-safe categories. `test:errors` § 9 pins them.

## Consequences

- An aggregator outage is an administrator action measured in seconds, not an app release.
- A new aggregator costs one tuple entry, an adapter with `capabilities`, and its webhook
  verification. No client changes.
- Clients must handle `flow` from `/options` **and** `instructions.requiresOtp` /
  `instructions.redirectUrl` from `initiate`, because the aggregator behind a provider can change
  between the two calls.
- Deploy order: jovi-mall first (with no document it behaves as before), then wi-admin. wi-admin
  treats a 404 from jovi-mall as "platform too old", never as success.

## Decided NOT to change

- **Stored saved-method `provider` values** stay lowercase and unrenamed (D-1).
- **No automatic failover** (D-9).
- **No backfill** of `provider` onto historical rows. Null means "before ADR-A08".
