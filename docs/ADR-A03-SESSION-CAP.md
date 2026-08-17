# ADR-A03 — A bearer session gets a 90-day absolute cap

**Date:** 2026-08-18 (evidence gathered 2026-08-17)
**Status:** Accepted — decided; implemented in Phase 4.A.5
**Scope:** jovi-mall
**Answers:** [Q-3](../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md#q-3--should-a-bearer-session-have-an-absolute-cap)
of the Phase D register · closes **A-3**

---

## Context

`AuthService.rotateRefreshToken` issues a **fresh pair**, and its own docstring states the
consequence rather than smuggling it:

> *"the 30-day window becomes sliding with no absolute cap, so a stolen refresh token an attacker
> keeps refreshing never lapses"* — `src/modules/auth/auth.service.ts:98`, repeated at
> `api-doc/auth/README.md:1217`.

Every client calls `auth-me` on launch and is re-issued both tokens at full lifetime, so this
predates the mobile namespace rather than arriving with it. Two things *do* revoke today, and
both work: a password change (`password_changed_at` vs `iat`, checked on **both** credential
paths) and a suspension (`user.status !== 'active'`, checked inside `rotateRefreshToken`).

What is missing is a clock. After a compromise the only remedy is a password change the victim
must know to perform.

---

## D-1 · Decision

**A 90-day absolute cap, carried statelessly in the token.**

- An `auth_time` claim is set at **login** and copied **unchanged** through every rotation. It is
  the one value a rotation must not refresh — refreshing it is the bug this decision exists to
  prevent, and it would look exactly like working code.
- `rotateRefreshToken` refuses when `now − auth_time > cap`, with a distinct error code so a
  client can tell "sign in again" from "your password changed".
- No session store, no new collection, no boot-time state. That matters: `users.sessions.revoke`
  is unbuilt in wi-admin **precisely** because there is no session store, and this decision must
  not quietly create one and leave that rationale stale.

**Why 90 days:** long enough that a real user experiences it as a rare event rather than friction
— a bearer client cannot renew silently inside an ordinary GET the way a cookie client does, so
every cap is a visible sign-out — and short enough that a stolen credential does not outlive a
quarter.

---

## D-2 · What this decision does **not** touch

**The bearer/cookie silent-refresh asymmetry stays exactly as it is.** `requireAuth` refreshes
from the refresh cookie when the caller presented **no credential at all**, and refuses to refresh
a caller who presented an **expired bearer**. That is deliberate, it is asserted by a source scan
in `test:mobile-auth`, and tidying the two branches into symmetry signs out every browser session
older than fifteen minutes. It is on the do-not-fix list and Q-3 was never about it.

Likewise unchanged: token lifetimes (`ACCESS_TOKEN_TTL_S` / `REFRESH_TOKEN_TTL_S` remain the one
pair of constants both the cookie `maxAge` and the JWT `expiresIn` derive from), and the
password-epoch revocation.

---

## Consequences

- **Native clients sign in again quarterly.** The Flutter agent app and any Capacitor-wrapped
  dashboard must handle a refresh refusal by routing to login rather than retrying — worth stating
  in the changelog, because a client that treats it as a transient failure will loop.
- **`api-doc/auth/README.md:1217` must change in the same commit.** It currently documents the
  uncapped sliding window as a property clients may rely on; leaving it is precisely the
  stale-doc failure X-8 records.
- Cookie clients are unaffected in practice — a browser session reaching 90 days without a login
  is rare, and the refusal is a redirect to a login page they already have.
- `test:mobile-auth`'s baseline moves when this lands; it gains cases for the cap and for
  `auth_time` surviving a rotation unchanged.
