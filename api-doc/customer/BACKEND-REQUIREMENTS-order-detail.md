# Order detail — what the storefront needs

Raised 2026-08-23, from device testing of the customer app.

> ## ✅ ANSWERED 2026-08-23 — read [FRONTEND-CHANGELOG-order-detail.md](./FRONTEND-CHANGELOG-order-detail.md)
>
> This page is kept as the request. **The answers, and three corrections to it, are in the
> changelog.** In short:
>
> | # | Outcome |
> |---|---|
> | 1 · Retry payment | Correct — nothing built. But the ⚠ was a **real backend bug** and is fixed: a refused gateway charge no longer marks the order `AWAITING_PAYMENT`. Your retry path is unaffected |
> | 2 · Agency identity | **Built**, plus support contacts. ⚠ The field is `logo` (a `FileDetail`), not `logoUrl` |
> | 3 · Agent identity | **Approved and built** — the decision was taken, not assumed: [ADR-A06](../../docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md). ⚠ `visibleFrom` is `"shipped"`, **not** `"out_for_delivery"` — § 3 of the changelog explains why those are different things here |
> | 4 · Null `location` | **Reproduced and fixed**, and it was worse than reported. ⚠ Your suggested fix #1 (sparse/partial) was measured and **does not work** |
>
> Two obligations came back to you with item 3: the privacy policy and the Play data-safety
> declaration. No backend change can close either.

Three asks. **One of them needs no backend work at all**, one is a small additive
change, and one reverses a decision this codebase made on purpose and should not be
built until somebody says so out loud. They are separated below so the cheap work is
not held up by the argument.

---

## 1. Retry payment on an unpaid order — **already possible, do nothing**

**Status: no backend change required.** Recorded here because the request came in as
"the backend does not support this", and it does.

The gap is real on the screen: an order sitting at `AWAITING_PAYMENT` offers the
shopper no way to pay. But `POST /api/payments/initiate` already handles it, and takes
`orderId` as an alternative to `cartId`:

```jsonc
POST /api/payments/initiate
{
  "orderId": "6a8a…",                       // instead of cartId
  "gateway": "NOTCHPAY" | "MYCOOLPAY" | "STRIPE",
  "channel": { "phoneNumber": "+2376…", "phoneOperator": "MTN" }
}
```

`payment-orchestrator.service.ts` already guards every case the screen needs:

| Situation | Behaviour |
|---|---|
| Order not found | 404 `PAYMENT_ORDER_NOT_FOUND` |
| Order is cash on delivery | 422 `PAYMENT_ORDER_IS_COD` |
| Already paid | 409 `PAYMENT_ORDER_ALREADY_PAID` |
| Any status other than `AWAITING_PAYMENT` / `pending` | 400 `PAYMENT_INVALID_ORDER_STATUS` |
| Existing txn `SUCCEEDED` | returns it, "Payment already completed" |
| Existing txn `INITIATED` / `PENDING` | returns it **with its `instructions`**, so the shopper can finish the prompt already sent |
| Existing txn `FAILED` / `CANCELLED` | **falls through and creates a new transaction** — this is the retry |

That last row is the one that matters: a failed attempt does not poison the order.

**So this is storefront work, and the storefront has now done it** (2026-08-23,
`components/shop/account/PayGroupSheet.tsx`). Flagged to the backend only so nobody builds
a second "retry" endpoint beside a working one.

Two notes back, from building against it:

- The storefront pays with **`cartId`, not `orderId`**, even though this document led with
  `orderId`. A checkout group is charged once and the shopper is told so, and
  `initiatePaymentForCart` already filters to the still-payable orders — so a group
  containing one cancelled order needs no per-order call to avoid re-charging it. The
  `orderId` form stays unused by the customer app.
- Confirmed while checking that a retry is even reachable: **nothing on the gateway path
  writes `failed` to the order**. Only `cancelOrder` does (`order.service.ts:201`). That is
  what makes a declined payment retryable, and it also means a cancelled order drops out of
  `payable` on its own. Both are load-bearing for the screen — please don't "fix" a failed
  payment into `payment_status: 'failed'` without saying so, as it would silently make
  every declined order unpayable.

⚠ One thing the backend SHOULD confirm: on 2026-08-23 a live MTN Mobile Money
initiation returned a created order in `AWAITING_PAYMENT` but **no prompt ever reached
the handset**. The order is correct; the gateway leg is not. Worth checking the
NotchPay/MyCoolPay sandbox credentials and whether the provider call is erroring
silently — the storefront cannot see that failure.

---

