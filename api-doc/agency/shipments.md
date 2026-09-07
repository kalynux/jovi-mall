# Agency Shipments

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

## Endpoints

- [`GET /api/agency/shipments`](#list) — shipments assigned to this agency
- [`GET /api/agency/shipments/:id`](#detail) — full shipment detail
- [`PATCH /api/agency/shipments/:id/status`](#status) — advance a shipment (picked up, in transit, delivered by agent, failed/retry)
- [`POST /api/agency/shipments/:id/reject`](#reject) — decline an assigned shipment
- [`PATCH /api/agency/shipments/:id/assign-agent`](#assign-agent) — **offer** the shipment to one of this agency's agents (agent-acceptance workflow)
- `GET /api/agency/shipments/:id/delivery-proof/file` — the proof photograph's **bytes**, scoped exactly like `GET /:id` (not yours, or no proof: **404**, never 403)

> ⚠ **The agency has ONE delivery-proof route, not the agent's four.** The bytes are readable;
> the *metadata* is not a separate endpoint on this side — it arrives as `deliveryProof` on
> [`GET /api/agency/shipments/:id`](#detail). Attaching and removing a proof are the agent's
> (`agent.routes.ts`), and there is no agency equivalent by design: the agency did not take the
> photograph. See [agent/delivery-proof.md](../agent/delivery-proof.md) for the full shape.
>
> Added here **2026-09-06** (DOC-PROGRAM F-17 class 6): the route was served and appeared on
> neither this page nor [assignment.md](assignment.md), only in a changelog.

> **The tracking number is generated, not recorded.** `PATCH /api/agency/shipments/:id/tracking-number`
> **no longer exists** — see [Tracking number](#tracking-number) below. Every shipment is stamped with
> one the moment it is created, and it is read-only on every endpoint.

> **Assignment is now an offer, not a push.** `assign-agent` creates an offer the agent must accept
> (accept / reject / ignore-timeout), and the shipment gains an `agent_id` only on acceptance. The
> full assignment surface — manual offer, auto-assignment, candidate preview, offer cancellation, and
> the auto-assignment toggle — is documented in [assignment.md](assignment.md); the agent's side is
> [agent/offers.md](../agent/offers.md).

Ownership is enforced at the query level on every endpoint below — an agency can only see/act on
shipments whose `agency_id` matches its own. A shipment outside the agency's scope is reported as
`404 SHIPMENT_NOT_FOUND` (existence of other agencies' shipments is never leaked).

> **Visibility gate.** A shipment is created (status `pending`) the moment the customer checks
> out — **before payment, before any vendor review.** Every endpoint here (list, detail, and every
> action) treats a `pending` shipment as if it doesn't exist yet. It only becomes visible once the
> vendor explicitly dispatches the paid order via
> [`POST /api/vendor/orders/:id/dispatch`](../vendor/orders.md#dispatch) (or the vendor has
> `auto_redirect_orders_to_agency` enabled, which does the same thing automatically on payment).
> This is the vendor's review/approval step before an order reaches the agency's dashboard.

---

## Shipment status lifecycle

```
pending → assigned → picked_up → in_transit → agent_delivered → delivered
                  ↘ rejected                ↘ failed → in_transit (retry)
                                                      ↘ returned
          ↘ pending_agency_reassignment (admin agency-deactivation cascade only)

  (agent → agent reassignment, POST .../reassign — see agency/assignment.md)
    assigned                                   → assigned      (pre-pickup: back to queue)
    picked_up / in_transit / failed / returned → handing_over → picked_up (new agent picks up)
                                                               ↘ returned  (handover abandoned)
```

> **Two actors drive this state machine, by the same rules.** The agency does, via `PATCH
> .../status` below; the assigned **agent** does too, via
> [`POST /api/agent/shipments/:id/status`](../agent/shipments.md#status). The transition table is
> **identical** for both — including `handing_over`, so a replacement agent records their own pickup
> after a reassignment. What differs is ownership (your `agency_id` vs their `agent_id`), the
> optional failure reason only the agent may attach, and
> `status_history[].changedByRole`, which records which of you it was.
>
> Either may act at any moment, so both endpoints write through a from-status compare-and-set: the
> loser of a race gets `409 SHIPMENT_STATUS_CONFLICT` and must reload before retrying.

| Status | Set by | Meaning |
|---|---|---|
| `pending` | System | Shipment created at checkout; not yet handed to the agency. **Invisible to the agency.** |
| `assigned` | **Vendor** (dispatch) or System (auto-redirect) | Order paid and dispatched; the agency now owns this shipment — first status the agency can see. |
| `handing_over` | System (`POST .../reassign`, post-pickup) | A picked-up parcel was reassigned off its agent and is being handed over to a replacement. Trackable (the replacement is tracked once they accept), non-terminal — resolves when the new agent sets `picked_up` (or `returned` if the handover is abandoned). **The replacement agent can record that pickup themselves**, from the agent app, just like a first-assigned shipment. See [agency/assignment.md](./assignment.md#reassign). |
| `picked_up` | **Agency** or **agent** | Physically picked up / pulled from storage. |
| `in_transit` | **Agency** or **agent** | Out for delivery. |
| `agent_delivered` | **Agency** or **agent** | Agent reports delivered — **awaiting customer confirmation**. |
| `delivered` | **System** (customer confirms, or the 7-day sweep) | Terminal, and neither an agency nor an agent can set it directly. **Prepaid:** the customer confirms via [`POST …/confirm-delivery`](../customer/orders.md#confirm-shipment), or the sweep does it for them after 7 days at `agent_delivered`. **COD:** the agent submits the customer's delivery code, or — after 7 days at `agent_delivered` — the sweep records the cash as collected without one. COD never reaches `delivered` without a cash collection behind it. |
| `failed` | **Agency** or **agent** | A delivery attempt failed (e.g. customer unreachable). Non-terminal — the parcel is still with the agent. When the **agent** reports it they may attach a reason + note, appended to the shipment's `deliveryFailures` log; the agency endpoint records none. |
| `returned` | **Agency** or **agent** | Terminal. Goods returned after a failed attempt. Same optional agent-supplied reason as `failed`. |
| `rejected` | **Agency** (`POST .../reject`) | Terminal for this shipment. Agency declined the assignment; its items move to `pending_agency_reassignment` for the vendor to reroute. |
| `pending_agency_reassignment` | System | Awaiting a new agency (rejection, or admin deactivated this agency). |

Every status change is appended to `status_history` (`{ status, changedAt, changedByRole }`),
which feeds the merged multi-agency timeline returned on the [shipment detail](#detail) endpoint
and on the vendor's `GET /api/vendor/orders/:id` (`deliveryTimeline`).

Each status change also recomputes the parent order's `fulfillment_status` — see
[vendor/orders.md#fulfillment-lifecycle](../vendor/orders.md#fulfillment-lifecycle).

<a name="cod"></a>
### Cash-on-delivery (COD) shipments — different rules

For shipments belonging to a `cash_on_delivery` order (`paymentMethod` on both the
[list](#list) and the [detail](#detail); see [cod-cash-management.md](./cod-cash-management.md) for
the whole cash chain), three rules change:

1. **Visible before payment.** COD orders are unpaid until handoff by design, so the vendor
   dispatches them (or auto-redirect fires) at checkout — the shipment reaches your dashboard
   without any payment.
2. **An agent must have accepted before `picked_up`.** Under the agent-acceptance workflow this now
   holds for **every** shipment (not just COD): `picked_up` on a shipment no agent has accepted fails
   with `SHIPMENT_AGENT_NOT_ASSIGNED`. For COD the agent is also the cash-accountable party, and the
   COD cash-exposure/trust gate is enforced when the offer is made and re-checked on acceptance
   (see [assignment.md](assignment.md)). The customer's delivery code is issued **at acceptance**
   (not at pickup) — they hold it before the agent reaches the door.
3. **`agent_delivered` is ACCEPTED and expected; only `delivered` is refused.** `agent_delivered`
   means *"I am at the door"*, not *"this is delivered"* — for a COD shipment it is a deliberate
   **dead end**, and reaching it is what raises the customer's delivery-code prompt
   (`shipment.service.ts:1421`). From there only the code moves it on: the agent submits it via
   `POST /api/agent/shipments/:id/cod/collect`, which atomically records the cash and marks the
   shipment `delivered`. (A 7-day sweep past the dispute window is the only other exit, and it is
   keyed on a COD shipment *sitting at* `agent_delivered`.) There is no customer app confirmation
   step for COD.

   > ⚠ **This rule read *"`agent_delivered` is rejected"* until 2026-09-06 and was inverted**
   > (DOC-PROGRAM F-43). A dashboard that hid or disabled the `agent_delivered` action for COD
   > shipments — the obvious reading — removed a legitimate agency action **and** removed the very
   > transition that causes the customer's code prompt to be raised, stalling the delivery.
   > `agent_delivered` is in `COLLECTIBLE_SHIPMENT_STATUSES`
   > (`cash-collection.service.ts:58`) alongside `picked_up` and `in_transit`.
   >
   > ⚠ **The refusal of `delivered` is real but its bespoke message is UNREACHABLE**
   > (DOC-PROGRAM F-44, a backend defect left unfixed). `shipment.service.ts:1219` throws
   > *"COD shipments are delivered by the agent submitting the customer delivery code"*, but two
   > layers refuse `delivered` first: it is absent from the Zod `z.enum` on both status endpoints
   > and from every `TRIGGERABLE_TRANSITIONS` value. A client sending `{"status":"delivered"}`
   > therefore gets a **generic** validation error that does not mention the delivery code. The
   > instruction has to come from this page, which is why it is spelled out above.

Both the [list](#list) and the [detail](#detail) carry a `cod` block for these shipments:
`{ expectedAmount, currency, status: "pending" | "collected" | "cancelled" | null, collectedAt }`
(never contains the customer's code). It is `null` on a prepaid shipment.

**`status` is `null` before an agent accepts**, and `expectedAmount` is then a **projection** rather
than a snapshot. The cash-collection record is only created at acceptance, so a shipment still out on
offer has no row to report — but that is exactly when you are choosing who to send, and how much cash
a delivery involves is part of that decision. The projected figure is Σ (item price × quantity), the
same arithmetic the collection will snapshot; treat a `null` status as "no agent has taken this yet".

---

<a name="list"></a>
### GET /api/agency/shipments

**Description**: Shipments assigned to this agency, newest first.

**Query Parameters**:
- `status` (string, optional) — filter by shipment status (see lifecycle table above).
- `q` (string, optional, **min 2 chars**, max 100) — free-text search over the customer's name and
  phone, the product titles on the shipment, the order number and the tracking number. Identical to
  the agent list's search — see [agent/shipments.md](../agent/shipments.md#list) for the full table.
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 100)

Each row also carries `pickup` (where the parcel is collected, with coordinates) and
`deliveryAddress` (the drop-off geocoded at checkout), plus the three money fields below. The
agent-facing `earning` field is **not** included here — it is that agent's contracted cut, not
agency-scoped data; `agencyEarning.agentCut` is the agency's view of the same number.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439100",
      "orderId": "507f1f77bcf86cd799439010",
      "agencyId": "507f1f77bcf86cd799439099",
      "agentId": null,
      "status": "assigned",
      "trackingNumber": "FDO-260705-090000-K7Q2M",
      "createdAt": "2026-07-05T09:00:00.000Z",
      "updatedAt": "2026-07-05T09:00:00.000Z",
      "orderNumber": "ORD-2026-000123",
      "paymentMethod": "cash_on_delivery",
      "cod": {
        "expectedAmount": 12500,
        "currency": "XAF",
        "status": null,
        "collectedAt": null
      },
      "agencyEarning": null,
      "agencyEarningUnavailable": "no_agent",
      "vendor": { "id": "507f1f77bcf86cd799439aaa", "businessName": "Acme Store", "phone": "+237670000001" },
      "customer": { "id": "507f1f77bcf86cd799439ccc", "name": "Jane Doe", "phone": "+237670000002" },
      "itemCount": 2,
      "itemImages": [
        { "id": "...", "key": "products/abc.jpg", "url": "https://…/products/abc.jpg", "access": "public", "mimeType": "image/jpeg", "size": 84213, "originalName": "tshirt.jpg" }
      ],
      "pickup": {
        "address": {
          "label": "Acme Warehouse",
          "formattedAddress": "12 Rue Njo-Njo, Bonapriso, Douala, Littoral, Cameroon",
          "addressLine1": "12 Rue Njo-Njo",
          "addressLine2": null,
          "city": "Douala",
          "state": "Littoral",
          "country": "Cameroon",
          "coordinates": { "lat": 4.0421, "lng": 9.7085 }
        },
        "mode": "pickup_based",
        "count": 1
      },
      "deliveryAddress": {
        "label": "Home",
        "formattedAddress": "Carrefour Ndokotti, Douala, Littoral, Cameroon",
        "addressLine1": "Carrefour Ndokotti",
        "addressLine2": null,
        "city": "Douala",
        "state": "Littoral",
        "country": "Cameroon",
        "coordinates": { "lat": 4.0611, "lng": 9.7359 }
      }
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

**`pickup`** and **`deliveryAddress`** are the shipment's two ends, both in the canonical address
shape. `pickup.mode` is `pickup_based` (collected from the vendor's business address),
`storage_based` (from this agency's own HQ), `mixed` (a shipment whose items come from both), or
`null` when nothing resolved; `pickup.count > 1` means `address` is only the first collection point
and the [detail](#detail) carries the rest. `coordinates` is `null` on legacy addresses that were
never geocoded — clients must handle it. For the map-shaped read of these same two ends across every
active shipment at once, see [live-tracking.md](./live-tracking.md).

<a name="money"></a>
**`paymentMethod`** is `"online"` or `"cash_on_delivery"` — whether the agent has to take money at
the door. **`cod`** is the cash to collect (see [COD shipments](#cod) above), `null` when prepaid.

**`agencyEarning`** is what this delivery is expected to pay **you**, with the agent's cut already
taken out. Present on the list and the [detail](#detail); itemised because each part moves
independently:

| Field | Meaning |
|---|---|
| `amount` | what you keep: `earnedFee − agentCut + codHandlingFee` |
| `deliveryFee` | the gross fee, before anything is carved out |
| `earnedFee` | what this run earns out of it — the same figure unless the shipment already **returned**, when it is your `rto_fee` instead |
| `agentCut` | the bound agent's share under their contract's `fee_split`. Legitimately `0` |
| `codHandlingFee` | your COD handling fee, kept whole and never shared. `0` on a prepaid shipment |
| `currency` | the contract's currency, else the order's |
| `estimated` | always `true` |
| `basis` | `contract_percentage` or `contract_flat` |

⚠️ **An estimate, not a promise.** The contract's `fee_split` is read live again when the money is
actually split, so renegotiating it between now and the delivery changes what is paid. A prepaid
shipment's `deliveryFee` is firm (it was snapshotted when the order was paid); a COD shipment's is
recomputed from your live `policies.pricing` at collection.

When it cannot be quoted, `agencyEarning` is `null` and **`agencyEarningUnavailable`** says why:

| Reason | Meaning |
|---|---|
| `no_agent` | no agent has accepted yet, so there is no `fee_split` to subtract. Quoting the gross fee here would show a number that drops the moment somebody accepts |
| `no_agency_policy` | your `policies.pricing` is not configured, so there is no delivery fee to divide |

Note that a **missing contract is not** a reason: `agentCut` is then `0` and you keep the whole fee,
which is a real answer and exactly what the split will do.

**`itemImages`** is a thumbnail preview of what is in the parcel: **one picture per item**,
deduplicated and capped at **3** — `itemCount` remains the true number of items. Each entry is the
standard file shape `{ id, key, url, access, mimeType, size, originalName }`; always an array, `[]` when
nothing on the shipment has a picture. The picture is the **variant's** own image where the variant
has one, otherwise the product's first image, and it is read **live** rather than snapshotted onto
the order — a vendor who replaces their photo changes what you see. The full per-item gallery is on
the [detail](#detail).

---

<a name="detail"></a>
### GET /api/agency/shipments/:id

**Description**: Full detail for one of the agency's own shipments — items (each with its own
pickup location, #3), vendor (#4), customer + delivery address (#5), assigned agent, status
history, and the parent order's merged multi-agency timeline.

`paymentMethod`, `cod`, `agencyEarning` and `agencyEarningUnavailable` mean exactly what they do on
the [list](#money). One field is detail-only: **`orderValue`** is the value of the **whole order**,
which is not the same as `cod.expectedAmount` — an order can split into several shipments across
several agencies, and `cod.expectedAmount` is only this shipment's share of the cash. Do not conflate
them.

The `vendor` block is present on **every** shipment, including one whose items were already sitting
in your own magazin (`pickup.mode: "storage_based"`) — `businessName` is the vendor's store name, and
who supplied the goods does not depend on where you collect them.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "orderNumber": "ORD-2026-000123",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": "507f1f77bcf86cd799439077",
    "status": "picked_up",
    "trackingNumber": "FDO-260705-090000-K7Q2M",
    "paymentMethod": "cash_on_delivery",
    "cod": {
      "expectedAmount": 12500,
      "currency": "XAF",
      "status": "pending",
      "collectedAt": null
    },
    "orderValue": { "total": 12500, "currency": "XAF" },
    "agencyEarning": {
      "amount": 1300,
      "currency": "XAF",
      "estimated": true,
      "deliveryFee": 1500,
      "earnedFee": 1500,
      "agentCut": 450,
      "codHandlingFee": 250,
      "basis": "contract_percentage"
    },
    "agencyEarningUnavailable": null,
    "items": [
      {
        "orderItemId": "507f1f77bcf86cd799439055",
        "productId": "507f1f77bcf86cd799439066",
        "quantity": 2,
        "title": "T-Shirt",
        "sku": "TSHIRT-RED-L",
        "variantTitle": "Size: Large, Color: Red",
        "images": [
          { "id": "...", "key": "products/abc.jpg", "url": "https://…/products/abc.jpg", "access": "public", "mimeType": "image/jpeg", "size": 84213, "originalName": "tshirt.jpg" },
          { "id": "...", "key": "products/def.jpg", "url": "https://…/products/def.jpg", "access": "public", "mimeType": "image/jpeg", "size": 91002, "originalName": "tshirt-back.jpg" }
        ],
        "pickupLocation": {
          "mode": "pickup_based",
          "alreadyInYourStorage": false,
          "address": { "label": "Main Shop", "addressLine1": "12 Rue du Marché", "addressLine2": null, "city": "Douala", "state": "Littoral" }
        }
      },
      {
        "orderItemId": "507f1f77bcf86cd799439056",
        "productId": "507f1f77bcf86cd799439067",
        "quantity": 1,
        "title": "Bulk Rice 25kg",
        "sku": "RICE-25KG",
        "variantTitle": null,
        "images": [],
        "pickupLocation": {
          "mode": "storage_based",
          "alreadyInYourStorage": true,
          "address": { "label": "HQ Warehouse", "city": "Douala" }
        }
      }
    ],
    "agency": {
      "id": "507f1f77bcf86cd799439099",
      "name": "Douala Express Logistics",
      "logo": { "id": "...", "key": "images/2026/07/logo.png", "url": "https://…/logo.png", "access": "public", "mimeType": "image/png", "size": 8213, "originalName": "logo.png" },
      "supportPhone": "+237670000009",
      "supportEmail": "support@douala-express.cm",
      "supportWhatsapp": null
    },
    "vendor": { "id": "507f1f77bcf86cd799439aaa", "businessName": "Acme Store", "phone": "+237670000001", "email": "acme@example.com" },
    "customer": {
      "id": "507f1f77bcf86cd799439ccc",
      "name": "Jane Doe",
      "phone": "+237670000002",
      "email": "jane@example.com",
      "deliveryAddress": {
        "label": "Home",
        "addressLine1": "12 Rue de la Paix",
        "addressLine2": null,
        "city": "Douala",
        "state": "Littoral",
        "country": "CM"
      }
    },
    "agent": { "id": "507f1f77bcf86cd799439077", "name": "Paul Biya Jr.", "phone": "+237670000003", "avatar": null },
    "handover": null,
    "statusHistory": [
      { "status": "assigned", "changedAt": "2026-07-05T09:00:00.000Z", "changedByUserId": null, "changedByRole": "system" },
      { "status": "picked_up", "changedAt": "2026-07-05T14:00:00.000Z", "changedByUserId": "507f...", "changedByRole": "agency" }
    ],
    "rejection": null,
    "customerConfirmation": null,
    "orderTimeline": [
      { "shipmentId": "507f1f77bcf86cd799439100", "agencyId": "507f1f77bcf86cd799439099", "agencyName": "FastShip Agency", "status": "assigned", "changedAt": "2026-07-05T09:00:00.000Z", "changedByRole": "system" },
      { "shipmentId": "507f1f77bcf86cd799439100", "agencyId": "507f1f77bcf86cd799439099", "agencyName": "FastShip Agency", "status": "picked_up", "changedAt": "2026-07-05T14:00:00.000Z", "changedByRole": "agency" }
    ]
  }
}
```

**`agency`** is the shipment's own agency — your business name, logo and support contacts, from your
magazin. It is here because the agency and agent detail views are one payload, and the agent (who
serves several agencies) needs it; on your own view it simply echoes you.

**`items[].images`** is **every** picture of that item, thumbnail first — enough to identify a parcel
by sight rather than by reading labels. `images[0]` is exactly the picture the list shows in
`itemImages` for the same item, so one thumbnail component serves both. Always an array, `[]` when
the item has no picture. Same selection and freshness rules as `itemImages` above (variant image
first, product image as fallback, resolved live).

`handover` is non-null only for a **reassigned** shipment — the collection point the replacement agent
uses, and where it came from:

```json
"handover": {
  "pickup": {
    "source": "previous_agent_location",   // original_pickup | agency_business | manual
    "label": "Handover with Jean (last known location)",
    "address": { "line1": "Rue Joffre", "line2": null, "city": "Douala", "state": "Littoral", "country": null },
    "location": { "type": "Point", "coordinates": [9.7043, 4.0483] },
    "note": null,
    "is_fallback": false
  },
  "fromAgentId": "507f...", "fromStatus": "in_transit", "reassignedAt": "2026-07-06T08:00:00.000Z"
}
```

How the pickup is chosen (and how the agency overrides it) is documented under
[agency/assignment.md → reassign](./assignment.md#reassign).

> **`items[].pickupLocation`** — each product is individually configured by its vendor (subject to
> this agency's own policy — see [Delivery Agencies](../vendor/delivery-agencies.md) and
> [Vendor Products](../vendor/products.md#update-product)), so a single shipment can mix items with
> different pickup locations even though they're all the same vendor. `mode: "storage_based"` /
> `alreadyInYourStorage: true` means the item already sits in the agency's own warehouse — nothing
> to go collect (`address` is the agency's own HQ, resolved live, not vendor-specific). `mode:
> "pickup_based"` / `alreadyInYourStorage: false` means the agency must collect from the specific
> vendor business address the vendor chose for that product — `address` is a **snapshot** taken
> when the order was placed, so it stays accurate even if the vendor edits/removes that address
> later. `pickupLocation` is `null` only for shipments whose order predates this feature.
>
> **`orderTimeline`** — every shipment of the parent order (not just this one), so a multi-agency
> order shows the full cross-agency flow, not just this agency's slice.

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.

---

<a name="status"></a>
### PATCH /api/agency/shipments/:id/status

**Description**: Advance a shipment through the agency-triggerable states. Mirrors the new status
onto every order item riding this shipment and recomputes the order's `fulfillment_status`, all in
one transaction.

**Request Body**:
```json
{ "status": "picked_up" }
```
- `status` (string, required) — one of `picked_up`, `in_transit`, `agent_delivered`, `failed`,
  `returned`. Must be a valid transition from the shipment's current status (see lifecycle table
  above) — e.g. `picked_up` is only valid from `assigned`, `agent_delivered` only from
  `in_transit`. `agent_delivered` may also move to `failed`: a claim of arrival is not proof of
  one, and the customer may be out, refuse the parcel, or (COD) refuse to pay.

`agent_delivered` means **"the agent is at the door"**, not "this is delivered". What turns it into
`delivered` depends on how the order was paid, and neither is a status change:

| Paid | `agent_delivered` → `delivered` when | Auto-confirm? |
|---|---|---|
| Online | the **customer** confirms that shipment ([customer orders](../customer/orders.md)) | Yes — after a **7-day** dispute window |
| COD | the **agent submits the customer's delivery code** ([`collect`](../agent/cod-cash.md#collect)) | Yes — after **7 days** the cash is recorded as collected *without* a code |

> **COD:** `delivered` is rejected as a status change — a recorded cash collection is the only way
> there, so `delivered` and "cash collected" are always the same event. The normal route is the agent
> submitting the customer's code: the response to `agent_delivered` carries `requiresDeliveryCode:
> true`, the agent app's cue to ask for it.
>
> If the shipment sits at `agent_delivered` for **7 days** with no code, the auto-confirm sweep records
> the cash as **collected without a code** (`verification.method: "auto_no_code"`), marks the shipment
> `delivered`, and makes the **agent** liable for that cash — leaving a shipment at `agent_delivered`
> for the whole window is treated as an implicit assertion that the cash was taken. So an agent who was
> **not** paid must move the shipment `failed` → `returned` **within the window**, or they will be
> booked as holding cash they never collected. This auto-collect never releases anyone's earnings
> prematurely: COD earnings carry `requires_cash_settlement` and cannot release until the platform
> physically holds the remitted cash (see [cod-cash-management.md](./cod-cash-management.md)).
>
> `picked_up` additionally requires an assigned agent (`SHIPMENT_AGENT_NOT_ASSIGNED`). A `returned` COD
> shipment voids its pending cash collection.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": "507f1f77bcf86cd799439077",
    "status": "agent_delivered",
    "trackingNumber": "FDO-260705-090000-K7Q2M",
    "requiresDeliveryCode": true,
    "nextAction": "Ask the customer for their delivery code and submit it to record the cash and complete the delivery.",
    "createdAt": "2026-07-05T09:00:00.000Z",
    "updatedAt": "2026-07-05T14:00:00.000Z"
  },
  "message": "Shipment status updated"
}
```

`requiresDeliveryCode` is `true` only for a COD shipment that just reached `agent_delivered`;
`nextAction` accompanies it. Both are absent/false otherwise. `recordedFailure` is always `null`
here — reasons are recorded only when the **agent** reports the outcome
([agent/shipments.md](../agent/shipments.md#status)).

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
- `400` – `SHIPMENT_INVALID_STATUS_TRANSITION` – Not a valid transition from the current status. `details` includes `{ from, to, allowed }`.
- `409` – `SHIPMENT_STATUS_CONFLICT` – The shipment moved between your read and your write — the assigned **agent** (or another dashboard session) transitioned it first. `details` includes `{ expectedStatus, to }`. **Reload the shipment and decide again** rather than blind-retrying the same body: the correct next status may have changed. Same handling as `SHIPMENT_CANCEL_CONFLICT` / `SHIPMENT_REASSIGNMENT_CONFLICT`.
- `422` – `SHIPMENT_AGENT_NOT_ASSIGNED` – `picked_up` requested but no agent has accepted the shipment yet.

---

<a name="reject"></a>
### POST /api/agency/shipments/:id/reject

**Description**: Decline an assigned shipment before picking it up. Its items move to
`pending_agency_reassignment` so the vendor can route them to another agency via the existing
`PATCH /api/vendor/orders/:id/delivery-agency` endpoint — no separate reassignment flow needed.

Only allowed while the shipment is still `assigned` (not yet picked up).

**Request Body**:
```json
{ "reason": "other", "note": "Bike courier off sick today; no cover until Monday." }
```
- `reason` (string, required) — one of `out_of_coverage_area`, `capacity_exceeded`,
  `invalid_address`, `vendor_item_not_ready`, `platform_intervention`, `other`. Fixed set,
  not free text. `platform_intervention` is the **administrator's** reason (a platform
  cancellation through the internal admin API); an agency has no reason to send it, and a
  rejection carrying it that an agency did send still records `changed_by_role: 'agency'`.
- `note` (string, optional; **required when `reason` is `other`**) — free-text explanation,
  max **200** characters. The four concrete reasons are self-describing, so a note is optional
  for them; `other` is not, so it must be accompanied by a note. Persisted on the shipment's
  `rejection` and shown to the vendor on their order view.

The vendor whose order this is receives a `shipment.rejected` notification (in-app + push, with a
deep-link to the order) and sees the `reason` + `note` on the order's per-item delivery detail, so
they know why it was declined before rerouting.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": null,
    "status": "rejected",
    "trackingNumber": "FDO-260705-090000-K7Q2M",
    "createdAt": "2026-07-05T09:00:00.000Z",
    "updatedAt": "2026-07-05T09:30:00.000Z"
  },
  "message": "Shipment rejected"
}
```

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
- `422` – `SHIPMENT_REJECTION_NOT_ALLOWED` – Shipment has already been picked up (or otherwise isn't `assigned`). `details.status` shows the current status.
- `409` – `SHIPMENT_STATUS_CONFLICT` – **New.** The shipment moved between the read that
  validated this rejection and the write: an agent picked it up, or a second rejection
  landed first. Reload and retry. Previously this path wrote blindly, so both racing
  rejections appeared to succeed and each fired its own post-commit block (offer
  cancellation, capacity release, vendor notification) for a status nobody was in.
- `400` – validation error – `reason` missing/invalid, `note` longer than 200 chars, or `note` missing when `reason` is `other`.

---

<a name="assign-agent"></a>
### PATCH /api/agency/shipments/:id/assign-agent

**Description**: Offer this shipment to one of the agency's agents. **No longer a direct
assignment** — it creates an offer the agent must accept before the shipment is theirs (see the
[agent-acceptance workflow](assignment.md)). The shipment gains an `agent_id` only on acceptance.

**Request Body**: `{ "agentId": "507f1f77bcf86cd799439077" }`

**Success Response** (`200 OK`): returns the created offer + the shipment's assignment state. See
[assignment.md → manual pick](assignment.md#offer) for the full response and error set. In short:
the response's `data.offer.status` is `pending` (or the agent's `autoAccepted` flag is `true` when
they have auto-accept on), and `data.shipment.assignmentState` is `offered` (or `accepted`).

> **COD:** for cash-on-delivery shipments the offer is additionally gated on the agent's cash risk
> profile up front, and re-checked at acceptance — the agent will physically hold this shipment's cash.

**Key errors**: `SHIPMENT_NOT_OFFERABLE` (422), `SHIPMENT_ALREADY_HAS_AGENT` (409),
`SHIPMENT_ALREADY_HAS_PENDING_OFFER` (409), `AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` (422),
`COD_AGENT_EXPOSURE_EXCEEDED` / `COD_AGENT_TRUST_TOO_LOW` (422, COD only). Full list in
[assignment.md](assignment.md#offer).

---

<a name="tracking-number"></a>
### Tracking number (read-only — no endpoint)

**There is no endpoint to set a tracking number.** `PATCH /api/agency/shipments/:id/tracking-number`
was removed: the number is now generated by the platform when the shipment is created, so it is never
absent and never editable. It is returned as `trackingNumber` on every shipment payload above (list,
detail, status transitions).

**Format** — `ACR-YYMMDD-HHMMSS-XXXXX`, e.g. `FDO-260730-142309-K7Q2M`:

| Segment | Meaning |
|---|---|
| `FDO` | the **owning agency's acronym**, derived from your magazin's business name |
| `260730` | the UTC **date** the shipment was created (`YYMMDD`) |
| `142309` | the UTC **time**, to the second (`HHMMSS`) |
| `K7Q2M` | 5 random characters guaranteeing uniqueness (no `I`, `L`, `O` or `U`, so nothing is misread off a label) |

Notes worth knowing:

- The acronym is **snapshotted at creation**. Renaming your magazin changes the prefix on *future*
  shipments only — existing tracking numbers never change, because a customer is already holding them.
- The number is **unique platform-wide** and is what
  [`GET /api/agency/shipments?q=`](#list) matches on, alongside customer name/phone, product titles
  and order number.
- It is surfaced on the vendor order detail (`items[].delivery.trackingNumber` and
  `deliveries[].trackingNumber`) and on the ticket reference lookups (`/reference/orders`).
- Shipments created before generation existed may still carry a hand-typed carrier number, or `null`
  until the platform backfill has run.

---

## Notifications

You receive an agency notification (in-app, always; plus your configured secondary channel) when
a vendor dispatches an order to you: `shipment.assigned` (`aggregateType: "shipment"`, `aggregateId`
= the `Shipment` id). Fires on both manual dispatch and payment-triggered auto-redirect — the
shipment's `status` has already moved `pending` → `assigned` by the time it's delivered, so it will
show up in `GET /api/agency/shipments` immediately.

Toggle via the `shipmentAssigned` flag on [notification preferences](./notifications.md) (default:
on).
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
