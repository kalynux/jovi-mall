# Vendor Frontend — Card payments (`provider: "CARD"`)

**Verified against source on 2026-09-30, at jovi-mall `39254e2`** — the billing request schemas
(`billing/validators/billing.validators.ts`), `provider` on the billing result and rows
(`test:billing-routing`, including "CARD with Stripe off → 422"), the CARD-without-key drop in
`payments/services/payment-options.service.ts`, the `sk_`/`rk_` guard in `payments/domain/pay-link.ts`,
and `gateway: "STRIPE"` → `CARD` in `deriveProvider`.

**Rewritten 2026-09-30 for provider routing.** The previous version of this page told the dashboard
to send `gateway: "STRIPE"` and to load the publishable key from `VITE_STRIPE_PUBLISHABLE_KEY`.
Both are replaced: a card is **`provider: "CARD"`**, offered only when
[`GET /api/payments/options`](../payments/README.md#get-paymentsoptions--what-the-customer-can-pay-with) lists it, and the
publishable key comes **from that answer**. Contract: [../payments/routing.md](../payments/routing.md).
All roles' changes: [../FRONTEND-CHANGELOG-payment-providers.md](../FRONTEND-CHANGELOG-payment-providers.md).

> ### ⛔ Cards are OFF today
>
> The owner's rule is mobile money only. `/options` lists no `CARD` entry, and a `CARD` charge
> answers `422 PAYMENT_PROVIDER_UNAVAILABLE`. Build the card path anyway, driven by `/options`:
> when an administrator turns cards on, it must appear **with no dashboard release**. Never show
> a card choice that `/options` did not list.

This page complements [billing.md](./billing.md), which documents the endpoints. The same body and
the same answers hold for agencies and agents under `/api/agency` and `/api/agent`
([../agency/billing.md](../agency/billing.md), [../agent/billing.md](../agent/billing.md)).

| Flow | Endpoint (initiate) | Endpoint (verify) |
|---|---|---|
| Buy / upgrade a plan | `POST /api/vendor/plans/:planId/purchase` | `POST /api/vendor/plan-purchases/:id/verify` |
| Buy a credit top-up | `POST /api/vendor/credits/topups` | `POST /api/vendor/credits/topups/:id/verify` |

---

## TL;DR — what a card payment needs

1. **Offer it only from `/options`.** A `CARD` entry reads
   `{ "provider": "CARD", "kind": "CARD", "flow": "CARD_ELEMENT", "fields": [], "mayRequireOtp": false, "publishableKey": "pk_live_…" }`.
   No entry, no card button.
2. **Load Stripe.js with that entry's `publishableKey`**, not with a key baked into the build.
   The key belongs to whichever Stripe account the server is configured with; a build-time key
   can go stale without anyone noticing.
3. **Send `provider: "CARD"`**, never `gateway`. `channel` needs nothing for a card
   (`customerEmail` / `customerName` are optional). Do not send `cardToken`.
4. **A card is charged in USD, the catalogue is in XAF.** Show the returned `chargedAmount` /
   `chargedCurrency`; never compute the conversion yourself.
5. **Confirm with the returned `clientSecret`** using Stripe's Payment Element, then poll
   `/verify`.

---

## 1. `/options` decides whether a card is offered

```jsonc
// GET /api/payments/options — with cards ON and routed to Stripe (not today's answer)
{
  "success": true,
  "data": {
    "providers": [
      { "provider": "MTN",    "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false },
      { "provider": "ORANGE", "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false },
      { "provider": "CARD",   "kind": "CARD", "flow": "CARD_ELEMENT", "fields": [], "mayRequireOtp": false,
        "publishableKey": "pk_live_…" }
    ]
  }
}
```

- Standard `{ success, data }` envelope. No auth. `Cache-Control: no-store`: fetch it when the
  payment dialog opens, not once per app session.
- `publishableKey` appears **only** on a `CARD_ELEMENT` entry, and is never a secret (`sk_` /
  `rk_` keys are refused server-side and never published).
- `flow` is a hint for which screen to prepare. The initiate response's `instructions` are the
  truth: if a `CARD` charge ever answers `redirectUrl` instead of `clientSecret` (reserved for a
  future card aggregator), open the URL.

---

## 2. The request

```jsonc
// POST /api/vendor/plans/:planId/purchase   (or /credits/topups with "packCode")
{
  "provider": "CARD",
  "channel": {
    "customerEmail": "vendor@example.com",  // optional — used for the card receipt
    "customerName": "Jane's Store"          // optional
  }
}
```

| `channel` field | `MTN` / `ORANGE` | `CARD` |
|---|---|---|
| `phoneNumber` | **required**, on the chosen network | omit (not read) |
| `phoneOperator` | legacy, omit (the provider is the operator) | omit |
| `cardToken` | n/a | **do NOT send** (ignored) |
| `customerEmail`, `customerName` | optional | optional (email → receipt) |

`gateway` is **deprecated, accepted and ignored**. An old build that still sends
`gateway: "STRIPE"` and no `provider` is read as `provider: "CARD"`: while cards are off it gets
`422 PAYMENT_PROVIDER_UNAVAILABLE`, and it is **never** turned into a mobile-money push.

---

## 3. What the initiate response contains

```jsonc
{
  "success": true,
  "data": {
    "purchase": {
      "_id": "66cc01", "plan_code": "growth",
      "price": 5000, "currency": "XAF",        // catalogue price — stays XAF
      "status": "pending",
      "provider": "CARD",                      // what the vendor paid with
      "gateway": "STRIPE",                     // informational only — never branch on it
      "gateway_ref": "pi_3Qabcdef...",
      "subscriber_plan_id": null,
      "created_at": "…", "updated_at": "…"
    },
    "instructions": {
      "clientSecret": "pi_3Qabcdef..._secret_xxx", // confirm the card with this
      "chargedAmount": 8.33,                        // amount actually charged
      "chargedCurrency": "usd",                     // …in this currency
      "message": "Complete payment of 8.33 USD with card"
    },
    "provider": "CARD"                         // the provider charged, as on every charging door
  },
  "message": "Plan purchase initiated"
}
```

| `instructions` field | Meaning | UI use |
|---|---|---|
| `clientSecret` | PaymentIntent client secret | Pass to Stripe.js to mount the Payment Element and confirm |
| `chargedAmount` | The exact amount the card will be charged | Show "You'll be charged **$8.33 USD**" |
| `chargedCurrency` | Presentment currency (`usd` today) | Currency label / formatting |

Mobile-money providers still return `{ ussdCode?, requiresOtp?, message?, expiresAt? }` and charge
the native XAF amount. Branch on which fields are present, never on `gateway`.

---

## 4. Frontend flow (Stripe Payment Element)

```
1. Dialog opens → GET /api/payments/options. Render one choice per providers[] entry.
   No CARD entry → no card choice (today's state).
2. User picks a plan/pack and "Card".
3. Frontend → POST /vendor/plans/:planId/purchase  { provider:"CARD", channel:{…} }
4. Backend → { purchase(status:pending), instructions:{ clientSecret, chargedAmount, chargedCurrency } }
5. Frontend shows "You'll be charged $<chargedAmount> USD"
   and mounts the Payment Element: loadStripe(<CARD entry>.publishableKey) + clientSecret.
6. User enters card → stripe.confirmPayment({ clientSecret, … })
   (Stripe handles 3-D Secure / redirects via return_url).
7. On confirmation, two things finalize the purchase server-side:
     • the Stripe WEBHOOK (authoritative, automatic), AND
     • your POST …/verify call (idempotent — good for immediate UX).
8. Poll …/verify until status is "paid" (applied) or "failed" (retry).
```

### Example (React, `@stripe/react-stripe-js`)

```tsx
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

// 1) What can be paid with — standard envelope
const { data: opts } = await api.get('/payments/options');
const card = opts.data.providers.find((p) => p.provider === 'CARD');
if (!card) { /* no card choice: cards are off or unroutable right now */ }

// Load Stripe.js with the SERVER's key (cache the promise per key, not per render)
const stripePromise = loadStripe(card.publishableKey);

// 2) Initiate on the server, get clientSecret
const { data } = await api.post(`/vendor/plans/${planId}/purchase`, {
  provider: 'CARD',
  channel: { customerEmail, customerName },
});
const { clientSecret, chargedAmount, chargedCurrency } = data.data.instructions;
const purchaseId = data.data.purchase._id;

// 3) Render the Payment Element
<Elements stripe={stripePromise} options={{ clientSecret }}>
  <p>You'll be charged {chargedAmount} {chargedCurrency.toUpperCase()}</p>
  <CheckoutForm purchaseId={purchaseId} />
</Elements>;

function CheckoutForm({ purchaseId }) {
  const stripe = useStripe();
  const elements = useElements();

  async function pay() {
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/billing/plan-purchase/${purchaseId}` },
      redirect: 'if_required', // stay in-page when no 3DS redirect is needed
    });
    if (error) { /* show error.message */ return; }

    // Confirmed → finalize + poll
    await pollVerify(purchaseId);
  }
  // …
}

