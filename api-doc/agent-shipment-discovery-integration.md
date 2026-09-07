# Frontend Integration Guide — Agent Shipment Discovery

**Status:** shipped, backend-complete. **Audience:** whoever integrates the agent app (and the agency
dashboard, which is affected in two places).

Everything an agent needs to *find* a job, *judge* it, and *navigate* it. Four capabilities:

1. **Search** the shipment list by customer, product, order number or tracking number.
2. **Earning** — what a delivery pays this agent, visible *before* they accept.
3. **Addresses** — pickup and drop-off, with coordinates, on every list row and detail.
4. **Route** — a road-following line from pickup to drop-off, ready to draw on a map.

Per-endpoint reference lives in [`agent/shipments.md`](./agent/shipments.md),
[`agent/offers.md`](./agent/offers.md) and [`agency/shipments.md`](./agency/shipments.md). This file
is the migration view: what changed, what breaks, and what to handle.

> **This guide covers shipment discovery only.** A **later** change set (2026-07-29) touched the
> agent's *own record* — the settings endpoint moved, a phantom capacity field went away, and two
> dead preference flags were removed. If you are building the profile/settings screens, read
> [`agent/profile.md`](./agent/profile.md) as well; its breaking-change table is the migration view
> for that half. Nothing below is affected by it.

---

## 1. Endpoints touched

| Endpoint | Change |
|---|---|
| `GET /api/agent/shipments` | ➕ `q` param · ➕ `pickup`, `deliveryAddress`, `earning`, `earningUnavailable` per row |
| `GET /api/agent/shipments/:id` | ⚠️ **breaking** (2 fields) · ➕ `orderValue`, `earning`, `earningUnavailable`, `pickup` |
| `GET /api/agent/shipments/:id/route` | 🆕 **new endpoint** |
| `GET /api/agent/offers` | ➕ `q` param · ➕ 10 fields per offer · ⚠️ customer PII now redacted while pending |
| `GET /api/agent/offers/:id` | same as the list — identical enriched shape |
| `GET /api/agency/shipments` | ➕ `q` param · ➕ `pickup`, `deliveryAddress` per row |
| `GET /api/agency/shipments/:id` | ⚠️ **breaking** (same 2 fields) · ➕ `orderValue`, `pickup` |

No endpoint was removed or renamed. No field was removed.

---

## 2. Breaking changes — fix these first

Only **two fields** changed shape, both on the shipment **detail**, and both hit the agent app *and*
the agency dashboard (they share one builder).

### 2.1 `items[].pickupLocation.address`

It used to leak two different raw database shapes depending on how the item is fulfilled. It is now
one uniform `AddressDetail` in both cases.

```jsonc
// BEFORE — mode: "pickup_based"          // BEFORE — mode: "storage_based"
{                                          {
  "label": "Main store",                     "label": "HQ",
  "address_line1": "Rue 1234",               "address_description": "Rue Njo-Njo",
  "address_line2": null,                     "region": "Littoral",
  "city": "Douala",                          "city": "Douala",
  "state": "Littoral",                       "support_contact": "+2376...",
  "geo": { /* GeoAddress */ }                "location": { /* GeoJSON */ },
}                                            "geo": { /* GeoAddress */ }
                                           }

// AFTER — both modes, identical
{
  "label": "Main store",
  "formattedAddress": "Rue 1234, Akwa, Douala",
  "addressLine1": "Rue 1234",
  "addressLine2": null,
  "city": "Douala",
  "state": "Littoral",
  "country": "Cameroon",
  "coordinates": { "lat": 4.0511, "lng": 9.7043 }
}
```

**What to change:** `address.address_line1` → `address.addressLine1`, `address.address_description` →
`address.addressLine1`, `address.region` → `address.state`. If you were branching on `mode` purely to
read different field names, **delete that branch** — `mode` now only tells you *who holds the parcel*
(`alreadyInYourStorage` says the same thing). `support_contact` is no longer returned; it was never
part of an address.

### 2.2 `handover.pickup`

Was a raw snake_case sub-document; is now the same envelope as everything else.

```jsonc
// BEFORE
"handover": {
  "pickup": {
    "source": "previous_agent_location",
    "label": "Handover with Jean",
    "address": { "line1": "Rue Joffre", "line2": null, "city": "Douala", "state": "Littoral", "country": null },
    "location": { "type": "Point", "coordinates": [9.7043, 4.0483] },
    "geo": { /* GeoAddress */ },
    "note": null,
    "is_fallback": false
  },
  "fromAgentId": "...", "fromStatus": "picked_up", "reassignedAt": "..."
}

// AFTER
"handover": {
  "pickup": {
    "source": "previous_agent_location",
    "address": { /* AddressDetail — label, coordinates and all fields folded in */ },
    "note": null,
    "isFallback": false
  },
  "fromAgentId": "...", "fromStatus": "picked_up", "reassignedAt": "..."
}
```

