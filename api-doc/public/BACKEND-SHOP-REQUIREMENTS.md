# Backend requirements — shop & customer account

**Verified against source on 2026-09-08** — the Tier 1 / Tier 2 census and the six deliberate
deviations still hold, and the six ⚠ marks below are still accurate. **Tier 3 was materially out
of date and is corrected**: four of its seven items — reviews & ratings, wishlist,
recently-viewed and the related strip — shipped in Phase 6, verified against
`src/modules/reviews/routes/public-review.routes.ts:30`,
`src/modules/customers/routes.ts:84-91` and
`src/modules/catalog/routes/public-catalog.routes.ts:50`. A storefront built from the old § 4
would have kept its wishlist in `localStorage` and shown "no reviews yet" against live data.

> ## ✅ Tiers 1 and 2 are BUILT (2026-08-14)
>
> **👉 Start with [FRONTEND-CHANGELOG-shop.md](./FRONTEND-CHANGELOG-shop.md)** — the reply to
> this document: what shipped, the two changes to your plan, and every deviation with its
> reason.
>
> Contract: **[catalog.md](./catalog.md)** for the public storefront; the customer half is in
> [customer/cart.md](../customer/cart.md), [customer/orders.md](../customer/orders.md),
> [customer/profile.md](../customer/profile.md) and [auth/README.md](../auth/README.md).
>
> ⚠ **Tier 3 (§4) is now PARTLY BUILT — four of its seven items shipped after this line was
> written.** Reviews & ratings, wishlist, recently-viewed and the related strip are all live;
> coupons, back-in-stock alerts and returns/RMA remain the open ask. **Read § 4 before planning
> around it** — it carries the routes.
>
> ### Six deviations from this document, all deliberate
>
> 1. **§2.6 → Option B, not A.** Product slugs stay unique *per vendor*; no migration was run.
>    The canonical URL is `GET /api/public/stores/:storeSlug/products/:productSlug`, with
>    `GET /api/public/products/:productId` (ObjectId) for deep links. Resolving the store
>    first turns the lookup into an exact hit on the existing `{vendorId, slug}` index.
> 2. **§2.4's vendor gate is `!== 'inactive'`, not `=== 'active'`.** The positive form would
>    have hidden the store of every vendor sitting at `pending_verification` (the registration
>    default) **while their products stayed in the browse grid**, because the activation gate
>    uses the negative form. Matching it keeps the storefront self-consistent.
> 3. **§2.8.2 was misdiagnosed and needed no fix at the cart.** `CartService.addToCart` *does*
>    reject non-active products — `PriceResolverService` raises `422
>    CATALOG_PRODUCT_INVALID_STATE` one call away, which the doc's `grep "status"
>    cart.service.ts` could not see. The real gap was at **checkout**, and stock reservation
>    closed it. §2.8.1 and §2.8.3 were both real and are fixed.
> 4. **§6.2 (CORS) was already done.** `.env` sets `ALLOWED_ORIGINS` including
>    `http://localhost:3000`.
> 5. **§3.2 — the customer is NOT charged delivery.** The fee is real but the **vendor**
>    absorbs it (`vendorNet = gross − commission − deliveryTotal`), so `total = subtotal` and
>    the quote reports the fee as `absorbedByVendor` for display. Moving it onto the customer
>    is a business-model change that must be paired with `splitOrder` no longer deducting it.
> 6. **§2.2's `policies` ship as structured terms, not prose strings.** There is no prose
>    field to render from, so a string would have had to be generated server-side in one
>    language for a five-locale storefront.
>
> ### One thing this document asked for that was NOT safe as written
>
> §3.1 said to wire the existing `StockReservation` family. As written it **decremented
> `variant.stock` at reserve time**, while the model TTL-*deletes* an expired reservation and
> only the release restores stock — so every abandoned checkout would have permanently
> destroyed inventory, and `InventoryAvailabilityCalculator` would have double-counted. The
> semantics were corrected first: **reserve holds, commit decrements once, release and expiry
> write nothing.**
>
> ### Still open
>
> - **Tier 3** — the three that are still open: coupons, back-in-stock alerts, returns/RMA (§4).
>   Reviews, wishlist, recently-viewed and the related strip **shipped** and are no longer asks.
> - Registration's 6-character password and its `role` default of `'vendor'` (§3.3) are
>   unchanged; reset uses the strong rule.
>
> ### Closed since this was written
>
> - **`POST /auth/login` checks the password.** An earlier revision listed this as open; it is
>   not, and there is no flag that can disable the check.
> - **Customer sign-in is the bot flow**, not this form — customers hold a system-generated
>   password and register on first contact with the WhatsApp / Telegram bot. §3.3's account gaps
>   are answered by [auth/customer-auth.md](../auth/customer-auth.md), which is the storefront's
>   contract for registration and sign-in.
>
> ### New error codes to mirror in `src/lib/auth/backend-error-codes.ts` (§6.4)
>
> `CART_ITEM_NOT_FOUND` (404) · `ORDER_DELIVERY_ADDRESS_REQUIRED` (422) ·
> `AUTH_RESET_TOKEN_INVALID` (400). `CATALOG_INSUFFICIENT_STOCK` (422) already existed in the
> registry but had never been raised; it is now raised at checkout.
>
> Everything below is the original ask, kept for context.

---

What `backend/jovi-mall` has to provide for the shop under
`src/app/[locale]/shop/` to be a real storefront instead of a prototype, and for
customer account management to be production-ready.

**Status of the frontend, so you know what you are unblocking.** As of
2026-08-13 the *authenticated* half of the shop is finished and calls this API
for real — profile, saved addresses, payment methods, the notification inbox and
its channel preferences, order history and detail (including cash-on-delivery
delivery codes), and the digital-download library. All of it goes through
`src/lib/api/client.ts` with cookie auth.

The *discovery* half — browse, search, product detail, vendor stores, cart,
checkout — is still rendering invented data from `src/lib/shop/catalog.mock.ts`,
because **there is no endpoint a shopper can call to read a product.** That is
what this document is for.