async function pollVerify(purchaseId) {
  for (let i = 0; i < 40; i++) {
    const { data } = await api.post(`/vendor/plan-purchases/${purchaseId}/verify`);
    const status = data.data.purchase.status;
    if (status === 'paid')   return 'paid';   // refresh GET /vendor/plan
    if (status === 'failed') return 'failed';  // show retry
    await new Promise(r => setTimeout(r, 3000));
  }
}
```

Credit top-ups are identical — swap the endpoints and read `data.data.topup.status`
from `POST /vendor/credits/topups/:id/verify`.

> **Why both webhook and verify?** The webhook (server→server) is the source of
> truth and will apply the plan / credit the wallet even if the browser closes. The
> `…/verify` poll just gives the user instant feedback. Both are idempotent, so
> there's no double-charge or double-apply.

---

## 5. UI adjustments checklist

- [ ] **Provider choice from `/options`**: one choice per `providers[]` entry. Label `CARD` as
      *Card (charged in USD)* and mobile money as *MTN Mobile Money* / *Orange Money (XAF)*.
      Remove any hard-coded "NotchPay / MyCoolPay / Stripe" gateway selector.
- [ ] **Empty list**: when `providers` is `[]`, show *"Online payment is unavailable right now"*
      instead of the pay button.
- [ ] **Conditional inputs**: for `CARD`, hide the phone-number input and render the Payment
      Element. For mobile money, ask for exactly the `fields` the entry lists.
- [ ] **Publishable key**: take it from the `CARD` entry's `publishableKey`. Delete
      `VITE_STRIPE_PUBLISHABLE_KEY` from the build config once this ships. Keep `sk_…` out of
      the frontend, as ever.
- [ ] **Remove `cardToken`** and **stop sending `gateway`**.
- [ ] **Show the dollar amount**: render `instructions.chargedAmount` + `chargedCurrency` (e.g.
      "You'll be charged **$8.33 USD**"). Optionally show "(5 000 XAF)" alongside.
- [ ] **Add a USD notice**: *"Card payments are processed in USD; your bank may apply its own
      conversion."*
- [ ] **3-D Secure / redirects**: pass a `return_url` to `confirmPayment`; handle the return route
      by resuming the verify poll for that purchase/top-up id.
- [ ] **Refusals before anything is written**: `422 PAYMENT_PROVIDER_UNAVAILABLE` (cards were
      switched off between `/options` and the click) → re-render from `details.offered`.
- [ ] **Declines**: a declined card surfaces as a failed initiation/verify
      (`PAYMENT_INITIATION_FAILED`) — show the message and a retry. See
      [../errors/README.md](../errors/README.md).
- [ ] **Tiny amounts**: Stripe enforces a ~**$0.50** minimum charge. A very cheap pack may convert
      below that and fail — steer such purchases to mobile money.

---

## 6. What does NOT change

- Endpoint paths, auth, the `success`/`data`/`meta` envelope, and the
  `pending → paid/failed` status model are all the same as in [billing.md](./billing.md).
- Catalogue/price/history fields stay in **XAF**. Only the live card *charge* is in USD.
- The verify-and-poll pattern is the same.

---

## 7. After the sale: disputes / chargebacks

A card payment can be **disputed** (chargeback) or refunded after it succeeds. The backend reacts
automatically, which introduces statuses the dashboard must render. These live in the per-area
docs:

- **Orders** — `payment_status: "disputed"` + a `dispute_hold` that **freezes** the order
  (status updates return `423`), and a `"returned"` fulfilment status on a lost dispute. See the
  "Payment disputes & order freeze" section in [orders.md](./orders.md).
- **Bookings** — `paymentStatus: "disputed"` → `refunded`/`cancelled`. See [bookings.md](./bookings.md).
- **Plan purchases / credit top-ups** — a `"reversed"` status, downgrade-to-free, and a possibly
  **negative** credit balance. See "Payment disputes / chargebacks" in [billing.md](./billing.md).

No new vendor endpoints — these are all driven by Stripe webhooks; the dashboard only needs to
display the new states.
