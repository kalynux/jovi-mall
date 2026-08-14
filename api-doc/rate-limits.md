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
| credential | **the whole `/api/auth` prefix** | IP address | **20** | `RATE_LIMIT_AUTH_PER_MIN` |

Three things to read out of that table:

- **Not signed in ⇒ 1200 per IP, and nothing else.** Layer B never sees an unauthenticated
  request, so there is no separate anonymous identity ceiling in force.
- **Authenticated callers are counted per user *as well as* per address.** An office, a school
  or a mobile carrier's NAT puts many people behind one IP; once you are signed in, Layer B is
  what actually bounds you, and their traffic is not yours.
- **The auth bucket is the strict one, and it is strict on purpose.** It bounds one source
  trying many passwords across many accounts. If you are legitimately hitting 20
  sign-in attempts a minute from one address, you are doing something the API should be
  told about rather than tuned around.

> ⚠ It is keyed on the **path prefix `/api/auth`**, not on "endpoints that take a password".
> Everything under it shares one 20/min IP bucket — including `/auth/me`, `/auth/auth-me/:role`
> and the `/auth/browser/*` trio. There are no password-reset endpoints on this service.

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
