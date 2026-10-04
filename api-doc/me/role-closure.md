# Role closure: answering an administrator's request

**Built 2026-10-04.** Design record: [`../../docs/ADR-A10-ROLE-CLOSURE.md`](../../docs/ADR-A10-ROLE-CLOSURE.md).

An administrator can **ask** a person to close one of their roles. The person answers it
themselves, signed in as that role, from that role's dashboard (customers: the storefront or the
bot). The three endpoints below are that answer. All four apps call the same routes; the role is
taken from the session.

> [!IMPORTANT]
> **Closing is anonymise-and-retain, and it is irreversible.** The role's name, contacts,
> addresses, payout details and identity documents are removed. Orders, shipments and money
> records stay, without them. Say **close**, never **delete**: ADR-A02 D-2 forbids describing
> this as a deletion.

## How a request reaches the person

1. An administrator asks, in wi-admin. Nothing about the role changes.
2. The role receives an `account.closure_requested` notification: in-app, push, and its secondary
   channel. **No preference can mute it.** The in-app row carries `aggregateType: 'account'`, and
   its link points at the dashboard path **`account/closure`** (customers: `{STOREFRONT_URL}/shop/account/closure`, ⏳ a storefront page not built yet).
3. The person opens that page, which calls `GET /api/me/closure-request`, then either confirms or
   declines.
4. If they do nothing, the request **expires after 7 days** and nothing happens.

## Authentication

`requireAuth`, any role. The request answered is the one for **the role the session is signed in
as**. A person holding a vendor role and an agent role answers a vendor-closure request from the
vendor dashboard only. Nothing in the path or body names a user or a role.

---

## `GET /api/me/closure-request`

The pending request for this role, or `data: null` when nothing is waiting. That is the ordinary
answer, not an error.

```json
{
  "success": true,
  "data": {
    "id": "6710…",
    "role": "vendor",
    "status": "pending",
    "reason": "Owner asked by email to close the shop",
    "requestedAt": "2026-10-04T09:12:00.000Z",
    "expiresAt": "2026-10-11T09:12:00.000Z",
    "warnings": [
      { "code": "prepaid_plan_forfeited", "planCode": "pro", "expiresAt": "2026-11-12T00:00:00.000Z", "amount": null },
      { "code": "credit_balance_forfeited", "planCode": null, "expiresAt": null, "amount": 4500 }
    ],
    "blockers": [
      { "code": "vendor_orders_in_flight", "count": 2 }
    ],
    "canConfirm": false,
    "outcome": null
  }
}
```

| Field | Meaning |
|---|---|
| `reason` | The administrator's words. Show them verbatim; they are not translated |
| `warnings` | What the person **loses** by confirming: remaining paid plan time, a credit balance. Show these before the button. They never block |
| `blockers` | What must be settled first, **evaluated now**. Non-empty means confirming will be refused. Codes are in the table below |
| `canConfirm` | `blockers` is empty and the request is still pending. Enable the button on this |

The administrator is never named. The notice and this payload say "an administrator".

## `POST /api/me/closure-request/confirm`

```json
{ "confirm": "CLOSE MY ACCOUNT" }
```

The exact phrase ADR-A02 self-closure uses. The body is `.strict()`. Blockers are re-checked
first, then the role closes in one transaction.

**Response (200)**: the request with `status: "confirmed"`, `blockers: null`, and

```json
"outcome": { "closedAt": "2026-10-05T14:03:11.000Z", "accountClosed": false, "endedRelationships": 3 }
```

| `accountClosed` | What the client does |
|---|---|
| `false` | Only this role closed. **The person still has other roles.** Sign them out of this one (the cookies were cleared; a bearer client discards its pair) and offer sign-in to the others |
| `true` | It was their last role, so the whole account is closed (ADR-A02). There is nothing to sign in to |

`endedRelationships` counts the contracts and vendor↔agency connections ended with the role. The
other parties were notified.

## `POST /api/me/closure-request/decline`

```json
{ "note": "I still use this shop" }
```

`note` is optional (≤ 500 characters, or `null`). Nothing about the role changes, and the
administrator sees the answer.

---

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Wrong or missing confirm phrase, or an unknown body key |
| 404 | `ROLE_CLOSURE_REQUEST_NOT_FOUND` | No pending request for the role signed in |
| 409 | `ROLE_CLOSURE_REQUEST_EXPIRED` | It expired, or was answered or cancelled, between the read and the write |
| 422 | `ROLE_CLOSURE_BLOCKED` | Something live is attached. `details.blockers` is the list. Show it; do not retry |

### After the closure

| Status | Code | Raised by |
|---|---|---|
| 403 | `AUTH_ROLE_CLOSED` | Any request on a session opened as the closed role (`requireAuth`), and its refresh. **Sign out of that role; re-authenticating as it will not work** |
| 409 | `ROLE_CLOSED` | `POST /api/auth/add-role` (and `/api/auth/mobile/add-role`) for a role this account closed. Closure is irreversible |

## Blocker codes

| Code | Role | Settle it by |
|---|---|---|
| `orders_in_flight` | customer | waiting for the orders to finish |
| `bookings_upcoming` | customer | finishing or cancelling the bookings |
| `vendor_orders_in_flight` | vendor | fulfilling or cancelling the orders |
| `vendor_bookings_open` | vendor | completing, cancelling or settling the bookings |
| `cod_collections_pending` | vendor · agency · agent | the parcels being delivered or returned |
| `payout_request_held` | vendor · agency · agent | the payout being paid or rejected |
| `earnings_balance` | vendor · agency · agent | withdrawing the balance (`amount`, `currency`) |
| `earnings_allocations_held` | vendor · agency · agent | the hold period ending |
| `agency_stock_held` | vendor · agency | the stock being collected or counted to zero |
| `storage_invoices_open` | vendor · agency | settling the storage statements |
| `negotiations_open` | vendor | open haggles and unspent price locks expiring |
| `stock_requests_pending` | vendor · agency | answering or withdrawing them |
| `shipments_unterminated` | agency | the shipments finishing (`failed` counts) |
| `cod_cash_held` | agency · agent | remitting or depositing the cash (`amount`) |
| `cod_remittances_declared` | agency | the platform confirming or rejecting them |
| `cod_discrepancies_open` | agency · agent | the discrepancy being resolved |
| `shipments_active` | agent | delivering or handing the shipments back |
| `shipments_handover_held` | agent | the replacement agent collecting the parcel |
| `offers_pending` | agent | accepting or declining the offers |
| `cod_deposits_declared` | agent | the agency confirming or rejecting them |

## Customers on the bot

A customer can answer the same request in the chat. The bot's existing closure preview
(`account_close_preview`, or the `acct:close` tap carried on the notice) shows the
administrator's reason and the two buttons. **Confirm** runs the confirm above. **"Keep my
account"** **declines** the request. When the person holds other roles, the copy says those are
not affected.
