# Backend requirements — standalone marketing pages

**Verified against source on 2026-09-08** — § 1 (the plan catalog) is built and its contract is
accurate; `GET /api/public/coverage` and `GET /api/public/stats` (§ 3a, § 3b) are still **not**
served, which is what this page says. No corrections were needed. Read this for the reasoning
behind the asks; the live contract is [README.md](./README.md).

What the pages under `src/app/[locale]/(marketing)/` need from `backend/jovi-mall`
to stop being hand-maintained mirrors and start being live. Nothing here blocks
shipping: every page renders and is correct today. Each item is either a
**correctness risk** (a number can silently go stale) or a **capability** the
copy currently has to work around.

Pages: `/pricing`, `/vendors`, `/agencies`, `/agents`, `/faq`, `/cameroon`, and
`/cameroon/{douala,yaounde,bafoussam,bamenda,garoua}` — each in five locales.

---

## 1. Public, unauthenticated plan catalog — **the one that matters**

**Status: ✅ BUILT (2026-08-07).** Contract: [public/README.md](./README.md).

```
GET /api/public/plans                                  → all roles, active tiers
GET /api/public/plans?role=agency                      → one role
GET /api/public/plans?role=agency&includeInactive=true → + the "coming soon" tiers
GET /api/public/credit-packs                           → packs + per-action credit costs
```

Three deviations from the ask below, all deliberate:

1. **A projection, not the raw document.** `_id` → `id`; `deletedAt`, `__v` and the audit timestamps
   are dropped. Every field the page asked for is there. Adding a field to the plan model does not
   publish it — that is an edit to `dto/public-plan.dto.ts`, on purpose.
2. **`includeInactive=true` exists**, so the seeded-but-inactive agency/agent tiers can come from the
   endpoint too and `plans.ts` can be deleted outright rather than kept for the "coming soon" column.
   Opt-in because `is_active: false` means *both* "not launched yet" and "withdrawn" — read the
   caveat in the contract before labelling them.
3. **`credit-packs` returns `{ packs, actionCosts }`**, not a bare array. The per-action credit costs
   are hand-copied out of `credit.config.ts` too and are **env-overridable**, so they carry the same
   silent-drift risk as the pack prices. Same failure, same fix.

Everything below in this section is the original ask, kept for context.

---

**Status: blocking correctness, not shipping.**

`/pricing` publishes real prices: 5 000 / 25 000 FCFA vendor tiers, 7 % → 3 %
commission, the agency and agent tiers, and the four credit packs. Those numbers
live in `src/lib/marketing/plans.ts`, hand-copied from:

- `backend/scripts/seed/seed-pricing-plans.ts` — every tier, price, quota,
  `commission_percent`, `credit_allowance`, and `is_active`
- `backend/src/modules/billing/config/credit.config.ts` — `CREDIT_TOPUP_PACKS`
  and the per-action credit costs

They are copied because there is no endpoint a logged-out visitor can call.
`GET /api/{role}/plans` sits behind `requireAuth` + `requireRole(['vendor'])`
(see `src/modules/billing/routes/vendor-billing.routes.ts`), so a marketing page
cannot read it.

**Ask:** an unauthenticated read of the active catalog. Shape can be exactly what
the authenticated route already returns — the page needs `code`, `name`, `price`,
`currency`, `term_days`, `is_active`, `sort_order` and the limit fields.

```
GET /api/public/plans            → all roles
GET /api/public/plans?role=agency
GET /api/public/credit-packs
```

Only `is_active: true` rows need to be public; the page renders the seeded-but-
inactive agency/agent tiers as "coming soon" from its own list and can keep doing
so, or drop them once the endpoint is the source.

**Until then:** changing a price in the backend seed **must** be mirrored in
`plans.ts`. Publishing a price we do not charge is the only failure mode on these
pages that is worse than being out of date.

> **No longer true as of 2026-08-07** — `plans.ts` can read the endpoint instead. The
> mirroring rule dies with it. Note the 5-minute `Cache-Control` on the public route: a
> price edit is invisible to the site for up to that long, plus whatever your own
> revalidation window adds.

---

## 2. Nothing else is required to ship

The rest of the pages are deliberately built from facts that do not change per
request — how commission is taken, how the delivery fee is split, what the
onboarding steps require, how the caps behave. Those were verified against
`api-doc/` and the services themselves, and they are cited in the code comments.
Sources used:

