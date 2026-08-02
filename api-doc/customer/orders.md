# Customer Orders

Customer-facing order actions.

**Base path:** `/api/customer/orders`
**Auth:** `Authorization: Bearer <jwt_token>` — role `customer`. A customer may only act on their own orders.

> **Multi-vendor checkout model.** A single cart may hold items from **several vendors** (all of
> the same product type). At checkout the cart is split into **one order per vendor** — each order
> belongs to exactly one vendor and runs its own delivery/fulfilment/earnings cycle. All orders
> from the same checkout share a **`cartId`** (the checkout-group id), so the customer sees them as
> **one logical order** while each vendor sees only their own. The customer **pays once** for the
> whole group via [`POST /api/payments/initiate`](#payment) with that `cartId`.

> **Fulfillment status values.** `pending → processing → partially_shipped → shipped →
> partially_delivered → delivered` (plus terminal `fulfilled` for digital orders, `cancelled`,
> `returned`). Everything from `partially_shipped` onward is **system-derived** from the order's
> underlying shipments (one per delivery agency) — it is never set directly by the vendor.
> `partially_shipped`/`partially_delivered` only ever appear on orders split across more than one
> delivery agency.

---

## POST /api/customer/orders/checkout

Turn the customer's current cart into orders — **one order per vendor**. Re-validates cart rules
(non-empty, single product type, no service products, single currency). All created orders share a
`cartId` and start in `payment_status='AWAITING_PAYMENT'`. The cart is cleared on success. Order
creation is **atomic**: if any order fails to create, none are persisted and the cart is left intact.

### Request Body

```json
{ "paymentMethod": "cash_on_delivery", "deliveryAddressId": "664addr..." }
```

- `paymentMethod` *(string, optional, default `"online"`)* — `"online"` (prepaid via gateway) or
  `"cash_on_delivery"`. Applies to the **whole checkout group**. See
  [Cash on delivery](#cod) below for eligibility and lifecycle.
- `deliveryAddressId` *(string, optional)* — id of one of the customer's saved addresses to deliver to.
- `deliveryAddress` *(GeoAddress, optional)* — a selected address-search result to deliver to, sent
  inline (see [Geospatial addresses](../geo/README.md)). Provide **either** `deliveryAddressId` **or**
  `deliveryAddress`, not both. When neither is given, the customer's **default saved address** is used.

The resolved address is **geocoded and frozen** onto every physical order as `delivery_address`, so a
later edit to the customer's saved addresses never rewrites past orders. Digital carts ignore it.

### Response

**Success (201 Created)**
```json
{
  "success": true,
  "data": {
    "cartId": "664a1f77bcf86cd799439900",
    "paymentMethod": "online",
    "orders": [
      {
        "id": "507f1f77bcf86cd799439011",
        "orderNumber": "ORD-2026-000123",
        "vendorId": "507f1f77bcf86cd799439aaa",
        "orderType": "physical",
        "total": 15000,
        "currency": "XAF",
        "paymentMethod": "online",
        "paymentStatus": "AWAITING_PAYMENT",
        "fulfillmentStatus": "pending",
        "itemCount": 2
      },
      {
        "id": "507f1f77bcf86cd799439012",
        "orderNumber": "ORD-2026-000124",
        "vendorId": "507f1f77bcf86cd799439bbb",
        "orderType": "physical",
        "total": 5000,
        "currency": "XAF",
        "paymentMethod": "online",
        "paymentStatus": "AWAITING_PAYMENT",
        "fulfillmentStatus": "pending",
        "itemCount": 1
      }
    ]
  },
  "message": "Orders created. Complete payment for the cart to proceed."
}
```

Next step (**online** checkout only): call `POST /api/payments/initiate` with
`{ "cartId": "<cartId>", "gateway": "...", "channel": {...} }` to pay for the whole group in one
transaction. A **cash_on_delivery** checkout requires no payment call — see
[Cash on delivery](#cod).

### Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `ORDER_CART_EMPTY` | Cart is empty. |
| 400 | `ORDER_CART_INVALID` | Missing product type / cart id, service product present, missing variant/SKU, or mixed currency. |
| 404 | `ORDER_PRODUCT_NOT_FOUND` | A cart item's product no longer exists. |
| 404 | `ORDER_VENDOR_NOT_FOUND` | A vendor referenced by the cart no longer exists. |
| 422 | `ORDER_NO_DELIVERY_AGENCY` | A physical product has no resolvable delivery agency. |
| 422 | `COD_NOT_AVAILABLE_FOR_DIGITAL` | `paymentMethod: "cash_on_delivery"` on a digital cart. |
| 422 | `COD_AGENCY_NOT_SUPPORTED` | A delivery agency on the order doesn't handle COD. `details.agencyName` names it. |
| 422 | `COD_ORDER_AMOUNT_EXCEEDS_LIMIT` | One vendor-order's total exceeds an agency's COD cap. `details: { agencyName, maxOrderAmount, orderTotal }`. |

---

## GET /api/customer/orders

The customer's order history, **grouped by checkout group (`cartId`)**. Each group is one logical
order that may contain several per-vendor orders. Paginated by group.

### Query params

- `page` *(int, default 1)*
- `limit` *(int, default 20, max 100)*

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": [
    {
      "cartId": "664a1f77bcf86cd799439900",
      "createdAt": "2026-07-02T10:00:00.000Z",
      "currency": "XAF",
      "totalAmount": 20000,
      "orderCount": 2,
      "paymentStatus": "awaiting_payment",
      "orders": [
        {
          "id": "507f1f77bcf86cd799439011",
          "orderNumber": "ORD-2026-000123",
          "vendorId": "507f1f77bcf86cd799439aaa",
          "orderType": "physical",
          "total": 15000,
          "currency": "XAF",
          "paymentMethod": "online",
          "paymentStatus": "AWAITING_PAYMENT",
          "fulfillmentStatus": "pending",
          "itemCount": 2,
          "createdAt": "2026-07-02T10:00:00.000Z"
        }
      ]
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

The group-level `paymentStatus` is an aggregate of its orders: `paid` (all paid), `awaiting_payment`
(none paid), `partially_paid` (some paid — including COD orders partway through their per-shipment
cash collection), or `mixed`. Each order also carries its own `paymentMethod`
(`"online"` | `"cash_on_delivery"`).

---

## GET /api/customer/orders/groups/:cartId

One checkout group in detail — all its per-vendor orders with line items. Scoped to the
authenticated customer.

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "cartId": "664a1f77bcf86cd799439900",
    "createdAt": "2026-07-02T10:00:00.000Z",
    "currency": "XAF",
    "totalAmount": 20000,
    "orderCount": 2,
    "paymentStatus": "awaiting_payment",
    "orders": [
      {
        "id": "507f1f77bcf86cd799439011",
        "orderNumber": "ORD-2026-000123",
        "vendorId": "507f1f77bcf86cd799439aaa",
        "orderType": "physical",
        "total": 15000,
        "currency": "XAF",
        "paymentMethod": "cash_on_delivery",
        "paymentStatus": "AWAITING_PAYMENT",
        "fulfillmentStatus": "pending",
        "codCollections": [
          {
            "shipmentId": "507f1f77bcf86cd799439100",
            "expectedAmount": 15000,
            "currency": "XAF",
            "status": "pending",
            "collectedAt": null,
            "deliveryCode": "847392"
          }
        ],
        "items": [
          {
            "id": "507f1f77bcf86cd799439055",
            "productId": "507f1f77bcf86cd799439066",
            "variantId": "507f1f77bcf86cd799439077",
            "sku": "TSHIRT-RED-L",
            "title": "T-Shirt",
            "variantTitle": "Size: Large, Color: Red",
            "quantity": 2,
            "price": 7500,
            "currency": "XAF",
            "freeDelivery": false
          }
        ]
      }
    ]
  }
}
```

> `items[].freeDelivery` is a snapshot of the product's free-delivery flag taken at checkout time; it does not reflect later changes to the product.
>
> **`codCollections`** — present only on `cash_on_delivery` orders. One entry per shipment, created
> when that shipment is picked up: `expectedAmount` is the exact cash to pay the agent at handoff;
> `deliveryCode` is the customer's secret 6-digit code (present **only while `status` is
> `"pending"`**) — show it prominently, with the instruction to give it to the agent only after
> receiving the package and paying. `status` becomes `"collected"` after handoff, or `"cancelled"`
> if the shipment was returned. See [Cash on delivery](#cod).

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `ORDER_NOT_FOUND` | No orders for this `cartId` under the authenticated customer. |

---

<a name="payment"></a>
## Paying for a checkout group

`POST /api/payments/initiate` accepts **either** `cartId` (pay the whole checkout group in one
transaction — preferred for cart checkout) **or** `orderId` (single-order payment).

```json
{
  "cartId": "664a1f77bcf86cd799439900",
  "gateway": "NOTCHPAY",
  "channel": { "phoneNumber": "+237670000000", "phoneOperator": "MTN", "customerEmail": "a@b.com" }
}
```

The customer is charged the **sum** of the group's order totals once. On payment success the
settlement **fans out** to every order in the group: each independently becomes `paid`, splits its
earnings against its own vendor's commission, and proceeds with fulfilment.

**Group-payment errors:** `404 PAYMENT_CART_NOT_FOUND` (no orders for the cartId), `409
PAYMENT_ORDER_ALREADY_PAID` (all orders already paid), `409 PAYMENT_CART_NO_PAYABLE_ORDERS` (nothing
left to pay), `400 PAYMENT_CART_MIXED_CURRENCY`, `400 PAYMENT_REFERENCE_REQUIRED` (neither cartId nor
orderId supplied), `422 PAYMENT_ORDER_IS_COD` (the checkout is cash-on-delivery — no online payment
exists for it).

### Watching the payment land

`initiate` returns a `transactionId` and usually `status: "PENDING"`. Two ways to follow it:

| Call | Auth | Use |
|---|---|---|
| `GET /api/payments/:transactionId` | **required** | Read the transaction's current state |
| `POST /api/payments/verify` | none | Force a gateway re-check now |

> **⚠️ Breaking change (2026-07-29):** `GET /api/payments/:transactionId` now **requires
> authentication** and returns only the **authenticated customer's own** transaction — it previously
> accepted no credentials, so any payment was readable by id. Send the session cookie
> (`credentials: 'include'`) or a Bearer token when polling. Someone else's transaction, or a
> malformed id, returns `404 PAYMENT_TRANSACTION_NOT_FOUND`.

Webhooks settle the payment regardless of whether the client polls — polling only makes the answer
arrive sooner. Full contract: [../payments/README.md](../payments/README.md).

---

<a name="cod"></a>
## Cash on delivery (COD)

Choosing `paymentMethod: "cash_on_delivery"` at checkout means the customer pays **each delivery
agent in cash at handoff** — one payment per shipment. No call to `/api/payments/initiate` is ever
made for a COD checkout.

**Eligibility** (validated at checkout): physical carts only, and every delivery agency involved
must support COD (some also cap the per-order amount).

**Lifecycle of a COD order:**

1. Order created (`paymentStatus: "AWAITING_PAYMENT"`). The vendor prepares and dispatches it —
   COD orders fulfil **before** payment, and are exempt from the unpaid auto-cancel sweep.
2. When a shipment is picked up by the delivery agency, a `codCollections[]` entry appears on the
   [group detail](#get-apicustomerordersgroupscartid) with the exact `expectedAmount` and the
   customer's secret 6-digit `deliveryCode` (also sent via WhatsApp when possible).
3. At the door: the customer receives the package, **pays the agent in cash**, then gives them the
   code. The verified code atomically records the payment and marks the shipment **delivered** —
   there is no separate confirm-delivery step for COD shipments, and
   [`POST …/confirm-delivery`](#confirm-shipment) rejects them.
4. **If the code never arrives:** the agent marks arrival (`agent_delivered`) and, after 7 days at
   that status, the system records the cash as collected anyway and the shipment becomes
   `delivered`. This exists because a customer can pay and still not produce the code (phone not to
   hand, or unwilling), while an agent who was *not* paid is required to mark the shipment failed →
   returned instead — so a shipment left at `agent_delivered` for a week is treated as paid. The
   collection is flagged internally as having no code behind it.
5. `paymentStatus` progresses `AWAITING_PAYMENT` → `partially_paid` (some shipments collected) →
   `paid` (all collected). If a shipment fails and is returned, no cash is due for it; an order
   where **nothing** was ever collected and all shipments came back ends `failed`.

> **UI guidance:** display the delivery code with a clear warning — *"only give this code to the
> delivery agent after you have received your package and paid."* The code is the customer's
> proof-of-payment lever; releasing it early is equivalent to signing a receipt.

### POST /api/customer/orders/:orderId/shipments/:shipmentId/resend-delivery-code

Regenerate this shipment's delivery code (e.g. lost, or locked after the agent entered too many
wrong codes) and resend it via WhatsApp. The new code is also returned — it is the customer's own
secret. Rate-limited to one (re)generation per 60 seconds.

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "shipmentId": "507f1f77bcf86cd799439100",
    "deliveryCode": "391847",
    "expectedAmount": 15000,
    "currency": "XAF"
  },
  "message": "A new delivery code was generated. Give it to the agent only after you have received and paid for your package."
}
```

**Errors:** `404 ORDER_NOT_FOUND` / `404 SHIPMENT_NOT_FOUND` (not this customer's), `404
COD_COLLECTION_NOT_FOUND` (no pending collection — not a COD shipment, not picked up yet, or
already collected), `429 COD_CODE_RESEND_TOO_SOON` (`details.retryInSeconds`).

---

## PATCH /api/customer/orders/:id/confirm-delivery

Confirm receipt/satisfaction. Confirmable once fulfilment is `delivered` (physical) or
`fulfilled` (digital) and the order has not already been completed. Completing the order
starts the 7-day escrow hold before vendor funds become withdrawable.

> **Physical orders:** `fulfillment_status` only reaches `delivered` once every shipment of the
> order has been individually confirmed via
> [`POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery`](#confirm-shipment)
> below — at that point completion has already fired automatically. This endpoint is the primary
> path for **digital** orders (`fulfilled`); for physical orders it mainly exists as an idempotent
> fallback (returns `409 EARNINGS_ALREADY_COMPLETED` if the last shipment confirmation already
> completed the order).

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "order_id": "507f1f77bcf86cd799439011",
    "completed_at": "2026-06-28T12:00:00.000Z"
  }
}
```

---

<a name="confirm-shipment"></a>
## POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery

Confirm **one shipment's** delivery. A physical order can be split across several delivery
agencies (one shipment per agency) — each shipment needs its own customer confirmation once the
agency/agent reports it delivered (`shipment.status = 'agent_delivered'`), since packages from
different agencies can arrive on different days.

Once every shipment on the order has been confirmed this way, the order's own
`fulfillment_status` becomes `delivered` **and its `completion` (escrow-release gate) fires
automatically** — no separate call to `PATCH /:id/confirm-delivery` is needed.

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "id": "664a1f77bcf86cd799439aaa",
    "orderId": "507f1f77bcf86cd799439011",
    "agencyId": "507f1f77bcf86cd799439bbb",
    "agentId": "507f1f77bcf86cd799439ccc",
    "status": "delivered",
    "trackingNumber": "FDO-260730-142309-K7Q2M",
    "orderFulfillmentStatus": "partially_delivered"
  }
}
```

`orderFulfillmentStatus` reflects the order-wide state right after this confirmation —
`partially_delivered` while other shipments are still outstanding, `delivered` once this was the
last one.

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `ORDER_NOT_FOUND` | Order not found. |
| 403 | `SHIPMENT_ACCESS_DENIED` | Order belongs to another customer. |
| 404 | `SHIPMENT_NOT_FOUND` | Shipment not found, or doesn't belong to this order. |
| 409 | `SHIPMENT_ALREADY_CONFIRMED` | Shipment already confirmed as delivered. |
| 422 | `SHIPMENT_CONFIRMATION_NOT_ALLOWED` | Shipment hasn't reached `agent_delivered` yet, **or the order is cash-on-delivery** (`details.paymentMethod`) — see below. |

> **Not for COD.** A cash-on-delivery order is confirmed by giving the agent your delivery code, not
> by calling this endpoint — the code is what records the payment and marks the shipment delivered in
> the same step. Calling it on a COD order returns `422 SHIPMENT_CONFIRMATION_NOT_ALLOWED`. Don't show
> a confirm-delivery action for COD shipments; show the delivery code instead.

---

## POST /api/customer/orders/:id/cancel

Customer-initiated cancellation, gated by the vendor's **cancellation policy**.

**Constraints:**
- Only **pre-shipment** orders (`fulfillment_status` is `pending` or `processing`).
- Only **unpaid** orders (`payment_status` is `pending` or `AWAITING_PAYMENT`). For a **paid**
  order, this endpoint returns `422 ORDER_CANCEL_REQUIRES_REFUND` — use the vendor refund flow
  instead (this endpoint performs no refund).
- **COD orders**: additionally, no shipment may have left the agency yet (all still
  `pending`/`assigned`). Once a package is `picked_up` or beyond, the handoff / failed-delivery
  flow owns the outcome — the customer can still refuse at the door (no cash changes hands and
  the shipment is returned).
- The vendor's `cancellation_policy` must permit it (`cancellable` flag + `cancellation_deadline`).
  Orders have no firm delivery date, so delivery-date-based deadlines fall back to
  creation-based handling.

On success the order is set to `fulfillment_status='cancelled'`, `payment_status='failed'`, a
timeline event is appended, and an `order.cancelled` event is emitted (drives vendor notifications).

### Request Body

```json
{ "reason": "Changed my mind" }
```

- `reason` *(string, optional, ≤ 500 chars)*.

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "order_id": "507f1f77bcf86cd799439011",
    "fulfillment_status": "cancelled"
  },
  "message": "Order cancelled"
}
```

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `ORDER_NOT_FOUND` | Order not found / not this customer's. |
| 403 | `EARNINGS_FORBIDDEN` | Order belongs to another customer. |
| 409 | `ORDER_ALREADY_CANCELLED` | Order is already cancelled. |
| 422 | `ORDER_NOT_CANCELLABLE` | Past `pending`/`processing`, or payment state not unpaid. |
| 422 | `ORDER_CANCEL_REQUIRES_REFUND` | Order is paid — use the refund flow. |
| 422 | `CANCELLATION_NOT_ALLOWED` | Vendor cancellation policy disallows it (see `details`). |

> **Auto-cancellation.** Independently of this endpoint, a daily background sweep cancels
> orders left unpaid past the vendor's configured window
> (`auto_cancel_unpaid_days`, default 3). See
> [vendor/profile.md](../vendor/profile.md#put-apivendorprofileauto-cancel-unpaid-days).
> **Cash-on-delivery orders are exempt** — they are unpaid until handoff by design.
