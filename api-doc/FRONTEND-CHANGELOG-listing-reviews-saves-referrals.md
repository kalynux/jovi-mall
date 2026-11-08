# Frontend changelog — listing reviews, saved listings, provider referrals (2026-11-08)

Plan and owner decisions: `PRODUCTION-READINESS/LISTING-REVIEWS-SAVES-REFERRALS-PLAN.md` (RS-1 … RS-12).
This page is the half **every app** shares. Each app's own tasks are in its role folder:

| App | Read |
|---|---|
| Storefront / landing | `public/FRONTEND-CHANGELOG-listing-reviews.md` and `customer/FRONTEND-CHANGELOG-listing-reviews-saves.md` |
| Vendor dashboard (providers) | `vendor/FRONTEND-CHANGELOG-listing-reviews.md` |
| Admin dashboard | `backend/admin/api-doc/FRONTEND-CHANGELOG-listing-reviews-saves-referrals.md` |
| Agency dashboard, agent app | this page only |

## What changed, in one paragraph

Customers can **save** a service listing in the same saved list as products, and **review** a listing once
they have unlocked one of its contacts. Listing cards now carry a real `rating`. A referral partner now
also earns when a **service provider** they referred pays Wi-Mall for a plan or a credit pack.

## The referral page, in every app (`/api/me/referral`)

A partner can belong to any role, so this reaches every app that shows the referral page.

1. **A fourth category, `provider`.** `GET /api/me/referral` → `terms` now has
   `provider: { ratePercent, durationMonths }` beside `vendor`, `customer`, `agency`. Show it with the
   others: "Service providers: 3% for 6 months".
2. **The referred list and the rewards list can show `category: "provider"`.** Label it "Service provider".
3. **Rewards gain `paymentKind`:** `"plan"` | `"credits"` | `null`. On a provider reward, show what the
   provider paid for: "Plan" or "Credits". `null` on every other reward: show nothing new there.
4. ⛔ **There is no amount the provider paid, and you must not ask for one** (owner RS-7). The partner sees
   the masked name, the kind, their reward and its dates, nothing about another business's spending.

How a provider reward behaves, so your copy is right:

- It is earned **when the provider pays** and becomes withdrawable after the same wait as every reward
  (`availableFrom`).
- If the payment is refunded or disputed later, the reward goes back to `0` (`status: "reversed"`), like a
  refunded commission.
- A seller referred as `vendor` still earns on sales only, never on what they pay for a plan.

## Nothing else changes for the agency dashboard or the agent app.
