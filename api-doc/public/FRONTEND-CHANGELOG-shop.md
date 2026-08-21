# Shop backend — what shipped, and what to do with it

**Reply to [BACKEND-SHOP-REQUIREMENTS.md](./BACKEND-SHOP-REQUIREMENTS.md). Built 2026-08-14.**

**Tiers 1 and 2 are done — all 20 numbered items in your §7 table.** Tier 3 is untouched.

Contracts: **[catalog.md](./catalog.md)** (the storefront's read side) ·
[customer/cart.md](../customer/cart.md) · [customer/orders.md](../customer/orders.md) ·
[customer/profile.md](../customer/profile.md) · [auth/README.md](../auth/README.md).

Thank you for the document — it was accurate enough to build straight from, and the parts
that turned out to be wrong were wrong in ways that were only visible from inside the code.
Those are all listed below, because two of them change what you should build.

---

## 1. Read this first — two changes to your plan

### 1a. Product URLs are nested. `getProductBySlug(slug)` needs a second argument.

You offered A (global slug uniqueness + migration) or B (nest under the store) and
recommended A. **We took B.**

Why: `Product.slug` is unique per vendor via a compound index `{ vendorId: 1, slug: 1 }`.
Option A meant a migration that de-duplicates collisions across the whole live catalogue —
i.e. silently renaming some vendors' product URLs — plus a new global index. Option B needs
neither, and it turned out to be *faster*, not just safer: resolving the store first makes
the lookup an exact hit on that existing compound index. A global-slug lookup would have
needed a new index to avoid a collection scan.

```
✅ GET /api/public/stores/:storeSlug/products/:productSlug     ← canonical, use everywhere
✅ GET /api/public/products/:productId                          ← ObjectId only, deep links
```

**What this costs you**, exactly as your table predicted: the route becomes
`/shop/stores/[vendorSlug]/products/[productSlug]`, and links, the sitemap and the JSON-LD
`url` all update. Every list row carries `store.slug` alongside `slug`, so you can build the
href from a row without a second fetch.

The id form is a genuine fallback — use it for a link out of an order, a notification or a
share sheet, where you hold an id and not a slug. It returns an identical body.

### 1b. `listVendorProducts` takes a **slug**, not a vendorId

`GET /api/public/stores/:slug/products`. **`vendorId` is not published anywhere on the public
API** — deliberately, so an internal id never becomes a public identifier. Stores are
addressed by slug throughout.

---

## 2. The swap

`src/lib/shop/shop.api.ts`, function by function:

| Your function | Endpoint | Note |
|---|---|---|
| `listProducts(query)` | `GET /api/public/products` | As specced |
| `getProductBySlug(slug)` | `GET /api/public/stores/:storeSlug/products/:productSlug` | **Signature change** — see §1a |
| `getVendorBySlug(slug)` | `GET /api/public/stores/:slug` | As specced |
| `listVendorProducts(vendorId)` | `GET /api/public/stores/:slug/products` | **Takes a slug** — see §1b |
| `getVendors()` | `GET /api/public/stores` | Paginated; `?q=`, `?city=` |
| `getCategories()` | `GET /api/public/categories` | Bare array, no `meta` |
| `getRelatedProducts(product)` | — | Tier 3, not built |
| `getSorts()` | stays a frontend constant | **Drop `popularity`** — see §3a |

All seven send `Cache-Control: public, max-age=300` and the standard `{ success, data, meta? }`
envelope. No cookies, no auth, no `credentials: 'include'` needed.

The four fields you marked `// MOCK` — `rating`, `reviews`, `sales`, `delivery` — are **not
provided** and should be deleted from the type, as you planned. `freeDelivery` (boolean) is
real and is on every row.

---

## 3. Where we deviated from your spec, and why

Six places. Four are because the document described the codebase inaccurately — no fault of
yours, they were only checkable from inside.

### 3a. `sort=popularity` is refused with a 400

You already excluded it, and we went further and made it an explicit rejection rather than an
ignored value: nothing tracks sales (`Product.lastOrderedAt` exists and is read by nobody), so
accepting it would mean silently returning some other order. Keep it out of `getSorts()`.

### 3b. Search is `$text`, not escaped `$regex` — it matches whole words

Your item #9 said "escape **or replace**" the regex. We replaced it, with the first
`$text` index in this codebase.

Escaping alone would have fixed the injection and left the two real problems: an unanchored
regex cannot use an index (a collection scan on an unauthenticated endpoint), and it produces
no relevance score — so `sort=relevance` would have had nothing to rank by.

**The trade, and you need to design around it:** `$text` matches whole words. Searching
`dres` does **not** find "dress". This is verified empirically in `verify:storefront`, not
assumed. If you want type-ahead behaviour, debounce and search on complete words, or tell us
and we can add a prefix index for autocomplete specifically.

Stemming is disabled — one stemmer would be wrong for four of the five locales vendors write
in.

### 3c. §2.4's vendor gate would have hidden most stores

You wrote: *"Only stores whose vendor is `status: "active"` are public."*

We used **`!== 'inactive'`** instead. `pending_verification` is the schema default at
registration, and the product-activation gate refuses only `inactive` — so a vendor who never
verified their email has legitimately `active` products. The positive form would have kept
those products in your browse grid **while 404ing their store page and their product detail**.
The negative form is what makes the storefront self-consistent, and it is the form the rest of
the codebase already uses for exactly this reason.

Net effect for you: nothing. It is only visible as the bug that did not happen.

### 3d. §2.2's `policies` are structured objects, not prose strings

You specced `policies: { returnPolicy: "…", cancellationPolicy: "…" }`. There is no prose
field anywhere to render from — `IVendorReturnPolicy` is a structured document — so a string
would have had to be *generated on the server, in one language*, for a five-locale storefront.

You get the facts and phrase them:

```jsonc
"returnPolicy": {
  "eligible": true, "windowDays": 14, "refundType": "full", "refundPercentage": null,
  "returnShippingPayer": "vendor", "refundProcessingDays": 5, "conditionNotes": "Unworn"
}
```

Either block is `null` when the vendor has not configured one — no defaults are invented.
Full shape in [catalog.md](./catalog.md).

### 3e. §3.2 — the customer is **not** charged for delivery

This is the one that changes a screen, so please read it.

`POST /api/customer/cart/quote` exists and returns real figures. But `delivery` is **0** and
`total` is the **subtotal**, because the agency's delivery fee is charged to the **vendor**,
not the shopper: `splitOrder` computes `vendorNet = gross − commission − deliveryTotal` off
the items subtotal. Adding it to the customer's total as well would collect it twice.

```jsonc
{
  "subtotal": 24000,
  "delivery": 0,              // what the CUSTOMER pays for delivery
  "absorbedByVendor": 1500,   // what the VENDOR pays the agency — informational
  "tax": 0, "discount": 0,
  "total": 24000
}
```

So: **render "Delivery included"**, and use `absorbedByVendor` only if you want to show the
seller covering it. Do not add it to a total.

Moving delivery onto the customer is a business-model decision, not a display change — it has
to be paired with `splitOrder` no longer deducting it. Say the word and it is a small, careful
change; it was not ours to make unilaterally.

`tax` and `discount` are pinned zeros (no tax engine, no coupon model) and are present rather
than absent so your receipt does not change shape the day either arrives. The same figures are
written into the order's `price_breakdown`, so the quote and the charge cannot diverge.

### 3f. §2.8.2 was misdiagnosed — there was nothing to fix at the cart

You wrote that `CartService.addToCart` never checks product status, citing
`grep -n "status" cart.service.ts` returning nothing.

It does check. `addToCart` calls `PriceResolverService.execute`, which raises
`422 CATALOG_PRODUCT_INVALID_STATE` for a non-active product and `422 CATALOG_VARIANT_ARCHIVED`
for an archived variant. The grep missed it because the check is one call away.

The **real** gap was one step later: a product drafted *after* it was added to a cart was
never re-checked at checkout. Stock reservation closed that — reservation re-validates
`status === 'active'` at reserve time.

Your other two §2.8 defects were both real and are both fixed (see §5).

---

## 4. The one thing we could not build as asked

**§3.1 — the `StockReservation` family could not be wired as written.** It would have
destroyed inventory.

`reservePhysicalStock` decremented `variant.stock` at *reserve* time. The model carries a TTL
index that **deletes** an expired reservation row — and only `StockReleaseService` restored
stock, which can never run on a row that no longer exists. Every abandoned checkout would have
permanently eaten its units, silently, with no record. It also double-counted against
`InventoryAvailabilityCalculator`'s `stock − activeReservations`, which is only correct if
`stock` means physically-on-hand.

We corrected the semantics first, then wired it:

| Stage | `variant.stock` | reservation row |
|---|---|---|
| **reserve** (checkout) | untouched | `active`, 30-minute hold |
| **commit** (payment success; COD at order *creation*) | decremented **once** | `committed` |
| **release** (cancel) | untouched | `released` |
| **expiry** | untouched | deleted; availability self-heals |

**What you see:**

- Checkout can now fail with `422 CATALOG_INSUFFICIENT_STOCK` and
  `details: { variantId, sku, requested, available }`. `available` is what the shopper can
  actually buy — `stock` minus what other in-flight checkouts hold — not the raw counter.
  Surface the line and the number; it is a real, actionable message.
- Adding to a cart still reserves nothing. A cart is not a claim on inventory. The hold starts
  at checkout and lapses on its own after 30 minutes.
- `inStock` on the public API remains a **boolean**, exactly as you asked. Now that the number
  is real we could publish a count — but on a 5-minute-cached page it would be wrong the
  moment it is read, so we did not. Ask if you want it on the product detail specifically.

---

## 5. The three §2.8 defects

| | Status |
|---|---|
| **2.8.1** Unauthenticated booking availability leaked draft/suspended products' calendars | ✅ Fixed — now 404s, using the same visibility predicate as the catalog |
| **2.8.2** Cart-add accepts non-active products | ⚠️ Did not exist — see §3f. The checkout-time gap it pointed at is closed |
| **2.8.3** Physical checkout succeeds with no address | ✅ Fixed — `422 ORDER_DELIVERY_ADDRESS_REQUIRED` |

**On 2.8.3, your subtler observation was the important one.** `resolveDeliveryAddress` returns
`chosen.geo ?? null`, so an address the customer *explicitly selected* still yielded null if
they typed it by hand rather than picking it from `GET /api/geo/search`. `details.reason`
distinguishes the two cases so you can respond correctly:

- `no_delivery_address` → prompt them to add or choose one
- `selected_address_not_geocoded` → reopen the address picker for the address they already chose

**Catch this before the pay button:** send `deliveryAddressId` to
`POST /api/customer/cart/quote` and it validates the address with the same rule, raising the
same code. That is the main reason the parameter exists.

---

## 6. Cart — one path shape you should know

Your #6 asked for `DELETE /api/customer/cart/items/:variantId`. We put it at
**`DELETE /api/customer/cart/items/variant/:variantId`**.

The product-keyed route is a live, documented endpoint we could not remove, and two DELETEs on
one path shape — distinguished only by which kind of id you happened to send — is a footgun: a
client sending a productId where a variantId was meant would get a silent mass-delete instead
of an error. The literal segment makes the key explicit.

```
PATCH  /api/customer/cart/items/:variantId          set an ABSOLUTE quantity (the stepper)
DELETE /api/customer/cart/items/variant/:variantId  remove ONE line   ← use this on a cart row
DELETE /api/customer/cart/items/:productId          remove EVERY variant (unchanged, back-compat)
POST   /api/customer/cart/merge                     the sign-in handover
POST   /api/customer/cart/quote                     price it
```

**On merge:** `quantity: 0` is refused on the PATCH (use DELETE — two intentions should not
share one call), and merge rejects any `price` in the body: every line is re-priced from the
catalogue, because a localStorage cart is client-controlled data. Dropped lines come back in
`meta.dropped[]` with a reason — please surface them; silently losing a line is what that
endpoint exists to prevent.

---

## 7. New error codes to mirror

Your §6.4 asked us to flag these for `src/lib/auth/backend-error-codes.ts`:

| Code | Status | Category | Where |
|---|---|---|---|
| `CART_ITEM_NOT_FOUND` | 404 | `not_found` | Cart PATCH/DELETE on a line that is not there |
| `ORDER_DELIVERY_ADDRESS_REQUIRED` | 422 | `business_rule` | Checkout and cart-quote |
| `AUTH_RESET_TOKEN_INVALID` | 400 | `validation` | Password reset |

`CATALOG_INSUFFICIENT_STOCK` (422) already existed in the registry but had **never been
raised** — it is now raised at checkout, so treat it as new for your union.

> `ORDER_DELIVERY_ADDRESS_REQUIRED` is deliberately **not** `ADDRESS_GEO_REQUIRED`, which
> already exists at **400**. The census test refuses one code carrying two categories, and
> these are genuinely different: that one is a malformed payload, this one is a business rule
> on a well-formed request.

---

## 8. Not built, and how to approach it

### Tier 3 (§4) — untouched

Reviews, wishlist, related products, coupons, back-in-stock alerts, returns/RMA. Nothing
exists. Keep `aggregateRating` omitted from JSON-LD; keep `/shop/saved` on `localStorage`.

Of these, **wishlist is by far the cheapest** — a three-endpoint CRUD on one collection, no
moderation, no money. If you want one thing from Tier 3 first, ask for that.

### §5.2 account management — 3 of 8 built

Built: password reset, address edit, push device registration.

**Not built:** email change + re-verify, phone change + re-verify, account
deletion/deactivation, data export, session list / revoke-other-devices.

None of these appear in your numbered §7 summary, so we read them as context rather than as
asks. If any is actually blocking a screen, say which and it can be scheduled — account
deletion is the one with real design weight (it interacts with order history, COD balances and
the vendor↔customer relation, so "delete" almost certainly has to mean "anonymise").

### `bargain` — a new field you will see and should ignore for now

A negotiable price range (`min`/`max` a buyer can haggle within) landed on `ProductVariant`
while this was being built. **It is not published**, pending a decision about whether the range
is buyer-facing or a vendor-side floor. Do not build against it yet; we will tell you when it
is public.

---

## 9. ✅ Resolved — `POST /api/auth/login` checks the password

An earlier revision of this changelog flagged that the login handler discarded
`bcrypt.compare`'s verdict. **That is closed.** `POST /api/auth/login` verifies the password,
and there is no environment variable that can disable the check.

What this means for you:

- **Dev or E2E flows that signed in with an arbitrary password need a real one.**
- Password reset now does what it says: `POST /api/auth/forgot-password` /
  `POST /api/auth/reset-password` are a genuine recovery path, and a reset revokes every other
  live session.

Everything downstream — session revocation on password change, suspension checks, the 20/min
credential bucket — was always sound and is now actually reached. See
[auth/README.md](../auth/README.md).

> Note that a **customer** still cannot sign in this way unless they have run a password reset:
> they hold a system-generated password nobody knows, and their sign-in is the bot flow. See
> [auth/customer-auth.md](../auth/customer-auth.md).

---

## 10. Environment & operations

- **CORS was already configured.** Your §6.2 said `ALLOWED_ORIGINS` was unset in
  `backend/jovi-mall/.env`. It is set, and includes `http://localhost:3000`. Nothing to do.
- **`/api/public/*` now has its own rate-limit bucket** (`RATE_LIMIT_PUBLIC_PER_MIN`, default
  3000/min per IP) **on top of** the global 1200/min backstop, so the effective ceiling is the
  lower of the two. It exists because your grid puts two calls on this prefix per page view,
  and without separate counters an anonymous crawler behind an office NAT would 429 the
  signed-in shoppers beside it. This is your §6.1 "decide, rather than discovering it under
  load" — decided.
- **Run `npm run migrate:storefront-indexes` before any deploy.** `autoIndex` builds the new
  indexes too, but *silently* — a failed `$text` build leaves every storefront search scanning
  the collection with no error anywhere.

## 11. Verification you can rely on

- `npm run test:public-catalog` (86) — visibility rules and projections. Its core is a set of
  **leak assertions**: the DTOs are built from documents carrying `vendorId`, suspension notes,
  vendor pickup-address ids and vectorisation state, and the serialised output is asserted to
  contain none of it. `/api/public/*` has no auth guard, so those projections *are* the access
  control.
- `npm run test:storefront-checkout` (50) — stock semantics and the cart write contract.
- `npm run verify:storefront` (28, needs Mongo) — proves the indexes actually build, every
  aggregation runs, a `pending_verification` vendor is published while a suspended one is not,
  and the route tables resolve in the right order.
