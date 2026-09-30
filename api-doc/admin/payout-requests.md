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

**A payout takes the owner's WHOLE available balance** — the requester names no amount, and
**verification does not change that.** An owner whose KYC is not verified withdraws exactly like a
verified one.

⚠ **There is no payout cap for unverified owners since 2026-09-27 (owner decision: "we should not
block someone's money just because he is not verified").** From 2026-09-15 an optional allowance
(`EARNINGS_UNVERIFIED_PAYOUT_CAP` per rolling `EARNINGS_UNVERIFIED_PAYOUT_WINDOW_DAYS`) could limit
what an unverified owner withdrew, with partial moves and `409 EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED`.
It was inert by default and is now **deleted** — config, env variables, error code, the partial
move — so it cannot be switched back on by setting a number. The owner-facing `payoutAllowance`
field survives on `GET /api/{vendor,agency,agent}/earnings` and is **always `null`**.

The `PAYOUT_REQUEST` ticket body and this API's `verification` field still state the owner's
verdict — `KYC: verified.` or `⚠ KYC: NOT verified (<verdict>)` — so the reviewing administrator
can weigh it. **It is information, not enforcement: it limits nothing.**

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
| POST | `/api/internal/admin/payout-requests/:id/triage` | Endorse the request as genuine. Moves no money and gates nothing |
| POST | `/api/internal/admin/payout-requests/:id/send` | Send the money through the payment gateway |
| POST | `/api/internal/admin/payout-requests/:id/mark-paid` | Record a payout sent OUT OF BAND; permanently deducts the earmarked funds |
| POST | `/api/internal/admin/payout-requests/:id/reject` | Reject the request; returns the earmarked funds to `available` |
| POST | `/api/internal/admin/payout-requests/:id/resolve-unknown` | Decide a `processing` transfer whose outcome is unknown: `paid` or `failed` (hold kept) |

---

## The lifecycle

```
(none)     → pending      the owner asks (or the threshold sweep asks for them)
pending    → rejected     reject               the hold is released
pending    → processing   send                 transfer submitted, hold retained
pending    → paid         mark-paid            settled by hand, hold consumed
processing → paid         gateway callback     hold consumed
processing → failed       gateway callback     hold retained
processing → paid         resolve-unknown      an administrator confirmed it; hold consumed
processing → failed       resolve-unknown      an administrator confirmed it did not; hold retained
failed     → processing   send (retry)         reuses the same gateway reference
failed     → rejected     reject               the hold is released
failed     → paid         mark-paid            reconcile an out-of-band settlement
```

⚠ **`processing` and `failed` are BOTH still holding the owner's money.** A failed transfer
has not returned anything — the funds stay in `requested` until somebody retries or rejects.
Treating `failed` as finished is how a balance gets offered to an owner twice.

⛔ **`processing → rejected` is refused** (`409 EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT`). Releasing
a hold while a transfer may still be moving is how a payout gets sent twice: once by the
transfer that was never actually dead, and once out of the balance that came back. Wait for
the gateway to reach a verdict.

⚠ **A payout is endorsed by a FIELD, not a status.** An endorsed request is still `pending`.
That is deliberate — the status machine above is what the one-request-per-owner index and the
four-eyes guard key on, and adding a state to it would break both.

---

### GET /api/internal/admin/payout-requests

**Description**: Newest-first, paginated list of payout requests across vendors and agencies.

**Query Parameters**:
- `status` (optional) — `pending` \| `processing` \| `paid` \| `rejected` \| `failed`
- `ownerType` (optional) — `vendor` \| `agency` \| `agent`
- `page` (integer, optional, default `1`)
- `limit` (integer, optional, default `20`, max `100`)

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "id": "66f0a1...",
      "ownerType": "vendor",
      "ownerId": "6601...",
      "ownerName": "Jovi Electronics",
      "amount": 118500,
      "currency": "XAF",
      "status": "pending",
      "origin": "manual",
      "destination": { "method": "mobile_money", "provider": "MTN", "last4": "4831" },
      "verification": { "verified": false, "verdict": "pending" },
      "ticketId": "66f0a2...",
      "requestedByUserId": "6601...",
      "resolvedAt": null,
      "resolvedBy": { "id": null, "source": "platform", "name": null },
      "paidReference": null,
      "rejectionReason": null,
      "createdAt": "2026-07-14T10:00:00.000Z",
      "updatedAt": "2026-07-14T10:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

⚠ **This example was WRONG until 2026-09-15 and in the dangerous direction.** It showed the raw
`PayoutRequest` document — snake_case keys, and a `payout_method_snapshot` carrying the
beneficiary's **plaintext** mobile-money number. The endpoint stopped returning that some time
ago: it maps named camelCase fields and puts the destination through `maskPayoutMethod`. A
frontend built against the old example would have looked for fields that are not there, and — far
worse — the document advertised a plaintext account number as available on a listing every
operator can read. The shape above is the one the mapper actually emits.

`ownerName` is resolved from the vendor/agency profile for display. `destination` is **last-4
only**; the full value is served by wi-admin's `GET /api/v1/money/payouts/:id/destination`, gated
on its own permission and audited on every read. The underlying snapshot is still frozen at request
time — money already in flight cannot be redirected by a later profile edit — masking changes the
reading, not the record.

### `verification` — has anybody vetted this owner?

```json
"verification": { "verified": false, "verdict": "pending" }
```

⚠ **Read this on every row before releasing funds.** Since 2026-09-15 accounts activate
themselves once the holder proves a phone number and has a name, so **`status: "active"` is no
longer evidence that an administrator vetted the business.** Payout review is the platform's one
human checkpoint on money leaving it, and without this field an active vendor with a plausible
destination is indistinguishable from a stranger who registered this morning.

- **`verified`** — the only field to branch on. `true` only when the KYC verdict is `verified`.
  "Never reviewed" is **not** approval, so do not derive this as `verdict !== "rejected"`.
- **`verdict`** — the role's own word, for display. ⚠ **The vocabulary differs between roles and
  that is deliberate.** Vendor and agency default to `pending`; an agent defaults to `unverified`
  and reaches `pending` only once documents are actually submitted. So on an agent the two words
  separate "nothing submitted" from "submitted, awaiting review" — which is exactly what tells you
  whether to chase someone for documents. Render it; never branch on it. Treat an unrecognised
  value as unverified.

⚠ **Not snapshotted, unlike `destination`.** It is read fresh, so an approval that lands after the
request was opened shows immediately. Freezing it would display a stale "unverified" against a
business already on file and send the reviewer chasing documents that have been submitted.

⚠ **It is shown, not enforced.** Whether to pay an unverified owner is the reviewer's judgement —
the platform does not refuse the payout, and since 2026-09-27 it does not cap it either (the
unverified-owner allowance was deleted; see the top of this page).

`payout_method_snapshot.method` is `mobile_money`, `bank` or **`card`**, and exactly one of the
three sub-objects is non-null. **Owners can only configure `mobile_money` right now** — `bank` and
`card` are switched off at the write path — but a snapshot of either still reaches this queue if it
was configured before the switch, and it is still yours to pay. Switching a kind off closes the door
on new configuration, never on money already addressed. ⚠ **This paragraph used to say the snapshot is "unmasked" and that
`phone_number` and `account_number` "come through in full". That was false** — and it had been
false since the Phase 11 step-0 fix, which introduced `toAdminPayoutRequestDto` and made every
response on this surface **masked to the last four digits**. The correction two sections above
was made and this paragraph was not, so the document contradicted itself. If your client reads
a full account number from this endpoint, it is reading a field that is not there.

Nothing here can reveal the full destination. wi-admin's audited
`GET /money/payouts/:id/destination` is the only reader of the routing values on the whole
platform. A
**card** is the exception in the other direction, and not for redaction reasons: no card number
was ever collected. You get
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

**Description**: Record a payout that was sent **out of band** — you moved the money yourself
and are entering the external reference. This **permanently deducts** the earmarked `requested`
amount — there is no undo. Also auto-resolves the linked ticket with a system note and notifies
the requester.

Accepted from `pending` and from `failed` (reconciling a transfer that succeeded at the
provider after we recorded it failed). ⛔ **Refused while a payout is `processing`** — the
gateway is about to report on that transfer itself, and recording a manual payment beside it
claims a settlement twice.

⚠ This is NOT the automated path. To have the platform send the money, use `/send` below. This
route remains the only way to settle a **bank** or **card** destination, which no gateway here
can reach, and the fallback when the gateway is unavailable.

---

### POST /api/internal/admin/payout-requests/:id/triage

**Description**: Record that a reviewer has checked this request and believes it genuine.

**Body**: `{ "note": "optional, 1..500 chars" }`

⚠ **Moves no money, changes no status, and gates nothing.** A payout nobody has endorsed is
exactly as payable as one that has been — the endorsement is a note from one administrator to
the next. **A dashboard must not disable its approve control on a missing endorsement.**

There is no rejection verdict here. A reviewer who rejects calls `/reject` — the same terminal
write anyone else would make, because rejection is terminal and terminal outcomes are statuses.

**Errors**: `404` `EARNINGS_PAYOUT_REQUEST_NOT_FOUND` · `409`
`EARNINGS_PAYOUT_REQUEST_NOT_PENDING` (already resolved) · `409`
`EARNINGS_PAYOUT_ALREADY_TRIAGED` (somebody has already endorsed it — `details` names who and
when).

⛔ **Who may call this is decided by wi-admin, not here.** jovi-mall serves `/triage` and
`/send` as two routes behind one service token and does not read `X-Actor-Tier` for any
decision — that header is advisory, and the token authenticating the call is a full-privilege
credential, so branching on it would be a check the caller sets for itself.

---

### POST /api/internal/admin/payout-requests/:id/send

**Description**: Send the money through the payment gateway.

**Body**: none.

⚠ **A 200 does NOT mean the money arrived.** The usual answer is the payout in **`processing`**
— the transfer has been accepted and the gateway confirms it later by callback. Only `paid`
means settled; `failed` means the transfer was refused and **the funds are still held**.

**How a double-send is prevented**: the row is claimed into `processing` and its gateway
reference minted in one atomic update, *before* any call leaves this service. A second request
loses that race and sends nothing. A retry after a failure reuses the same reference, so a
transfer that actually succeeded and merely failed to report is deduplicated by the provider
rather than paid twice.

**Errors**: `404` `EARNINGS_PAYOUT_REQUEST_NOT_FOUND` · `409`
`EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT` (already `processing`) · `409`
`EARNINGS_PAYOUT_NOT_SENDABLE` (already resolved) · `422`
`EARNINGS_PAYOUT_GATEWAY_UNSUPPORTED` (a bank or card destination — settle it by hand) ·
`503` `EARNINGS_PAYOUT_GATEWAY_UNSUPPORTED` (automatic payouts are off on this deployment) ·
`409` `EARNINGS_PAYOUT_TRANSFER_FAILED` with `details.reason: "insufficient_gateway_balance"`
(the float is short — nothing was claimed, so retry once it is topped up).

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

### POST /api/internal/admin/payout-requests/:id/resolve-unknown

**Description**: The manual exit for a transfer whose outcome is **unknown**. The payout is
`processing` because the transfer POST timed out or threw after the claim. Such a row carries
`transferFailureReason: "Outcome unknown: …"` naming the reference to look up. It has no provider
transfer id, so the reconciliation sweep cannot ask about it, and `mark-paid` and `reject` refuse
`processing` by design. An administrator who has checked the provider's own records decides it.

Both outcomes settle through `applyTransferOutcome`, the same compare-and-set on `processing`
that a transfer callback uses, so a callback or the sweep landing at the same moment resolves it
exactly once:

- `paid`: the balance is debited and the payout settles in one transaction. `resolved_by` is **the
  administrator** (`resolved_by_source: "admin"` plus a name snapshot), not the platform. A
  gateway-confirmed settlement still stamps the platform.
- `failed`: the payout moves to `failed` with the **hold kept** (ADR-024 D-7), ready for `send` (a
  retry that reuses the same reference) or `reject`.

The linked ticket gets a note naming the administrator, the reason and the evidence.

The route applies to **any** `processing` row, with or without a gateway transfer id. A row whose
gateway cannot be asked, or keeps answering inconclusively, needs the same exit.

**Request Body** (`.strict()`):
```json
{ "outcome": "paid", "reason": "MyCoolPay dashboard shows jm_po_8f2… SUCCESS", "evidence": "MCP txn 77812" }
```
`outcome` is `paid` | `failed`. `reason` is required, 10–500 characters. `evidence` is optional,
1–500 characters.

**Who may call it, and whether a large `paid` needs a second administrator, is decided in
wi-admin**, like everything else on this mount (`paid` requires `money.payouts.mark_paid` and the
≥ 2,000,000 XAF four-eyes rule; `failed` requires `money.payouts.triage`).

**Success Response** — `200 OK`: the updated `PayoutRequest`.

**Error Responses**:
- `400` – `VALIDATION_ERROR` – bad `outcome`, a short or missing `reason`, or an unknown key.
- `404` – `EARNINGS_PAYOUT_REQUEST_NOT_FOUND`
- `409` – `EARNINGS_PAYOUT_NOT_PROCESSING` – the payout is not `processing` (`details.status`),
  or a callback or the sweep resolved it between the read and the write.
- `409` – `EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT` – too soon. The payout has been `processing` for
  less than `PAYOUT_RECONCILE_MIN_AGE_MINUTES` (default 15), measured from `updated_at`, so a
  callback may still arrive. `details.settleAfter` (ISO) and `details.minAgeMinutes`. This is the
  same setting the sweep uses.

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
