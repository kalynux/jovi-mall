# Customer app — the order-detail asks, answered

Answers [`BACKEND-REQUIREMENTS-order-detail.md`](./BACKEND-REQUIREMENTS-order-detail.md),
raised 2026-08-23 from device testing.

- **Written:** 2026-08-23 · **Shipped:** same day
- **Contracts changed:** [orders.md](./orders.md) · [payments/README.md](../payments/README.md)
- **New design record:** [`docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md`](../../docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md)

---

## The change list

| # | Your ask | Verdict | Your work |
|---|---|---|---|
| 1 | Retry payment on an unpaid order | **You were right — nothing was built.** But the ⚠ you flagged was a real bug and is fixed | One branch, and it is not the one you expected — see § 1 |
| 2 | Agency logo beside the name | **Built**, additive | Small. Note the field is `logo`, not `logoUrl` |
| 3 | Assigned agent's name and photo | **Approved and built** — the decision was taken, not assumed | Medium — read § 3, the visibility window is not what you sketched |
| 4 | Null address `location` breaks customer writes | **Reproduced, and worse than reported.** Fixed | None |

**Nothing you already call was renamed, removed or re-shaped.** `agencyName` stays exactly
where it is.

---

## 1 · Retry payment — you were right, and the ⚠ was real

No "retry" endpoint was built. `POST /api/payments/initiate` already handles it, your reading
of `payment-orchestrator.service.ts` is accurate, and both of your notes back are correct and
now written into the contract:

- Paying by **`cartId`** is the right call for a checkout group, and `orderId` stays as the
  single-order form.
- **Nothing on the gateway path writes `failed` to the order.** Confirmed, and now guarded by a
  comment at the one place that was closest to doing it. Only `cancelOrder` writes `failed`.

### The ⚠ — "AWAITING_PAYMENT but no prompt ever reached the handset"

Reproduced as a code path, and it is a backend defect rather than a credentials problem
(though see below, because it is probably both).

**What was happening.** When the gateway *refuses* the charge, the adapter returns
`success: false` — and the orchestrator advanced the order to `AWAITING_PAYMENT` anyway. So
the order stated as fact that a gateway was waiting for a payment when no gateway was waiting
for anything. Nothing was ever going to arrive, and nothing was ever going to time it out.

**Fixed:** the order now stays at `pending` when the gateway refuses.

🟢 **This does not affect your retry flow.** `pending` is equally payable — both the `cartId`
and `orderId` forms accept `pending` and `AWAITING_PAYMENT` — so `PayGroupSheet` needs no
change. It just stops an order claiming a payment is in flight when none is.

### The one branch you may want

**Branch on `data.status`, not on the HTTP code.** A refused charge is a `200` carrying
`status: "FAILED"` and the provider's own reason in `message`. Only a transport failure (the
provider unreachable) is a `502`. If your sheet only checks the HTTP status, a refusal renders
as "waiting for your payment", forever — which is exactly the screen you described.

```ts
const res = await initiate({ cartId, gateway, channel });
if (res.data.status === 'FAILED') showError(res.data.message);   // the gateway said no
else showPrompt(res.data.instructions);
```

### And the credentials half — please check this at your end

Your keys are **sandbox** (`NOTCHPAY_PUBLIC_KEY=pk_test…`, `NOTCHPAY_PRIVATE_KEY=sk_test…`).
NotchPay's sandbox accepts the charge and answers `action: "confirm"` with no USSD code — the
real network is what pushes a prompt to a handset, and sandbox does not reach it. So a
*successful* sandbox initiation legitimately produces no prompt, and that is very likely what
you saw rather than an error at all.

Two things make this diagnosable next time, and neither existed for the run you reported:

- `payment_transactions.rawGatewayPayloads` holds the provider's verbatim response for every
  attempt (`type: 'initiate'` / `'error'`). That is the ground truth for "did they take it".
- `npm run audit:stuck-payments` lists payments that never closed.

I could not read your run: `payment_transactions` on this machine's dev database is **empty**,
so whatever you tested against has since been reset. If it recurs, grab the `transactionId`
from the response and I can read the payload back.

---

## 2 · The agency block — built, with one deviation

`GET /api/customer/orders/:orderId/shipments` now carries an `agency` block per shipment.

```jsonc
{
  "agencyName": "Douala Express",          // unchanged, still here, not going away
  "agency": {
    "id": "…",
    "name": "Douala Express",
    "logo": { "id": "…", "key": "…", "url": "https://…", "access": "public",
              "mimeType": "image/png", "size": 24118, "originalName": "logo.png" } | null,
    "supportPhone":    "+2376…" | null,
    "supportEmail":    "…"      | null,
    "supportWhatsapp": "+2376…" | null
  } | null
}
```

🟡 **`logo` is a `FileDetail`, not `logoUrl: string`.** This is the one place the shipped shape
differs from your spec, and it is deliberate: every referenced file on this API returns
`{ id, key, url, access, mimeType, size, originalName } | null` and never a bare URL string —
the same convention as vendor logos, product images and avatars, which your storefront already
consumes. Read `agency.logo?.url ?? null` and you have what you asked for; `null` is a real and
common answer, and initials from `name` are the right fallback exactly as you planned.

🟢 **Support contacts are included and are yours to show.** You asked for `phone` "only if an
agency-level support number already exists" — it does, on the agency's Magazin, and it is a
business line the agency published deliberately. All three are surfaced. This is confirmed
policy: **a customer may see the delivery agency's support contacts on an order that agency is
handling.**

