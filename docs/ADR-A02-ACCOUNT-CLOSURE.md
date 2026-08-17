# ADR-A02 — "Delete my account" means anonymise-and-retain

**Date:** 2026-08-18 (evidence gathered 2026-08-17)
**Status:** Accepted — decided; implemented in Phase 6.D
**Scope:** jovi-mall (and, for the trail, geo-tracker)
**Answers:** [Q-2](../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md#q-2--what-does-delete-my-account-mean-and-is-it-a-legal-obligation-here)
of the Phase D register

---

## Context

Nothing exists today. `grep` for `deleteAccount|account-deletion|data-export|anonymi` over `src`
returns **zero hits**, and `/api/me` carries exactly two things: `PATCH /password` and the
messaging-connections mount (`modules/users/user.routes.ts`). Email change, phone change,
deletion, export and session revocation are all unbuilt.

What deletion collides with, in this tree:

- **Orders** — simultaneously a vendor's business record and a platform tax record. Neither is
  the customer's to erase.
- **COD balances** — an agent or agency may still owe or be owed money against that customer's
  orders, and the two liability balances are independent by design (`modules/cod/`).
- **Roles** — one `users` row can hold `customer` *and* `vendor`. Deleting the person deletes a
  shop, its products and its payout history.
- **geo-tracker** — shipment tracking history and the GPS trail live in a second service with its
  own retention rules and its own cleanup job.

---

## D-1 · The product answer

**Anonymise-and-retain, and say "anonymise" rather than "delete".**

- The `users` row **keeps its `_id`** and loses its identifiers — `login_email`, `login_phone`,
  name, avatar, saved addresses, messaging connections.
- **Orders keep their reference to that id.** They become a pseudonymous record: the shape of the
  transaction survives for the vendor and for tax, the person does not.
- **Money records are untouched.** COD liability, earnings, payouts and refunds are not the
  customer's personal data to remove, and removing them would corrupt somebody else's balance.
- **The account cannot be signed into again.** The credential path is closed by the same
  mechanisms that already exist — `User.status` refuses authentication on all three paths, and
  `password_changed_at` invalidates every live token.
- **A dual-role account is refused**, not partially closed. Somebody holding `vendor` alongside
  `customer` closes the shop first; the alternative is a half-anonymised person who still owns a
  storefront with their name on it.

The two **change + re-verify** flows — email and phone — are ordinary work, blocked by nothing,
and should be built first regardless of when closure is (Phase 6.D says the same).

## D-2 · The regulatory question is treated as not applicable, for now

**Decision: no legal enquiry is opened at this time.** The platform's operating market is
Cameroon (`GEO_DEFAULT_COUNTRY_CODES` defaults to `cm`, `Vendor.timezone` to `Africa/Douala`),
and no obligation has been established that would make erasure statutory or put a clock on it.

Two things follow, and they are the reason this is a decision rather than an omission:

- **D-1 is a product promise, not a compliance position.** Nothing here should be described to a
  customer, or in a privacy policy, as satisfying a legal right — it satisfies a reasonable
  expectation.
- **This is the row to revisit if the market changes.** Serving customers in a jurisdiction with a
  statutory erasure right, or taking payment through a processor that imposes one contractually,
  reopens it. The trigger is a *new market or a new processor*, not a date.

---

## Consequences

- **Phase 6.D is unblocked.** Deletion and export are designable: export means "the data we would
  anonymise, rendered", and it is optional under D-2 rather than required.
- **Session revocation stays unbuildable as asked** — stateless JWTs with no session store, and
  the password-epoch mechanism is a revoke-**all**, not a revoke-**one**. Unchanged by this ADR,
  and related to [ADR-A03](./ADR-A03-SESSION-CAP.md).
- **geo-tracker needs a position on the trail.** Anonymising in jovi-mall does not reach the
  checkpoints and history rows in Postgres. Their existing retention/cleanup job is the natural
  answer — say so explicitly in Phase 6.D rather than leaving a second service holding a location
  history for an account this one has closed.
