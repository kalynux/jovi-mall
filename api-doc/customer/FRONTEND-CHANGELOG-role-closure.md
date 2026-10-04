# Role closure: customer / storefront (2026-10-04)

**For:** the storefront (`/shop`, the signed-in customer area). Read [the cross-role changelog](../FRONTEND-CHANGELOG-role-closure.md) and the contract [`../me/role-closure.md`](../me/role-closure.md) first.

## Build

1. ⏳ **A new page at `/shop/account/closure`** (locale-prefixed like every `/shop/account/*`
   page). ⚠ **This page must be live before the WhatsApp template
   `customer_account_closure_requested` is submitted**, because Meta freezes the button URL at
   approval. It is listed as NOT BUILT in `api-doc/notifications/storefront-routes.md`; mark it
   built there when it ships.
   - `GET /api/me/closure-request`. When `data` is null, show "nothing is waiting".
   - Show the administrator's `reason`, `expiresAt`, and `blockers[]` (`orders_in_flight`,
     `bookings_upcoming`). Disable Confirm unless `canConfirm`.
   - **Confirm** sends `{ "confirm": "CLOSE MY ACCOUNT" }` behind a deliberate step. **Decline**
     sends an optional `{ note }`.
   - Copy: their shopping account will be **closed**, not "deleted". Past orders are kept
     without their details.
2. **After confirm:** the cookies are cleared. `outcome.accountClosed: false` means the person
   still has a business role (shop, agency…), so send them to sign-in; `true` shows an
   "account closed" page.
3. **Global:** `403 AUTH_ROLE_CLOSED` means sign out, with no refresh loop.
4. Optional: a banner in `/shop/account` when `GET /api/me/closure-request` returns a request.

The notice also reaches the customer in chat, where the bot handles confirm and decline itself
(no storefront work). The in-app notification is `type: 'account.closure_requested'`,
`aggregateType: 'account'`, button "Open my account" leading to `/shop/account/closure`.

## Docs to copy

`api-doc/me/role-closure.md` · `api-doc/FRONTEND-CHANGELOG-role-closure.md` · this file · `api-doc/notifications/storefront-routes.md` · `api-doc/notifications/deep-links.md`
