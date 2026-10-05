# Orange Money payment code (`CODE_FIRST`) and mobile-money amount limits — every app

**Applies to:** every app that takes a mobile-money payment: the shop (landing site), the vendor
dashboard, the agency dashboard, the agent app. The admin dashboard has its own page
([`admin/api-doc/FRONTEND-CHANGELOG-payment-code.md`](../../admin/api-doc/FRONTEND-CHANGELOG-payment-code.md)).
**Status:** ✅ built 2026-10-05 in jovi-mall; live after the next production deploy. **Nothing changes
for a customer until an administrator makes NovaSend the collection aggregator.**
**Breaks:** nothing on the wire. A build that never sends the code keeps working on every other
aggregator. While NovaSend is active, its Orange customers are refused `PAYMENT_CODE_REQUIRED` and
have nowhere to type the code: **ship the step before the switch.**

Per app: [shop](./customer/FRONTEND-CHANGELOG-payment-code.md) ·
[vendor](./vendor/FRONTEND-CHANGELOG-payment-code.md) ·
[agency](./agency/FRONTEND-CHANGELOG-payment-code.md) ·
[agent](./agent/FRONTEND-CHANGELOG-payment-code.md). The contract is
[`payments/routing.md`](./payments/routing.md) § "The payment code".

---

## What changed

The platform gained a seventh payment aggregator, **NovaSend** (Cameroon, MTN + Orange). Like
every aggregator it is chosen by an administrator at runtime; apps never name it. Two things about
it reach the apps.

### 1. Orange Money through NovaSend needs a payment code BEFORE the charge

The customer **dials a USSD code first** (NovaSend's documentation shows `#144*82#`; the server
always tells you the right one), the operator answers with a short **payment code**, and that code
is **sent with the charge**. Then everything continues exactly like today's push: the customer
approves on the handset and the app polls `verify`.

This is the **opposite order** from the My-CoolPay OTP you already handle (`flow: "OTP"`: charge
first, then an SMS code to `/authorize`). It is a separate flow, **`CODE_FIRST`**.

`GET /api/payments/options` says when it applies:

```jsonc
{ "provider": "ORANGE", "kind": "MOBILE_MONEY", "flow": "CODE_FIRST",
  "fields": ["phoneNumber", "paymentCode"], "mayRequireOtp": false,
  "codeUssd": "#144*82#", "limits": { "min": 200, "max": 500000 } }
```

| New on an `/options` entry | Meaning |
|---|---|
| `flow: "CODE_FIRST"` | collect a payment code **before** `initiate` |
| `fields` includes `"paymentCode"` | the charge's `channel` must carry it |
| `codeUssd` | only on `CODE_FIRST`: what the customer dials. **Show it verbatim; never hard-code it** |
| `limits` | `{ min, max }` in XAF when the route has them (both MTN and Orange on NovaSend) |

The code goes in **`channel.paymentCode`**: a string of **4 to 8 digits** (spaces are tolerated and
removed). Every door that takes a `channel` accepts it.

### 2. Amount limits

NovaSend accepts **200 to 500,000 XAF** per payment in Cameroon. Outside that range the server
refuses **before anything is written**. There is **no automatic switch** to another payment company
(owner decision): the customer is told plainly and pointed to support.

---

## The three new refusals

All three are `422`, category `business_rule`, so `details` reaches you.

| Code | `details` | When | What the app does |
|---|---|---|---|
| `PAYMENT_CODE_REQUIRED` | `{ provider, ussd, spent: false }` | the route is `CODE_FIRST` and no `paymentCode` was sent | **Keep the form.** Show the code field with *"Dial {ussd} to get your payment code"* and let the customer pay again. Nothing was charged or written. This is also how an app with a stale `/options` finds out |
| `PAYMENT_CODE_REJECTED` | `{ provider, ussd }` | Orange refused the code (wrong, expired, already used) | Clear the code field, *"That code was not accepted. Dial {ussd} for a new one."* Nothing was charged. The attempt is closed: send a **new** `initiate` with the new code |
| `PAYMENT_AMOUNT_OUT_OF_RANGE` | `{ provider, amount, min, max, spent: false }` | the amount is outside `limits` | *"Mobile money payments are limited to {max} FCFA right now. Please contact support."* Nothing was charged. Use `limits` from `/options` to warn before the customer presses Pay |

Plus the field-shape check: a `paymentCode` that is not 4–8 digits is `400 VALIDATION_ERROR` on
`channel.paymentCode`.

---

## Rules every app follows

1. **Show the code field only for a `CODE_FIRST` entry**, and only once the customer has chosen
   that provider. MTN through NovaSend is a plain `PUSH`: no code.
2. **Show `codeUssd` as a tappable `tel:` link where the platform allows it** (encode `#` as `%23`),
   plus the text. The customer usually dials it on the same phone they pay from.
3. **Ask for the code just before Pay.** It is short-lived; a code typed minutes earlier may be
   refused.
4. ⛔ **The code is a one-payment credential.** Do not store it (no local storage, no form
   autosave, no analytics, no crash reports, no logs), do not pre-fill it, and drop it from memory
   once the charge is answered. Use `inputmode="numeric"` and `autocomplete="one-time-code"`.
5. **Never branch on the aggregator.** `/options` and the refusals tell you everything; `gateway`
   stays a display label.
6. **`instructions.requiresOtp` and `instructions.redirectUrl` still apply after any `initiate`**,
   whatever `/options` said. NovaSend may answer `redirectUrl` when the customer must confirm on a
   NovaSend page.

---

## Where it shows up, per surface

| Surface | Doors |
|---|---|
| Shop (landing site) | `POST /api/payments/initiate`, `POST /api/bookings/:id/pay`, `POST /api/customer/bookings/:id/pay-balance`, `POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/pay` |
| Vendor dashboard | `POST /api/vendor/plans/:planId/purchase`, `POST /api/vendor/credits/topups` |
| Agency dashboard | the same under `/api/agency` |
| Agent app | the same under `/api/agent` |
| Bot (WhatsApp / Telegram) and its in-app pages | done server-side; nothing for the apps |

Re-copy: [`payments/routing.md`](./payments/routing.md) (capability types, `/options` fields, error
table, § "The payment code").