> **One thing to understand before reading further.** The missing catalog API does
> not only block browsing. `POST /api/customer/cart/items` requires real
> `productId` and `variantId` ObjectIds, and the mock catalogue's ids are `p1`
> and `v1`. So **cart and checkout are blocked by the same gap as browse** —
> they are not separate pieces of work that can be picked up first.

---

## 0. How to read this

### Tiers

| Tier | Meaning | Stop here and you have… |
|---|---|---|
| **1** | The shop does not function at all without these | A working storefront: browse, search, open a product, add to cart, check out |
| **2** | Needed before this can be called production | A storefront that quotes real money, does not oversell, lets a customer track a parcel, and lets them back in when they forget their password |
| **3** | Commerce-standard, deferrable | Reviews, wishlist, recommendations, coupons |

Each tier is independently shippable. Tier 1 alone is a coherent release.

### Conventions this document assumes

Everything here follows the contracts already in [`../README.md`](../README.md):
the `{ success, data, meta? }` envelope, the
`{ success: false, requestId, error: { code, message, statusCode, category, details } }`
error shape, `page`/`limit`/`sort` pagination with a `meta` block, ObjectId ids,
ISO-8601 UTC timestamps, and money as **whole units** in the account currency
(`XAF` has no minor unit — do not multiply by 100).

Three existing exceptions the frontend already handles, listed so nothing new is
built to match them by accident: `/api/payments/*` answers flat with no `data`
key; `DELETE /api/customer/cart` and `DELETE /api/me/payment-methods/:id` answer
`{ success, message }` with no `data`; ticket endpoints key their pagination
`pagination` rather than `meta`. **New endpoints should use the standard
envelope**, not these.

### The `/api/public` rule

Every Tier 1 read belongs on the existing public router, and `src/api/index.ts`
already states the rule that governs it:

> ⚠️ `/public` is the ONE mount with no auth guard anywhere above or below it.
> Anything added under this prefix is world-readable with no further review, so a
> router mounted here must contain only reads of already-published data.

Follow `modules/billing/routes/public-billing.routes.ts` and
`modules/blog/routes/public-blog.routes.ts`: read-only, no `req.auth`, no writes,
and `Cache-Control: public, max-age=300` (`PUBLIC_CACHE_SECONDS`).

**And follow `modules/billing/dto/public-plan.dto.ts` for the shape.** It is an
explicit projection rather than the raw document, with this reasoning on it:

> Adding a field to the plan model does **not** publish it — add it here too, on
> purpose. That is the point of the projection: publication is a decision.

The same applies here, and it matters more, because the product and vendor
documents carry things that must never be public (§2.7).

### Everything the frontend reads goes through one module

`src/lib/shop/shop.api.ts` is the entire catalog integration surface. Each
function below names the endpoint it is waiting for:

| Function | Endpoint |
|---|---|
| `listProducts(query)` | `GET /api/public/products` |
| `getProductBySlug(slug)` | `GET /api/public/products/:idOrSlug` |
| `getVendorBySlug(slug)` | `GET /api/public/stores/:slug` |
| `listVendorProducts(vendorId)` | `GET /api/public/stores/:slug/products` |
| `getVendors()` | `GET /api/public/stores` — consumed by `src/app/sitemap.ts` |
| `getCategories()` | `GET /api/public/categories` |
| `getRelatedProducts(product)` | *Tier 3 — no endpoint requested yet* |
| `getSorts()` | *none — the sort list is a frontend constant* |

When those exist, the swap is editing that one file and deleting
`catalog.mock.ts`. No page and no component changes.

> **The field names in this document are the ones to build.** Do not try to match
> the current types in `src/lib/shop/shop.types.ts` — those describe the mock and
> will be rewritten to match whatever ships. In particular the mock carries four
> fields explicitly marked `// MOCK` that **have no backend and are not being
> requested at Tier 1**: `rating`, `reviews`, `sales` and a `delivery` label.
> They will be deleted from the type, not filled in. The only names worth keeping
> stable are the ones already proven on the authenticated half
> (`src/lib/shop/customer.types.ts`), which this document does not change.

---

## 1. Why this document exists

So nobody has to re-derive it: **there is no catalog-browse API, and there never
has been.**

- `src/api/index.ts:97` mounts exactly one non-vendor product router:
  `router.use('/products', productBookingRouter)`. That file
  (`modules/catalog/routes/product-booking.routes.ts`) contains only
  `GET /:productId/availability`, `POST /:productId/slots/:slotId/lock`,
  `POST /:productId/book` and `POST /:productId/slots/:slotId/unlock` — service
  booking, nothing else.
- `/api/public/*` is two routers: the plan catalogue and the blog.
- Everything under `modules/catalog` is `requireAuth` + `requireRole(['vendor'])`
  and filtered to the caller's own products.

Two documentation defects worth correcting while you are here, because both have
already misled someone:

- **`api-doc/README.md`'s permission matrix has a row reading
  "Catalog browse / product booking availability ✅" for Anonymous.** That refers
  only to the booking-availability route above. Read as written, it says a public
  catalog exists. It should be narrowed to "product booking availability".
- **`api-doc/customer/profile.md` shows the profile in snake_case.** The actual
  response is camelCase at the top level with snake_case inside nested objects —
  see §5.1. `modules/customers/dto/customer-profile.dto.ts` is the authority.

---

## 2. Tier 1 — without these there is no shop

### 2.1 `GET /api/public/products`

The browse grid, search, category chips, filters and sort at `/shop`, plus the
sitemap feed.

**Query parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | Full-text over title, description, tags. **Must be escaped or replaced — see §2.7.** |
| `category` | string | — | Exact match on the free-text `category` field |
| `type` | `physical \| digital \| service` | — | Repeatable, or comma-separated |
| `storeSlug` | string | — | Narrow to one vendor's store |
| `minPrice` / `maxPrice` | integer | — | Whole units, matched against the product's resolved price |
| `inStock` | boolean | — | See §3.1 on what this can honestly mean |
| `sort` | enum | `newest` | `newest \| price_asc \| price_desc \| relevance`. **No `popularity`** — nothing tracks sales (§4) |
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–100 | `20` | |

