# Rate limits

**New in Phase 16.** This API had no rate limiting of any kind before it. If you have been
building against it, nothing you were doing at a normal pace will start failing — the
ceilings are set so that no realistic client reaches them.

## What you get back

```http
HTTP/1.1 429 Too Many Requests
RateLimit: limit=600, remaining=0, reset=42
RateLimit-Policy: 600;w=60
Retry-After: 42
Content-Type: application/json
```

```json
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests — please wait a moment and try again",
    "statusCode": 429,
    "category": "rate_limit",
    "details": { "retryAfterSeconds": 60 }
  }
}
```

The headers are IETF draft-7. **Prefer them** — `RateLimit: remaining=…` lets a client slow
down *before* being refused, which the body cannot.

## The ceilings

Per 60-second window. Every one of these is a **backstop, not a budget**: they exist to stop
a runaway loop or a scraper, and they are set well above what any real user of that role
generates.

There are **two layers**, and both apply to a signed-in caller. Layer A is IP-scoped and runs
before authentication; Layer B is identity-scoped and runs at the tail of `requireAuth`, so an
anonymous caller is bounded by Layer A only.

| Layer | Caller | Counted per | Limit | Env var |
|---|---|---|---|---|
| A — global | **every caller**, signed in or not | IP address | 1200 | `RATE_LIMIT_GLOBAL_PER_MIN` |
| B — identity | Agent | user | 1200 | `RATE_LIMIT_AGENT_PER_MIN` |
| B — identity | Platform admin | user | 1200 | `RATE_LIMIT_ADMIN_PER_MIN` |
| B — identity | Vendor | user | 900 | `RATE_LIMIT_VENDOR_PER_MIN` |
| B — identity | Agency | user | 900 | `RATE_LIMIT_AGENCY_PER_MIN` |
| B — identity | Customer | user | 600 | `RATE_LIMIT_CUSTOMER_PER_MIN` |
| credential | `/api/auth` paths that **present** a credential | IP address | **20** | `RATE_LIMIT_AUTH_PER_MIN` |
| session | `/api/auth` paths that **extend** a session | IP address | 300 | `RATE_LIMIT_AUTH_SESSION_PER_MIN` |
| C — connection code | `POST /api/me/connections` | IP address | **30** | `RATE_LIMIT_CONNECTION_CODE_PER_MIN` |

Four things to read out of that table:

- **Not signed in ⇒ 1200 per IP, and nothing else.** Layer B never sees an unauthenticated
  request, so there is no separate anonymous identity ceiling in force.
- **Authenticated callers are counted per user *as well as* per address.** An office, a school
  or a mobile carrier's NAT puts many people behind one IP; once you are signed in, Layer B is
  what actually bounds you, and their traffic is not yours.
- **The credential bucket is the strict one, and it is strict on purpose.** It bounds one source
  trying many passwords across many accounts. If you are legitimately hitting 20
  sign-in attempts a minute from one address, you are doing something the API should be
  told about rather than tuned around.
- **The connection-code bucket is the second security control, and it stacks with a third.**
  `POST /api/me/connections` takes a 6-character code, which is guessable in a way a password
  is not. It is bounded per IP here (30/min, `RATE_LIMIT_EXCEEDED`) *and* per account by a
  separate attempt counter — 5 tries per 10 minutes, answering
  `CONNECTION_CODE_ATTEMPTS_EXCEEDED`. The two key on different axes on purpose: accounts are
  free to create, so an account-scoped limit alone bounds nothing. Expect either code, and do
  not retry in a loop on either.

### The two `/api/auth` buckets

They are split by **what the request does**, not by which router serves it. Exactly one applies
per request, so `RateLimit: remaining=…` always describes the counter that is binding you.

| Bucket | Paths |
|---|---|
| **credential**, 20/min/IP | `login` · `register` · `forgot-password` · `reset-password` · `add-role` · `send-email-verification` · `request-wa-verification` · `verify-email` · `logout` · `browser/login` · `browser/logout` · `mobile/login` · `mobile/register` · `mobile/add-role` |
| **session**, 300/min/IP | `me` · `auth-me/:role` · `mobile/auth-me/:role` · `browser/refresh` · `mobile/refresh` |

> ⚠ **The credential bucket is the DEFAULT.** Anything added under `/api/auth` later lands in
> it unless it is named on the session list — the safe direction, since the mistake it prevents
> is a new credential endpoint silently inheriting 300/min.

This split exists because the two kinds of traffic were sharing one counter and the failure
mode was bad: a user whose refresh was refused got signed out, tried to sign back in, and found
the sign-in refused too — by their neighbours' traffic behind the same NAT. Renewing a session
you already hold presents an unguessable signed token, never a password, so the
password-spraying argument that justifies the 20 does not apply to it.

**Where 300 comes from.** Not from refresh — at roughly four renewals an hour per active user,
300 covers about 1200 users behind one address. It is set from `/auth/me`, which a dashboard
polls: at once a minute, a 120 ceiling would bind at 120 concurrent users on one office IP,
which is reachable. Both `me` and `auth-me` sit behind authentication, so Layer B already bounds
each *person* and Layer A still bounds the address; this counter's remaining job is only to stop
one client looping on refresh.

**Internal service callers are exempt** from Layers A and B (resolved from the
`INTERNAL_SERVICE_TOKEN` / `INTERNAL_ADMIN_SERVICE_TOKEN` shared secret, not from a JWT), but
**not** from the credential bucket — nothing internal signs in, so an exemption there would only
be usable by something that had already stolen the token.

Agents get the most generous ceiling because the agent app polls offers, shipment status and
position, and is the client most likely to be on a bad connection retrying.

## Never limited

Three path prefixes, matched on a segment boundary (`/api/healthcheck-bypass` does **not**
inherit `/api/health`'s exemption) and on `req.path` only — a query string can never talk its
way in. The list is closed; see `src/api/rate-limit/exempt-paths.ts`.

- `/api/health` — and everything under it (`/live`, `/ready`), every method. geo-tracker
  registers `GET /api/health` as a **readiness** checker and treats any status ≥ 300 as an
  error, so a 429 there pulls geo-tracker out of rotation and kills every live WebSocket
  tracking session.
- `/metrics` — a throttled scrape is a monitoring gap that opens exactly when load is high. It
  has its own token gate.
- `/api/webhooks` — and everything under it (Stripe, NotchPay, MyCoolPay, WhatsApp, Telegram),
  every method, including the authenticated WhatsApp/Telegram link-management routes that share
  the prefix. A 429 to Stripe does not inconvenience a caller; it loses a payment notification.

## Behaviour worth relying on

**It fails open.** If the counter store is unavailable, requests are **allowed** rather than
refused. A cache problem will never present as a platform-wide 429.

**A 429 is always safe to retry**, after the window. It means the request was not processed —
not that it half-was.

**Do not retry-storm.** Respect `Retry-After`. A client that retries immediately on 429 is
the reason the ceiling exists.

## If a limit is wrong

It is a configuration value, not a deploy. Every ceiling is an environment variable
(`RATE_LIMIT_*`), and the platform records `jovimall_rate_limited_total{caller_class,policy}`
— so "this integration is being throttled" is a question with an answer. Raise it.
