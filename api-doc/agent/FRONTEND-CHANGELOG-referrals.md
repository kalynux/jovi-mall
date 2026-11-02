# Agent app: the referral program

**2026-11-02 · not deployed yet · additive.** Read [the shared rules](../FRONTEND-CHANGELOG-referrals.md) first, and
[me/referrals.md](../me/referrals.md) for the contract.

## 1. Agents earn as partners, not as referred accounts

An agent can apply and earn from the vendors, customers and agencies they refer. An agent's own deliveries generate
nothing, for them or for whoever referred them. Don't suggest otherwise in the copy.

## 2. Registration

Add an optional "Referral code" field to sign-up and send it as `referral_code` on `POST /api/auth/register`. There is
no install-time way to carry a link's code into the app, so this field is the only path. Don't send it on add-role.
Nothing in the response reports on it, so show nothing about it.

## 3. A referral screen

A new screen in the menu. Build the states in the shared rules. `GET /api/me/referral` resolves the partner from the token.

Share with the platform share sheet. `links.registerUrl` suits vendors and agencies; `links.whatsappUrl` and
`links.telegramUrl` suit customers.

## 4. The payout destination

An agent with a payout method gets `payoutDestination.source: "agent"` and `editableHere: false`. Show it masked with a
link to the existing payout screen. An agent with none gets `source: null`: link there rather than building a form.

## 5. Separate money

⚠ A partner's balance is **not** the agent's delivery earnings and is unrelated to the COD cash limit. It has its own
withdrawal and its own lower minimum. Keep them visibly apart.