**Mandatory filter, on every row returned.** `status: "active"`,
`deletedAt: null`, `suspension: null`. Nothing else is publishable.

**Response**

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439066",
      "slug": "ankara-wax-print-maxi-dress",   // see §2.6 — needs to be unambiguous
      "title": "Ankara Wax Print Maxi Dress",
      "type": "physical",                       // physical | digital | service
      "category": "Fashion",
      "tags": ["wax", "handmade"],

      // Resolved from the default variant. The product itself has no price.
      "price": 24000,
      "compareAtPrice": 30000,                  // null when not discounted
      "currency": "XAF",
      "priceRange": { "min": 24000, "max": 38000 },  // omit when only one price
      "inStock": true,                          // boolean, never a count — §3.1

      // Thumbnail only on the list. Full gallery on detail.
      "image": {
        "id": "507f1f77bcf86cd799439030",
        "url": "https://…/products/abc123.jpg",
        "mimeType": "image/jpeg",
        "originalName": "cover.jpg"
      },

      "store": {                                // never `vendorId`
        "slug": "maison-bella",
        "name": "Maison Bella",
        "isOpen": true                          // vendor vacation mode — §2.7
      },

      "freeDelivery": false,
      "updatedAt": "2026-07-30T09:20:00.000Z"   // needed by sitemap.ts — §3.7
    }
  ],
  "meta": { "total": 120, "page": 1, "limit": 20, "pages": 6 }
}
```

**What to project it from.** `ProductRepositoryMongo.searchListView()`
(`product.repository.mongo.ts:184-261`) is the closest existing query — same
skip/limit + parallel `countDocuments` shape, same `meta`. It needs: `vendorId`
dropped from the filter, `status`/`deletedAt`/`suspension` forced, a join to the
default variant for price, and the store joined for name/slug. Use the **batched**
`resolveFileDetails` / `resolveProductImages`
(`modules/catalog/read-models/`) for images — `resolveProductImages` already
implements the rule that variant media replaces product media rather than merging
with it, and returns the gallery thumbnail-first, so `[0]` is the list image.

**Do not** build this from `enrichProduct` — see §2.7.

**Errors.** `VALIDATION_ERROR` (400) for a bad query param. Nothing else; an
empty result is `data: []`, not a 404.

### 2.2 `GET /api/public/products/:idOrSlug`

The product page at `/shop/products/[productSlug]`. Accepts either an id or a
slug (the frontend routes on slug; the id form is for deep links).

```jsonc
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439066",
    "slug": "ankara-wax-print-maxi-dress",
    "title": "Ankara Wax Print Maxi Dress",
    "description": "Comfortable cotton…",
    "type": "physical",
    "category": "Fashion",
    "tags": ["wax", "handmade"],
    "seo": { "title": "…", "description": "…" },   // optional, for <title>/meta

    "images": [ /* full gallery, FileDetail objects, thumbnail first */ ],

    // ── Options: what the chips render from ─────────────────────────────
    "options": [
      {
        "id": "507f…opt1",
        "name": "Size",
        "position": 1,
        "values": [
          { "id": "507f…val1", "value": "S" },
          { "id": "507f…val2", "value": "M" }
        ]
      }
    ],

    // ── Variants: the sellable units ────────────────────────────────────
    "variants": [
      {
        "id": "507f1f77bcf86cd799439077",
        "name": "Size: M",
        "price": 24000,
        "compareAtPrice": 30000,
        "currency": "XAF",
        "inStock": true,

        // The selection key. See §2.7 — do NOT rely on optionSignature.
        "optionValueIds": ["507f…val2"],
        // Pre-joined so the client does not have to reconstruct it:
        "options": [
          { "optionId": "507f…opt1", "optionName": "Size",
            "valueId": "507f…val2", "value": "M" }
        ],

        "images": [ /* variant media, if any */ ],

        // digital variants only — these are terms of sale, safe to publish
        "digital": { "maxDownloads": 3, "expiresAfterDays": 30 },

        // service variants only — note `price` above is a UNIT RATE (§2.7)
        "service": {
          "durationMinutes": 60,
          "bookingMode": "calendar",
          "bufferBeforeMinutes": 0,
          "bufferAfterMinutes": 15
        }
      }
    ],
    "defaultVariantId": "507f1f77bcf86cd799439077",

    "store": {
      "slug": "maison-bella",
      "name": "Maison Bella",
      "logo": { /* FileDetail | null */ },
      "isOpen": true,
      "verified": true,          // vendor kyc_details.legit_verified
      "city": "Douala",          // vendor business_addresses[0].city — CITY ONLY
      "country": "CM",
      "supportWhatsapp": "+237670000000",
      "policies": {              // buyer-facing terms; the most useful thing here
        "returnPolicy": "…",
        "cancellationPolicy": "…"
      }
    },

    "freeDelivery": false,
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

**Simple-mode products** (`mode: "simple"`) have exactly one variant and zero
options. Return `options: []` and the single variant; the frontend skips the
picker entirely.

**Errors.** `404 CATALOG_PRODUCT_NOT_FOUND` when absent, soft-deleted, **or not
`active`** — a draft product must 404, not 403, so its existence is not confirmed.

### 2.3 `GET /api/public/categories`

`Product.category` is a plain indexed `string` with **no Category collection,
model or taxonomy anywhere in the codebase**. The frontend therefore cannot
derive the chip list at `/shop`, and hardcoding it is what the mock does today.

```jsonc
{
  "success": true,
  "data": [
    { "name": "Fashion", "productCount": 48 },
    { "name": "Home",    "productCount": 31 }
  ]
}
```

Distinct `category` values across **active, non-deleted** products only, with
counts, sorted by count descending. A category whose products are all draft must
not appear. A `$group` over the same filter as §2.1 is enough; cache it 300s.

### 2.4 `GET /api/public/stores/:slug` and `GET /api/public/stores/:slug/products`

