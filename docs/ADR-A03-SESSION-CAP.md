# ADR-A03 — A bearer session gets a 90-day absolute cap

**Date:** 2026-08-18 (evidence gathered 2026-08-17) · **implemented 2026-08-19**
**Status:** Accepted — **IMPLEMENTED**, plan step 4.A.5, with one correction recorded below
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

---

## D-3 · Correction, made while implementing (2026-08-19)

> Recorded rather than quietly fixed, because it is the difference between this decision
> working and this decision being unreachable — and because the wrong version would have
> passed every test anyone would think to write.

**Plan step 4.A.5.2 names four `auth.service.ts` sites as credential-proving and tells them to
stamp `auth_time` fresh: `:221`, `:300`, `:330`, `:390`.** Read out of the tree, those are
`register`, `login`, **`authMe`** and **`addRole`** — and the last two prove no credential. Both
sit behind `requireAuth`; their caller presented a *token*, exactly as the rotation's does.

`auth-me` in particular is named in this ADR's own Context paragraph as a **cause** of the
uncapped window: *"every client calls `auth-me` on launch and is re-issued both tokens at full
lifetime"*. Stamping fresh there would reset the 90-day clock every few days for the life of
every account — `now − auth_time` would never approach the cap, and the feature would be
inoperative while looking complete.

**What was built instead:**

| Site | `auth_time` | Why |
|---|---|---|
| `login` | **fresh** | `bcrypt.compare` ran |
| `register` | **fresh** | the password is set here |
| `messaging-login` `issueSession` | **fresh** | a single-use bot credential was spent |
| `user.controller.ts` password change | **fresh** | D-8, unchanged — the old password was proved, and this keeps "change your password" a complete remedy |
| `rotateRefreshToken` | **copied** | as decided |
| **`authMe`** | **copied** | ⬅ the correction |
| **`addRole`** | **copied** | ⬅ the correction |

Both re-issue methods take `authTime` as a **required** parameter — omitting it must not
compile, the same reasoning D-1 applies to the two `generate*` functions. `requireAuth`
publishes the verified claim as `req.auth.auth_time` (with D-9's fallback already applied) and
all four call sites — browser and mobile — pass it through.

**A second consequence follows and is not optional.** If `authMe` copies but nothing checks the
cap on the access path, a client polling `auth-me` inside the 15-minute access lifetime never
reaches `rotateRefreshToken` and slides forever anyway. So the refusal is on **both** credential
paths, which is the identical argument `password-epoch.ts` already makes for its own two call
sites — `rotateRefreshToken` evicts, `requireAuth` closes the tail and covers the re-issue
routes behind it. D-1's "rotateRefreshToken refuses" is therefore necessary and not sufficient.

**The generalisable lesson**, and it is the plan's own: a step that names line numbers has
already read the file, and a reader who does not re-read it inherits the reading. Same shape as
F-27 and as cross-service defect 3.

---

## Implementation notes

- The predicate is `core/auth/session-cap.ts`, deliberately shaped like `password-epoch.ts`:
  pure, no imports beyond the constant, and failing **closed** on a payload it cannot date.
- `AUTH_ABSOLUTE_SESSION_CAP` (seconds, default 7 776 000) is in `.env.example` with its
  provenance line; `test:env` fails in both directions.
- `AUTH_SESSION_CAP_REACHED` is 401 and derives to the `authentication` category from
  `(code, statusCode)` — never annotated, per the error system.
- `test:mobile-auth` **102/2 → 127/2**; `.github/workflows/ci.yml` moved with it. The 2 is
  still the `isValid` exclusion.
- `api-doc/auth/README.md`'s "Known limitation" section no longer promises an uncapped sliding
  window; it carries the cap, the code, the four-way 401 comparison table, and the instruction
  that matters most — **route to login, never retry**.
