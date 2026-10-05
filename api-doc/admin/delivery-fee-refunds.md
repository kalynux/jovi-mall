# Manual delivery-fee refunds — `/api/internal/admin/delivery-fee-refunds`

**Added 2026-10-04 (ADR-A11, workstream W-E2, owner decision D-12).** Source:
`src/modules/delivery-fee-proposals/{admin-delivery-fee-refund.routes.ts,services/delivery-fee-refund-admin.service.ts}`,
the pure rules `domain/customer-fee-change.rules.ts` (`planManualSettlement`, `customerRefundPosition`).
Pinned by `npm run test:customer-fee-changes` § 15.

> **If you are building a dashboard, this is not your document.** wi-admin calls this surface on the
> administrator's behalf, after resolving their tier and permission and writing its own audit row.
> This is the service-to-service door: `requireAdminCaller` (`Authorization: Bearer
> <INTERNAL_ADMIN_SERVICE_TOKEN>` + `X-Actor-Id` / `X-Actor-Name`). `X-Actor-Tier` is advisory and
> never read here. See [internal-service-api.md](./internal-service-api.md).

> ⚠ **Folded into the refund queue on 2026-10-05 (REFUND-FLOW-PLAN § 4, § 7).** Delivery money
> owed back is now a **refund request** (`/api/internal/admin/refunds`, [refunds.md](./refunds.md)),
> raised by the system with **no earnings impact** (`earningsImpact: 'none'` — it was never
> allocated to anybody): a card refund completes at once, mobile money is sent to the number that
> paid (minus the 2% refund fee), and COD — no number on record — waits **awaiting approval** in
> the queue, where an administrator types the number with its proof and a second one approves.
> The `delivery_fee_refunds` row is still written (it is the ledger the customer's owed amount is
> measured against) and now carries **`refund_request_id`**; it stays `processing` while its
> request is open and becomes `completed` when the request completes.
>
> **This surface keeps answering** — wi-admin's money module calls it — for:
> - rows written **before** the change, until `migrate:legacy-refunds-to-requests` moves them onto
>   a request (they keep `manual_required`, gain `refund_request_id`, and leave this screen);
> - rows for which **no request could be opened** (the floor: a HIGH ticket, as before);
> - rows whose request was **rejected** (`refund_request_id` moves to `rejected_refund_request_id`
>   and the row is `manual_required` again — record a cover or a hand payment here).
>
> A row linked to an **open** request is refused by `settle` with
> `409 DELIVERY_FEE_REFUND_NOT_SETTLEABLE` + `details.refundRequestId` / `details.refundRequestStatus`
> (paying it here while the request can still send would pay the customer twice), and reads
> `settleable: false`. The same `409` (same details) answers while **any** refund request of the
> ORDER is open — its money comes out of the same ceiling (review finding 5, 2026-10-05). Each row now also carries `refundRequestId` (null on a legacy row).

---

## What a manual refund is

When delivery money is owed back to a customer — a customer-paid fee lowered after payment, the
unspent fee of a returned parcel — jovi-mall refunds it through the payment gateway on its own
(`delivery_fee_refunds`, ADR-A11 § Refunds). When the gateway **cannot or will not** (mobile money,
NotchPay with refunds disabled, a cash-on-delivery order), the ledger row becomes
**`manual_required`**: a HIGH support ticket is opened (`type: order_refund`, `entityType: order`)
and the customer is told a person is sending it (`order.delivery_fee.refund_pending`).

A person then sends the money by hand and records it here. Settling:

- turns the row `completed` with a `settlement` (method, reference, note, who, when) — the
  customer's **owed** amount clears on their order view (`deliveryFeeRefund.owed`) and on
  `GET /api/customer/orders/:id/delivery-fee-proposals` (`refunds.owed`);
- writes an `admin_action_log` row (`DELIVERY_FEE_REFUND_SETTLED`) in the same transaction;
- then resolves the linked ticket (with a system note) and tells the customer
  (`order.delivery_fee.refund_settled` — not sent for `covered_by_order_refund`, see below).

Money paid by hand is subtracted from every later "what can this order still return" ceiling, so a
later refund of the whole order cannot pay the same delivery money a second time.

## `GET /delivery-fee-refunds`

The manual refunds only (automatic rows are not this surface's — read `delivery_fee_refunds`
directly if you need the whole ledger).

| Query | | |
|---|---|---|
| `status` | `manual_required` (default — still owed, the queue) · `settled` (settled by an administrator) · `all` | |
| `orderId` | ObjectId | one order's manual refunds |
| `page` / `limit` | default 1 / 20, `limit` ≤ 100 | newest first |