The store page at `/shop/stores/[vendorSlug]`. `/api/vendor/store` is
`requireRole(['vendor'])` and self-scoped, so a shopper cannot read a store today.

This one is nearly free. `StoreRepository.findBySlug(slug)` already exists
(`modules/store/repositories/store.repository.ts:105`), `Store.slug` is
**globally unique, lowercase and immutable through the vendor API**, and
`GetStoreProfileResponseDto` says in its own header that its fields are safe for
public consumption. The public DTO is that one minus `vendorId` and `version`:

```jsonc
{
  "success": true,
  "data": {
    "slug": "maison-bella",
    "name": "Maison Bella",
    "description": "Contemporary African fashion, handmade in Douala.",
    "logo":   { /* FileDetail | null */ },
    "banner": { /* FileDetail | null */ },
    "isOpen": true,                       // vacation mode
    "supportEmail": "…", "supportPhone": "…", "supportWhatsapp": "…",
    "country": "CM",
    "city": "Douala",                     // vendor business_addresses[].city ONLY
    "verified": true,                     // vendor kyc_details.legit_verified
    "productCount": 48,
    "memberSince": "2026-02-01T00:00:00.000Z"   // store.created_at
  }
}
```

`/products` takes the same query params as §2.1 minus `storeSlug`, and returns
the same row shape.

**Only stores whose vendor is `status: "active"` are public.** A suspended
vendor's store must 404.

**Also needed: `GET /api/public/stores`** — a paginated list of the same summary
objects (`page`, `limit`, optional `q` on store name, optional `city`). This is
not a nice-to-have: `src/app/sitemap.ts` calls `getVendors()` to emit one
`/shop/stores/<slug>` URL per store, and without it no store page is ever
submitted for indexing. It also backs a future "browse stores" page. A store with
zero active products should be excluded — an empty storefront is a soft-404 to a
crawler.

> **Never publish from the vendor document:** `user_id`, `email`, `phone`,
> `payout_details`, any `kyc_details` field other than `legit_verified`, the
> `suspended_*` fields, `default_delivery_agency_id`, `wa.*`,
> `notification_preferences`, `two_factor_enabled`, or the full
> `business_addresses` sub-document. City is the only address component a
> shopper needs; the rest is a home or warehouse address.

### 2.5 Cart — three gaps that make the cart UI unbuildable

The cart is **variant-first** (`cart.model.ts` requires `variantId` on every
item), but its write surface is not. Today it is exactly:

```ts
router.get('/', CartController.getCart);
router.post('/items', CartController.addItem);          // only ever INCREMENTS
router.delete('/items/:productId', CartController.removeItem);  // product-keyed
router.delete('/', CartController.clearCart);
```

**a. `PATCH /api/customer/cart/items/:variantId` — set an absolute quantity.**

`POST /items` on an existing variant does
`cart.items[i].quantity += quantity` (`cart.service.ts`), so there is no way to
*decrease* a quantity or to set one directly. The quantity stepper on
`/shop/cart` cannot be implemented against the current API.

```jsonc
// PATCH /api/customer/cart/items/507f1f77bcf86cd799439077
{ "quantity": 2 }     // integer ≥ 1. To remove, use DELETE below.
```
Returns the updated cart (same shape as `GET /api/customer/cart`).
Errors: `CART_VARIANT_NOT_FOUND` (404), `CART_DIGITAL_QUANTITY_MUST_BE_ONE`
(400), `VALIDATION_ERROR` (400) for `quantity < 1`.

**b. `DELETE /api/customer/cart/items/:variantId` — remove one line.**

The existing delete is keyed on `productId` and filters
`item.productId.toString() !== productId`, so **removing one size of a T-shirt
removes every size of it.** The per-line remove button cannot be implemented.

Keep the existing product-keyed route for back-compat if you like; add the
variant-keyed one beside it.

**c. `POST /api/customer/cart/merge` — the sign-in merge.**

Checkout requires an account (agreed — no guest-cart identity model is being
requested). But browsing does not, so a visitor fills a cart, signs in at
checkout, and must not lose it. The frontend holds an anonymous cart in
`localStorage` (`CartProvider`) and needs to hand it over exactly once.

```jsonc
// POST /api/customer/cart/merge
{
  "items": [
    { "productId": "507f…066", "variantId": "507f…077", "quantity": 2 }
  ],
  "strategy": "sum"     // "sum" (default) | "replace" | "keep_server"
}
```

Server-side rules to apply, in this order: drop any line whose product is no
longer `active`; enforce the single-product-type rule (`CART_MIXED_PRODUCT_TYPES`
— if the incoming items conflict with an existing server cart, the **server cart
wins** and the conflicting incoming lines are reported, not thrown); enforce
digital qty = 1 and one-digital-per-cart. Return the merged cart **plus** what
was dropped, so the UI can say so rather than silently losing a line:

```jsonc
{ "success": true,
  "data": { /* cart */ },
  "meta": { "dropped": [ { "variantId": "…", "reason": "PRODUCT_UNAVAILABLE" } ] } }
```

### 2.6 The product URL is ambiguous — this needs a decision

`ProductSchema.index({ vendorId: 1, slug: 1 }, { unique: true })`. Product slugs
are unique **per vendor**, not globally. Two vendors can both own `blue-shirt`.

The live frontend route is `/shop/products/[productSlug]`, which cannot resolve
that. Store slugs *are* globally unique, so:

| Option | Backend | Frontend |
|---|---|---|
| **A — make product slug globally unique** | Migration + index change; slug generation must de-duplicate across vendors | No change |
| **B — nest products under the store** | No change | Route becomes `/shop/stores/:storeSlug/products/:productSlug`; links, sitemap and JSON-LD all update |

**A is recommended** — it keeps the shorter, more linkable URL and the change is
one migration, whereas B changes every product URL the site will ever emit. But
it is your call; say which and the frontend follows.

Until it is decided, `GET /api/public/products/:idOrSlug` should accept an **id**
as well, so nothing is blocked on the migration.

