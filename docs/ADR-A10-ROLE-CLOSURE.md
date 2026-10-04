# ADR-A10 — An administrator asks; the user closes one role

**Date:** 2026-10-04 (decisions taken 2026-10-03)
**Status:** Accepted, and built
**Scope:** jovi-mall (the request, the blockers, the manifest, the notices) and wi-admin (the verb, the permission, the audit). geo-tracker: no code change.
**Amends:** [ADR-A02](./ADR-A02-ACCOUNT-CLOSURE.md) D-1, which refused a dual-role account outright.
**Plan:** [`../../PRODUCTION-READINESS/ROLE-CLOSURE-PLAN.md`](../../PRODUCTION-READINESS/ROLE-CLOSURE-PLAN.md)

---

## Context

ADR-A02 built **self-service closure for customers only**. It refuses every other case:
`AccountClosureService.close` throws `ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE` for any account that
holds a role besides `customer`, and nothing anywhere closes a vendor, agency or agent role.
`users.roles.manage` sat in wi-admin's catalogue with no route, because removing a role had no
implementation.

The owner asked for this:

> An admin should be able to close the account of a user upon request, but it should only take
> place once the user confirms. An admin with enough permission can close an account even when
> it has links to other roles. The closing should only close the selected role.

---

## Decisions (owner, 2026-10-03)

| # | Question | Decision |
|---|---|---|
| O-1 | What does closing one role do? | **Anonymise-and-retain that role**, ADR-A02's philosophy applied per role. Irreversible. |
| O-2 | Live work or money on the role? | **Refuse, itemised.** Checked when the administrator asks AND again when the user confirms. Holding *other roles* is no longer a refusal. |
| O-3 | How does the user confirm? | **Signed in, as the role being closed**, from the dashboard; customers can also confirm from the bot. **7-day** expiry. The administrator may cancel while it is pending. The notice alone closes nothing. |
| O-4 | Who may ask? | New **`users.close`**, `destructive`, tiers 1 + 2, never Support. Every request and cancel is audited fail-closed in wi-admin. |
| O-5 | Contracts and connections with nothing live on them? | **Ended automatically** at closure, and the other party is told. |
| O-6 | Prepaid plan time, credit balance? | **Forfeited.** Shown as **warnings** on the request, never blockers. |
| O-7 | WhatsApp outside the 24 h window | New UTILITY templates, en + fr, submitted to Meta. |

**Derived, stated to the owner:** closing the **last** role closes the whole account. The
`users` row is anonymised and sign-in is shut, exactly as ADR-A02 does. Otherwise the person keeps
signing in with their remaining roles, and the closed role is refused, including live sessions.

---

## D-1 · A request, then a confirm — never an admin verb that closes

`role_closure_requests` holds the handshake: `pending → confirmed | declined | cancelled | expired`.
Nothing about the role changes while the request is pending. The confirm is the only write that
touches the role, and it runs as **one transaction**:

1. **The request's compare-and-set first** (`status: 'pending'`, `expires_at > now`). Two confirms
   racing (two tabs, a tap and a dashboard) run the cascade exactly once.
2. **The manifest** for that role: anonymise, delete, end relationships.
3. **The account half:** `$pull` the role from `users.roles`. If none remain, anonymise the `users`
   row through ADR-A02's own compare-and-set.

Events and the audit line are post-commit, for the reason `AccountClosureService` gives: an event
announcing a closure that rolled back is worse than a late one.

**There is no administrator confirm, and there must never be one.** The whole point of the
request is the user's consent. `test:role-closure` § 9 and wi-admin's `test:users` both fail if a
confirm route appears on the admin surface.

**Expiry is lazy.** Nothing sweeps. A `pending` row past `expires_at` reads as `expired` in both
DTOs, the confirm's filter refuses it, and a new request retires stale rows first so the partial
unique index (`role_closure_one_pending_per_role`) admits it.

## D-2 · How a closed role is shut, without widening thirty gates

A closed role is **`status: 'inactive'` plus `closed_at`**, written in one `$set`.

- `inactive` is the value every business gate already treats as "off": the storefront predicate,
  the activation gate, the agency directory, dispatch eligibility, pickup resolution and COD
  eligibility. A new `closed` status value would have been "live" to every one of them, since they
  test `=== 'inactive'` or `!== 'active'`.
- `closed_at` is what tells a closure from a suspension. Five places read it:

