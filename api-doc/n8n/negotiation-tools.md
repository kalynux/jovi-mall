# The bargaining sub-agent's read tools

**The contract for `/api/internal/negotiation/tools/*` — Stream B of
[BARGAINING-AGENT-PLAN.md](./BARGAINING-AGENT-PLAN.md).** Built 2026-09-07,
`test:negotiation-tools` 50/0.

The five tools the bargaining sub-agent uses to *find out things*. The two that change
state — `negotiation_context` and `negotiation_record` — are Stream A and live at
`POST /api/internal/negotiation/{context,record}`.

---

## 1 · The door

| | |
|---|---|
| Base | `/api/internal/negotiation/tools` |
| Credential | `X-Service-Token: $INTERNAL_SERVICE_TOKEN` (or `Authorization: Bearer …`) |
| Verb | **POST**, on all five |
| Envelope | `{ success, data }` on success; the standard `{ success, requestId, error }` otherwise |

Inherited from the `/api/internal/negotiation` mount, so it is the same credential the
playbook fetch already uses. **No route here reads a customer identity of any kind** — these
are catalogue and logistics reads, and there is no parameter by which one conversation could
reach another's data.

**POST rather than GET**, unlike `/playbook` beside it: the inputs are structured, and one of
them (`query`) is *the customer's own words*. A search phrase in a query string is written
into every access log and proxy record on the path — the same objection `/internal/bot` raises
about a phone number, weaker but pointing the same way.

⚠ **These routes are not on the maintenance-mode exemption list.** During a window they 503,
bargaining stops, and the sub-agent hands back to the main agent — customers are still served,
they simply pay the asking price.

### ⚠ The floor is disclosed here, and nowhere else

Two places on the platform strip the vendor's haggling window before it can reach a
customer-facing model: `product_search()` does `metadata - 'bargain_windows'`, and n8n's
`Shape Result` allowlist drops it again. **Both stay in force.** Plan decision **D-2** lifts
the rule for the bargaining sub-agent alone, through this tool. Nothing downstream of these
responses may forward `window.floor` to a customer, to the main agent, or into any log a
customer's transcript is assembled from.

---

## 2 · Vocabulary

The stored shape is `bargain: { minPrice, maxPrice }`. This surface renames both halves, once,
and the rename is deliberate:

| Wire | Stored | Meaning |
|---|---|---|
| `window.floor` | `variant.price` (`=== bargain.minPrice`, always) | **the vendor's floor** — never go below |
| `window.ask` | `bargain.maxPrice` | the shelf price, and where the haggle opens |
| `askingPrice` | derived | what the customer pays with no haggling — the ask if bargainable, the price otherwise |

`minPrice` reads as *"the least the customer pays"* and is the opposite; the consumer here is a
model choosing what to say to the person on the other side of that number.

`bargainable: false` ⇒ `window: null`. A window configured on a product whose
`vectorisationEnabled` is false is **kept and inert** — the variant is quoted at its price and
carries no window.

`currency` is `XAF` platform-wide.

---

## 3 · `get_product_details` — the truth source

`POST /product-details`

```jsonc
{ "productId": "…" }     // or "variantId", or "sku", or "slug" — at least ONE
```

Resolution order is `productId → variantId → sku → slug`, **first supplied wins** (they are not
intersected — a stale id beside a fresh SKU is a real case). `data.resolvedBy` echoes which was
used. ⚠ A SKU is a vendor's own code and is not unique across the catalogue; the first active
variant wins, so confirm the title with the customer.

```jsonc
{
  "success": true,
  "data": {
    "resolvedBy": "productId",
    "product": {
      "id": "…", "slug": "…", "title": "…", "description": "…",
      "type": "physical", "category": "…", "tags": ["…"],
      "currency": "XAF",
      "store": { "slug": "…", "name": "…", "isOpen": true },
      "images": [ { "id": "…", "url": "…", "access": "public", "mimeType": "image/webp", … } ],
      "defaultVariantId": "…",
      "variants": [
        {
          "id": "…", "sku": "…", "name": null,
          "displayName": "Size M · Red",
          "options": [ { "option": "Size", "value": "M" } ],
          "askingPrice": 45000,
          "compareAtPrice": null,
          "bargainable": true,
          "window": { "floor": 38000, "ask": 45000 },
          "stock": { "onHand": 2, "isInfinite": false, "sellable": true },
          "images": [ … ]
        }
      ]
    }
  }
}
```

**Only sellable variants are returned** (active, not soft-deleted), cheapest first.