### 2.7 Five things that will silently break an implementation that looks right

**a. `optionSignature` goes stale. Key selection on `optionValueIds`.**
`ProductVariant.optionSignature` is a lowercased string like
`"size:large|color:red"`, unique per product. But renaming an option value is
explicitly documented as *"Safe operation — does not affect variant
`optionValueIds` or `optionSignature`"* (`vendor-products.routes.ts:429`). After a
rename the stored signature still says `color:red` while the displayed value says
`crimson`. **A client that rebuilds the signature from displayed text will fail to
find a variant that exists.** That is why §2.2 returns `optionValueIds` and a
pre-joined `options[]` per variant. Do not publish `optionSignature` as the
matching key.

**b. Do not reuse `EnrichedProduct` for the public DTO.** It is
`Omit<Product, 'fileIds'>` — a spread of the entire domain object — so it carries
`vendorId`, the `suspension` block (whose `note` is free text like "storage rent
unpaid"), `delivery.pickup_location` (which leaks vendor home and warehouse
address ids), and the vectorisation fields. It is also N+1 on files
(`Promise.all(fileIds.map(findById))`). Build an allowlist projection and use the
batched resolvers.

**c. `status: "active"` already guarantees more than you think.**
`ProductStatusValidationService.collectActivationBlockers()` enforces, before a
product may become active: a non-empty description, at least one variant, `price
> 0` on every active variant, a resolvable active `defaultVariantId`, a vendor
that is not `inactive`, and — for physical products — an active default delivery
agency with an approved vendor↔agency connection and a valid pickup location.
Filtering on `active` inherits all of that, so the public endpoint does not need
to re-validate it.

**d. A service variant's `price` is a unit rate, not a total.** It is the price
per `serviceConfig.durationMinutes`, prorated by actual elapsed duration and then
surcharged by `serviceConfig.peakHours`. A storefront that prints it as "the
price" is misquoting the customer. Either return a `priceUnit` label
(`"per 60 min"`) alongside it, or return a computed `priceFrom` — but say which,
because the frontend currently renders `variant.price` as a flat price.

**e. Store vacation is orthogonal to product status.** `store.is_open === false`
does **not** suspend that vendor's products, and nothing in the backend hides or
flags them. So a shopper can currently reach a buyable product from a store that
is closed. Decide: hide those products from public lists, or return them with
`store.isOpen: false` so the UI can flag them. §2.1/§2.2 assume the latter; the
frontend can do either.

### 2.8 Three defects found while writing this

All three are the same class — a public or shopper-reachable path that does not
check `status` — and the Tier 1 rule fixes them.

1. **`GET /api/products/:productId/availability` is already unauthenticated and
   does not check `product.status`.** Its three sibling routes have `requireAuth`;
   this one does not, and `ProductBookingService.getAvailability` uses
   `findByIdUnscoped` and checks only `type === 'service'`. A logged-out caller
   can read the booking calendar of a `draft`, `archived` or `suspended` product.
2. **`CartService.addToCart` never checks product status** — `grep -n "status"
   cart.service.ts` returns nothing. A draft or archived product can be added to
   a cart and carried to checkout.
3. **A physical checkout with no usable address succeeds.**
   `resolveDeliveryAddress` (`order.service.ts:538-566`) falls through inline
   address → named address → default saved address → **`null`**, and nothing
   rejects the null. Note it returns `chosen.geo ?? null` — so **even an address
   the customer explicitly selected yields `null` if it was typed by hand rather
   than picked from `GET /api/geo/search`**, since `geo` is only populated by the
   address picker. Either way the order is created with `delivery_address: null`
   and no drop-off location. A physical order should refuse to be created without
   one.

---

## 3. Tier 2 — before this can be called production

### 3.1 Stock is fiction — the most serious item in this document

**Nothing in the order path ever changes `variant.stock`.**

- Adding to cart reserves nothing: `grep -rn "stock\|Reserv" src/modules/cart`
  returns **zero hits**.
- Order creation does not read or write it.
- Neither does payment success — `handlePaymentSuccess` touches `lastOrderedAt`,
  not stock.
- The unpaid-order-cancel worker says so outright: *"Stock is not reserved at
  order creation, so cancellation is a clean status change."*

A `StockReservation` model exists, with a TTL index and the right fields — and it
is **dead code**: no service instantiates `StockReservationService`,
`StockCommitService` or `StockReleaseService` anywhere outside a test script.
`agency-stock-level.model.ts` confirms it: *"Phase 2 wires the (currently dead)
StockReservationService family."*

So `variant.stock` is a number a vendor types in, and overselling is completely
unconstrained. Two consequences:

1. **A public API must not expose a stock count.** §2.1/§2.2 return
   `inStock: boolean` only. Publishing "3 left" when nothing decrements it is a
   promise the platform cannot keep.
2. **Checkout needs real reservation or decrement** before this is a shop rather
   than an order form. `InventoryAvailabilityCalculator` already encodes the
   intended semantics — `available = allowOversell ? stock : stock − activeReservations`
   — so the shape of the answer already exists; it just is not wired.

Minimum viable version: decrement at payment success (and at order creation for
COD, which fulfils before payment), release on cancel/refund, and reject at
checkout with `CATALOG_INSUFFICIENT_STOCK` (the code already exists) when a line
cannot be satisfied.

### 3.2 The customer is never quoted a delivery fee, tax or discount

```ts
// order.service.ts:592-597
const base = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
const tax = 0;       // TODO: Implement tax calculation
const discount = 0;  // TODO: Implement discount calculation
const total = base + tax - discount;
```

So `total_amount === base`. The agency's delivery fee exists, but only inside
`earningsSplitService.splitOrder` — it is deducted from the vendor's share and
**never charged to or shown to the customer**. `item.freeDelivery` is a snapshot
flag with no price effect.

The frontend used to invent a flat `DELIVERY_FEE = 1000` and a 2% "service fee".
Both have been **deleted** — showing a total nobody will be charged is worse than
showing the item subtotal alone, which is what `/shop/cart` now does.