**What to change:** `pickup.label` → `pickup.address.label` · `pickup.address.line1` →
`pickup.address.addressLine1` · `pickup.location.coordinates` (`[lng, lat]`) →
`pickup.address.coordinates` (`{ lat, lng }`, already flipped) · `pickup.is_fallback` →
`pickup.isFallback`. `source` is unchanged.

### 2.3 Behaviour change — `customer.deliveryAddress` (not a compile break, but read this)

Every previous key still exists, so nothing crashes. But **the value can now be different**, and the
change is a bug fix you want:

- **Before:** the customer's *current default saved address*, read live.
- **After:** the address geocoded and snapshotted **at checkout** — the address they actually ordered
  to. It no longer changes when the customer edits their profile mid-delivery.

It also gained `formattedAddress` and `coordinates`. Only orders predating the snapshot fall back to
the saved default.

---

## 3. Shared types

Copy these into the frontend. All three appear across several endpoints.

```ts
/** Every address this API returns, everywhere. */
interface AddressDetail {
  label: string | null;
  /** Geocoder's one-liner, or composed from the stored fields. Best for display. */
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  /** null on legacy addresses never geocoded — ALWAYS handle this. */
  coordinates: { lat: number; lng: number } | null;
}

/** Where the parcel is collected. */
interface Pickup {
  address: AddressDetail | null;
  /**
   * pickup_based  — collect from the vendor
   * storage_based — already in the agency's warehouse
   * mixed         — both, on one shipment
   * null          — no pickup could be resolved (legacy order)
   */
  mode: 'pickup_based' | 'storage_based' | 'mixed' | null;
  /** Distinct pickup points. Usually 1; >1 means several stops. */
  count: number;
}

/** What the delivery pays THIS agent. */
interface Earning {
  /** Minor units. 0 is a real answer — see below. */
  amount: number;
  currency: string;
  /** Always true. Never present this as a guaranteed amount. */
  estimated: true;
  /** The whole delivery fee this cut comes out of. */
  deliveryFee: number;
  basis: 'contract_percentage' | 'contract_flat';
}

type EarningUnavailable = 'no_contract' | 'no_agency_policy' | null;
```

`earning` and `earningUnavailable` are **mutually exclusive**: exactly one is non-null.

---

## 4. Search (`q`)

Available on `GET /api/agent/shipments`, `GET /api/agent/offers`, `GET /api/agency/shipments`.
One input box, one term, matched against **all** of:

| Matched against | Example query |
|---|---|
| Customer **name** | `?q=marie` |
| Customer **phone** (substring) | `?q=670123` |
| **Product** title on this shipment | `?q=samsung` |
| **Order number** | `?q=ORD-2026-000123` |
| **Tracking number** | `?q=FDO-260730` |

Rules the UI must respect:

- **Minimum 2 characters.** A 1-char `q` returns **400** (Zod validation). Debounce and don't fire
  until `q.trim().length >= 2`, or the user gets an error toast while typing.
- Max 100 characters.
- Case-insensitive substring match. Regex characters are escaped server-side — `q=(` is safe.
- Combine freely with `status` and pagination; they AND together.
- **There is no "shipment number."** A shipment is identified by its `trackingNumber` — generated by
  the platform at creation, so **always present** (`ACR-YYMMDD-HHMMSS-XXXXX`, e.g.
  `FDO-260730-142309-K7Q2M`) — or by its parent `orderNumber`. Label the search box accordingly —
  "Search by customer, product, order # or tracking #" is honest; "shipment number" is not. Since the
  number is prefixed by agency and date, partial terms (`FDO-2607`) are useful searches.
- A term matching an unusually broad set is capped at the first 500 customers/products/orders. Users
  will not hit this with a real name or phone fragment.

---

## 5. Endpoint reference

### 5.1 `GET /api/agent/shipments`

```
?status=picked_up&q=marie&page=1&limit=20
```

Existing fields unchanged. New per row:

```jsonc
{
  "...": "id, orderId, status, orderNumber, vendor, customer, itemCount, …",
  "itemImages":      [ /* FileDetail[] — ≤3 item thumbnails, deduped; [] when none */ ],
  "pickup":          { "address": { /* AddressDetail */ }, "mode": "pickup_based", "count": 1 },
  "deliveryAddress": { /* AddressDetail | null */ },
  "earning":         { "amount": 1200, "currency": "XAF", "estimated": true, "deliveryFee": 2000, "basis": "contract_percentage" },
  "earningUnavailable": null
}
```

The list is now enough to render a full job card — no detail fetch needed to show where it goes,
what it pays, or what it looks like.

