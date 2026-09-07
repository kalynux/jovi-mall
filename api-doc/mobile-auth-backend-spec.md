# Mobile client auth — backend work specification

**Verified against source on 2026-09-08** — ⚠ **this is a HISTORICAL ASK, and every item in it
has been answered.** Do not build from the "Required" column below; build from the reply,
[auth/FRONTEND-CHANGELOG-mobile-auth.md](./auth/FRONTEND-CHANGELOG-mobile-auth.md), and from
[auth/README.md § Mobile namespace](./auth/README.md#mobile-namespace--bearer-clients).

| # | Asked for | What actually happened |
|---|---|---|
| **C0** | restore the password check in `login` | ✅ **shipped** — `auth.service.ts:330-331` compares with bcrypt and throws `401 AUTH_INVALID_CREDENTIALS`; pinned by a source scan in `test:mobile-auth` |
| **C1** | an `X-Client-Type: mobile` request marker | 🔴 **DECLINED.** The route namespace is the switch instead. No such header is read anywhere in `src/` — sending one does nothing. The reason crosses a service boundary: geo-tracker's CORS allows a closed header list, so a new non-safelisted request header would have forced an edit in two repositories |
| **C2** | tokens in the response body, mobile mode only | ✅ **shipped**, but as a namespace rather than a mode — `POST /api/auth/mobile/login`, `/register`, `GET /mobile/auth-me/:role`, `POST /mobile/add-role` return `data.tokens` and set no cookie |
| **C3** | a refresh endpoint taking the token in the body | ✅ **shipped** — `POST /api/auth/mobile/refresh`, and it returns a fresh **pair**, not just an access token |
| **C4** | read the bearer header, ignore cookies | ✅ **shipped, and stronger than asked**: the bearer is read **first** on every route, and an expired bearer is never silently refreshed from an ambient cookie (`auth.middleware.ts`) |
| **C5** | CORS for the Capacitor origins | ✅ **configuration, not code** — add them to `ALLOWED_ORIGINS`. No new header was needed, because C1 was declined |
| **C6** | the `/auth` IP bucket will not survive mobile refresh traffic | ✅ **shipped** — `/api/auth/mobile/refresh` sits in a second, looser bucket at **300/min/IP** (`rate-limit/auth-paths.ts`), while credential paths stay at 20 |
| **C7** | geo-tracker: same origin allowance | ✅ **configuration** — geo-tracker's `ALLOWED_ORIGINS` drives both its HTTP CORS and its WebSocket `CheckOrigin`; no Go source changed |

The document is kept because § 1's argument — *why* a WebView cannot use the cookie session — is
still the reason the mobile namespace exists, and § 7's "no change needed" findings are still
true.

---


**For:** jovi-mall backend team
**From:** agency-dash frontend
**Why:** we are wrapping the agency dashboard in Capacitor (iOS + Android). The app runs our
JavaScript inside a WebView, which cannot use the cookie session. It needs a bearer-token mode.
**Verified against:** `backend/jovi-mall` @ current `main`, and `frontend/agency-dash` @ `admin-build`.

---

## 0. TL;DR — what we are asking for

| # | Change | Size | Priority |
|---|---|---|---|
| **C0** | Restore the password check in `login` | 1 line | ✅ **Done** — `login` verifies the password |
| **C1** | A `X-Client-Type: mobile` request marker + helper | Small | Required |
| **C2** | Return tokens in the response body on the 4 token-minting endpoints, mobile mode only | Medium | Required |
| **C3** | A mobile refresh endpoint that takes the refresh token in the body | Medium | Required |
| **C4** | In mobile mode, read the bearer header and ignore cookies | Small | Required |
| **C5** | CORS: allow the Capacitor origins and the new header | Small | Required |
| **C6** | Rate limiting: the `/auth` IP bucket will not survive mobile refresh traffic | Small–Medium | Required |
| **C7** | geo-tracker: same CORS/origin allowance (separate service) | Small | Required |

**No change needed** for device-token/push registration — see §7.

Nothing here changes browser behaviour. Every change is gated behind a header that browsers never send.

---

## 1. Background — why the current design blocks us

The dashboard today relies entirely on cookies. `src/services/api.ts` never touches a token; it
sends `credentials: 'include'` and the browser attaches `access_token` automatically.

Inside a Capacitor app that stops working, for reasons that are not fixable client-side:

1. **The app's origin changes** to `capacitor://localhost` (iOS) / `https://localhost` (Android).
   A cookie for `api.jovimall.com` is therefore a **third-party cookie**, and both platforms block
   those by default (WKWebView's ITP; Android is following).
2. **`Set-Cookie` is unreadable from JavaScript.** It is a *forbidden response-header name* in the
   Fetch standard — stripped from every `Response.headers` object in every browser and WebView.
   So we cannot scrape the token out of the response the way a native HTTP client can.

> The agent app (Flutter) works around #2 because Dio is a native HTTP client, not a browser, and
> the `HttpOnly` flag means nothing to it. Their own writeup notes the technique is **unavailable on
> Flutter Web** for exactly the reason above. A Capacitor WebView is in the Flutter Web position,
> not the Dio position. Hence this request.

We are asking for the officially-supported mobile path that `api-doc/README.md` already describes
("Mobile / service clients: send `Authorization: Bearer <access_token>`") — the only missing piece
is that there is currently **no way for a mobile client to obtain a token**.

---

## 2. What already works — please do not rebuild these

Confirmed by reading the source. These need no changes and should not be touched:

| Behaviour | Where | Note |
|---|---|---|
| `Authorization: Bearer` is already accepted on all authed routes | `src/api/middlewares/auth.middleware.ts:56-66` | `extractToken` falls back to the header |
| `auth-me` reissues **both** tokens with full lifetimes | `src/modules/auth/auth.controller.ts:105` → `setAuthCookies` | This is what makes a rolling session possible |
| `/auth/browser/refresh` reissues **access only** | `src/modules/auth/controllers/browser-auth.controller.ts:63` | Correct as-is for browsers |
| Silent refresh on any authed route | `src/api/middlewares/auth.middleware.ts:76-107` | Cookie-only by design; mobile will refresh explicitly instead |
| Token TTLs: access 900s, refresh 2,592,000s | `src/config/cookie.config.ts:30,36` | Env-overridable, fine as-is |
| Password-change revocation via `iat` vs `password_changed_at` | `src/core/auth/password-epoch.ts` | Works for bearer callers too |
| Device-token registration accepts `ios` / `android` | `src/modules/notifications/validators/device-token.validator.ts:10` | Already native-ready |

---

## 3. ✅ C0 — Restore the password check (done)

**Resolved.** `POST /api/auth/login` verifies the password, and the ask's second half was answered
in the stricter direction: there is deliberately **no** environment escape hatch — a bypass whose
failure direction is "open on a typo" is exactly what the environment validator exists to argue
against. A seed or fixture that relied on the old behaviour needs a real password rather than a
flag.

The premise of the ask holds and is worth keeping on the record: everything below issues a 30-day,
self-renewing credential, and the longer the session the more the login gate matters.

> One thing that changed *after* this document was written, and that a client of `login` needs:
> **customers do not sign in here.** They hold a system-generated password nobody knows and sign
> in through the bot instead — see [auth/customer-auth.md](./auth/customer-auth.md). Vendor,
> agency and agent are unaffected.

**Related — and this paragraph was itself the example.** It used to read *"the backend's own
`CLAUDE.md` notes `JWT_SECRET` falls back to the literal string `'secret'` when unset"*. That was
**already false when it was written**: the fallback had been removed and `getJwtSecret()` fails
closed. The claim had survived in three documents and reached this spec, which is how a frontend
team came to quote a fixed defect back at the backend team.

**Current behaviour, verified in source 2026-08-19:** `JWT_SECRET` is **required** on both
services. jovi-mall throws `CONFIG_MISSING_JWT_SECRET` and refuses to boot
(`config/secrets.config.ts` → `assertSigningSecrets()`); geo-tracker's `validate()` does the same,
with the same minimum length and the same placeholder list. A deploy that forgets it does not
start, on either side. Nothing for a client to work around.

---

## 4. C1 — The mobile client marker

### Header

```
X-Client-Type: mobile
```

Any request carrying this header is in **mobile mode**. Browsers never send it, so browser behaviour
is unchanged by construction.

### Helper

Add one shared predicate — everything else in this spec branches on it:

```ts
// src/core/auth/client-mode.ts
export function isMobileClient(req: Request): boolean {
  return req.headers['x-client-type'] === 'mobile';
}
```

### Notes

- Header name is a suggestion; any name works as long as it is agreed and documented. It **must**
  be added to the CORS allow-list (see C5) — a non-safelisted request header triggers a preflight.
- This is a **client hint, not a security boundary.** Anyone can send it. It only selects a response
  shape; it must never grant privileges or bypass a check.

---

## 5. C2 — Return tokens in the body (mobile mode only)

### Which endpoints

All four that mint tokens today. Missing any of them breaks a flow:

| Endpoint | Currently calls | If omitted |
|---|---|---|
| `POST /auth/login` | `setAuthCookies` (`auth.controller.ts:32`) | App can never authenticate |
| `POST /auth/register` | `setAuthCookies` (`auth.controller.ts:39`) | New signups cannot proceed |
| `GET /auth/auth-me/:role` | `setAuthCookies` (`auth.controller.ts:105`) | **Session cannot roll — see below** |
| `POST /auth/add-role` | `setAuthCookies` (`auth.controller.ts:116`) | Role-add signs the user out |

> **`auth-me` is the important one and the easiest to overlook.** It is the only endpoint that
> reissues *both* tokens, which is what restarts the 30-day window. If only `login` returns tokens,
> mobile users get a hard 30-day expiry from their last password entry regardless of activity —
> which is the exact problem we are trying to solve. Please treat it as non-optional.

### Response shape

Add a `tokens` object **alongside** the existing payload. Nothing existing changes, so no client
breaks:

```jsonc
{
  "success": true,
  "data": {
    "user":        { "...": "unchanged" },
    "role":        "agency",
    "role_entity": { "...": "unchanged" },

    // present ONLY when X-Client-Type: mobile
    "tokens": {
      "accessToken":  "eyJhbGciOi...",
      "refreshToken": "eyJhbGciOi...",
      "accessExpiresIn":  900,
      "refreshExpiresIn": 2592000
    }
  }
}
```

`accessExpiresIn` / `refreshExpiresIn` are seconds. They let us refresh **proactively** rather than
waiting for a 401, which matters for C6 (fewer wasted calls against the rate limiter). Please read
them from the same config as the cookie `maxAge` so they cannot drift.

### Behaviour

- When `isMobileClient(req)` → include `tokens`, **and skip `setAuthCookies` entirely.** Setting
  cookies for a client that cannot use them is dead weight and makes debugging confusing.
- When not mobile → byte-for-byte identical to today. `setAuthCookies`, no `tokens` key.

### Suggested implementation

One helper so the branch is written once rather than four times:

```ts
// src/config/cookie.config.ts (or alongside it)
export function deliverTokens(
  req: Request, res: Response, accessToken: string, refreshToken: string,
): { tokens?: TokenPayload } {
  if (isMobileClient(req)) {
    return { tokens: { accessToken, refreshToken,
                       accessExpiresIn:  accessTtlSeconds(),
                       refreshExpiresIn: refreshTtlSeconds() } };
  }
  setAuthCookies(res, accessToken, refreshToken);
  return {};
}
```

Then each controller becomes `sendSuccess(res, { user, role, role_entity, ...deliverTokens(req, res, accessToken, refreshToken) })`.

### ⚠️ Logging

Please confirm response bodies are not logged at info level, and that `tokens` is redacted if they
are. Today tokens only exist in `Set-Cookie` headers, which logging usually skips by default — that
assumption stops holding with this change.

---

## 6. C3 — A mobile refresh endpoint

### Why a new endpoint

`POST /auth/browser/refresh` reads the refresh token from `req.cookies` and replies with a
`Set-Cookie`. A mobile client has neither. It needs to *send* the refresh token and *receive* tokens
in the body.

### Proposed

```
POST /auth/mobile/refresh
```

**Request**

```jsonc
{ "refreshToken": "eyJhbGciOi..." }
```

**Response `200`**

```jsonc
{
  "success": true,
  "data": {
    "tokens": {
      "accessToken":  "eyJhbGciOi...",
      "refreshToken": "eyJhbGciOi...",
      "accessExpiresIn":  900,
      "refreshExpiresIn": 2592000
    }
  }
}
```

### Please reissue BOTH tokens here

This is a deliberate request, and it makes mobile *simpler* than the browser path:

- Refresh tokens are stateless JWTs with no server-side store, so issuing a new one does not
  invalidate the old one. There is no rotation risk and no grace-period problem.
- Reissuing both means **every refresh slides the 30-day window**, so the session rolls on ordinary
  use. We would not need to call `auth-me` purely to keep the session alive.
- It costs one extra `jwt.sign` per refresh.

### Validation

Reuse the existing refresh path's checks — do not write new ones. It must still reject with the
established codes, because the client behaves differently for each:

| Code | Status | Client action |
|---|---|---|
| `AUTH_SESSION_EXPIRED` | 401 | Sign out, prompt login |
| `AUTH_REFRESH_TOKEN_INVALID` | 401 | Sign out, prompt login |
| `AUTH_PASSWORD_CHANGED` | 401 | Sign out immediately, **do not retry** |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | Sign out with a reason shown |

Please also reject an **access** token passed where a refresh token belongs (the `type: 'refresh'`
claim check) — it is an easy client bug and a silent one if it succeeds.

### Alternative if you prefer no new route

Accept the refresh token on the existing `/auth/browser/refresh` via a body field or an
`X-Refresh-Token` header, and return `tokens` in mobile mode. Functionally equivalent. We have no
preference — a separate route just keeps browser and mobile paths from tangling.

---

## 7. C4 — Ignore cookies in mobile mode

`src/api/middlewares/auth.middleware.ts:56` reads the cookie **first**, then falls back to the
bearer header. In mobile mode, invert that — or more simply, skip the cookie entirely:

```ts
function extractToken(req: Request): string | null {
  if (!isMobileClient(req)) {
    const cookieToken = req.cookies?.[AUTH_COOKIE.ACCESS];
    if (cookieToken) return cookieToken;
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.split(' ')[1];
  return null;
}
```

**Why this matters, since a Capacitor app usually sends no cookies anyway:** if we end up routing
requests through Capacitor's native HTTP layer, the OS cookie jar *will* attach cookies. A stale
cookie would then win over a freshly-refreshed bearer token, producing 401s that look impossible
from the client side. This is cheap insurance against a genuinely hard-to-diagnose bug.

Same treatment for the refresh-token lookup at `auth.middleware.ts:76` and `:98` — in mobile mode
there is no refresh cookie, so silent refresh should not be attempted. Let it fail closed with
`AUTH_TOKEN_EXPIRED`; the client will call C3 explicitly.

---

## 8. C5 — CORS

Not optional, and **the new header makes it stricter, not looser**: `X-Client-Type` is not a
CORS-safelisted request header, so every mobile request will be preceded by a preflight `OPTIONS`.

Required on the jovi-mall API:

| Setting | Value |
|---|---|
| Allowed origins | add `capacitor://localhost` and `https://localhost` |
| Allowed headers | add `X-Client-Type` (alongside `Authorization`, `Content-Type`) |
| Allowed methods | `GET, POST, PATCH, PUT, DELETE, OPTIONS` |
| `OPTIONS` handling | must return 2xx **before** auth middleware runs |
| Credentials | unchanged — mobile does not need it |

Two gotchas worth stating explicitly:

- `capacitor://` is a non-HTTP scheme. Some CORS libraries and reverse proxies reject or normalise
  it. Please verify the value actually reaches the allow-list check rather than being stripped
  upstream by nginx/Cloudflare.
- A preflight that hits `requireAuth` returns 401, and the browser reports it as a CORS error with
  no useful detail. If mobile requests fail with an opaque network error, check this first.

---

## 9. C6 — Rate limiting will bite

`src/api/rate-limit/policy.ts:143-152`:

```ts
windowSeconds: 60,
scope: 'ip',
limits: { /* every role */ envInt('RATE_LIMIT_AUTH_PER_MIN', 20) }
```

**20 requests per minute, scoped by IP, shared across the whole `/auth` prefix.**

This is fine today because browsers refresh silently on ordinary routes and rarely touch `/auth`.
Mobile clients cannot do that — every refresh is an explicit `/auth/mobile/refresh` call, roughly
every 15 minutes per active user, plus one `auth-me` per app launch.

The problem is `scope: 'ip'`. Agency staff on the same office WiFi, or on the same mobile carrier
NAT, **share one 20/min bucket**. Your own comment at `policy.ts:161-164` already identifies this
exact hazard for storefront traffic:

> *"behind an office NAT or a Cameroonian mobile carrier that is hundreds of people contending for
> one counter"*

The failure mode is bad: a user whose refresh is rate-limited gets signed out, tries to log in, and
the login is rate-limited too — locked out by their neighbours' traffic.

### Options, in our order of preference

1. **Identity-scope the refresh route.** `/auth/mobile/refresh` is authenticated by the refresh
   token, so the caller is known. Scope its bucket by user rather than IP. Solves it properly and
   keeps brute-force protection on the genuinely anonymous routes (`login`, `register`,
   `forgot-password`), which is what the IP bucket is actually for.
2. **Raise `RATE_LIMIT_AUTH_PER_MIN`.** One env var. Weakens brute-force protection on login.
3. **Longer mobile access TTL** (say 60 minutes) so refreshes are 4× rarer. Cheapest change, but it
   widens the window in which a stolen access token is usable.

We would take (1), or (1) and (3) together. Whatever you choose, please tell us the final numbers so
we can size our proactive-refresh timing to stay under them.

---

## 10. C7 — geo-tracker (separate service)

Our live map opens a WebSocket to geo-tracker and also calls its HTTP routes. Per
`api-doc/geo-tracker/`, it already accepts a jovi-mall access token two ways:

```
Sec-WebSocket-Protocol: bearer, <access_token>     // WebSocket handshake
Authorization: Bearer <access_token>               // HTTP routes
```

**So the token from C2 works there unchanged — no auth work needed on geo-tracker.** Our client
already supports it (`src/services/geo-tracker.service.ts:47`). Two things do need checking:

1. **Origin allow-list.** The WebSocket handshake carries an `Origin` header. If geo-tracker
   validates it, add `capacitor://localhost` and `https://localhost`. Its HTTP routes need the same
   CORS treatment as C5.
2. **Handshake-time vs ongoing validation.** Please confirm the access token is validated *at
   handshake* and not re-checked mid-connection. If it is re-checked, a 15-minute access token drops
   the socket every 15 minutes. If it is handshake-only, a long-lived socket is fine and we will
   reconnect with a fresh token whenever we reconnect for other reasons.

Note this may be a different team or repo — flagging so it does not fall between the two.

---

## 11. What is explicitly **not** changing

To keep review focused:

- **Browser behaviour.** No request without `X-Client-Type: mobile` behaves differently. This should
  be provable by a regression test (§13).
- **Token lifetimes**, unless you choose option (3) in C6.
- **Cookie attributes**, `HttpOnly` / `SameSite` / `Secure` — untouched.
- **Password-epoch revocation** — already works for bearer callers.
- **Push / device-token registration.** `platform: z.enum(['web','android','ios'])` at
  `device-token.validator.ts:10` already accepts native. We will register an FCM token with
  `platform: "ios" | "android"` and everything downstream is unchanged.
- **Logout.** `POST /auth/logout` clears cookies; for mobile that is a harmless no-op and we discard
  tokens client-side. We are **not** asking for server-side revocation (see §12).

---

## 12. Known limitation we are accepting

Refresh tokens are stateless JWTs with no revocation store, so **a stolen refresh token stays valid
for its full 30 days** and the only lever that kills it early is a password change. That is already
true for the agent app and for browsers; mobile does not make it worse, but it does make the
credential more portable — it now sits in device storage rather than a browser cookie jar.

Our mitigations are client-side: we will store tokens in the iOS Keychain / Android Keystore, never
plain preferences. We are noting it here so the tradeoff is a shared decision rather than an
assumption. If you would rather add a revocation store (a `token_version` on the user, bumped on
logout-all), we are happy to support it — but we do not consider it blocking.

---

## 13. Acceptance criteria

Please treat these as the definition of done.

**Browser regression — must pass unchanged**

- [ ] Login from the web dashboard sets both cookies exactly as today.
- [ ] Response body contains **no** `tokens` key when the header is absent.
- [ ] Silent refresh on an ordinary authed route still works.
- [ ] `/auth/browser/refresh` still reissues the access cookie only.

**Mobile mode**

- [ ] `POST /auth/login` + `X-Client-Type: mobile` returns `data.tokens` with all four fields, and
      sets **no** cookies.
- [ ] Same for `register`, `auth-me/:role`, `add-role`.
- [ ] An authed request with `Authorization: Bearer <access>` + the header succeeds.
- [ ] The same request succeeds when a **stale** `access_token` cookie is also present — proving C4.
- [ ] `POST /auth/mobile/refresh` with a valid refresh token returns a **new pair**.
- [ ] The new refresh token carries a full 30-day expiry (the sliding window works).
- [ ] An expired refresh token → 401 `AUTH_SESSION_EXPIRED`.
- [ ] An **access** token posted to the refresh endpoint → 401 `AUTH_REFRESH_TOKEN_INVALID`.
- [ ] After a password change, both the old access and old refresh tokens → 401
      `AUTH_PASSWORD_CHANGED`.
- [ ] A suspended account → 403 `AUTH_ACCOUNT_SUSPENDED` on refresh, not only at login.

**CORS**

- [ ] Preflight `OPTIONS` from `capacitor://localhost` returns 2xx without hitting auth.
- [ ] `X-Client-Type` appears in `Access-Control-Allow-Headers`.

**Security**

- [x] A wrong password is rejected (C0). ✅ Done.
- [ ] `tokens` does not appear in application logs.

---

## 14. Suggested order of work

1. ~~**C0** — the password fix, on its own, today.~~ ✅ Done.
2. **C1 + C4** — the marker and the extract-token branch. Small, and nothing depends on them being
   right yet.
3. **C2** — token delivery on the four endpoints. At this point we can log in from the app and start
   integrating.
4. **C5** — CORS. Do this alongside C2 or the app cannot reach you at all.
5. **C3** — mobile refresh. Sessions survive past 15 minutes.
6. **C6** — rate limiting. Needed before more than a handful of testers use it.
7. **C7** — geo-tracker origins. Needed before the live map works in the app.

Steps 2–4 are enough for us to begin frontend integration; the rest can land while we build.

---

## 15. Open questions for you

1. Is `X-Client-Type: mobile` an acceptable marker name, or do you have a convention?
2. New route `/auth/mobile/refresh`, or extend `/auth/browser/refresh`? (§6)
3. Which rate-limit option in §9 — and what are the final numbers?
4. Is `JWT_SECRET` explicitly set in production? (§3)
5. Does geo-tracker validate `Origin` on the WebSocket handshake, and is the token re-checked
   mid-connection? (§10)
6. Any objection to reissuing both tokens on mobile refresh? (§6)

---

## Appendix — verified source references

| Claim | File | Line |
|---|---|---|
| `extractToken` cookie-first, bearer fallback | `src/api/middlewares/auth.middleware.ts` | 56–66 |
| Silent refresh reads refresh cookie | `src/api/middlewares/auth.middleware.ts` | 76, 98 |
| Silent refresh sets access cookie only | `src/api/middlewares/auth.middleware.ts` | 87, 107 |
| `login` → `setAuthCookies` | `src/modules/auth/auth.controller.ts` | 32 |
| `register` → `setAuthCookies` | `src/modules/auth/auth.controller.ts` | 39 |
| `authMe` → `setAuthCookies` (**both tokens**) | `src/modules/auth/auth.controller.ts` | 105 |
| `addRole` → `setAuthCookies` | `src/modules/auth/auth.controller.ts` | 116 |
| `/auth/browser/refresh` sets access only | `src/modules/auth/controllers/browser-auth.controller.ts` | 63 |
| `setAuthCookies` writes both | `src/config/cookie.config.ts` | 63–65 |
| Access TTL 900s / refresh TTL 2,592,000s | `src/config/cookie.config.ts` | 30, 36 |
| Password comparison discarded | `src/modules/auth/auth.service.ts` | 203–204 |
| Auth rate limit 20/min, IP-scoped | `src/api/rate-limit/policy.ts` | 143–152 |
| NAT contention already acknowledged | `src/api/rate-limit/policy.ts` | 161–164 |
| Device token accepts `ios` / `android` | `src/modules/notifications/validators/device-token.validator.ts` | 10 |
