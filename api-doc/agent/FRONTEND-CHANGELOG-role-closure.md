# Role closure: agent (2026-10-04)

**For:** the agent app (`agent_app`, Flutter). Read [the cross-role changelog](../FRONTEND-CHANGELOG-role-closure.md) and the contract [`../me/role-closure.md`](../me/role-closure.md) first.

## Build

1. **A closure screen**, reached from the notification deep link **`account/closure`** (map
   that pinned path to your own route, as with the other deep links) and from a banner when a
   request is pending (call `GET /api/me/closure-request` on app load or settings open).
   - Show the administrator's `reason` verbatim, the `expiresAt` deadline, and every `warnings[]`
     item (paid plan time, credits lost).
   - List `blockers[]` with what to do about each. Disable Confirm unless `canConfirm` is true.
   - **Confirm** sends `POST /api/me/closure-request/confirm` with `{ "confirm": "CLOSE MY ACCOUNT" }`,
     behind a deliberate step (typed phrase or checkbox). Copy says your **agent account** will be
     **closed**, never "deleted".
   - **Decline** sends `POST /api/me/closure-request/decline` with an optional `{ note }`.
2. **After confirm:** sign out of the agent role. Then `outcome.accountClosed` decides: `false`
   goes to sign-in (the person keeps other roles), `true` goes to an "account closed" screen.
3. **Global handling:** `403 AUTH_ROLE_CLOSED` on any call or on refresh means sign out, with
   no refresh loop. `409 ROLE_CLOSED` on add-role means that role cannot be reopened.
4. **Notifications inbox:** accept `type: 'account.closure_requested'` with
   `aggregateType: 'account'`; its button is "Review request", leading to `account/closure`.
   Also accept: `agent_contract.ended_by_closure`: an **agency** you work for closed its account and the contract was deactivated (`deactivation_reason: 'role_closed'`). Deep link `memberships/{{contractId}}` (existing path).

## Blocker codes this role can receive

`shipments_active` · `shipments_handover_held` · `offers_pending` · `cod_collections_pending` · `cod_deposits_declared` · `cod_discrepancies_open` · `cod_cash_held` · `payout_request_held` · `earnings_balance` · `earnings_allocations_held`

Closing turns Tracking Allow off, so the app should stop location streaming and close its geo-tracker socket when the session ends. Bearer client: discard both tokens on confirm, and on any `403 AUTH_ROLE_CLOSED`.

## Docs to copy

`api-doc/me/role-closure.md` · `api-doc/FRONTEND-CHANGELOG-role-closure.md` · this file · `api-doc/notifications/deep-links.md`
