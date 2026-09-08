# Admin Payout Requests API

**Verified against source on 2026-09-08** — the four routes, the list query schema, the `payout_method_snapshot` unmasking rule and the two 409 paths, against `jovi-mall/src/modules/earnings/{routes/admin-payout-requests.routes.ts,services/payout-request.service.ts,config/earnings.config.ts:77,87}`. Three defects: the Base Path and Authentication sections still described the deleted public `/api/admin` mount, and the ticket note gave the Phase-17 exclusivity lock as a live failure cause.

> ## ⚠️ This surface moved at the Phase 5 cutover — read this before the routes below
>
> **The public mount `/api/admin/payout-requests` is DELETED.** It was served to any platform session
> whose `users` row carried `roles: ['admin']` — jovi-mall's second authorization model, which
> carried no tier, no permission set and no audit identity. That model is retired.
>
> **The routes themselves are unchanged and still live, at `/api/internal/admin/payout-requests`**, behind
> `requireAdminCaller` (a service token plus `X-Actor-*` headers, never a user session). One
> factory always served both mounts, so every path, payload and response below is still exact —
> only the prefix and the guard changed. **Every path in this document has been rewritten to
> the internal prefix**, so what you read here is what the service answers.
>
> **If you are building a dashboard, this is not your document.** Call wi-admin's `/api/v1/money` instead — it resolves the
> administrator's tier and permissions, writes the audit row, and calls this surface on your
> behalf. See [internal-service-api.md](./internal-service-api.md) for the door itself, and
> `admin/api-doc/api/` in the wi-admin repository for the dashboard contract.

---

