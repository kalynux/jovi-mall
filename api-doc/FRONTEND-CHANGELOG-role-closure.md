# Frontend changelog: role closure (2026-10-04)

**Who:** every app. This is the cross-role half; each app's own tasks are in its role folder:
[vendor](./vendor/FRONTEND-CHANGELOG-role-closure.md) ·
[agency](./agency/FRONTEND-CHANGELOG-role-closure.md) ·
[agent](./agent/FRONTEND-CHANGELOG-role-closure.md) ·
[customer (storefront)](./customer/FRONTEND-CHANGELOG-role-closure.md) ·
admin dashboard: `admin/api-doc/FRONTEND-CHANGELOG-role-closure.md`.

**Contract:** [`me/role-closure.md`](./me/role-closure.md) · **Design record:** [`../docs/ADR-A10-ROLE-CLOSURE.md`](../docs/ADR-A10-ROLE-CLOSURE.md)

## What changed

An administrator can **ask** a person to close ONE of their roles (customer, vendor, agency or
agent). **Nothing happens until the person confirms**, signed in as that role, within 7 days.
Confirming anonymises that role and cannot be undone. The person's other roles are unaffected.
If it was their last role, the whole account closes.

## The three endpoints (every app, same routes)

| Call | Use |
|---|---|
| `GET /api/me/closure-request` | `data: null` means nothing is waiting; otherwise `{ reason, expiresAt, warnings[], blockers[], canConfirm }` |
| `POST /api/me/closure-request/confirm` | body `{ "confirm": "CLOSE MY ACCOUNT" }` (exact phrase). Answers `outcome.accountClosed` |
| `POST /api/me/closure-request/decline` | body `{ "note"?: string }` |

The role is taken from the **session**. Never send a role or user id.

## Rules every app must follow

1. **Say "close", never "delete".** Product rule (ADR-A02 D-2).
2. **Show `warnings` before the button** (paid plan time or credits forfeited), and **disable the
   button while `blockers` is non-empty** (`canConfirm: false`). Render each blocker code; the
   table is in `me/role-closure.md`.
3. **Make the confirm deliberate.** Have the person type or tick something; the API requires the phrase.
4. **After a successful confirm, drop the session for that role** (cookies are already cleared;
   bearer clients discard their token pair). Then:
   - `accountClosed: false`: go to sign-in. The person still has other roles.
   - `accountClosed: true`: show a "your account is closed" screen. There is nothing to sign in to.
5. **Handle `403 AUTH_ROLE_CLOSED` globally**, on any request and on refresh: sign out of that
   role and **do not retry or refresh**. Treat it like `AUTH_ACCOUNT_CLOSED`.
6. **Handle `409 ROLE_CLOSED`** on add-role ("this role was closed on your account and cannot be reopened").
7. **New notification values.** Accept them in your notification type unions, or a strict client
   will drop them:
   - `type: 'account.closure_requested'` with the new `aggregateType: 'account'` (`aggregateId` is
     the request id). Its deep link is the pinned path **`account/closure`**, which each app maps
     to its own closure screen (see `notifications/deep-links.md`).
   - Counterparty notices `connection.ended_by_closure` / `agent_contract.ended_by_closure`, which
     reuse the existing connection and contract deep links.

## Docs to copy

| File | Why |
|---|---|
| `api-doc/me/role-closure.md` | the contract: payloads, errors, blocker codes |
| `api-doc/FRONTEND-CHANGELOG-role-closure.md` | this file |
| `api-doc/<your-role>/FRONTEND-CHANGELOG-role-closure.md` | your app's tasks |
| `api-doc/notifications/deep-links.md` | the `account/closure` path and the new situations |
| `docs/ADR-A10-ROLE-CLOSURE.md` | optional background: what is removed and what is kept |
