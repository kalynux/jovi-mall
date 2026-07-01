# Ticket entity pickers — fields needed from `reference/*`

Context: the "New ticket" form has three pickers — **ticket type**, **related-to**, and
**entity** (order/product) — plus a **tracking-number** selector for ORDER tickets.

The purpose-built `GET /vendor/tickets/reference/orders` and `reference/products`
endpoints are the right home for the entity pickers, but they currently return too few
fields, so the frontend falls back to the heavier `/vendor/orders` + `/vendor/products`
(for display + search) and a per-order `GET /vendor/orders/:id` call (for tracking
numbers). If the additions below are made, the frontend can use **only** the two
`reference/*` endpoints and drop the extra calls.

---

## `GET /vendor/tickets/reference/orders`

**Returns today:** `id`, `orderNumber`, `orderType`, `fulfillmentStatus`, `createdAt`,
`shipments[] = { shipmentId, agencyId, agentId, trackingNumber, status }`.

**Please add:**

| Field | Type | Why the picker needs it |
|---|---|---|
| `customerName` | string | Flat top-level field on each order item. Order rows show the **customer name** as the primary line, and the selected chip shows customer name + order number. Not derivable from the current payload. |
| `shipments[].agencyName` | string | An order can span several shipments/agencies. Each tracking number must be labelled with **the agency in charge of that shipment**. Only `agencyId` is returned today. |
| `q` (query param) | string | The picker is a **search** box. Needs server-side search over **order number + customer name** (tracking number too, if cheap). No search param exists today. |

**Nice to have:** `customerAvatarUrl` (row thumbnail).

With `shipments[].trackingNumber` + `agencyName` + `status` present, tracking options
come **inline** with the selected order — no `GET /vendor/orders/:id` needed.

---

## `GET /vendor/tickets/reference/products`

**Returns today:** `id`, `title`, `slug`.

**Please add:**

| Field | Type | Why the picker needs it |
|---|---|---|
| `category` | string | Shown as the product row's secondary line. |
| `tags` | string[] | Shown on the row and used for search. |
| `firstFileUrl` | string \| null | Row **thumbnail** — URL of the first product image (or `null`). |
| `q` (query param) | string | Server-side search over **title + category + tags**. |

---

## Notes
- Both endpoints already accept `page`/`limit` (max 50) — that's fine for the picker's
  base window; a `q` param lets us drop the current client-side filtering workaround.
- Response envelope/pagination shape can stay exactly as documented; these are additive.