`itemImages` is a capped thumbnail stack (one picture per item, deduped, ≤3) — `itemCount` stays the
true item count. Each entry is `{ id, key, url, access, mimeType, size, originalName }`. The picture is the
sold **variant's** image where it has one, else the product's first image, and it is resolved **live**
from the catalog rather than snapshotted onto the order — so a vendor replacing their photo changes
what the agent sees, and an item whose media was removed simply has none.

### 5.2 `GET /api/agent/shipments/:id`

Breaking changes in §2. New fields:

```jsonc
{
  "orderValue":         { "total": 52000, "currency": "XAF" },
  "earning":            { /* Earning | null */ },
  "earningUnavailable": null,
  "pickup":             { /* Pickup — summary of items[].pickupLocation */ },
  "items": [ { "...": "orderItemId, productId, quantity, title, sku, variantTitle, pickupLocation",
               "images": [ /* FileDetail[] — EVERY picture, thumbnail first; [] when none */ ] } ]
}
```

The detail is the only place that returns the **whole gallery**: it is the screen an agent is on
while matching a parcel on a counter to their job, and one angle often will not separate two boxes.
`items[].images[0]` is the same picture the list and the offer show for that item, so one thumbnail
component serves all three.

⚠️ **`orderValue` ≠ `cod.expectedAmount`.** `orderValue` is the whole order; `cod.expectedAmount` is
the cash *this shipment's* agent collects. An order can split into several shipments across different
agencies. Never label `orderValue` as "cash to collect".

`pickup` summarises `items[].pickupLocation` into the one place the agent drives to. The per-item
breakdown stays in `items` — show it when `pickup.count > 1`.

### 5.3 `GET /api/agent/shipments/:id/route` 🆕

```jsonc
{
  "success": true,
  "data": {
    "origin":      { /* AddressDetail */ },
    "destination": { /* AddressDetail */ },
    "waypoints":   [ /* AddressDetail[] — extra pickups when count > 1 */ ],
    "source": "road",
    "reason": null,
    "distanceMeters": 2300.4,
    "durationSeconds": 540.2,
    "geometry": [ { "lat": 4.0511, "lng": 9.7043 }, { "lat": 4.0333, "lng": 9.7000 } ]
  }
}
```

`geometry` is an ordered polyline in `{ lat, lng }` — feed it straight to the map. Branch on `source`:

| `source` | What to render |
|---|---|
| `road` | The real route. `distanceMeters` and `durationSeconds` are road values — show both. |
| `straight` | Draw the line, show the distance, **hide the ETA** — `durationSeconds` is `null` by design (a straight-line ETA would be a guess). Optionally mark it "approximate". |
| `unavailable` | `geometry` is `[]`. Show the addresses as text; check `reason` (`missing_pickup_coordinates` / `missing_delivery_coordinates`) to explain which end can't be mapped. |

