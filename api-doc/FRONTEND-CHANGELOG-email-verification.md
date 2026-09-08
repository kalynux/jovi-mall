# Frontend changelog — unified email verification, all four apps

**Verified against source on 2026-09-08** — the three error codes
(`AUTH_VERIFY_TOKEN_INVALID`, `VALIDATION_ERROR`, `RATE_LIMIT_EXCEEDED`) in
`src/core/error-codes.ts`, the 24-hour `EMAIL_VERIFY_EXPIRE` constant
(`src/modules/auth/auth.service.ts:35`) and the `STOREFRONT_URL` → `API_PUBLIC_URL` link fallback
(`auth.service.ts:39`, `src/core/utils/storefront-link.util.ts:79-87`). No corrections were needed.

**Date:** 2026-08-24 · **Audience:** landing/storefront (owns both pages), vendor dashboard,
agency dashboard, agent app · **Backend:** `jovi-mall`

Answers [api-doc/auth/BACKEND-REQUIREMENTS-verification.md](./auth/BACKEND-REQUIREMENTS-verification.md).
All four checklist items on the backend side are built; the fifth is a frontend deletion and is
listed at the bottom.

> [!IMPORTANT]
> **Nothing here is a breaking change.** Every existing call and every link already in an inbox
> keeps working. Two things are *new* (a `POST` verb and an `app=` query parameter) and one thing
> *moved* (where the registration-verification email points).

---

## 1 · Registration verification now points at your page, not at the API

🔴 **This is the one that was broken, and it was broken for every audience.**

The verification email used to link to `{API_PUBLIC_URL}/api/auth/verify-email?token=…` — the API
itself. Three consequences, all live until this shipped:

1. Clicking it rendered a **raw JSON envelope** in the browser. No page, no branding, no way
   onward, for customers, vendors, agencies and agents alike.
2. It was a **`GET` that mutates**, so the token was spent by whatever prefetched the mail — link
   scanners, corporate relays, the mail client's own preview. By the time a person tapped it, it
   was frequently already gone.
3. The landing app has had a `/verify-email` page all along that **nothing linked to**.

**New mail carries:**

```
{STOREFRONT_URL}/verify-email?token=<64 hex>&app=<customer|vendor|agency|agent>
```

Your page reads the token out of the query string and POSTs it. Nothing is spent until a human
acts.

---

## 2 · `POST /api/auth/verify-email` — new, and the `GET` stays

| Verb | Status | Use it for |
|---|---|---|
| **`POST /api/auth/verify-email`** | **New** | Everything. This is what the emailed page calls |
| `GET /api/auth/verify-email?token=…` | **Kept** | Links minted before the deploy. Do not build against it |

**Request** — `.strict()`, so an unknown key is a `400` on the whole request:

```json
{ "token": "abc123def456..." }
```

**Response `200`** — identical to the `GET`'s, same service call, same effects:

```json
{ "success": true, "data": { "message": "Email verified successfully" } }
```

**Errors**

| Status | `error.code` | When |
|---|---|---|
| `400` | `AUTH_VERIFY_TOKEN_INVALID` | Unknown, expired **or already spent** — one code for all three |
| `400` | `VALIDATION_ERROR` | Missing/blank token, over 512 characters, or an unknown body key |
| `429` | `RATE_LIMIT_EXCEEDED` | Credential bucket — see §5 |

> [!NOTE]
> **Why the `GET` survives.** Registration tokens live **24 hours** (`EMAIL_VERIFY_EXPIRE`), so a
> link minted the minute before the deploy stays valid for a day after it. It will not be removed
> on a schedule anybody needs to plan around, but treat it as legacy: it is a mutating `GET`, which
> is the whole problem this change exists to fix.

### Your POST-first fallback is correct, and here is when to delete it

The landing's `verifyEmail()` in `src/lib/auth/auth.api.ts` POSTs first and falls back to the
legacy `GET` **only on 404/405** — statuses that mean nothing was spent. That is exactly right, and
every other status is the real answer and must propagate. **Delete the fallback once every
environment serves the POST**; keeping it indefinitely means a genuine routing fault degrades into
a silently-spent token.

---

## 3 · `app=` — one page, four apps

Both emailed-token pages now receive the role that started the flow.

| Page | Link |
|---|---|
| Verify a new registration | `{STOREFRONT_URL}/verify-email?token=…&app=<role>` |
| Confirm a changed email | `{STOREFRONT_URL}/account/confirm-email?token=…&app=<role>` |

