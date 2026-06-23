# Vendor Frontend — Stripe Card Payments

Stripe card payments are now **live** (previously a stub that returned mock data).
This doc describes the **frontend changes** required to support Stripe alongside
the existing mobile-money gateways. It complements [billing.md](./billing.md),
which documents the endpoints themselves.

Stripe is offered on the two vendor self-serve payment flows:

| Flow | Endpoint (initiate) | Endpoint (verify) |
|---|---|---|
| Buy / upgrade a plan | `POST /api/vendor/plans/:planId/purchase` | `POST /api/vendor/plan-purchases/:id/verify` |
| Buy a credit top-up | `POST /api/vendor/credits/topups` | `POST /api/vendor/credits/topups/:id/verify` |

Both already accept `gateway: "STRIPE"`. The request/response **envelope is
unchanged** — what changes is how the frontend must *act on* the Stripe response.

---

## TL;DR — two things you must change

1. **Stripe charges in USD, the catalog is in XAF.** Plan/pack prices stay in
   **XAF** (e.g. `price: 5000, currency: "XAF"`), but the actual Stripe charge is
   converted to **USD** at a fixed server-side rate. The response now tells you the
   exact dollar amount — **display that** for the Stripe path. Never compute the
   conversion on the frontend.
2. **Card collection uses Stripe.js + `clientSecret`, not a `cardToken`.** The old
   docs mentioned `channel.cardToken` — that field is **no longer used** and must
   not be sent. You collect the card with Stripe's Payment Element and confirm with
   the `clientSecret` returned by the initiate call.

---

## 1. What the initiate response now contains for Stripe

`POST /api/vendor/plans/:planId/purchase` (or `/credits/topups`) with
`gateway: "STRIPE"` returns gateway-specific `instructions`:

```jsonc
{
  "success": true,
  "data": {
    "purchase": {
      "_id": "66cc01", "plan_code": "growth",
      "price": 5000, "currency": "XAF",        // catalog price — stays XAF
      "status": "pending", "gateway": "STRIPE",
      "gateway_ref": "pi_3Qabcdef...",          // Stripe PaymentIntent id
      "vendor_plan_id": null,
      "created_at": "…", "updated_at": "…"
    },
    "instructions": {
      "clientSecret": "pi_3Qabcdef..._secret_xxx", // confirm the card with this
      "chargedAmount": 8.33,                        // amount actually charged
      "chargedCurrency": "usd",                     // …in this currency
      "message": "Complete payment of 8.33 USD with card"
    }
  },
  "message": "Plan purchase initiated"
}
```

New fields on `instructions` (Stripe only):

| Field | Meaning | UI use |
|---|---|---|
| `clientSecret` | PaymentIntent client secret | Pass to Stripe.js to mount the Payment Element & confirm |
| `chargedAmount` | The exact amount the card will be charged | Show "You'll be charged **$8.33 USD**" |
| `chargedCurrency` | Presentment currency (always `usd` today) | Currency label / formatting |

> Mobile-money gateways (`NOTCHPAY`, `MYCOOLPAY`) are unchanged — they still return
> `{ ussdCode?, message?, expiresAt? }` and charge the native XAF amount.

---

## 2. Request body changes for the Stripe path

Send **only** identification fields in `channel` — no phone fields, no `cardToken`:

```jsonc
// gateway: "STRIPE"
{
  "gateway": "STRIPE",
  "channel": {
    "customerEmail": "vendor@example.com",  // optional — used for the Stripe receipt
    "customerName": "Jane's Store"          // optional
  }
}
```

| `channel` field | NOTCHPAY / MYCOOLPAY | STRIPE |
|---|---|---|
| `phoneNumber`, `phoneOperator` | **required** | omit |
| `cardToken` | n/a | **do NOT send** (deprecated/ignored) |
| `customerEmail`, `customerName` | optional | optional (email → receipt) |

---

## 3. Frontend flow (Stripe Payment Element)

You need the **publishable key** (`pk_…`) on the frontend — expose it via your app
config/env (e.g. `VITE_STRIPE_PUBLISHABLE_KEY`). It pairs with the backend's
`STRIPE_PUBLISHABLE_KEY`. Never put the secret key (`sk_…`) on the frontend.

```
1. User picks a plan/pack and selects "Card (Stripe)".
2. Frontend → POST /vendor/plans/:planId/purchase  { gateway:"STRIPE", channel:{…} }
3. Backend → { purchase(status:pending), instructions:{ clientSecret, chargedAmount, chargedCurrency } }
4. Frontend shows "You'll be charged $<chargedAmount> USD"
   and mounts Stripe Payment Element with clientSecret.
5. User enters card → frontend calls stripe.confirmPayment({ clientSecret, … })
   (Stripe handles 3-D Secure / redirects via return_url).
6. On confirmation, two things finalize the purchase server-side:
     • the Stripe WEBHOOK (authoritative, automatic), AND
     • your POST …/verify call (idempotent — good for immediate UX).
7. Poll …/verify until status is "paid" (applied) or "failed" (retry).
```

### Example (React, `@stripe/react-stripe-js`)

```tsx
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

// 1) Initiate on the server, get clientSecret
const { data } = await api.post(`/vendor/plans/${planId}/purchase`, {
  gateway: 'STRIPE',
  channel: { customerEmail, customerName },
});
const { clientSecret, chargedAmount, chargedCurrency } = data.data.instructions;
const purchaseId = data.data.purchase._id;

// 2) Render the Payment Element
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

## 4. UI adjustments checklist

- [ ] **Gateway selector**: label Stripe as *Card (charged in USD)* and mobile money
      as *Mobile Money (XAF)*. Make the currency difference visible.
- [ ] **Conditional inputs**: when `STRIPE` is selected, hide the phone-number /
      operator inputs and render the Stripe Payment Element instead.
- [ ] **Remove `cardToken`**: delete any card-token collection / field for Stripe.
- [ ] **Show the dollar amount**: render `instructions.chargedAmount` +
      `chargedCurrency` (e.g. "You'll be charged **$8.33 USD**"). Optionally show
      "(5 000 XAF)" alongside for transparency.
- [ ] **Add a USD notice**: a short line like *"Card payments are processed in USD;
      your bank may apply its own conversion."*
- [ ] **3-D Secure / redirects**: pass a `return_url` to `confirmPayment`; handle the
      return route by resuming the verify poll for that purchase/top-up id.
- [ ] **Declines**: a declined card surfaces as a failed initiation/verify
      (`PAYMENT_CARD_DECLINED` / `PAYMENT_INITIATION_FAILED`) — show the message and a
      retry. See [../errors/README.md](../errors/README.md).
- [ ] **Tiny amounts**: Stripe enforces a ~**$0.50** minimum charge. A very cheap
      pack may convert below that and fail on Stripe — steer such purchases to mobile
      money, or disable Stripe for them.
- [ ] **Publishable key**: load `pk_…` from config; keep `sk_…` server-side only.

---

## 5. What does NOT change

- Endpoint paths, auth, the `success`/`data`/`meta` envelope, and the
  `pending → paid/failed` status model are all the same as in [billing.md](./billing.md).
- Catalog/price/history fields stay in **XAF**. Only the live Stripe *charge* is in USD.
- Mobile-money flows (USSD instructions, polling) are untouched.
- The verify-and-poll pattern is the same; it just tends to resolve faster now
  because the webhook finalizes server-side almost immediately after confirmation.
