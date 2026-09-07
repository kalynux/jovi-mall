# Close Account API

**Verified against source on 2026-09-08** — the route and verb, the exact `confirm` literal, the
two 422 refusals with their `details`, the 409 compare-and-set, the cookie clear and the
`password_changed_at` stamp, against `jovi-mall/src/modules/users/user.controller.ts:89-130`,
`account-closure.service.ts` and `user.validator.ts:77-104`.

Reference for closing — and anonymising — the authenticated **customer's** own account.

> [!IMPORTANT]
> **This anonymises and retains. It is not a deletion, and it must not be presented to a
> customer as one.** The account row survives so that past orders, tickets and bookings still
> resolve; what is removed is the person. Design record:
> [ADR-A02](../../docs/ADR-A02-ACCOUNT-CLOSURE.md).
>
> ADR-A02 **D-2** is explicit about the second half: no statutory erasure obligation has been
> established in this market, so nothing here — in your UI copy, in a help page or in a privacy
> policy — may describe this as satisfying a legal right. It satisfies a reasonable
> expectation. Use the word **close**, and say what is kept.

> [!NOTE]
> **A customer can also close their account from a chat**, since MCP parity step 7 — as a
> deliberate **two step**: `account_close_preview` (a read) answers `canClose`, the two
> blockers, and the anonymise-and-retain sentence **already localised**, and only then does
> `account_close` run. The sentence is written on the backend for the reason this whole
> paragraph exists: the automation layer has no copy table, and "deleted" is exactly the word
> it would reach for. Contract: `api-doc/n8n/bot-surface.md` § 16.3.

---

## Authentication

Requires a valid access token belonging to a **customer**.

```
Authorization: Bearer <access_token>
```

The token may also be supplied via the `access_token` httpOnly cookie (browser clients).

---

## `POST /api/me/close`

Close the caller's own account. The account is always the one in the token — there is no id
in the path, and the body is `.strict()`, so a `userId` in it is a `400`, never a way to aim
this at somebody else.

### Request body

```json
{ "confirm": "CLOSE MY ACCOUNT" }
```

| Field | Type | Notes |
|---|---|---|
| `confirm` | string | **Required**, and must be exactly `CLOSE MY ACCOUNT` |

**Why a typed phrase and not the password.** Customers on this platform are *passwordless by
default* — registration mints a random password and they sign in through the messaging bot
(see [auth/customer-auth.md](../auth/customer-auth.md)) — so a password prompt would make
closure impossible for most of the people entitled to it. The phrase does the one job a
confirmation can do: it makes the request impossible to send by accident. The access token is
what proves who is asking.

### Response (200)

```json
{
  "success": true,
  "message": "Your account has been closed and your personal details anonymised. Past orders are kept as business records, without your name or contact details.",
  "data": { "closedAt": "2026-08-21T09:14:02.113Z" }
}
```

The auth cookies are cleared on the way out. A bearer client should discard its own pair — both
tokens are already dead (see *What happens to your session*, below).

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `confirm` missing, misspelled, or an unexpected key in the body |
| 401 | `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | |
| 404 | `USER_NOT_FOUND` / `CUSTOMER_NOT_FOUND` | |
| 409 | `USER_STATUS_CONFLICT` | The account is not `active` — most often, it was already closed by a request that raced this one |
| 422 | `ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE` | The account holds a role beyond `customer`. `details.blockingRoles` names them |
| 422 | `ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT` | Orders are still moving. `details.activeOrderCount` says how many |

---

## The two refusals, and what a client should say

### A dual-role account is refused, not partially closed

ADR-A02 D-1. Somebody holding `vendor` alongside `customer` has a shop, products, payouts and a
KYC record hanging off the identity this would erase; anonymising the person behind a live
storefront leaves it trading under a name nobody can resolve.

`details.blockingRoles` is an array (`["vendor"]`, `["agent"]`, …). Route the customer to
closing that role first — there is no self-service verb for it yet, so today that means support.

### Orders in flight are refused

**This one is not in ADR-A02.** It was added with the implementation because the anonymisation
does not merely lose contact with the customer, it strands a parcel: the COD delivery code is
sent to `Customer.phone`, which closure clears, and the messaging connections that carry every
other delivery notification are deleted. The agent arrives holding something they can no longer
be given a code for.

An order counts as in flight when its `fulfillment_status` is anything other than `fulfilled`,
`cancelled` or `returned`, **or** it is under a dispute hold. Tell the customer to come back
when their orders finish, and show the count.

---

## What is removed, what is kept, and what is deleted

### Removed from the account (the row survives, its identifiers do not)

| Where | What goes |
|---|---|
| `users` | `login_email`, `login_phone`, and the stored password hash. The `_id` is **kept** |
| Customer profile | name (replaced with *Closed account*), email, phone, avatar, bio, saved addresses, date of birth, saved payment methods, marketing opt-in |

### Deleted outright — these rows *are* the identifier

Messaging connections (WhatsApp / Telegram), push device tokens, saved payment instruments, and
the in-app notification history. Each is either an address the person can be reached on or a
name; anonymising them would keep exactly the part that identifies them. Deleting the messaging
connection also frees that number, so the same person may connect it to a new account later.

### Untouched

**Orders, shipments, cash collections, earnings, payouts, refunds, bookings, digital
entitlements and support tickets.** They keep their reference to the retained id and become
pseudonymous by construction — none of them snapshots a name, an email or a phone number. Money
records in particular are not the customer's personal data to remove, and removing them would
corrupt somebody else's balance (ADR-A02 D-1).

One partial write sits between the two groups: a vendor's private customer row keeps its
statistics (`order_count`, `total_spent`, `last_order_at`, flags) and loses its
`display_name_override`, because that field is a name and it is what a vendor's customer list
prints.

### The one thing this does not reach: geo-tracker

Anonymising here does not reach the second service. It does not have to —
[`geo-tracker/docs/ADR-B02-CLOSED-ACCOUNT-TRAIL.md`](../../../geo-tracker/docs/ADR-B02-CLOSED-ACCOUNT-TRAIL.md)
records the position and the evidence for it: geo-tracker stores **no customer identity at
all**, and the one customer-derived value it holds (the drop-off coordinate on a live tracking
session) never reaches Postgres and dies with the session.

---

## What happens to your session

Three locks land together, and each would be sufficient on its own:

1. **`status: 'closed'`** — refused on every authenticated request, at login, at refresh
   rotation and at password-reset redemption, with the distinct code `AUTH_ACCOUNT_CLOSED`
   (403). Not `AUTH_ACCOUNT_SUSPENDED`: a suspension is an appealable administrative decision
   and a closure is not, and a client should not offer "contact support to have this lifted".
2. **`password_changed_at`** stamped to the closure instant — every access token and refresh
   cookie minted before it is refused on sight.
3. **The identifiers are gone**, so `POST /api/auth/login` can no longer resolve the account at
   all, by email or by phone.

There is **no un-close**. `POST /api/internal/admin/users/:id/restore` compare-and-sets from
`suspended`, so it misses a closed row and answers `409` — and there is nothing to restore the
identifiers to in any case.

---

## Related

- [password.md](./password.md) — the other `/api/me` account verb
- [auth/customer-auth.md](../auth/customer-auth.md) — why customers are passwordless
- [customer/profile.md](../customer/profile.md) — the profile this anonymises
- [errors/README.md](../errors/README.md) — the error envelope