Processing queue for vendor/agency payout requests. Each request is also mirrored as a
`PAYOUT_REQUEST` support ticket (admin-pool assigned) — this API is for the money-side actions
(mark paid / reject), which are deliberately **separate** from generic ticket-status changes so
resolving the ticket for an unrelated reason can never accidentally trigger a payment. See
[Vendor Earnings — Requesting a payout](../vendor/earnings.md#requesting-a-payout) and
[Agency Earnings — Requesting a payout](../agency/earnings.md#requesting-a-payout) for the
requester-facing side.

**Two ways a request gets created** (see `origin` below): a vendor/agency calls their `POST
.../earnings/payout` endpoint themselves (`"manual"`), or a daily platform sweep
(`EarningsReleaseWorker`) opens one automatically once an account's `available_balance` reaches
`EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD` (default **2,000,000 XAF**) — `"auto_threshold"` — so the
platform never ends up owing an unbounded amount to one account. Both flows share the same
minimum (`EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT`, default **10,000 XAF**) and land in this same queue;
process them identically. The auto sweep silently retries daily (logging, not failing) for any
account that's over threshold but has no payout method configured yet — nothing for admins to do
there beyond following up with the vendor/agency if it persists.

## Base Path
```
/api/internal/admin/payout-requests
```

## Authentication

`requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`) — a **service** call from
wi-admin, not a browser session:

| Header | Required | Meaning |
|---|---|---|
| `X-Service-Token` | yes | `INTERNAL_ADMIN_SERVICE_TOKEN`, compared in constant time. `Authorization: Bearer <token>` is accepted as an alternative |
| `X-Actor-Id` | yes | The acting administrator’s `admin_accounts._id` from the **wi-admin** database. Must be a valid ObjectId |
| `X-Actor-Name` | no | Snapshotted onto the actor stamps this surface writes. Defaults to `Administrator` |
| `X-Request-Id` | no | Correlation id, echoed into logs |

Unset secret ⇒ `503`; bad token ⇒ `401`; missing or malformed actor ⇒ `400`.

> ⚠ **These two sections said `/api/admin` and *"a valid Bearer token with the admin role"*
> until 2026-09-08.** That was the deleted public mount and its `requireRole(['admin'])` guard.
> Every `/api/admin/*` route went at the Phase 5 Part E cutover, and this router is instantiated
> once, with `[requireAdminCaller]` (`api/routes/internal-admin.routes.ts`).

---

## Endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/internal/admin/payout-requests` | List payout requests (filterable, paginated) |
| GET | `/api/internal/admin/payout-requests/:id` | Get one payout request |
| POST | `/api/internal/admin/payout-requests/:id/mark-paid` | Confirm the payout was sent; permanently deducts the earmarked funds |
| POST | `/api/internal/admin/payout-requests/:id/reject` | Reject the request; returns the earmarked funds to `available` |

---

### GET /api/internal/admin/payout-requests

**Description**: Newest-first, paginated list of payout requests across vendors and agencies.

**Query Parameters**:
- `status` (optional) — `pending` \| `paid` \| `rejected`
- `ownerType` (optional) — `vendor` \| `agency`
- `page` (integer, optional, default `1`)
- `limit` (integer, optional, default `20`, max `100`)

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "_id": "66f0a1...",
      "owner_type": "vendor",
      "owner_id": "6601...",
      "ownerName": "Jovi Electronics",
      "amount": 118500,
      "currency": "XAF",
      "status": "pending",
      "origin": "manual",
      "payout_method_snapshot": {
        "method": "mobile_money",
        "mobile_money": { "provider": "MTN", "phone_number": "+237...", "account_name": "..." },
        "bank": null,
        "card": null
      },
      "ticket_id": "66f0a2...",
      "requested_by_user_id": "6601...",
      "resolved_at": null,
      "resolved_by": null,
      "paid_reference": null,
      "rejection_reason": null,
      "created_at": "2026-07-14T10:00:00.000Z",
      "updated_at": "2026-07-14T10:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

`ownerName` is resolved from the vendor/agency profile for display; everything else is the raw
`PayoutRequest` record. `payout_method_snapshot` is frozen at request time — it reflects where the
money should go even if the profile's payout details changed since.

`payout_method_snapshot.method` is `mobile_money`, `bank` or **`card`**, and exactly one of the
three sub-objects is non-null. **Owners can only configure `mobile_money` right now** — `bank` and
`card` are switched off at the write path — but a snapshot of either still reaches this queue if it
was configured before the switch, and it is still yours to pay. Switching a kind off closes the door
on new configuration, never on money already addressed. Unlike the owner-facing reads, **this snapshot is unmasked** — you
are the one sending the money, so `phone_number` and `account_number` come through in full. A
**card** is the exception, and not for redaction reasons: no card number was ever collected. You get
`brand`, `last4`, `card_holder_name`, `expiry_month`/`expiry_year`, `issuing_bank`, `country`, and a
`gateway_token` **only if** the owner's client tokenized the card through a payment gateway.

- **With a token** the transfer is automatable through that gateway.
- **Without one**, settle it the same way you settle a bank transfer: confirm the destination from
  brand + last4 + holder + expiry, send out of band, and record the external reference on
  `mark-paid`.

Full contract for what the owner could have entered, including why no PAN exists:
**[Vendor](../vendor/payout-methods.md)** · **[Agency](../agency/payout-methods.md)** ·
**[Agent](../agent/payout-methods.md)** payout methods — the three are the same schema, documented
per role.

### GET /api/internal/admin/payout-requests/:id

**Description**: Fetch a single payout request.

**Success Response** — `200 OK`: same shape as one list item (without `ownerName`).

**Error Responses**: `404` – `EARNINGS_PAYOUT_REQUEST_NOT_FOUND`.

### POST /api/internal/admin/payout-requests/:id/mark-paid

**Description**: Confirm the payout was sent out-of-band (bank transfer / mobile money). This
**permanently deducts** the earmarked `requested` amount — there is no undo. Also auto-resolves
the linked ticket with a system note and notifies the requester.

**Request Body**:
```json
{ "reference": "MOMO-TX-88213 (optional)" }
```

**Success Response** — `200 OK`: the updated `PayoutRequest` (`status: "paid"`, `resolved_at`,
`resolved_by`, `paid_reference` set).

**Error Responses**:
- `404` – `EARNINGS_PAYOUT_REQUEST_NOT_FOUND`
- `409` – `EARNINGS_PAYOUT_REQUEST_NOT_PENDING` – Already paid or rejected.

> **The linked ticket is auto-resolved best-effort, and a failure there never rolls the payout
> back** — the financial action stands and the ticket is left for a human
> (`earnings/services/payout-request.service.ts:312-330`). What can actually fail is
> `404 TICKET_NOT_FOUND`, `403 TICKET_ACCESS_DENIED` (the resolver is not a follower) or a
> `500 TICKET_UPDATE_FAILED`. Resolve the ticket manually in that case.
>
> ⚠ **This note gave *"locked to a different admin"* as the example cause until 2026-09-08.**
> That exclusivity lock was removed at Phase 17 — `assigned_admin_id`, `setActiveAdminIfNotSet`
> and `validateActiveAdminPermission` are all gone, and no ticket refuses an administrator on
> the grounds that another one touched it first. See [tickets.md](./tickets.md). The stale
> phrase also survives in the service’s own comment at `payout-request.service.ts:313`.

### POST /api/internal/admin/payout-requests/:id/reject

**Description**: Reject the request. Returns the earmarked amount to the requester's `available`
balance immediately. Also auto-resolves the linked ticket with the reason as a system note and
notifies the requester.

**Request Body**:
```json
{ "reason": "Payout details could not be verified" }
```
`reason` is required.

**Success Response** — `200 OK`: the updated `PayoutRequest` (`status: "rejected"`, `resolved_at`,
`resolved_by`, `rejection_reason` set).

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Missing/empty `reason`.
- `404` – `EARNINGS_PAYOUT_REQUEST_NOT_FOUND`
- `409` – `EARNINGS_PAYOUT_REQUEST_NOT_PENDING` – Already paid or rejected.

---

## Error envelope

`category` is one of the nine values listed in [`../errors/README.md`](../errors/README.md) and is
**always present**; `details` is omitted entirely when absent.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "EARNINGS_PAYOUT_REQUEST_NOT_PENDING",
    "message": "Human-readable description",
    "statusCode": 409,
    "category": "conflict"
  }
}
```
