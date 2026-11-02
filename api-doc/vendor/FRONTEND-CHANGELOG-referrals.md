# Vendor dashboard: the referral program

**2026-11-02 · not deployed yet · additive.** Read [the shared rules](../FRONTEND-CHANGELOG-referrals.md) first, and
[me/referrals.md](../me/referrals.md) for the contract.

## 1. Registration

Add an optional "Referral code" field, filled from `?ref=` when present, and send it as `referral_code` on
`POST /api/auth/register` or `/api/auth/mobile/register`. Don't send it on add-role. Nothing in the response reports
on it, so show nothing about it.

## 2. `/dashboard/account/referrals`

A new page, with a menu entry near Payout. Build the states in the shared rules.

`GET /api/me/referral` resolves the partner from the session, so nothing vendor-specific is sent.

## 3. The payout destination

A vendor with a payout method gets `payoutDestination.source: "vendor"` and `editableHere: false`. Show it masked with
a link to the existing `/dashboard/account/payout`. Editing it there changes it here, immediately.

A vendor with none gets `source: null`. Link to `/dashboard/account/payout` rather than building a form: once they
have one there, it is the one used.

## 4. Separate money

⚠ A partner's balance is **not** the vendor's earnings. It has its own withdrawal, its own lower minimum, and never
appears on the earnings page. Keep them visibly apart.

## 5. Being referred

Nothing changes for a vendor who was referred. They are not told who referred them, and their earnings, commission
and statements are unaffected: the reward comes out of Wi-Mall's share.