### ⚠ `stock` — a count is not a verdict

- `onHand` is the real number, or **`null`** when the variant is infinite-stock — never `0`.
- `sellable` is whether an order would be accepted today, and it **can be `true` while
  `onHand` is `0`** (the vendor permits overselling).

So *"I have exactly 2 left"* may be said **only** from `onHand` when it is a number, and
**never** from `sellable`. The playbook's scarcity rule depends on this distinction.

### `compareAtPrice`

Published only while strictly above `askingPrice`. A vendor may legitimately hold
`price 24 000 · compareAtPrice 30 000 · ask 45 000`, and *"normally 30 000, today 45 000"* is
worse than saying nothing.

**Errors:** `400 NEGOTIATION_TOOL_SUBJECT_REQUIRED` (no identifier), `404
CATALOG_PRODUCT_NOT_FOUND`.

---

## 4 · `find_alternative_product` — the price-bounded substitute search

`POST /alternatives`

```jsonc
{
  "productId": "…",      // optional: substitute FOR this. Excluded from its own results
  "query": "something smaller",   // optional: search BY this
  "maxPrice": 40000,     // the customer's BUDGET
  "category": "…",       // optional; defaults to the subject's
  "type": "physical",    // optional; defaults to the subject's
  "inStockOnly": true,   // optional
  "limit": 5             // optional; default 5, max 10
}
```

**At least one of a subject or a `query` is required**; a bare `query` is a complete request.

### ⚠ `maxPrice` bounds the FLOOR, never the ask

A variant shelved at **45 000** with a floor of **38 000** **IS returned** for
`maxPrice: 40000`. That is the point: the question a bargaining agent asks is *"is there
anything I could get this customer into for 40 000"*, and the lowest a negotiation can reach is
the floor. Bounding on the ask would hide exactly the products the agent exists to negotiate
down.

It is also what `product_search()` already does — its `p_price_max` compares against
`price_min`, the minimum `variant.price` across the product.

```jsonc
{
  "success": true,
  "data": {
    "basis": "substitute",
    "subjectId": "…",     // null when searched by query alone
    "hits": [
      {
        "id": "…", "slug": "…", "title": "…", "type": "physical", "category": "…",
        "currency": "XAF",
        "store": { "slug": "…", "name": "…", "isOpen": true },
        "image": { … } ,          // the card image, or null
        "variantCount": 3,
        "entry": {                 // the CHEAPEST sellable variant — where a pitch opens
          "variantId": "…",
          "askingPrice": 42000,
          "bargainable": true,
          "window": { "floor": 35000, "ask": 42000 },
          "stock": { "onHand": 7, "isInfinite": false, "sellable": true }
        },
        "floorMin": 35000,
        "floorMax": 51000
      }
    ]
  }
}
```

A hit is a shortlist card, not a product. **Call `get_product_details` before making any claim
about a hit beyond what is on it** — `variantCount > 1` means there is more to ask about.

---

## 5 · `find_complementary_products` — bundle candidates

`POST /complements`

```jsonc
{ "productId": "…", "maxPrice": 20000, "inStockOnly": true, "limit": 5 }
```

A subject is **required** here (there is nothing to complement otherwise).

### ⚠ "Complementary" is a claim about ORDERS, never about fit

Hits come from **real co-purchase history** — how many past *paid* orders contained both
products — and `coPurchasedOrders` on each hit is that count, unembellished. It is a sample
over recent orders, not an exhaustive figure.

Nothing in this database knows whether a charger fits a phone. The tool is deliberately not
called `check_compatibility`, and its response carries a `note` restating this. **Never tell a
customer an item is compatible with, fits, or works with another** — say it is often bought
together with it.

**There is deliberately no fallback.** When there is no co-purchase history the result is
`hits: []`. A same-category product is a *substitute*, and offering one as a bundle tells a
customer to buy two of the same kind of thing while calling it generosity. An empty result
means sweeten some other way.

Same hit shape as § 4, plus `coPurchasedOrders`, and `basis: "co_purchased"`.

---

## 6 · `quote_delivery` — the delivery PROMISE

`POST /delivery-promise`

```jsonc
{ "productId": "…", "region": "littoral" }   // region optional
```

### ⚠ Re-scoped by D-7 — there is no fee to quote and no waiver to grant

`order.total_amount` is the item subtotal; the agency's fee comes out of the **vendor's** net
inside `splitOrder`. **Delivery is already free to every customer on every order.** So the
agent may promise free delivery truthfully — it just may not present it as a concession it
decided to make, because it is not one.