**Ask:** a quote endpoint the cart can call before checkout —

```jsonc
// POST /api/customer/cart/quote   { "deliveryAddressId": "664addr…" }
{ "success": true,
  "data": {
    "currency": "XAF",
    "subtotal": 24000,
    "delivery": 1500,          // per checkout group, or per vendor order
    "tax": 0,
    "discount": 0,
    "total": 25500,
    "perVendor": [ { "vendorId": "…", "subtotal": 24000, "delivery": 1500 } ]
  } }
```

and for `POST /orders/checkout` to write the same figures into `price_breakdown`
so the quote and the charge cannot diverge.

### 3.3 There is no password reset — a customer who forgets is locked out forever

```
$ grep -rniE "forgot.password|reset.password|password_reset|passwordReset" src/
(no output)
```

Zero hits in the entire backend. `PATCH /api/me/password` exists but requires the
**old** password. The only way to change a login identifier is
`PATCH /api/internal/admin/users/:userId`, which is admin-only and on the
internal service surface.

For a storefront whose customers sign in rarely, this is the single largest
account gap. Needed:

- `POST /api/auth/forgot-password` — `{ identifier }` (email or E.164 phone).
  **Always answers 200** regardless of whether the account exists, or it becomes
  an account-enumeration oracle. Rate-limited (the `/auth` bucket is already
  20/min/IP).
- `POST /api/auth/reset-password` — `{ token, newPassword }`. Single-use token,
  short expiry, and it must stamp `password_changed_at` so every other session is
  revoked by the existing password-epoch check.
- Delivery over **email and WhatsApp** — WhatsApp is the primary channel for this
  audience and `phone` is the required registration field, not email.

Two related inconsistencies worth fixing in the same pass:

- Registration accepts a **6-character** password (`auth.schemas.ts`), while
  `PATCH /api/me/password` demands 8 + upper + lower + digit + symbol. Reset
  should use the strong rule, and registration should be raised to match.
- `POST /api/auth/register` defaults `role` to **`'vendor'`**. A storefront must
  send `role: "customer"` explicitly or it silently creates the wrong account
  type. Consider making `role` required.

### 3.4 A customer cannot see a shipment — and two shipped endpoints are unreachable

There is **no customer-facing shipment endpoint of any kind**. Every
`ShipmentController` handler is mounted under `/agency`, `/agent` or `/admin`.

Worse, this creates a dead end. Both of these require a `:shipmentId`:

```
POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery
POST /api/customer/orders/:orderId/shipments/:shipmentId/resend-delivery-code
```

but **no customer-facing response returns a shipment id**, except inside
`codCollections` — which is `undefined` for every online-paid order. So a prepaid
customer can never confirm a shipment, and `confirmShipmentDelivery` in
`src/lib/shop/orders.api.ts` has no reachable input. The tracking number is
returned exactly once, by the confirm call itself — after delivery, when it is
useless.

**Ask:** `GET /api/customer/orders/:orderId/shipments`, scoped to the caller.

```jsonc
{ "success": true,
  "data": [
    {
      "id": "507f…100",
      "status": "in_transit",              // the customer-visible subset
      "trackingNumber": "FDO-260730-142309-K7Q2M",
      "agencyName": "WiExpress",
      "itemIds": ["507f…055"],             // which order lines are in this parcel
      "statusHistory": [                    // shipment.status_history already exists
        { "status": "picked_up",  "at": "2026-07-30T10:00:00.000Z" },
        { "status": "in_transit", "at": "2026-07-30T14:00:00.000Z" }
      ],
      "estimatedDelivery": null
    }
  ] }
```

Only the four statuses the notification catalog already considers
customer-facing (`shipped`, `out_for_delivery`, `delivered`, `delivery_failed`)
should be surfaced verbatim; the internal ones (`assigned`, `handing_over`, …)
should be collapsed. Never expose the agent's personal details or the free-text
internal `note` on a failed delivery — the notification copy already rephrases
those deliberately.

### 3.5 The cart is destroyed even when the order is unpaid

`createOrdersFromCart` clears the cart post-commit, unconditionally. For an
online checkout the orders are `AWAITING_PAYMENT` at that moment, so a customer
whose payment fails has **lost their basket** and holds orders they must find
again to pay for.

Either keep the cart until payment succeeds, or make the unpaid orders trivially
resumable from `/shop/account/orders` (a "pay now" action returning the
`cartId` for `POST /api/payments/initiate`). The second is probably cheaper and
is what the order-history UI is already shaped for.

### 3.6 Order history is missing what a customer needs to recognise an order

`GET /api/customer/orders` accepts only `page` and `limit` — no status filter, no
date range, no search. And the detail DTO omits, though all of it exists on the
model:

| Missing | Why it matters |
|---|---|
| Store name / slug (only `vendorId` is returned) | "Order from `507f1f77bcf86cd799439aaa`" is not a receipt |
| Product image on the line item | Order history with no pictures is unreadable on a phone |
| `price_breakdown` | Only `total` is shown; once §3.2 lands the breakdown is the receipt |
| `delivery_address` | The customer cannot see where their order is going |
| `items[].delivery.status` / `shipment_id` | Per-line delivery state; also §3.4 |
| Order timeline | `OrderTimeline` is a full audit trail, readable only by the vendor |
| `updatedAt` | "Last updated" on the order card |

Plus: **there is no `GET /api/customer/orders/:id`** — a single per-vendor order
cannot be fetched, only the whole `cartId` group.

### 3.7 Smaller Tier 2 items

- **`updatedAt` on public products** so `src/app/sitemap.ts` can emit a real
  `lastModified`. It currently omits the field rather than fabricate one.
- **`PATCH /api/customer/addresses/:id`.** Editing an address today means delete
  + re-add, which mints a new `_id` — and past orders reference the old one via
  `deliveryAddressId`.
- **Customer push registration.** `DeviceTokenController`, `device-token.model.ts`
  and `fcm-push.service.ts` all exist and are mounted for vendor, agency and
  agent. There is **no `/api/customer/devices`**, so a shopper can never receive
  a push — even though the customer notification catalog already says push is
  sent "always, to every device the customer has registered".
