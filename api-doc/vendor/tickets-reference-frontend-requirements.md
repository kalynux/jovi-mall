# Ticket entity pickers — `reference/*`

> **Status: DONE.** Every field and query parameter requested below has been implemented in
> `src/modules/tickets/services/ticket-reference.service.ts`. The frontend can drive both
> pickers from these two endpoints alone — no fallback to `/vendor/orders` + `/vendor/products`,
> and no per-order `GET /vendor/orders/:id` for tracking numbers. This page is kept as the
> record of *why* the two endpoints carry the fields they do, and now documents what they
> actually return.

Context: the "New ticket" form has three pickers — **ticket type**, **related-to**, and
**entity** (order/product) — plus a **tracking-number** selector for ORDER tickets.

Both endpoints are mounted under **every** role's ticket namespace with the same handlers
(`/api/{vendor,agency,agent,customer,admin}/tickets/reference/…`) and scope themselves from the
caller's role:

| Role | Orders it can reference | Products it can reference |
|---|---|---|
| `vendor` | its own orders | its own catalogue |
| `admin` | all | all |
| `agent` | orders it has a shipment on | products appearing in those orders |
| `agency` / `customer` | its own scope | products appearing in those orders |

---

## `GET /{role}/tickets/reference/orders`

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–50 | `20` | Capped at 50 to keep the lookup lightweight |
| `q` | string | — | Server-side search over **order number + customer name + tracking number**. Blank/whitespace is ignored. The term is escaped before it becomes a `$regex` |

### Response

> ⚠ This endpoint does **not** use the `{ success, data, meta }` envelope. It answers
> `{ success, data, pagination }` — the pagination block is called **`pagination`**, not `meta`.

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "664ord...",
      "orderNumber": "ORD-10241",
      "orderType": "physical",
      "fulfillmentStatus": "processing",
      "createdAt": "2026-08-02T09:11:00.000Z",
      "customerName": "Jane Doe",
      "customerAvatar": { "id": "…", "key": "…", "url": "https://…", "mimeType": "image/png",
                          "size": 24576, "originalName": "avatar.png" },
      "shipments": [
        { "shipmentId": "664shp...", "agencyId": "664agy...", "agencyName": "FastTrack Logistics",
          "agentId": "664agt...", "trackingNumber": "FDO-260730-142309-K7Q2M", "status": "in_transit" }
      ]
    }
  ],
  "pagination": { "total": 87, "page": 1, "limit": 20, "pages": 5 }
}
```

- `customerName` and `customerAvatar` are `null` when the customer cannot be resolved.
  `customerAvatar` is a full **FileDetail object**, not a URL string — the platform-wide
  convention.
- `agencyName` comes from the agency's **Magazin**, not the agency profile, and is `null` when
  no Magazin row resolves.
- **`shipments[]` is role-scoped**: an agency sees only its own shipments on the order, an agent
  only theirs. A vendor or admin sees all of them. So tracking options come inline with the
  selected order.

---

## `GET /{role}/tickets/reference/products`

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–50 | `20` | |
| `q` | string | — | Server-side search over **title + category + tags** |

### Response

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "664prd...",
      "title": "Wireless Earbuds",
      "slug": "wireless-earbuds",
      "category": "electronics",
      "tags": ["audio", "bluetooth"],
      "firstFileUrl": "https://.../images/2026/07/664file....jpg"
    }
  ],
  "pagination": { "total": 42, "page": 1, "limit": 20, "pages": 3 }
}
```

- `firstFileUrl` is the public URL of the product's **first** image, or `null`.
- Soft-deleted products are never returned.

---

## Related

- [tickets.md](./tickets.md) — the ticket payloads themselves
- [../ticket_types.txt](../ticket_types.txt) — the `TicketType` list the type picker renders