```jsonc
{
  "success": true,
  "data": {
    "productId": "…",
    "promise": {
      "deliverable": true,
      "reason": "agency_assigned",
      "customerPays": 0,
      "currency": "XAF",
      "free": true,
      "agency": { "id": "…", "name": "Douala Express", "coverageAreas": ["littoral", "centre"] },
      "coversRegion": true,
      "eta": null,
      "etaBasis": "No delivery date is available: …"
    }
  }
}
```

`reason` is a closed set: `agency_assigned` · `digital_download` · `not_shipped` ·
`no_agency_resolved`. The last is the only one with `deliverable: false` — the product is
physical and neither it nor its vendor names an agency, which is what checkout refuses with
`ORDER_NO_DELIVERY_AGENCY`.

### ⚠ `eta` is always `null`, and that is the confirmed answer

The plan asked for a date *"if the agency policy model supports it"*. **It does not.**
`IAgencyPolicies` carries exactly `pricing` · `returns` · `damage` · `cod` · `documents` —
there is no lead time, SLA, schedule or per-region delivery window anywhere on the agency or
its Magazin. `etaBasis` says so in a sentence the model can act on: *say delivery is arranged
with the agency and free, and do not name a day.* `test:negotiation-tools` § 6 fails if a
lead-time field is ever added, so this stays a checked claim rather than a note that goes
stale.

`coversRegion` is **three-valued**: `true`/`false` when a region was named against a published
coverage list, and **`null`** when there is nothing to compare — no region given, or an agency
that published none. `null` is not "they do not go there".

### ⚠ `absorbedByVendor` never appears here

It is what the vendor pays the agency. In front of a model negotiating with a customer it is a
lever, not a fact — *"delivery is costing me 2 000, meet me halfway"*. No file on this surface
names it, asserted by source scan.

---

## 7 · `check_promotion` — the deliberate stub

`POST /promotion`

```jsonc
{}                        // → 200
{ "code": "JOVI10" }      // → 422
```

**There is no coupon model on this platform at all.** `CartQuoteService` pins `discount` to a
literal `0`. This tool exists so the model has somewhere to *ask*, and gets a "no" it can say
out loud, rather than inventing one.

```jsonc
{
  "success": true,
  "data": {
    "available": false,
    "promotions": [],
    "reason": "no_promotion_system",
    "guidance": "This platform runs no promotions, coupons or discount codes of any kind. …"
  }
}
```

### ⚠ A supplied `code` is REFUSED, not answered `false`

`422 NEGOTIATION_PROMOTIONS_UNAVAILABLE`. A customer saying *"I have code JOVI10"* is asking a
question this platform cannot answer, and `{ available: false }` to that question reads as
**"that code is not valid"** — a verdict on a code nobody checked, which is exactly the
invented fact this tool exists to prevent. The registry message states the platform-level fact
instead, and is worded so it cannot be rendered as "your code expired". The code itself is
**not** echoed into `details`.

**This must never grow the ability to report a promotion.** It is not a feature awaiting a
backend; it is the honest shape of a question that has one answer.

---

## 8 · Errors

| Code | Status | When |
|---|---|---|
| `NEGOTIATION_TOOL_SUBJECT_REQUIRED` | 400 | No product named (and, on `/alternatives`, no `query` either). `details.accepts` lists what would have worked |
| `NEGOTIATION_PROMOTIONS_UNAVAILABLE` | 422 | A discount code was handed to `check_promotion` |
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | The identifier resolved to nothing publishable |
| `AGENT_SERVICE_TOKEN_INVALID` | 401 | Bad or missing service token |
| `AGENT_SERVICE_TOKEN_NOT_CONFIGURED` | 503 | `INTERNAL_SERVICE_TOKEN` unset on this deployment |
| `VALIDATION_ERROR` | 400 | A field of the wrong type (a negative `maxPrice`, a non-boolean flag) |

A 404 is a useful answer, not an outage: it is what makes the model say *"let me check that"*
rather than answer from a hand-off another model composed.

---

## 9 · What these tools deliberately do not do

- **No ETA.** § 6.
- **No promotion.** § 7.
- **No compatibility verdict.** § 5.
- **No fee, discount or delivery charge of any kind** — the customer pays the item subtotal.
- **No customer data.** No identity is read, so nothing here can tell the sub-agent who it is
  talking to. That is `negotiation_context`'s job (Stream A).
- **No writes.** Nothing on this surface changes any state. The price the model decides is
  submitted through `negotiation_record`, which is the gate.
