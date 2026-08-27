# Backend requirements — unified email verification across all four apps

**Authored, not a mirror.** No backend counterpart exists yet; this is the ask. Written
2026-08-24 against `jovi-mall` at `contact-change.service.ts`, `auth.service.ts`,
`auth.routes.ts`, `auth.controller.ts`.

The landing app now hosts **both** emailed-token pages on behalf of the storefront, the vendor
dashboard, the agency dashboard and the agent app. One of the two flows already points here and
works. The other does not point here at all, and that is the substance of this document.

---

## 0 · Why one page for four apps is the right shape

`POST /api/auth/email-change/confirm` reads no `req.auth`, takes no actor, resolves the account from
the SHA-256 of the token, and then syncs the confirmed address onto **every** role profile the
account holds. The confirmation is genuinely role-free — a per-dashboard copy of the page would have
nothing to do differently, and each copy would be one more place for the POST-not-GET rule to be got
wrong. `vendor-dash` already carries such a copy (`src/pages/auth/ConfirmEmailChange.tsx`), inert
by its own admission; **delete it** once this lands.

The one thing a role-free confirm cannot answer is *where to send the person afterwards*.

---

## 1 · Stamp the requesting role into the email-change link

**Status: the page already reads this. The backend does not send it yet.** Absent, the flow still
works — the page falls back to storefront links, which is the wrong destination for three of the
four audiences.

`src/modules/users/services/contact-change.service.ts`

```ts
/** The confirmation URL. One builder, so the mail and the api-doc cannot drift. */
export function buildEmailChangeLink(token: string, app?: string): string {
  const origin = app ? `&app=${encodeURIComponent(app)}` : '';
  return `${confirmLinkBase()}/account/confirm-email?token=${token}${origin}`;
}
```

and at the one call site, inside `requestEmailChange` — `actor.role` is already resolved from the
verified token by `ContactChangeController.actorFrom`:

```ts
variables: {
  link: buildEmailChangeLink(token, actor.role),
  // …unchanged
}
```

`actor.role` is one of `customer | vendor | agency | agent`, which is exactly the enum the page
accepts. **Optional parameter on purpose:** links already sitting in inboxes carry no `app=`, and
the page treats its absence as normal.

⚠ **A role key, never a URL.** The page maps `app=` through a compile-time table and ignores
anything else — verified: `?app=https://evil.example` renders the storefront link, not a redirect.
Do not "improve" this into a `?return=` parameter; the page is reachable with no session.

---

## 2 · 🔴 Point registration verification at the storefront

This is the flow that is **not built for any dashboard today**, and the reason is one line.

`src/modules/auth/auth.service.ts:537`

```ts
const verifyLink = `${API_PUBLIC_URL}/api/auth/verify-email?token=${token}`;
```

The link points at **the API**, so no frontend is ever involved. Three consequences, all live now:

1. A person who clicks it gets a **raw JSON envelope** in their browser. There is no page, no
   branding, and no way onward — for customers, vendors, agencies and agents alike.
2. It is a **`GET` that mutates**, so it is spent by whatever prefetches the mail: link scanners,
   corporate relays, the mail client's own preview. This is the exact failure `PasswordResetService`
   and the email-*change* confirm each argue against at length; registration verification never got
   the same treatment.
3. The landing has had a `/verify-email` page all along that **nothing links to**, because nothing
   points at it.

```ts
const verifyBase = (process.env.STOREFRONT_URL || API_PUBLIC_URL).replace(/\/+$/, '');
const verifyLink = `${verifyBase}/verify-email?token=${token}&app=${role}`;
```

`role` is already a parameter of `sendEmailVerification(userId, role)`. The `API_PUBLIC_URL` fallback
keeps local dev working when `STOREFRONT_URL` is unset — the same precedence `confirmLinkBase()`
uses.

---

## 3 · Add `POST /api/auth/verify-email`, keep the `GET`

Same handler, same service call, different verb — so the page can spend the token deliberately
instead of a prefetcher spending it first.

`src/modules/auth/auth.schemas.ts` — mirrors `ConfirmEmailChangeSchema`, including the generous
512-char bound (a mail client that wraps a URL is a real thing, and a near-miss should be told the
token is *invalid*, not *malformed*):

```ts
export const VerifyEmailSchema = z
  .object({ token: z.string().trim().min(1, 'A verification token is required').max(512) })
  .strict();
```

`src/modules/auth/auth.controller.ts`:

```ts
/**
 * POST /api/auth/verify-email — spend the token deliberately.
 *
 * The GET below it still works, for links already in inboxes. New mail points
 * at the storefront page, which POSTs here.
 */
static verifyEmailPost = asyncHandler(async (req: Request, res: Response) => {
  const { token } = VerifyEmailSchema.parse(req.body);
  const result = await authService.verifyEmail(token);
  sendSuccess(res, result);
});
```

`src/modules/auth/auth.routes.ts`, beside the existing GET:

```ts
router.get('/verify-email', AuthController.verifyEmail);     // legacy links — keep
router.post('/verify-email', AuthController.verifyEmailPost); // new
```

Both inherit the `/auth` prefix's credential bucket (20/min/IP), which is what a bearer-secret spend
should be counted against. `rate-limit/auth-paths.ts` is an allowlist, so **not** naming the new
route there is how it gets the strict counter.

**Do not remove the `GET`.** Registration tokens live 24 hours (`EMAIL_VERIFY_EXPIRE`), so links
minted before the deploy stay valid for a day after it.

### 3.1 The frontend already tolerates this not being deployed

`verifyEmail()` in `src/lib/auth/auth.api.ts` POSTs first and falls back to the legacy `GET` **only
on 404/405** — statuses that mean nothing was spent. Every other failure is the real answer and
propagates. Delete the fallback once every environment serves the POST.

---

## 4 · What is deliberately not asked for

**No role in the confirm response.** `{ email }` is right. An account can hold several roles, so a
`roles` array would not identify one destination anyway — which is why the origin travels in the
link, stamped by the half of the flow that has a session.

**No per-role link base.** `VENDOR_APP_URL` and friends exist for notification deep links and should
stay that way. One page means one base; four bases would mean four pages.

**No change to `POST /api/auth/email-change/confirm`.** It is correct as built — public, POST, and
role-free. Nothing here touches it.

---

## 5 · Checklist

| # | File | Change | Blocking? |
|---|---|---|---|
| 1 | `users/services/contact-change.service.ts` | `buildEmailChangeLink(token, app?)` + pass `actor.role` | no — page degrades to storefront links |
| 2 | `auth/auth.service.ts` | verification link → `{STOREFRONT_URL}/verify-email?token=…&app={role}` | **yes** — until then, users see raw JSON |
| 3 | `auth/auth.schemas.ts` | `VerifyEmailSchema` | yes, with #4 |
| 4 | `auth/auth.controller.ts` + `auth.routes.ts` | `POST /api/auth/verify-email`, keep the `GET` | yes, with #3 |
| 5 | `vendor-dash` | delete `pages/auth/ConfirmEmailChange.tsx` and its route | no — inert either way |