This endpoint **never fails because the tracking service is down** — it degrades to `straight`. Only
`404` (not this agent's shipment / order gone) is an error.

> **You may not need it.** The detail already returns `coordinates` on both addresses, so a plain
> straight line needs no extra request. Call `/route` when you want real road geometry.

### 5.4 `GET /api/agent/offers` and `/api/agent/offers/:id`

**This is the important one.** The offer is where an agent accepts or declines, and it previously
returned bare IDs — no order number, no customer, no products, no addresses, no money. The shipment
was unreadable until after accepting, so the decision was blind. It now carries:

```jsonc
{
  "...": "id, shipmentId, status, origin, expiresAt, isCod, expectedCodAmount, score, …",

  "orderNumber": "ORD-2026-000123",
  "shipmentStatus": "assigned",
  "itemCount": 2,
  "items": [ { "productId": "...", "quantity": 1, "title": "Wireless Headphones", "variantTitle": "Black",
               "image": { /* FileDetail | null — the thumbnail only */ } } ],
  "vendor": { "id": "...", "businessName": "TechHub Douala", "phone": "+2376..." },
  "customer": { "name": "Marie", "phone": null, "redacted": true },
  "pickup": { /* Pickup */ },
  "deliveryAddress": { /* AddressDetail | null */ },
  "orderValue": { "total": 25000, "currency": "XAF" },
  "earning": { /* Earning | null */ },
  "earningUnavailable": null
}
```

**Customer privacy while pending** — new behaviour, must be handled:

| | `pending` (and every non-accepted status) | `accepted` |
|---|---|---|
| `customer.name` | **first name only** — `"Marie"` | full name |
| `customer.phone` | `null` | full number |
| `customer.redacted` | `true` | `false` |
| `deliveryAddress` | city / region / country + **coordinates**; `addressLine1` and `label` are `null` | full street address |
| `pickup`, `items` (`image` included), `orderValue`, `earning` | full | full |

Why: auto-assignment broadcasts one shipment to several agents at once and keeps earlier offers
standing, so everyone who *declines* would otherwise keep the customer's name, phone and street.
Product images are deliberately **not** redacted — what is being shipped is exactly what the agent is
being asked to decide about (does it fit the vehicle?), unlike who is receiving it and where.

**UI rule:** never render a "call customer" button when `customer.redacted === true` — the phone is
`null`. Accepting reveals everything immediately; re-fetch the offer (or go to the shipment detail)
after a successful accept.

### 5.5 Agency endpoints

`GET /api/agency/shipments` gains `q` plus `pickup`, `deliveryAddress` and `itemImages` per row.
`GET /api/agency/shipments/:id` gains `orderValue`, `pickup` and `items[].images`, and carries **both
breaking changes from §2**.

`earning` is deliberately **absent** from every agency response — it is a specific agent's contracted
cut, not agency-scoped data.

---

## 6. Null-handling rules

The four cases that will otherwise produce `undefined` in the UI:

| Field | When it's null | Render as |
|---|---|---|
| `AddressDetail.coordinates` | Address was never geocoded (legacy data) | Text address only; disable "open in maps" and map pins |
| `pickup.address` / `deliveryAddress` | Legacy order with no pickup snapshot and no saved address | "Address unavailable" — don't crash on `.city` |
| `earning` | `earningUnavailable` is non-null | `no_contract` → "No active contract with this agency"; `no_agency_policy` → "Agency pricing not configured" |
| `earning.amount === 0` | **Not null — a real answer.** The contract's `fee_split` pays nothing (commonly one never configured) | Show "0" honestly. Do **not** hide it or treat it as missing — a silent blank is how an agent finds out at payout instead |

Prefer `formattedAddress` for display and fall back to composing from parts; it is populated even for
non-geocoded addresses.

---

## 7. What to build

Suggested, not prescriptive:

- **Shipment list** — search box (debounced, ≥2 chars) + per-row job card showing pickup city →
  drop-off city, `itemCount`, the earning amount, and the `itemImages` thumbnail stack. Badge when
  `pickup.count > 1` ("2 stops").
- **Offer card** — the accept/decline screen. Lead with `earning.amount`, then products (with
  `items[].image`), then pickup → drop-off distance. Redacted customer block. For `origin: "auto"` do
  **not** count down to `expiresAt` as a hard deadline (see [offers.md](./agent/offers.md) on the
  broadcast lifecycle).
- **Shipment detail** — map from `/route`, addresses with "navigate" actions, `orderValue` and
  `earning` clearly separated from `cod.expectedAmount`, and a swipeable `items[].images` gallery for
  identifying the parcel.
- **Earning label** — always mark it estimated. The agency's pricing and the contract split are
  re-read when money is actually divided.

---

## 8. Integration checklist

- [ ] Rename `items[].pickupLocation.address` fields (§2.1) — **agent + agency detail**
- [ ] Rename `handover.pickup` fields (§2.2) — **agent + agency detail**
- [ ] Confirm nothing depended on `customer.deliveryAddress` being the customer's *current* address (§2.3)
- [ ] Add `AddressDetail` / `Pickup` / `Earning` types (§3)
- [ ] Search box: debounce, enforce ≥2 chars client-side, avoid the word "shipment number" (§4)
- [ ] Handle `coordinates: null` everywhere a map pin or "navigate" action is rendered (§6)
- [ ] Handle `earning: null` + the two `earningUnavailable` reasons; render `amount: 0` as zero (§6)
- [ ] Label `orderValue` distinctly from `cod.expectedAmount` (§5.2)
- [ ] Offer screen: hide call/contact actions when `customer.redacted === true` (§5.4)
- [ ] Re-fetch after accept to pick up the revealed customer details (§5.4)
- [ ] Map view: branch on `route.source`; hide ETA when `straight`, handle `unavailable` (§5.3)

---

## 9. Backend notes worth knowing

- **The earning is an estimate by construction.** The agency's `policies.pricing` and the contract's
  `fee_split` are re-read when the money is actually divided, so a change in between changes the
  payout. Where a shipment already carries a fee snapshot the quote uses it and is exact — but the
  API does not distinguish the two cases, so treat every figure as estimated.
- **Both payment methods quote an earning.** COD pays off the cash handoff, online-paid at
  `agent_delivered` — different moments, same contracted share of the same delivery fee.
- **The route degrades, never fails.** geo-tracker is off the critical path by contract; a delivery
  must work when it is down.
- **PII reveal is configurable.** `SHIPMENT_ASSIGNMENT_OFFER_PII_REVEAL=on_offer` shows everything on
  pending offers. Default is `on_accept`. If that is flipped, `customer.redacted` becomes `false`
  throughout — so **branch on `redacted`, never on `status === 'accepted'`**.
