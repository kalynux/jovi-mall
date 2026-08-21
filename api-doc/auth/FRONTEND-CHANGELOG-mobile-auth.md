# Front-end changelog — mobile client auth

**Audience:** whoever wraps **agency-dash** (or any dashboard) in Capacitor.
**Status:** backend shipped. Nothing is behind a flag. Everything is **additive** — no existing
endpoint changed its request, its response, or its cookies.

This is the reply to [mobile-auth-backend-spec.md](../mobile-auth-backend-spec.md). §1 answers
C0–C7 and your §15 questions; §2–§4 are what you build against.

> **If you read only two things:** §1.2 — *there is no `X-Client-Type` header, the route
> namespace is the switch* — and §1.5 — *your §7 request would have broken the browser and the
> agent app, so we did half of it.*

> Reference: [Auth → Mobile namespace](./auth/README.md#mobile-namespace--bearer-clients) ·
> [Rate limits](./rate-limits.md) · [Errors](./errors/README.md)

---

## 1. Your requirements, point by point

### 1.1 C0 — the password check ✅ **fixed, shipped separately**

`bcrypt.compare`'s verdict is acted on again. We did **not** take your suggested
`AUTH_ALLOW_ANY_PASSWORD` escape hatch: an auth bypass whose failure direction is "open on a
typo" is the exact shape this service's environment validator exists to argue against. A test
asserts both that the check runs and that no environment variable can disable it.

Consequence for you: nothing. Consequence for anyone with a seeded dev account — they need the
real password now.

### 1.2 C1 — ❌ **declined**, and replaced with something better for you

**There is no `X-Client-Type` header.** Instead there is a third route namespace,
`/api/auth/mobile/*`, beside the `/api/auth/browser/*` one you already know about.

| | header design (yours) | namespace design (shipped) |
|---|---|---|
| browser regression risk | a check that can be got wrong | **impossible by construction** |
| preflight | `OPTIONS` on **every** mobile request (non-safelisted header) | none — you send only safelisted headers plus `Authorization` |
| CORS allow-list | must add `X-Client-Type` | unchanged |
| **geo-tracker** | **would have needed a Go source change** — its CORS middleware allows a *closed* header list (`Authorization, Content-Type, X-Request-Id`) | **untouched** |
| ways to be "mobile" | two (route + header) that can disagree | one |

Cost to you: your `api.ts` switches four base paths on `Capacitor.isNativePlatform()` instead
of setting one header. We think that is the better side of the trade, but say so if it is not —
the header is still addable.

### 1.3 C2 — ✅ **done**, on all four, plus refresh

`data.tokens` is present on all five mobile endpoints and **absent everywhere else**. No cookie
is set on the mobile namespace at all — not a smaller one, not a redundant one.

```jsonc
"tokens": {
  "accessToken":      "eyJhbGciOi...",
  "refreshToken":     "eyJhbGciOi...",
  "accessExpiresIn":  900,
  "refreshExpiresIn": 2592000
}
```

You asked that `accessExpiresIn` be read "from the same config as the cookie `maxAge` so they
cannot drift". It is better than that now: both the published number **and** `jwt.sign`'s
`expiresIn` **and** the cookie `maxAge` come from one pair of constants. They used to be two
independent reads of the same environment variable, agreeing only because the defaults matched
— harmless while nothing published a lifetime, and a live bug the moment we did.

You flagged `auth-me` as the easy one to overlook. Agreed, and it is there:
`GET /api/auth/mobile/auth-me/:role`.

### 1.4 C3 — ✅ **done**, as a new route, and yes to both tokens

`POST /api/auth/mobile/refresh`, body `{ "refreshToken": "…" }`, returns a fresh **pair**.

**No objection to reissuing both** (your §15 Q6) — your reasoning was right and we have nothing
to add to it. `/auth/browser/refresh` keeps returning access-only; both go through the *same*
service method, so the validation cannot drift between them. The `type: "refresh"` claim check
you asked for was already there and still runs, so an access token posted here is refused with
`AUTH_REFRESH_TOKEN_INVALID` rather than quietly accepted.

**§15 Q2 answered:** a new route, not an extension of `/auth/browser/refresh`. You had no
preference; we did, for the reason your own §6 gives — it keeps the two paths from tangling.

**One thing to state rather than smuggle.** Because every refresh re-issues the refresh token at
full lifetime, the 30-day window becomes **sliding with no absolute cap**: an actively-used
session never hard-expires, and neither does an actively-abused one. That is not new — `auth-me`
has always re-issued both and every client calls it on launch — but it is now explicit, so it
should be a shared decision rather than an assumption. Your Keychain/Keystore mitigation is the
right one. See §1.9.

### 1.5 C4 — ✅ **done, but only half of it, and the other half matters**

You asked for the same treatment at `auth.middleware.ts:56`, `:76` **and** `:98`. We did `:56`
and `:98`. **Doing `:76` would have broken the browser and the agent app**, so please do not
re-request it.

`:76` is the *no access token at all* branch. That is not an edge case:

- it is **the ordinary browser path** every time the 15-minute access cookie expires and the
  browser deletes it — every session older than fifteen minutes goes through it;
- it is the **Flutter agent app's second refresh path**, which sends `GET /auth/auth-me/agent`
  with a hand-built `Cookie: refresh_token=…` header and no `Authorization` at all.

What shipped instead:

| what you sent | result |
|---|---|
| nothing, but a refresh cookie | **unchanged** — silent refresh |
| a valid `Authorization: Bearer` | authenticated by it, **even if a stale `access_token` cookie is also present** |
| an expired `Authorization: Bearer` | **`401 AUTH_TOKEN_EXPIRED`** — no cookie refresh is attempted, even if a refresh cookie is attached |
| an expired cookie token | unchanged — silent refresh |

That gives you exactly the property you wanted (a stale cookie can never beat a fresh bearer)
plus the one you were really after (a stale cookie can never *silently authenticate you as
somebody else* when your own token expired), and it costs no marker.

Your §2 table row "*Silent refresh on any authed route — cookie-only by design*" was slightly
off, for what it is worth: it fires for anyone presenting a refresh **cookie**, browser or not.
That is how the agent app refreshes.

### 1.6 C5 — ✅ **done**, and your §8 gotcha was real

Both origins are supported. Add them to `ALLOWED_ORIGINS` on the deployment.

**Your instinct to check that `capacitor://` survives the allow-list check was correct, and it
did not.** The environment validator rejected any origin not matching `^https?://[^/]+$`, and it
raises an *error*, which **refuses the boot**. So setting `capacitor://localhost` would not have
produced a CORS failure — it would have failed to start the API, and you would reasonably have
reported "the whole backend is down". The scheme set is now `http | https | capacitor`,
deliberately closed rather than a generic `\w+://`.

No `allowedHeaders` change was needed (§1.2). Methods already covered all six, `OPTIONS` already
returns before any auth middleware, and `credentials` is unchanged.

> ⚠ **One thing you should know you are asking for.** `https://localhost` in a *production*
> allow-list grants credentialed CORS to any HTTPS server on the user's own loopback. Narrow —
> an attacker with a listener on the victim's `:443` already owns the machine — but real. If you
> would rather avoid it, Capacitor can be configured to a custom Android hostname; tell us and
> we will list that instead.

### 1.7 C6 — ✅ **done**, but neither of your options. §15 Q3 answered.

We took **neither** (1) nor (2), and here is why each was wrong for this codebase:

- **Not (1), identity-scope the refresh route.** The limiter's identity key reads `req.auth`,
  which `/auth/mobile/refresh` never populates — it runs no auth middleware, because the refresh
  token *is* the credential. Labelling it `identity` would silently have produced an IP bucket
  with a misleading name.
- **Not (2), raise `RATE_LIMIT_AUTH_PER_MIN`.** That number is the only security control in the
  file. Raising it weakens the login gate by exactly the amount it helps refresh traffic,
  because the two share the counter — which is the actual problem.

**We split the bucket by purpose.** Presenting a credential and extending a session are now
counted separately:

| Bucket | Limit | Paths |
|---|---|---|
| **credential** | **20/min/IP** | `login` · `register` · `forgot-password` · `reset-password` · `add-role` · the verification routes · `logout` · `browser/login` · `mobile/login` · `mobile/register` · `mobile/add-role` |
| **session** | **300/min/IP** | `me` · `auth-me/:role` · `mobile/auth-me/:role` · `browser/refresh` · `mobile/refresh` |

Exactly one of the two applies per request.

> ⚠ **Reading the headers: on an authenticated route they describe Layer B, not the bucket
> above.** Layer B is attached at the tail of the auth middleware, so it writes last and
> overwrites whatever ran before it. `GET /auth/me` as an agency therefore reports
> `RateLimit-Policy: 900;w=60` — the per-*user* ceiling — even though the 300/IP session bucket
> also counted the request. That is the pre-existing behaviour of the layer stack, not something
> the split introduced, and the header you get is usually the one you want. On an
> unauthenticated route (`login`, `mobile/refresh`) you read the IP bucket, because Layer B
> never runs there.

**Your final numbers**, as requested:

| Layer | Limit | Scope | Applies to |
|---|---|---|---|
| credential | 20/min | IP | login and friends |
| session | **300/min** | IP | refresh, `me`, `auth-me` |
| Layer A (global) | 1200/min | IP | everything, on top of the above |
| Layer B (identity) | 600–1200/min | **user** | every authenticated route; agency = 900 |

**Size your proactive refresh at ~60s before `accessExpiresIn`.** At one renewal per ~15 minutes
per active user, 300/min/IP covers roughly 1200 users behind one address — you will not
approach it. (300 rather than the 120 we first considered because the binding path is `/auth/me`,
not refresh: a dashboard polling it once a minute would saturate 120 at 120 concurrent users on
one office IP.)

This also fixes something that was wrong before you asked: `/auth/me` and `/auth/auth-me` were
eating the login budget on every poll and every app launch.

### 1.8 C7 — ✅ **config only. §15 Q5 answered, verified in the Go source.**

**No geo-tracker code changed, and the token from C2 works there unchanged** — you were right
about that.

1. **Does it validate `Origin` on the WebSocket handshake?** **Yes.** Exact string match, no
   wildcards, no normalisation. It uses the **same `ALLOWED_ORIGINS` variable** as its HTTP CORS
   — one setting, no separate WebSocket knob. A *missing* `Origin` is always allowed (that is
   every native client and every server-to-server caller), so the check constrains browsers and
   WebViews only. Add the two origins there too.
2. **Is the token re-checked mid-connection?** **Not on a timer — there is no periodic
   re-validation anywhere.** But there is one event-driven re-check you should design for:

   > When jovi-mall pushes a shipment lifecycle event, geo-tracker re-resolves each watcher's
   > permissions by forwarding **the token captured at handshake** back to jovi-mall. If that
   > token has since expired, the check fails closed and your **subscription** is dropped with
   > `permission_revoked` and `reason: "shipment_completed"` — **which is misleading**; the
   > shipment may be fine and your token simply aged out. The socket itself stays open.

   So: **do not trust that `reason` string**, and reconnect the socket with a fresh access token
   on a cadence shorter than the 15-minute access TTL (reconnecting is cheap — you resume the
   same session). An agent's own publishing socket is exempt from this path; it is viewers —
   which is what your live map is — that are affected.

   Its HTTP routes allow a closed header list (`Authorization, Content-Type, X-Request-Id`), so
   do not send custom headers there. Not a problem, since there is no marker header (§1.2).

### 1.9 §12 — the known limitation: **we agree, and we are not adding a revocation store**

Your read is correct and your mitigation is the right one. Two additions:

- C3 makes the window **sliding**, so "valid for 30 days" is more precisely "valid for 30 days
  after last use". Stated in §1.4 and in the reference docs.
- If you later want `token_version`, the cheapest hook is the refresh path, which already loads
  the user row on every call — it would cost no extra query. Not blocking, as you said.

### 1.10 §5's logging worry — **already satisfied, no work needed**

Checked rather than assumed: no middleware at any level logs a response body; the
administrative action log stores `Object.keys(req.body)` only and is not mounted on `/auth`; and
the logger's redaction path list already covers `accessToken` / `refreshToken`, derived from a
shared list so it cannot drift out of step. Your §13 criterion "`tokens` does not appear in
application logs" holds **by construction**.

### 1.11 §15 Q4 — **`JWT_SECRET` cannot be unset**

A deploy without it **does not start**: the getter throws, and in production it additionally
refuses a value under 16 characters or a known placeholder. The `|| 'secret'` fallback you cited
is gone.

You read that claim from our own `CLAUDE.md`, which was stale. That is on us — we have corrected
it in all three places it survived.

### 1.12 Small corrections to your spec, for the record

- Your §5 table and Appendix have `login` and `register` swapped (`auth.controller.ts:32` is
  `register`, `:39` is `login`). `auth-me:105` and `add-role:116` were right.
- §2's silent-refresh row — see §1.5.
- §3's `JWT_SECRET` note — see §1.11.

Everything else in the spec checked out exactly, including all thirteen appendix references we
verified. It was a genuinely good document to work from.

---

## 2. One thing you did not ask about: maintenance windows

The platform has a `readonly` maintenance mode that refuses unsafe methods. Nobody had noticed
what that does to a bearer client:

- a **browser** renews inside an ordinary GET, so it rides out a read-only window indefinitely;
- a **bearer client** has no such path — `POST /auth/mobile/refresh` is its only one — so it
  would have been **signed out fifteen minutes in**, while browsers carried on.

`POST /api/auth/mobile/refresh` is therefore **exempt from `readonly`** (it mints a token and
writes nothing). It is still blocked in `down`, where refusing to extend anybody's session is
the point of the window — so in a full outage, expect `503` and a sign-out. Everything else
under `/api/auth` behaves as before.

---

## 3. What to build

```jsonc
// 1. login
POST /api/auth/mobile/login   { identifier, password, role? }
  → 200 { user, role, role_entity, tokens }
  → store tokens in Keychain / Keystore, never plain preferences

// 2. every request
Authorization: Bearer <accessToken>

// 3. proactively, ~60s before accessExpiresIn elapses
POST /api/auth/mobile/refresh   { refreshToken }
  → 200 { tokens }
  → replace BOTH stored tokens (keeping the old refresh token still works,
    but you lose the sliding window, which is the point)

// 4. on app launch
GET /api/auth/mobile/auth-me/:role
  → 200 { user, role, role_entity, tokens }   // fresh profile AND a fresh pair

// 5. adding a role
POST /api/auth/mobile/add-role   { role, name? | business_name? | agency_name? }
  → 201 { user, role, role_entity, tokens }   // the pair is scoped to the NEW role —
                                              // replace your stored tokens or the next
                                              // request is still on the old role

// 6. logout
   discard the tokens. No server call needed.
```

Request bodies and the non-`tokens` half of every response are **byte-identical** to the cookie
endpoints, so your existing types are unchanged.

> One footgun worth naming, because it caught our own smoke test: **a JWT's `iat` is in whole
> seconds**, so two mints in the same second for the same `{userId, role}` are *byte-identical*.
> Log in and immediately refresh, and the "new" access token can equal the old string. It is a
> correct, valid token either way — just never use "did the token string change?" as the signal
> that a refresh succeeded. Use the HTTP status.

### Refresh errors — branch on `error.code`, not on the status

| `error.code` | Status | Do |
|---|---|---|
| `AUTH_MISSING_TOKEN` | 401 | sign out |
| `AUTH_REFRESH_TOKEN_INVALID` | 401 | sign out. In development, check you are not sending the **access** token — that is what this code means most often |
| `AUTH_SESSION_EXPIRED` | 401 | sign out, prompt login |
| `AUTH_PASSWORD_CHANGED` | 401 | sign out **immediately, do not retry** — every token you hold meets the same rule. Worth surfacing verbatim: to someone who did not change their password, it is the first sign that somebody else did |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | sign out, show the reason |
| `AUTH_USER_NOT_FOUND` | 401 | sign out |
| `RATE_LIMIT_EXCEEDED` | 429 | respect `Retry-After`; never retry-storm |

On an ordinary authed route, `401 AUTH_TOKEN_EXPIRED` means *refresh now* — that is the one
that is not terminal.

---

## 4. Acceptance criteria — where each of your §13 items landed

**Browser regression** — all four hold, and by construction rather than by a check: the cookie
endpoints were not modified at all. A source scan asserts the four cookie-minting handlers still
set cookies and still return no `tokens` key.

**Mobile mode** — all ten covered. The stale-cookie case (your fifth bullet) is the one worth
trying by hand, since it is the whole point of §1.5.

**CORS** — preflight from `capacitor://localhost` returns 2xx before any auth middleware; there
is no `X-Client-Type` to appear in `Access-Control-Allow-Headers`, by design.

**Security** — a wrong password is rejected (§1.1); `tokens` cannot reach the logs (§1.10).

Backend-side this is covered by `npm run test:mobile-auth` (103 assertions, no database), which
deliberately asserts the *structural* invariants — that the mobile controller sets no cookie,
that the credential rate-limit bucket stays the default, and that the silent-refresh asymmetry
in §1.5 is not "tidied" into symmetry by a future reader.

---

## 5. Open on our side

- **Deployment configuration is not code and has not been applied.** Someone must add
  `capacitor://localhost` and `https://localhost` to `ALLOWED_ORIGINS` on **both** jovi-mall and
  geo-tracker before the app can reach either. Until then you will see CORS failures on HTTP and
  a rejected WebSocket handshake. Tell us which environments you need it on.
- `RATE_LIMIT_AUTH_SESSION_PER_MIN` defaults to 300 and is tunable without a deploy. If your
  real traffic disagrees with the arithmetic in §1.7, say so and we will move it.
