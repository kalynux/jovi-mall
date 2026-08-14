# Front-end changelog — bargainable pricing

**Audience:** whoever builds the **vendor dashboard** (product + variant editors).
**Status:** backend shipped. Nothing is behind a flag. Everything is **additive** — no
existing field changed type, moved, or disappeared.

This is the reply to your bargainable-pricing requirements. §1 answers each requirement
point-by-point, §2–§5 are what you need to build against. **If you read only one thing,
read §1.3 — the min input on your editor must write `price`, not `bargain.minPrice`.**

> Reference docs: [Vendor → Variants § Bargainable pricing](./vendor/variants.md#bargainable-pricing) ·
> [Vendor → Simple products](./vendor/simple-products.md) ·
> [Vendor → Products § vectorisation](./vendor/products.md) ·
> [Errors](./errors/README.md)

---

## 1. Your requirements, point by point

### 1.1 Met as specified

| # | You asked for | How it landed |
|---|---|---|
| 1 | Bargaining applies **only when explicitly configured** on a variant | A variant with no `bargain` object is not bargainable. There is no default, no inheritance from the product, no implicit range |
| 2 | An **optional** bargain range on each sellable variant | `bargain: { minPrice, maxPrice }` on the variant. Optional everywhere; omitting it is always valid |
| 4 | `maxPrice` = the **highest price allowed** for bargaining | Exactly that. Validated `>= minPrice`; equality allowed |
| 5 | No range ⇒ **not bargainable**; `minPrice` defaults to the actual price; `maxPrice` required | `maxPrice` is the only required key. `{ "maxPrice": 45000 }` is a complete configuration — `minPrice` fills in from the variant's price |
| 6 | The existing `price` field **unchanged**; bargain config is **additional** | `price` and `compareAtPrice` are untouched in name, type, meaning and position. `bargain` is a new sibling object |
| 7 | Support **simple, advanced, physical, digital** | All four. See §1.4 for the one type that is excluded |
| 8 | Configured on **variants**, not the parent product | The field lives on the variant. There is no product-level bargain setting |
| — | Bargain config **optional**; if configured, both prices valid | Enforced |
| — | `maxPrice >= minPrice` | Enforced |
| — | **Prevent inconsistent states** between price and `minPrice` | Enforced structurally — see §1.3. The two cannot diverge through any endpoint |
| — | **Same validation on creation and update** | One shared rule module drives every create and update path; there is no second copy that could drift |

### 1.2 No duplicate price field — how the invariant is held

You asked that `minPrice` always be the actual selling price, and that no duplicate
pricing structure appear. Both hold, and they hold *by construction* rather than by
convention:

- **`bargain.minPrice === price` is invariant.** The backend never persists a variant
  where they differ. There is no code path — create, update, simple editor, duplicate —
  that can produce one.
- **`price` remains the single source of truth.** Cart, checkout, orders, COD amounts and
  earnings were not touched by this change and still read `price` alone. `minPrice` is a
  restatement of it inside the window, present so the window is self-describing when it
  reaches the negotiating agent.

### 1.3 ⚠️ The one place we diverged — read this before building the editor

You wrote: *"Updating `minPrice` must also update the variant's actual price."*

**We implemented the sync in the other direction: `price` is the input, `minPrice` follows
it automatically.** Sending a `bargain.minPrice` that disagrees with the price is a `422`,
not a price change. This was confirmed as the intended behaviour during design; the
outcome you asked for — the two can never diverge — is fully delivered, but the write
you make is different.

**What this means for a two-input "bargain range" widget:**

```jsonc
// ❌ Your "min" input writing bargain.minPrice — 422 CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH
PATCH /api/vendor/products/:productId/variants/:variantId
{ "bargain": { "minPrice": 32000, "maxPrice": 45000 } }

// ✅ Your "min" input writes `price`; the backend re-points minPrice at it
{ "price": 32000, "bargain": { "maxPrice": 45000 } }

// ✅ Equally fine — send minPrice too, as long as it AGREES with price
{ "price": 32000, "bargain": { "minPrice": 32000, "maxPrice": 45000 } }
```

Practically: **bind your minimum-price input to `price`.** Then a user editing the minimum
of the bargain range and a user editing the plain price are doing the same thing, which is
what "minPrice is the actual selling price" means.

The compensating benefit is that you get the sync for free on the plain price editor too:

```jsonc
// A price edit on a bargainable variant — no bargain key needed
{ "price": 32000 }
// → 200. price = 32000 AND bargain.minPrice = 32000. maxPrice untouched.
```

So an existing price field elsewhere in your app that knows nothing about bargaining
cannot break the invariant. If you would rather also accept `minPrice` as a price-writing
input, say so — it is a small, contained change.

### 1.4 Two things we did that you did not ask for

**Service products are refused** (`400 CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED`). You listed
physical and digital; service is the third product type in this catalogue and it needed a
decision. A service variant's `price` is a base rate *per minute* that the booking engine
prorates and peak-surcharges, so a flat `[min, max]` window would not describe anything a
customer is actually charged. Hide the bargain control when `product.type === "service"`.
Clearing (`"bargain": null`) is still allowed on every type, so a stray window is never
unremovable.

**The vectorisation gate is a display gate, not a write gate.** See §2 — this is the only
part of the contract that is likely to surprise you.

### 1.5 Explicitly not built

This phase is **configuration and validation only**. There is no offer/counter-offer
endpoint, no way for a customer to submit a bargained price, and no path by which a
negotiated price reaches a cart or an order. The window is stored, validated, shown back to
you, and shipped to the AI index. Everything downstream of "a buyer proposes a number" is a
separate phase and will need its own decisions (cart price provenance, order snapshotting,
COD expected amounts, abuse limits).

---

## 2. ⚠️ `bargainable` is not the same as "has a bargain window"

You asked that a range be configurable **only when vectorisation is enabled**. That gate
exists, but it is enforced on **effect**, not on the write:

| | Behaviour |
|---|---|
| **Writing** a window | Allowed at any time, on any product, regardless of vectorisation. Always fully price-validated |
| **Effect** of a window | Live only while the parent product has `vectorisationEnabled: true` |
| Vectorisation turned **off** | The window is **kept**, marked inert. Nothing is deleted |

Reads therefore give you two fields that answer two different questions:

- **`bargain`** — what the vendor configured.
- **`bargainable`** — whether it is in effect right now. Always present, always a boolean.
  Equals `product.vectorisationEnabled && bargain != null`.

**Never infer "is this live?" from the presence of `bargain`.** Render off `bargainable`.

Why it was built this way: a brand-new product is never vectorisation-enabled (eligibility
requires the product to already be `active`), so a hard write-gate would make it impossible
to configure a bargain range while building a product — the vendor would have to publish,
enable vectorisation, then come back. Storing-but-inert lets the editor work in any order.

### Three behaviours that follow

1. **A newly created product returns `bargainable: false` even when you sent a window.**
   That is correct, not an error. Show it as "configured — starts applying when AI search
   is enabled for this product", not as a failure.

2. **`bargainable` can flip with no pricing edit.** If a product stops being *eligible* for
   vectorisation — demoted out of `active`, or its title / description / category emptied —
   the indexing pipeline resets `vectorisationEnabled` to `false` on its own. Re-read the
   flag rather than caching it across an edit session.

3. **`PATCH /api/vendor/products/:id` responds before the toggle is applied.** If you flip
   `vectorisationEnabled` through the general product update, the response body — and any
   variant read that races it — still reflects the **old** flag. Use the dedicated
   `PATCH /api/vendor/products/:id/vectorisation` when you need the flag and its effect in
   one round trip; that one awaits the toggle before responding.

Also inherited, not new: while `vectorisationStatus === "pending"`, **every** product and
variant write returns `409 CATALOG_PRODUCT_VECTORISATION_PENDING`. A UI that reveals the
bargain editor the moment vectorisation is switched on reveals it inside exactly that
window — handle the 409 (disable the form, poll
`GET /api/vendor/products/:id/vectorisation/status`).

---

## 3. The wire

### Reading

Every endpoint that already returned an enriched variant now returns two more keys:

```jsonc
{
  "id": "507f1f77bcf86cd799439015",
  "sku": "TSHIRT-RED-M",
  "price": 29.99,
  "compareAtPrice": 39.99,
  "bargain": { "minPrice": 29.99, "maxPrice": 45.00 },  // absent when unconfigured
  "bargainable": true,                                   // ALWAYS present
  "stock": 100
  // …every existing field unchanged
}
```

`bargain` is **absent** (not `null`) when no window is configured — test with
`'bargain' in variant` or a truthiness check, not `!== null`.

| Endpoint | Where to find it |
|---|---|
| `GET /api/vendor/products/:id/variants` | `data[].bargain` / `data[].bargainable` |
| `GET /api/vendor/products/:productId/variants/:variantId` | `data.bargain` / `data.bargainable` |
| `POST /api/vendor/products/:id/variants` | `data.…` (the create response) |
| `PATCH /api/vendor/products/:productId/variants/:variantId` | `data.…` |
| `PATCH …/variants/:variantId/status` | `data.…` — **see the note below** |
| `POST /api/vendor/products/simple` · `PATCH /api/vendor/products/:id/simple` · the simple detail read | `data.defaultVariant.bargain` / `.bargainable` |
| `GET /api/vendor/products/:id` | **Not present** — this endpoint does not embed variants and did not change |

> **Small shape upgrade on the status toggle.** `PATCH …/variants/:variantId/status`
> previously returned the bare stored variant. It now returns the **full enriched variant**,
> like every sibling endpoint — so it gains `files`, `displayName`, `digital`, `bargain` and
> `bargainable`. It is a strict superset; no field was removed. We changed it because
> returning `bargain` without `bargainable` would let a client read a window and wrongly
> assume it was live.

### Writing

Accepted on all four write endpoints, in the same shape:

- `POST /api/vendor/products/:id/variants`
- `PATCH /api/vendor/products/:productId/variants/:variantId`
- `POST /api/vendor/products/simple`
- `PATCH /api/vendor/products/:id/simple`

| Body | Result |
|---|---|
| `"bargain": { "maxPrice": 45000 }` | Window set. `minPrice` = the effective price (this request's `price` if present, otherwise the stored one) |
| `"bargain": { "minPrice": 30000, "maxPrice": 45000 }` | Same — but `minPrice` must **equal** that effective price |
| `"bargain": null` | **Clears** the window. Update endpoints only (`400` on the two create endpoints) |
| `bargain` omitted | Untouched — except that a `price` in the same body auto-syncs `minPrice` |
| `"price": 32000` alone | Price written **and** `minPrice` re-pointed at it |

`maxPrice === minPrice` is allowed and means "bargainable, no headroom yet". Both bounds
must be numbers `>= 0`.

---

## 4. Errors

| Code | Status | When | Suggested copy |
|---|---|---|---|
| `CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH` | 422 | An explicit `bargain.minPrice` disagrees with the price | "The minimum bargain price is the selling price — edit the price instead." |
| `CATALOG_VARIANT_BARGAIN_RANGE_INVALID` | 422 | `maxPrice` is below the effective price, **including** a bare `price` edit that would rise above the stored ceiling | "The maximum bargain price must be at least the selling price." |
| `CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED` | 400 | A window was sent for a service product's variant | Don't render this control for services |
| `VALIDATION_ERROR` | 400 | `maxPrice` missing, a negative or non-numeric bound, an unknown key inside `bargain`, or `bargain: null` on a create endpoint | Field-level, from `details` |

All three bargain codes carry `details.variant` (the variant's name or SKU) plus the numbers
involved — `{ variant, price, minPrice, maxPrice }` — so you can point at the offending row
in a multi-variant editor without re-deriving it.

### The failure you will hit most

Raising a price above the ceiling is **refused**, not silently accommodated:

```jsonc
// stored: price 30000, bargain { minPrice: 30000, maxPrice: 45000 }

{ "price": 50000 }
// → 422 CATALOG_VARIANT_BARGAIN_RANGE_INVALID
//   details: { variant: "Red / M", price: 50000, minPrice: 50000, maxPrice: 45000 }

{ "price": 50000, "bargain": { "maxPrice": 65000 } }
// → 200
```

Deciding a new ceiling is the vendor's call, so we ask rather than guess. Two reasonable UI
responses: pre-validate `price <= bargain.maxPrice` in the form, or catch the 422 and prompt
"this price is above your bargain ceiling of X — raise it to…?".

**Nothing is written when this fires.** The rule runs before every side effect, so a refused
PATCH does not partially apply, and in particular it does not leave a stray stock-adjustment
request in an agency's queue.

---

## 5. Edge cases worth handling

- **Duplicating a product carries the window over.** `POST /api/vendor/products/:id/duplicate`
  copies `price` verbatim, so the invariant holds. The copy is born with vectorisation off,
  so it arrives `bargainable: false`.
- **Archiving a variant does not clear its window.** `bargainable` describes the parent
  product's opt-in, not whether the variant is on sale. An archived variant is never sent to
  the index regardless.
- **`maxPrice` is a ceiling, never a "was" price.** Do not render it struck through or feed it
  to a discount calculation — that is `compareAtPrice`, which is unrelated and unchanged. A
  bargainable variant might have both, meaning different things.
- **Typos behave differently on the two editors.** `PATCH /variants/:variantId` does not
  reject unknown body keys, so `{"bargin": {...}}` returns **200 with nothing written**. The
  simple-product endpoints are strict and **400** the same typo. Pre-existing asymmetry, but a
  silently swallowed *price ceiling* is worth guarding against client-side.
- **Concurrent writes are not serialised.** Two simultaneous PATCHes — one setting `price`, one
  setting `bargain.maxPrice` — each validate against stored state and both commit, which can
  leave `price` above `maxPrice`. Variant writes have no version check (the same is already
  true of `compareAtPrice`). If your editor can issue both at once, serialise them.

---

## 6. Suggested editor shape

```
Price                    [ 32 000 ]  FCFA        ← writes `price`
Compare-at price         [ 45 000 ]  FCFA        ← unchanged, unrelated
─────────────────────────────────────────────
☑ Allow customers to bargain
    Minimum (selling price)   32 000  (read-only, mirrors the field above)
    Maximum                 [ 45 000 ]  FCFA     ← writes `bargain.maxPrice`

    ⓘ Bargaining starts applying once AI search is enabled
      for this product.                          ← when bargainable === false
```

- The checkbox maps to presence: ticked ⇒ send `bargain`, unticked ⇒ send `"bargain": null`.
- Show the minimum as a **read-only mirror** of the price input. That makes the
  "minPrice is the selling price" rule visible instead of something the user discovers via a 422.
- Show the inert hint whenever `bargainable === false` while `bargain` exists, with a link to
  the product's vectorisation toggle.
- Hide the whole block for `type: "service"`.

---

## 7. Questions back to you

1. **Do you want `bargain.minPrice` to be accepted as a price-writing input** (§1.3), matching
   your original wording? It is a contained change if the two-input widget is easier for you.
2. **Should `bargainable: false` be visually distinct from "not configured"** in list views, or
   is it enough on the detail screen? Right now the API gives you everything needed for either.
3. **What does the negotiation phase need from the catalogue?** Before that is designed it
   would help to know whether an accepted price is per-customer, per-cart or per-order, since
   that decides where it gets snapshotted.