Unknown query keys are a `400`.

```json
{
  "success": true,
  "data": [
    {
      "id": "6700…",
      "orderId": "66f0…",
      "orderNumber": "WM-2026-000123",
      "shipmentId": "66f1…",
      "customerId": "66a0…",
      "vendorId": "66b0…",
      "amount": 1500,
      "currency": "XAF",
      "status": "manual_required",
      "cause": "fee_decrease",
      "note": "The order was paid in cash at delivery — there is no charge to refund",
      "ticketId": "6701…",
      "settleable": true,
      "settlement": null,
      "createdAt": "2026-10-04T10:00:00.000Z",
      "updatedAt": "2026-10-04T10:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

- `status` — `manual_required` (owed) · `completed` (settled).
- `settleable` — the one flag a settle button needs (`status === 'manual_required'` and NOT linked to an open refund request — `refundRequestId` null).
- `cause` — `fee_decrease` · `rto_leftover` · `sweep`.
- `note` — why it is manual. **Operator-facing**; never show it to the customer.
- `settlement` once settled: `{ method, reference, note, settledBy: { id, source, name }, settledAt }`.
  `settledBy.id` is the wi-admin administrator id (`source: "admin"`) — it resolves to nothing in
  jovi-mall, hence the `name` snapshot.

## `GET /delivery-fee-refunds/:refundId`

One manual refund, same shape. `404 DELIVERY_FEE_REFUND_NOT_FOUND` for an unknown id **or an
automatic row**.

## `POST /delivery-fee-refunds/:refundId/settle`

```json
{ "method": "mobile_money", "reference": "MP241004.1234.A56789", "note": "Sent to the order's MTN number" }
```

| Field | | |
|---|---|---|
| `method` | **required** | `mobile_money` · `cash` · `bank` · `other` — the money was **sent by hand**. `covered_by_order_refund` — **no money moved**: a refund of the whole order (by the vendor or an administrator) already returned it |
| `reference` | optional, ≤ 200 | the transfer's own reference |
| `note` | optional, ≤ 1000 | lands on the ticket |

`.strict()` — any other key is a `400`. **There is no `settledBy` field**: who settled is the
caller (`X-Actor-Id` / `X-Actor-Name`).

**Rules**

1. Only a `manual_required` row settles. The write is a compare-and-set on that status and the
   amount read: two administrators settling at once get one `200` and one
   `409 DELIVERY_FEE_REFUND_NOT_SETTLEABLE`.
2. **Online orders — never paid twice.** If a refund of the whole order already returned this money
   (the order's payments can no longer cover the row), a paying method is refused with
   `409 DELIVERY_FEE_REFUND_ALREADY_COVERED` (`details.amount`, `details.stillReturnable`). Settle it
   `covered_by_order_refund` instead. If the order could still return **part** of it, the covered
   part is settled and the rest becomes **a new `manual_required` row** on the same ticket
   (`remainder` in the response) — pay that one by hand.
3. `covered_by_order_refund` on money the order still covers — or on a COD order, where nothing
   else can have returned it — is `409 DELIVERY_FEE_REFUND_NOT_COVERED`.

**200**

```json
{
  "success": true,
  "message": "Delivery-fee refund marked settled.",
  "data": {
    "refund": { "id": "6700…", "status": "completed", "amount": 1500, "settleable": false,
                "settlement": { "method": "mobile_money", "reference": "MP241004.1234.A56789",
                                "note": "Sent to the order's MTN number",
                                "settledBy": { "id": "ad01…", "source": "admin", "name": "Awa N." },
                                "settledAt": "2026-10-04T12:00:00.000Z" }, "…": "…" },
    "remainder": null
  }
}
```

`remainder` is the new owed row after a partial cover (message: "Partly covered — the rest is still
owed."), otherwise `null`.

| Error | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | bad id, bad body |
| `DELIVERY_FEE_REFUND_NOT_FOUND` | 404 | unknown refund |
| `ORDER_NOT_FOUND` | 404 | the row's order is gone |
| `DELIVERY_FEE_REFUND_NOT_SETTLEABLE` | 409 | not `manual_required` (settled, automatic, or lost the race) — reload |
| `DELIVERY_FEE_REFUND_ALREADY_COVERED` | 409 | rule 2 |
| `DELIVERY_FEE_REFUND_NOT_COVERED` | 409 | rule 3 |

The ticket update and the customer notification are best-effort after the commit: a ticketing or
messaging failure never undoes the settlement (the ledger is the truth).