- **Product-data i18n.** `title`, `description`, `category`, `tags` and `seo.*`
  are plain `string`, with no `Accept-Language` handling on any read path, in an
  app that ships five locales. At minimum, decide whether product text is
  vendor-authored-in-one-language (and say so in the UI) or translatable.

---

## 4. Tier 3 — commerce-standard, and **four of the seven are now built**

> ⛔ **The census below is the state on 2026-08-14 and is no longer true.** Re-checked against
> source on 2026-09-08: **reviews & ratings, wishlist, recently-viewed and the related strip all
> shipped** in Phase 6 (steps 6.E.1 / 6.E.2 / 6.E.4). The table further down marks each row. The
> `grep` output below is kept because it is the evidence for the three that are still open, and
> because it records what the shop looked like when this was written.
>
> | Now live | Route | Contract |
> |---|---|---|
> | Reviews & ratings | `GET /api/public/products/:productId/reviews` | [../reviews.md](../reviews.md) |
> | Wishlist | `GET`/`POST /api/customer/wishlist`, `DELETE /api/customer/wishlist/:productId`, `POST /api/customer/wishlist/saved-among` | [../customer/saved-and-viewed.md](../customer/saved-and-viewed.md) |
> | Recently viewed | `GET`/`POST`/`DELETE /api/customer/recently-viewed` | same page |
> | Related strip | `GET /api/public/products/:productId/related` | [catalog.md](./catalog.md) |

The 2026-08-14 census, verified against `core/database/collections.ts` — the
frozen registry every model name is drawn from — and all 88 `*.model.ts` files:

```
$ grep -rniE "wishlist|favou?rite|recently.?viewed" src/ --include=*.ts
(no output — not even a comment)

$ grep -rniE "coupon|voucher|promocode|promotion" src/ --include=*.ts
src/modules/notifications/models/customer-notification-preference.model.ts:63: (a comment)
```

The only `discount` is the field pinned to `0` in §3.2. The only `rating` is the
internal **agent** reputation score used for delivery assignment, which has no
product linkage.

| Feature | Status | Note |
|---|---|---|
| **Reviews & ratings** | ✅ **BUILT** | Verified-purchase gating and moderation both exist. Emit `aggregateRating` **if and only if** `rating` is non-null — the backend never sends a zero-count summary, so there is no way to publish an invented review count. |
| **Wishlist / favourites** | ✅ **BUILT** | Server-side and cross-device. `saved-among` answers a whole grid in one call. `product` comes back **`null`** for a product that has left sale — render "no longer available" with a working remove button. |
| **Related / "customers also bought"** | ✅ **BUILT** | `GET /api/public/products/:productId/related`. |
| **Recently viewed** | ✅ **BUILT** | `Customer.recent_product_code` is no longer unused — `POST /api/customer/recently-viewed` maintains it, writing the product's **id**. The list is capped (20, `CUSTOMER_RECENTLY_VIEWED_CAP`) and re-viewing moves an entry to the head. |
| **Coupons / promo codes** | ❌ open | No model, and `price_breakdown.discount` is the field waiting for it. |
| **Back-in-stock & price-drop alerts** | ❌ open | Both depend on §3.1 being real first. |
| **Returns / RMA** | ❌ open | No module. Refunds today are vendor-initiated only, and only Stripe is implemented — NotchPay and MyCoolPay raise `REFUND_GATEWAY_NOT_SUPPORTED`. |

---

## 5. Customer account management

### 5.1 What exists today

| Capability | Endpoint |
|---|---|
| Read / update profile | `GET`·`PATCH /api/customer/profile` |
| Add / remove / default address | `POST /api/customer/addresses`, `DELETE …/:id`, `PATCH …/:id/default` |
| Saved payment methods | `GET`·`POST /api/me/payment-methods`, `GET …/default`, `PATCH …/:id/default`, `DELETE …/:id` |
| Change password (knows the old one) | `PATCH /api/me/password` |
| Email verification | `POST /api/auth/send-email-verification`, `GET /api/auth/verify-email?token=` |
| WhatsApp verification | `POST /api/auth/request-wa-verification` |
| Notification inbox & channel preferences | `/api/customer/notifications*` |

> **Wire-format note, because the doc is wrong.**
> `api-doc/customer/profile.md` shows this response in snake_case. It is not.
> `GET /api/customer/profile` is **camelCase at the top level**
> (`emailVerified`, `savedAddresses`, `dateOfBirth`, `onboardingStep`) with
> **snake_case inside nested objects** (`savedAddresses[].address_line1`,
> `preferences.marketing_opt_in`). Verified against a live response;
> `modules/customers/dto/customer-profile.dto.ts` is the authority, and
> `src/lib/shop/customer.types.ts` is typed to match. Please fix the doc rather
> than the response — the frontend is already built against the DTO.

**Avatar flow**, documented here because it works and was undocumented: `POST
/api/files/upload` (field `files`, customer cap 100 MB) → take `data[0].id` →
`PATCH /api/customer/profile { "avatarFileId": "<24-hex>" }`. Reads return a
resolved `avatar` file object, never a bare URL. `FileReferenceService.reconcile`
attaches the new file and detaches the old, and an attached file cannot be
deleted until detached (`avatarFileId: null`).

### 5.2 What is missing

| Missing | Impact |
|---|---|
| **Password reset** (§3.3) | Permanent lockout. Highest priority in this section. |
| **Email change + re-verify** | `login_email` is admin-only |
| **Phone change + re-verify** | `login_phone` is admin-only; `request-wa-verification` only verifies the number already on file |
| **Address edit** (§3.7) | Delete + re-add breaks order references |
| **Account deletion / deactivation** | Nothing. Suspend/restore is admin-only. A GDPR-style "close my account" does not exist |
| **Data export** | Nothing |
| **Session list / revoke other devices** | Only the password change revokes globally |
| **Push device registration** (§3.7) | No `/api/customer/devices` |