🔴 **Still never the agent's number.** See § 3.

`agency` is `null` on the same condition `agencyName` is: the agency has no Magazin on file.
The two never disagree, because `agencyName` is now read off the same block.

---

## 3 · The agent block — approved, and the window is not where you drew it

**The decision was taken rather than assumed.** You were right to refuse to build on the
strength of the request, and right about what it costs. It is now
[ADR-A06](../../docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md), and it is close to the shape you
sketched:

```jsonc
"agent": {
  "displayName": "Jean T.",      // partial: first name + surname initial. Never the full name
  "photo": FileDetail | null,    // ← `photo`, not `photoUrl` — same convention as § 2
  "visibleFrom": "shipped"       // ← NOT "out_for_delivery". Read this bit
} | null
```

### 🔴 `visibleFrom` is `"shipped"`, and that is not a typo

You wrote `visibleFrom: "out_for_delivery"`, meaning the everyday sense: the parcel is out and
on its way. **In this API those are different things.**

`out_for_delivery` maps from the internal `agent_delivered` — the agent has *already reported
the handover*. Opening the window there would have shown your user who came to their door
**after** they came, which defeats the entire safety argument the ask was built on. So the
window opens one step earlier, at `shipped`.

`visibleFrom` is echoed on the wire so you can render "you'll see your courier once your parcel
is picked up" without hardcoding the policy.

### When `agent` is null — and the nulls are not interchangeable

| Customer status | `agent` | What your screen should say |
|---|---|---|
| `preparing` | `null` | No courier assigned yet. Do **not** show an empty card |
| `shipped` | **set** | "Your parcel is with …" |
| `out_for_delivery` | **set** | Handover reported, awaiting confirmation |
| `delivery_failed`, from `failed` | **set** | Same courier, still holding it, coming back |
| `delivery_failed`, from `returned` | `null` | Over |
| `delivered` | `null` | **Revoked.** Do not cache it into order history |

⚠ Note rows 4 and 5: `delivery_failed` gives you `agent` sometimes and not others, because it
collapses two internal states that are opposite answers here (a retryable attempt vs. a
returned parcel). Render from the field, never from the status.

⚠ **`delivered` returning `null` is the point of the design, not an oversight.** The
disclosure is scoped to a live delivery. If you cache the agent block into a local order
record, please expire it — re-showing a courier's face on a six-month-old order is the thing
this ADR was careful not to do.

### 🔴 There is no phone number and there will not be one

A customer with a question contacts the **agency** — `agency.supportPhone` from § 2, a
business line its owner chose to publish. Not an individual worker's handset. Please do not
render a "call your courier" affordance.

### What this obliges at your end

Both of the items you flagged are now live obligations, not hypotheticals:

- The **privacy policy** must say that a delivery agent's given name and photograph are shown
  to the recipient during an active delivery.
- The **Play data-safety declaration** must reflect it.

No backend change can close either. They were already open items for the app release; this
adds a line to each.

---

## 4 · The null-`location` bug — reproduced, and it is bigger than payment methods

You were right that it is not specific to payment methods, and right about which of your two
fixes to prefer. Both were measured against MongoDB.

### What is actually broken

| Scenario | Result |
|---|---|
| Every saved address has `location: null` | ✅ fine — sparse skips the document |
| One address has a point, another has `location: null` | 🔴 **refused** — `Can't extract geo keys` |
| One address has a point, another **omits the key** | ✅ fine |
| Building the index over a document in state 2 | 🔴 **the index build itself fails** |

The live symptom is worse than "saving a payment method fails". Because the *offending write is
the one that fails*, a document cannot quietly become broken — which means what actually
happened is:

> **A customer who already had one geocoded address could not add a second address at all.**

That is the customer's own address book, and the error dump in your report is the post-image
MongoDB refused: `Domicile` (geocoded) plus the `Work` entry being pushed. The push is what
failed. The customer id in your log (`7e57…b1`) is the `seed:customer` account, which ships
with a geocoded `Domicile` — so every address added on top of it failed.

### 🔴 Your fix #1 does not work, and it is worth knowing why

`sparse` was **already** on both indexes, and a `partialFilterExpression` was measured too.
Neither helps: both select **documents**, and this document legitimately holds a point, so it
is selected — and then fails on the null sibling regardless. Please don't spend an afternoon
on it if this comes up again elsewhere.

### The fix — your #2

The `location` key is now **omitted** rather than stored as `null`, on every write path, in all
three models that have this shape (`customers.saved_addresses`, `vendors.business_addresses`,
`agency_magazins.headquarters_addresses` — the last two had the same latent bug and would have
stranded an agency mixing a geocoded depot with a legacy one).

Also fixed: editing an address to clear `location` is now an `$unset`, not a `$set: null`.

**No migration was needed**, and that is a property rather than a shortcut: after this change
no application path writes `location` at all, so a document already holding all-nulls can never
be joined by a point, and all-nulls index fine. The 7 dev customers in that state are safe.

**Nothing you send changes.** The wire contract still accepts `location: null` — "I have no
coordinate" remains a thing you may say. It just stops being something the database is asked to
store. `geo` was never affected (its `coordinates` is required, so the null sits one level above
the indexed leaf).

### Your reproduction, corrected

"Save an address that fails geocoding, then attempt any customer write" — the second step is
not needed. On an account whose first address is geocoded, **the failing-geocode save is itself
the failure**. Worth knowing when you verify the fix: add a second address to the
`seed:customer` account with no geo, and it should now succeed.
