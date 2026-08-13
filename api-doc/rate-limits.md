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

| Caller | Counted per | Limit |
|---|---|---|
| Not signed in | IP address | 600 |
| Customer | user | 600 |
| Vendor · Agency | user | 900 |
| Agent | user | 1200 |
| Platform admin | user | 1200 |
| **Any caller, additionally** | IP address | 1200 |
| **Sign-in, registration, password reset, code resend** | IP address | **20** |

Two things to read out of that table:

- **Authenticated callers are counted per user, not per address.** An office, a school or a
  mobile carrier's NAT puts many people behind one IP; once you are signed in, their traffic
  is not yours.
- **The auth bucket is the strict one, and it is strict on purpose.** It bounds one source
  trying many passwords across many accounts. If you are legitimately hitting 20
  sign-in attempts a minute from one address, you are doing something the API should be
  told about rather than tuned around.

Agents get the most generous ceiling because the agent app polls offers, shipment status and
position, and is the client most likely to be on a bad connection retrying.

## Never limited

- `GET /api/health`, `/api/health/live`, `/api/health/ready`
- `GET /metrics`
- `POST /api/webhooks/*` — gateway callbacks. A 429 to Stripe does not inconvenience a
  caller; it loses a payment notification.

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
