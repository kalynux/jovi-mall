# NovaSend: no Orange code, and "Moon SARL" on the customer's phone — every app

**Applies to:** every app that takes a mobile-money payment: the shop (landing site), the vendor
dashboard, the agency dashboard, the agent app.
**Status:** ✅ built 2026-11-04 from a live test with real money. It applies once this backend is
deployed and an administrator selects NovaSend, which the owner intends as the default.
**Breaks:** nothing on the wire.
**Replaces:** [`FRONTEND-CHANGELOG-payment-code.md`](./FRONTEND-CHANGELOG-payment-code.md). Its Orange
code step is not needed. Do not build it.

Per app: [shop](./customer/FRONTEND-CHANGELOG-novasend-moon-sarl.md) ·
[vendor](./vendor/FRONTEND-CHANGELOG-novasend-moon-sarl.md) ·
[agency](./agency/FRONTEND-CHANGELOG-novasend-moon-sarl.md) ·
[agent](./agent/FRONTEND-CHANGELOG-novasend-moon-sarl.md).
Contract: [`payments/routing.md`](./payments/routing.md).

---

## 1. The customer must look for "Moon SARL"

The confirmation on the customer's phone names **Moon SARL**, not Wi-Mall. That is correct, and a
customer who was not warned may refuse a request from a name they do not know. Any `initiate`
response through NovaSend now says so:

```jsonc
"instructions": {
  "ussdCode": "#150*50#",
  "payeeName": "Moon SARL",
  "message": "Composez #150*50#, vérifiez que la demande vient de Moon SARL, puis entrez votre code secret. / Dial #150*50#, check the request is from Moon SARL, then enter your PIN."
}
```

| Field | Meaning |
|---|---|
| `payeeName` | **New, optional.** The name the customer will see on their phone. Only NovaSend sends it: the name other gateways show is not known yet, so it is absent and the screen stays as it is today |
| `message` | What to do, French then English, ready to show as it is |
| `ussdCode` | What to dial: `#150*50#` for Orange, `*126#` for MTN (MTN only if the prompt does not appear) |

## 2. The two operators behave differently on the phone

| Operator | What the customer does |
|---|---|
| **MTN** | A prompt appears by itself. They check for Moon SARL and enter their PIN |
| **Orange** | ⚠ **No prompt appears.** They must dial `#150*50#`, check for Moon SARL, and enter their PIN. Nothing happens until they dial |

So on the waiting screen after `initiate`:

1. **When `payeeName` is present, make the instruction the main thing on the screen.** Show `message`,
   or your own translation built from `payeeName` and `ussdCode`, for example *"Confirmez la demande
   de {payeeName}"*.
2. **Offer `ussdCode` as a tappable `tel:` link** where the platform allows it (encode `#` as `%23`),
   and always show it as text too.
3. **Keep polling `verify`, and do not time out early.** An Orange payment stays `PENDING` until the
   customer dials and enters their PIN, which took several minutes in the live test. Never say the
   payment failed because no answer has come yet.
4. **Never hard-code "Moon SARL" or `#150*50#`, and never branch on the aggregator.** Read them from
   the response. Another aggregator returns different values, or none.

`instructions.redirectUrl` and `instructions.requiresOtp` still apply exactly as before.

## 3. Orange needs no payment code

`GET /api/payments/options` now answers the same flow for both operators:

```jsonc
{ "provider": "MTN",    "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false, "limits": { "min": 301, "max": 500000 } },
{ "provider": "ORANGE", "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false, "limits": { "min": 301, "max": 500000 } }
```

- **Not built yet:** skip it.
- **Already shipped:** it hides itself, because it only appears on a `CODE_FIRST` entry and none
  exists now. Nothing needs removing urgently.
- **A build that still sends `channel.paymentCode`:** the code is ignored.

## 4. The minimum is 301 XAF, not 200

NovaSend's documentation says 200, and its live API refuses it. Payments are now accepted from
**301 to 500,000 XAF**; outside that, the answer is `422 PAYMENT_AMOUNT_OUT_OF_RANGE` as before, with
`details.min` and `details.max`, and nothing is charged. Read `limits` from `/options` rather than
hard-coding either number.