## 2. Delivery agency identity on the order — **small additive change**

`GET /api/customer/orders/:orderId/shipments` already returns the agency's **name**:

```ts
interface CustomerShipment {
  agencyName: string | null;   // "The delivery company's business name. Never the agent's."
  …
}
```

so the name can be shown today. What is missing is anything to draw beside it.

**Requested — additive, per shipment:**

```jsonc
{
  "agencyName": "Douala Express",
  "agency": {
    "id": "…",
    "name": "Douala Express",
    "logoUrl": "https://…/api/files/…",   // null when the agency has not uploaded one
    "phone": "+2376…"                      // OPTIONAL — see below
  }
}
```

- `logoUrl` is the actual ask. A name alone on a tracking screen reads as unfinished.
- Keep `agencyName` where it is. It is already consumed; do not move it.
- `null` must be a real answer for `logoUrl` — most agencies will have no logo, and the
  storefront draws initials in that case, exactly as it does for vendors.
- `phone` only if an agency-level support number already exists. **Do not surface an
  agent's personal number here** — that is item 3.

---

## 3. Assigned agent's name and photo — **needs a decision, not an endpoint**

**Do not build this on the strength of this document.**

The customer app deliberately does not publish who the agent is, and it is written down
in two places rather than being an oversight:

> The agent's identity and the free-text internal note on a failed attempt are never
> published; only the fact of an attempt and its count.
> — `customer.types.ts`, and repeated in `customer-order.controller.ts`

The request is reasonable on its face — for a cash-on-delivery handoff the shopper is
about to meet this person, hand over money and read out a delivery code, and "who is
coming" is a safety question as much as a convenience one. Most delivery apps show a
courier's name and photo for that reason.

But it is a reversal, and it has consequences the storefront cannot weigh alone:

1. **It exposes a worker's name and face to every customer they deliver to**, including
   after a dispute. Agents are individuals, not a company brand.
2. It is a data-protection change, so it belongs in the privacy policy and the Play
   data-safety declaration — both of which are open items for the app release.
3. The status vocabulary is deliberately collapsed to five customer-facing words to keep
   internal dispatch machinery private. Agent identity is part of that same boundary.

**What is needed before any code:** an explicit decision from whoever owns ADR-A02 and
the privacy policy, recorded as an ADR, on whether agent identity becomes customer-visible
and under what conditions — e.g. only once `out_for_delivery`, only for COD, name and
photo but never a phone number, and revoked once the parcel is delivered.

If that decision is yes, the shape the storefront would consume is:

```jsonc
{
  "agent": {
    "displayName": "Jean P.",       // partial by default — full name is a separate call
    "photoUrl": "https://…" | null,
    "visibleFrom": "out_for_delivery"
  } | null                            // null before assignment, and after delivery
}
```

---

## Contact

Raised from `frontend/landing` during Phase 4 device testing — see
`MOBILE-APP-PLAN.md` at "C:\Users\Fante\Desktop\projects\wi-mall\frontend\landing\MOBILE-APP-PLAN.md". Items 1 and 2 unblock the order detail screen; item 3 is
deliberately parked.

---

## 4. BUG — a null address `location` breaks writes to the customer document

Found in the backend log during the same session, 12 occurrences, all on
`/api/payment-methods`:

```
Plan executor error during findAndModify :: caused by ::
Can't extract geo keys: { _id: ObjectId('7e57…b1'), … saved_addresses: [
  { label: "Domicile", …, location: { type: "Point", coordinates: [9.742, 4.0919] } },
  { label: "Work",     …, location: null }        <-- this one
] }
```

The customer has two saved addresses. One was geocoded and has a `location`; the
other has `location: null`. A 2dsphere index over `saved_addresses.location` cannot
index the null, so **the whole `findAndModify` fails** — and it is the *customer
document* being written, not the address.

That means any write touching this customer fails while that address exists. It
happened to surface on saving a payment method; it is not specific to payment methods.

`location: null` is a legitimate state — `customer.types.ts` documents that geocoding
may fail and the address is still saved. So the data is not malformed; the index does
not tolerate what the schema allows.

**Suggested fix, in order of preference:**

1. Make the 2dsphere index **sparse** / partial so documents with a null `location`
   are simply not indexed. This matches the existing intent — an ungeocoded address
   should not be geo-searchable, but it must not block writes.
2. Or omit the `location` key entirely rather than storing `null` (2dsphere ignores a
   missing field but rejects an explicit null), and migrate existing rows.

Reproduce: save an address that fails geocoding, then attempt any customer write.