One security note while you are in this area: the upload pipeline is wired with
`NoOpVirusScanner` even though `core/uploads/scanners/clamav-scanner.ts` exists.
Customer-uploaded avatars are served from an unauthenticated `express.static`
mount at `/api/files`.

---

## 6. Cross-cutting

### 6.1 Caching and rate limits

There is `Cache-Control` on exactly **two** controllers in the entire backend
(public billing and public blog, both `public, max-age=300`), and **none on any
catalog, cart or order route**. No `ETag`, no `Last-Modified`, no response cache.

Rate limiting is three layers, and none of them is storefront-shaped:

| Layer | Scope | Limit |
|---|---|---|
| Global backstop | per IP, before auth | **1200/min**, shared by anonymous browse traffic |
| Identity | per authenticated identity | customer **600/min** |
| Credential | per IP on `/api/auth/*` | 20/min |

There is no per-endpoint policy and `/api/public/*` has no bucket of its own. A
product grid that fires a list call plus a categories call per page view, from an
office or a shared mobile NAT, will contend for the same 1200/min. Either give
`/api/public/*` its own (higher) bucket, or lean on the 300s cache — but decide,
rather than discovering it under load.

### 6.2 CORS — currently blocks the browser entirely

`ALLOWED_ORIGINS` is present in `.env.example` but **not set in
`backend/jovi-mall/.env`**. `buildCorsOptions()` returns `callback(null, false)`
for an unlisted origin, which omits the CORS headers — so every authenticated
call from `http://localhost:3000` fails, silently, with no server-side error.
`curl` does not reveal this because a request with no `Origin` header is not
subject to CORS at all. This has already cost one debugging session.

```
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:3000
```

Production will need the real storefront origin added before launch.

### 6.3 Fields the SEO layer needs

`src/lib/seo/jsonld.ts` emits `Product` and `Store` structured data. For rich
results it needs, per product: `sku` (or a stable identifier), `price`,
`priceCurrency`, availability, and the seller name — all of which §2.1/§2.2
provide except `sku`, which is currently proposed as omitted. If you would rather
not publish SKUs, say so and the frontend drops the field; `Offer` is valid
without it.

`aggregateRating` stays omitted until Tier 3 exists. Do not add it earlier.

### 6.4 Error codes

Reuse the existing catalog wherever one fits — `CATALOG_PRODUCT_NOT_FOUND`,
`CATALOG_INSUFFICIENT_STOCK`, `CART_VARIANT_NOT_FOUND`,
`CART_MIXED_PRODUCT_TYPES`, `CART_DIGITAL_QUANTITY_MUST_BE_ONE`,
`VALIDATION_ERROR`. The frontend's union in
`src/lib/auth/backend-error-codes.ts` was verified 447/447 against the backend
catalog, so any **new** code must be added there too — flag new ones explicitly
in the PR and they will be mirrored.

Every new error needs a `category` from the existing nine-value taxonomy; the
frontend branches on it whenever it has no specific handling for a code.

---

## 7. Summary of the ask

| # | Endpoint / change | Tier | Blocks |
|---|---|:--:|---|
| 1 | `GET /api/public/products` | 1 | Browse, search, filters, sort, sitemap |
| 2 | `GET /api/public/products/:idOrSlug` | 1 | Product page |
| 3 | `GET /api/public/categories` | 1 | Category chips and filter |
| 4 | `GET /api/public/stores/:slug` + `/products` | 1 | Store page |
| 4b | `GET /api/public/stores` (list) | 1 | Store URLs in the sitemap |
| 5 | `PATCH /api/customer/cart/items/:variantId` | 1 | Quantity stepper |
| 6 | `DELETE /api/customer/cart/items/:variantId` | 1 | Per-line remove |
| 7 | `POST /api/customer/cart/merge` | 1 | Cart survives sign-in |
| 8 | Product slug: global uniqueness *or* nested route | 1 | Unambiguous product URLs |
| 9 | Storefront indexes + escape/replace the `q` regex | 1 | Performance; ReDoS |
| 10 | Status checks on availability, cart-add, checkout address | 1 | Three live defects (§2.8) |
| 11 | Stock reservation / decrement | 2 | Honest availability; no overselling |
| 12 | `POST /api/customer/cart/quote` + real `price_breakdown` | 2 | Showing a total that matches the charge |
| 13 | `POST /api/auth/forgot-password` + `/reset-password` | 2 | Locked-out customers |
| 14 | `GET /api/customer/orders/:orderId/shipments` | 2 | Parcel tracking; makes two shipped endpoints reachable |
| 15 | Preserve cart on unpaid checkout, or resumable payment | 2 | Lost baskets on payment failure |
| 16 | Order DTO: store name, images, breakdown, address, filters | 2 | Readable order history |
| 17 | `PATCH /api/customer/addresses/:id` | 2 | Address editing |
| 18 | `POST/DELETE /api/customer/devices` | 2 | Customer push |
| 19 | `updatedAt` on public products | 2 | Real sitemap `lastModified` |
| 20 | Product-data i18n decision | 2 | Five-locale correctness |
| 21 | ~~Reviews, wishlist, recently-viewed, related~~ — **all four built**; coupons, alerts, returns still open | 3 | Feature parity with a normal store |

**Environment, needed today regardless of tier:** set `ALLOWED_ORIGINS` (§6.2).

---

## Related

- [`../README.md`](../README.md) — envelope, pagination, auth, permission matrix
- [`./README.md`](./README.md) — the existing public API (plans, credit packs)
- [`./BACKEND-REQUIREMENTS.md`](./BACKEND-REQUIREMENTS.md) — the marketing-page ask, §1 of which shipped
- [`./BACKEND-BLOG-REQUIREMENTS.md`](./BACKEND-BLOG-REQUIREMENTS.md) — the blog ask
- [`../customer/cart.md`](../customer/cart.md) · [`../customer/orders.md`](../customer/orders.md) · [`../customer/profile.md`](../customer/profile.md) — the contracts the shipped half already uses