| Path | Refuses with |
|---|---|
| `requireAuth`: the entity is already loaded, so no extra query | `403 AUTH_ROLE_CLOSED` |
| `rotateRefreshToken`, through `user.roles.includes(payload.role)`, since the closure `$pull`ed it | `403 AUTH_ROLE_CLOSED` |
| `addRole`: the closed entity is retained and unique on `user_id` | `409 ROLE_CLOSED` |
| vendor restore · agency reactivate · agent `setStatus` | `409 ROLE_CLOSED` |
| the bot's registration upgrade, which would otherwise hand back the anonymised profile | `403 AUTH_ROLE_CLOSED` |

## D-3 · The manifest, per role

One file, `role-closure.manifest.ts`, for ADR-A02's reason: every collection holding a role's
identifiers is named in one place, so one added later is visibly missing.

| Role | Anonymised | Deleted / detached | Ended |
|---|---|---|---|
| customer | ADR-A02's customer manifest | payment methods, notifications, notification preferences, vendor annotations, file references | — |
| vendor | Vendor (name, contacts, addresses, payout details, KYC, social links, policies) and Store (name, description, logo, banner, support contacts; **slug kept**). Every active product suspended (`vendor_suspended`) | payment methods, notifications and preferences, Google Calendar tokens, file references | vendor↔agency connections |
| agency | DeliveryAgency (name, contacts, payout details, KYC, policies) and Magazin (name, logo, description, support contacts, coverage, **each depot's contact**). The admin-deactivate cascade runs too | payment methods, notifications and preferences, file references | agent contracts and vendor connections |
| agent | DeliveryAgent (name, contacts, vehicle, legal ID, emergency contact, KYC, home base, device, last position). **Tracking Allow off**, with the outbox row in the same transaction | payment methods, notifications and preferences, file references | agent contracts |

**User-scoped rows** (messaging connections, device tokens) are deleted **only** when the last role
closes, because the person's other roles still use them.

**Money is untouched**, per ADR-A02 D-1. The manifest imports no earnings, payout, COD, payment or
refund model, and `test:role-closure` § 7 scans for that.

⚠ **A depot's address is not emptied.** Its subdocument `_id`s are durable references: a product's
`agency_address_id`, `agency_stock_levels.location_id`, and the live pickup resolution of
historical shipments. A depot is a business address; only its per-depot *contact* is personal,
and that is replaced.

## D-4 · Blockers (O-2)

These are evaluated twice: when the administrator asks, and when the user confirms. Each is
something another party depends on.

| Role | Blockers |
|---|---|
| customer | orders in flight or under a dispute hold · bookings pending, confirmed, or with money pending |
| vendor | orders in flight · open bookings · pending COD collections · a held payout · any earnings balance · held allocations · stock on an agency shelf · open storage invoices · open negotiations or spendable price locks · pending stock requests |
| agency | unterminated shipments (**including `failed`**, which is not terminal for an agency) · pending COD collections · COD cash held · declared remittances · open discrepancies · held payout · earnings · depot stock · storage invoices · stock requests |
| agent | active shipments · a parcel held mid-handover (`handover.from_agent_id`) · pending offers · pending COD collections · declared deposits · open discrepancies · COD cash held · held payout · earnings |

`details.blockers` is `[{ code, count, amount?, currency? }]`, a closed vocabulary in
`role-closure.types.ts`.

## D-5 · Notices

| Event | Who is told |
|---|---|
| `role_closure.requested` | the role being closed, on its own stack, through a new `account.closure_requested` situation that no preference can mute |
| `role_closure.relationships_ended` | each counterparty whose contract or connection ended, named by the closing party's name as it was **before** the anonymisation |
| `role_closure.confirmed` / `.declined` | nobody yet; the hooks exist |
| `user.account.closed` | published on the last-role branch too, so a listener does not need to know there are two routes to it |

## D-6 · geo-tracker

There is **no code change**. An agent closure rides the existing `agent.tracking_allow_changed`
event, written in the closure transaction. Blockers guarantee no active shipment, so no tracking
session is open. ADR-B02 still holds: geo-tracker stores no customer identity.

---

## Consequences

- **ADR-A02 D-1's dual-role refusal now covers only self-service.** `POST /api/me/close` is
  unchanged and still customer-only-account. A dual-role person's customer role can be closed
  only through an administrator's request.
- **The bot's "Keep my account" declines a pending request**, so the administrator learns the
  answer. Its Confirm runs the request's confirm, which may close only the customer role.
- **Closure is irreversible on every path.** `addRole`, the bot's registration upgrade and the
  three reinstate verbs all refuse a closed role. A person who wants that role again needs a new
  account.
- **wi-admin's `test:vendors` pin is untouched.** The `=== 'inactive'` vendor check in
  `requireAuth` remains, now preceded by the `closed_at` check.