| Claim on the pages | Verified against |
|---|---|
| Commission is a % of order gross, taken at payment, set by the vendor's plan | `modules/earnings/services/earnings-split.service.ts` (`splitOrder`) |
| Platform takes no share of the delivery fee; agency keeps fee − agent cut | `earnings-quote.service.ts` (`applyFeeSplit`, `computeAgencyCut`) |
| Agent cut is per-contract, percentage or flat, and quoted before accepting | `api-doc/agent/shipments.md` (`earning` on the list), `api-doc/agent/agency-membership.md` |
| Agency cap is soft (alert only); agent cap is hard (`422 AGENT_AT_CAPACITY`) | `api-doc/billing-plans-across-roles.md` |
| No recurring charge; term expires → queued plan or free tier | `api-doc/billing-plans-across-roles.md` |
| Payout: escrow → order completion (or 7-day auto-confirm) → 7-day hold → request | `api-doc/vendor/earnings.md` |
| Vendor required onboarding = country + payout details only | `api-doc/vendor/onboarding.md` |
| Agency required onboarding = coverage + HQ address + payout + policies | `api-doc/agency/onboarding.md` |
| Agents sign up independently, may hold several agency contracts | `api-doc/agent/agency-membership.md` |
| Payment methods: NotchPay / MyCoolPay (MTN, Orange, Moov), Stripe, COD | `api-doc/payments/README.md`, `modules/payments/gateways/` |
| Cameroon only; ten regions; region-keyed coverage | `src/core/constants/locations.json`, `locations.helper.ts` |

If any of those change, the corresponding copy in `messages/*.json` under
`pages.*` needs changing with it.

---

## 3. Nice-to-have, in the order they would add most

**Status: none of these are built**, deliberately. Each one is either blocked on a product decision
this file itself raises (3a: how an uncovered region reads) or explicitly not-yet-worth-it by its own
argument (3b: "no number beats a small one"; 3c: needs real reviews first). 3d is a frontend
constant, not a backend endpoint. Say the word on any of them and they are small additions to the
`/api/public` router that now exists.

### 3a. Real coverage per region

`/cameroon` currently says all ten regions are *available for an agency to
register*, which is true and deliberately not the same as "we deliver there".
A public count of agencies with live coverage per region would let the page say
something much stronger, and would let a city page say whether it is actually
served.

```
GET /api/public/coverage → [{ region: "littoral", agencies: 4, active: true }, …]
```

Caveat worth deciding before building it: a region showing `0` is a truthful
answer that also reads as "not available here". The page copy is already written
to frame an uncovered region as an opening for agencies rather than a gap, so
either presentation works — but it should be a decision, not an accident.

### 3b. Real counts to replace the goal figures

`TRUST_STATS` in `src/lib/constants.ts` (10K+ vendors, 500+ agencies, 2M+ orders,
15+ cities) are labelled in code as first-year *goals*, and `PRODUCT.md` is
explicit that they must never be presented as current fact. The new pages
therefore quote **no** counts at all. A public aggregate would let them:

```
GET /api/public/stats → { vendors, agencies, agents, cities, orders }
```

Only worth wiring when the numbers are large enough to help. Until then, no
number beats a small one.

### 3c. Structured data we are choosing not to emit

`src/lib/seo/jsonld.ts` deliberately omits `aggregateRating` and `review`
everywhere, because ratings on `shop.fixtures.ts` are invented. When real reviews
exist, a public per-vendor rating aggregate would let `/cameroon/{city}` and the
store pages carry rating rich results legitimately.

### 3d. WhatsApp entry point

`BRAND.whatsappNumber` in `src/lib/constants.ts` is still the placeholder
`+2340000000000`, and `WHATSAPP_CUSTOMER_LINK` is built from it. The marketing
pages route their CTAs to `/register?role=…` rather than to WhatsApp precisely
because of this — the customer CTA is the one path they do not push. Set the real
number and the customer-side CTA becomes usable on every page.

---

## 4. Two frontend-side decisions the backend forces

Recorded here because they will look like mistakes otherwise.

**Currency is FCFA, not Naira.** These pages price in XAF because that is what
the backend charges (`seed-pricing-plans.ts`, `credit.config.ts`, `Africa/Douala`
timezone defaults, NotchPay/MyCoolPay). The existing landing page's hero and demo
chat quote ₦ and Lagos, and `src/i18n/request.ts` sets `timeZone: "Africa/Lagos"`.
`PRODUCT.md` already flags this as unsettled and says the real market "likely
points to FCFA / XAF and French-first". **The landing copy and the new pages
currently disagree with each other in public.** Resolving that is a product
decision, not a code change — but it should be resolved before launch, because a
hero in ₦ above a pricing page in FCFA reads as carelessness.

**Geography is Cameroon only.** `locations.json` has exactly one country. The
city pages are five hand-written pages, not a generated set — see the comment on
`CITIES` in `src/lib/marketing/geo.ts`. Adding the other 61 cities from a template
would be a doorway-page set, which is a spam-policy problem rather than an SEO
win. New city pages should be added when there is something specific and true to
say about commerce there.
