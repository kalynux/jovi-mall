# Front-end changelog — what the storefront quotes for a bargainable variant

**Audience:** whoever builds the **customer storefront** (`frontend/landing`).
**Status:** backend shipped 2026-09-07. Nothing is behind a flag.
**Verified against source on 2026-09-08.**

> ⛔ **This is a BREAKING SEMANTIC CHANGE and it is silent.** No field was added, removed or
> retyped. `price` is still an integer called `price` in the same position. **It is the number
> that changed**, for one class of variant — so nothing in your build fails, no type errors
> appear, and the only symptom is a price that disagrees with what the customer is charged, or a
> filter that returns products it should have excluded.

> ⚠ **The previous edition of this page said the opposite.** `api-doc/public/catalog.md` used to
> record `bargain` as *"not published, pending a decision about whether the range is buyer-facing
> or a vendor-side floor."* That decision was taken on 2026-09-07 and went the **other** way.
> If your copy of that page still carries the old bullet, it is stale — this file supersedes it.

---

## 1. The change in one paragraph

A vendor may configure a **haggling window** on a variant: `bargain: { minPrice, maxPrice }`,
where `minPrice` is always equal to `variant.price`. Until 2026-09-07 the shop quoted
`variant.price`. It now quotes **`bargain.maxPrice` — the vendor's ask** — and `variant.price`
becomes the vendor's **floor**: the number they will not go below in a negotiation, and which
**is never published on any public route, under any key**.

For a variant with no window, nothing changed at all.

---

## 2. Five values moved together, and that is load-bearing

These are computed in two different places in the backend — a mapper for the product detail, an
aggregation pipeline for everything else — and they were changed as one unit deliberately
(`src/modules/catalog/read-models/public-display-price.ts`):

| What | Where you see it |
|---|---|
| `price` | product detail, every variant; browse rows |
| `priceMin` / `priceMax` | the product row's range |
| `price_asc` / `price_desc` | `?sort=` |
| the `minPrice` / `maxPrice` **filter band** | `?minPrice=&maxPrice=` |
| the by-SKU resolution's price | `GET /api/public/variants/by-sku/:sku` |

**The guarantee you can rely on:** a filtered page still only contains products whose *displayed*
price is inside the band you asked for. Filter `maxPrice=40000` and nothing showing 45 000 comes
back. Had display moved without the filter, that guarantee would have broken — which is why they
are one rule in one file.

**Nothing you need to do**, provided you render `price` and pass the filter values through. If you
cache prices, or derive a range client-side from something other than these fields, re-check it.

---

## 3. `compareAtPrice` is now suppressed on a bargainable variant

It is published **only while it is strictly above the ask**; otherwise it comes back `null`.

A vendor can legitimately hold `price 24 000 · compareAtPrice 30 000 · maxPrice 45 000`. Publishing
that pair after the flip would render a strikethrough **30 000** above a live **45 000** — *"was
cheaper, now dearer"*. Your existing "render the strikethrough iff `compareAtPrice` is non-null"
rule is still correct and needs no change.

---

## 4. What is deliberately NOT published

| Not published | Why |
|---|---|
| `bargain.minPrice` (the floor) | It is what the vendor will not go below. Handing it to a shopper hands it to the other side of the negotiation. Asserted absent from every public DTO by `test:public-catalog` § 4. |
| the `bargain` object at all | Same reason. |
| a `bargainable` flag | **Still open, and known.** Bargaining is chat-only, so the storefront has nothing to do with it today. The accepted cost is stated plainly in the backend's own notes: *a shopper cannot tell a negotiable price from a fixed one.* If you want the flag, ask — it is a publication decision, not an oversight. |

**There is no "make an offer" control on the storefront and none is planned.** Negotiation happens
in WhatsApp or Telegram. Do not build an offer UI against this.

---

## 5. One precondition that is easy to miss

A configured window is not always an **effective** one. The rule is

```
isBargainEffective = product.vectorisationEnabled === true && variant.bargain != null
```

(`src/modules/catalog/domain/services/bargain-price.rule.ts:162-167`)

So a window on a product whose vectorisation opt-in is **off** is kept, fully validated, and
**inert** — that variant is still shelved at its ordinary `price`.

Nothing on the public surface lets you tell the two apart, and nothing needs to. It matters only
if you are reconciling a shop price against what a vendor configured on their dashboard, where
this is the missing half of the explanation.

---

## 6. The cart charges the ask too — so display and checkout agree

Worth stating explicitly, because the obvious worry is that the shelf moved and the till did not.
It did not happen: adding a bargainable variant **without** negotiating resolves at the same
`publicDisplayPrice` the shop quoted
(`PriceResolverService.ts:148-150`). Shown price and charged price are the same number.

A line that *was* negotiated in chat carries its own agreed price and two extra keys — that is a
separate contract, documented at
[Customer → Cart § Negotiated prices](./customer/cart.md#negotiated-prices). Read it if you render
the cart; it introduces two ways a price can silently drop back to the shelf price.

---

## 7. Also new on this surface: `GET /api/public/products/by-ids`

Hydrate up to **50** products in one call. Unauthenticated, same DTO as the browse grid.

```
GET /api/public/products/by-ids?ids=<id>,<id>,<id>
GET /api/public/products/by-ids?ids=<id>&ids=<id>      ← both shapes accepted
```

```json
{ "success": true, "data": { "products": [ /* … */ ], "missing": ["<id>"] } }
```

| Behaviour | Detail |
|---|---|
| order | **Your `ids` order is preserved.** A ranking computed elsewhere survives hydration without re-sorting. |
| duplicates | Collapsed before the cap is applied. Repeating an id is allowed and costs nothing. |
| `missing` | **An answer, not an error.** An id no longer publishable — archived, suspended, deleted — is named here; the request still returns `200`. |
| cap | 50 ids per request; `ids` naming none is a `400`. |

⚠ **`missing` is not optional to handle.** It is how a withdrawn product disappears from a list
you built earlier. Rendering `products` and ignoring `missing` leaves a gap with no explanation.

---

## 8. Your checklist

1. **Nothing to change** if you render `price` / `compareAtPrice` / `priceMin` / `priceMax` as
   given and pass filter values straight through. That is the intended outcome.
2. **Re-check any client-side price derivation** — a cached price, a range computed from a variant
   list, a "from X" label built by hand.
3. **Do not add** an offer control, a `bargainable` badge, or anything reading `bargain`.
4. **Read [Customer → Cart § Negotiated prices](./customer/cart.md#negotiated-prices)** before
   touching cart rendering.
5. **Handle `missing`** if you adopt `by-ids`.