`app` is one of **`customer` · `vendor` · `agency` · `agent`**, taken from the JWT by the half of
the flow that has a session. Use it to pick where to send the person after success.

**Why one page rather than four.** Both confirm endpoints are genuinely role-free — neither reads
your access token, each resolves the account from the token in the link, and the email-change one
syncs the confirmed address onto **every** role profile the account holds. A per-dashboard copy
would have nothing to do differently, and each copy would be one more place to get the
POST-not-`GET` rule wrong. The only thing a role-free confirm cannot answer is *where to send the
person afterwards* — which is what `app` is.

Three properties to build against:

- ⚠ **It is a KEY, never a URL.** Map it through a compile-time table and ignore anything else.
  These pages are reachable with **no session**, so honouring a caller-supplied destination is an
  open redirect on the same origin as your sign-in pages. Do not turn it into `?return=`.
  (Verified on the landing today: `?app=https://evil.example` renders the storefront link.)
- **Absence is normal.** Links already sitting in inboxes carry no `app=`. Fall back to your
  default destination — do not error, and do not block the confirm.
- **The response carries no role, deliberately.** `POST /api/auth/email-change/confirm` returns
  `{ email }`. An account can hold several roles, so a `roles` array would not identify one
  destination anyway — which is precisely why the origin travels in the link instead.

---

## 4 · What did NOT change

- **`POST /api/auth/email-change/confirm`** — same path, same body, same response, still public,
  still a `POST`. Only the link that leads to it gained a parameter.
- **`POST /api/auth/send-email-verification`** — same call, same auth, same empty body. It simply
  builds a different link now.
- **Every `GET` route.** Nothing was removed.
- **Token lifetimes.** Registration verification 24 h; email change per
  `CONTACT_CHANGE_CONFIG.EMAIL_TOKEN_TTL_SECONDS` (shorter than 24 h by design).

---

## 5 · Rate limiting

Both verbs on `/api/auth/verify-email` sit in the **credential bucket: 20/min/IP** — the strict
one — because each spends a bearer secret. Same bucket as `/api/auth/email-change/confirm`,
`login`, `register` and the password-reset pair. See [rate-limits.md](./rate-limits.md).

Practical consequence: **do not retry a failed verify in a loop.** A `429` behind a shared NAT is a
real possibility, and retrying makes it worse for everyone on that address. Show the error and
offer "resend the email" instead.

---

## 6 · Deployment order

Producer-first, and no coordination is needed:

1. **Backend deploys** (done). Old links keep working through the `GET`; new mail points at your
   page. A person clicking a new link before your page ships lands on a 404 on *your* origin — so
   ship the page promptly, but nothing is spent and they can request another email.
2. **Frontends deploy.** The POST-first/404-fallback shape means a page can ship before or after
   the backend in any environment.
3. **Delete the fallback** once every environment is on the POST.

Nothing needs a migration, and no environment variable was added. `STOREFRONT_URL` — which already
drives the password-reset link, the magic sign-in link and the email-change confirmation — now
drives this one too, falling back to `API_PUBLIC_URL` when unset so a local box still works.

---

## 7 · Frontend to-do

| # | App | Action |
|---|---|---|
| 1 | landing | Point `/verify-email` at `POST /api/auth/verify-email`; read `app` and route on success |
| 2 | landing | Read `app` on `/account/confirm-email` too; keep the storefront default when absent |
| 3 | landing | Map `app` through a **compile-time table**; ignore unknown values. Never treat it as a URL |
| 4 | all | Do not retry a `429`; offer "resend" |
| 5 | **vendor-dash** | 🗑 **Delete `src/pages/auth/ConfirmEmailChange.tsx` and its route.** Inert by its own admission, and the landing now serves that page for all four apps. *(Not done by the backend change — separate repository.)* |
| 6 | landing | Delete the legacy-`GET` fallback in `src/lib/auth/auth.api.ts` once every environment serves the POST |

---

## Backend reference

- Endpoint contract: [auth/README.md](./auth/README.md) — `POST /auth/verify-email`,
  `GET /auth/verify-email` (legacy), and the link shape under `POST /auth/send-email-verification`
- Email change: [me/contact-change.md](./me/contact-change.md) — the `app=` note
- Rate limits: [rate-limits.md](./rate-limits.md)
- Backend regression suite: `npm run test:email-verification` (30 assertions, no DB)
