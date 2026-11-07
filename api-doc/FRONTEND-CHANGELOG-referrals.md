# The referral program: what every app shares

**2026-11-02 · not deployed yet · additive.** The program starts switched off, and no existing response or
request changes shape. Contract: [me/referrals.md](./me/referrals.md). Per app:
[landing and shop](./public/FRONTEND-CHANGELOG-referrals.md) · [vendor](./vendor/FRONTEND-CHANGELOG-referrals.md) ·
[agency](./agency/FRONTEND-CHANGELOG-referrals.md) · [agent](./agent/FRONTEND-CHANGELOG-referrals.md) ·
[admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-referrals.md).

## What it is

An approved partner shares a link. When someone registers through it, the partner earns a percentage of the
vendor commission Wi-Mall later earns on orders that person takes part in. Any signed-in user can apply, in
any app, and an administrator approves them.

## The rules your copy must not contradict

- **Rewards come from Wi-Mall's commission,** never the order value. On a 100,000 FCFA order at 7% commission,
  3% pays 210 FCFA, not 3,000.
- **Vendors, customers and agencies generate rewards.** A delivery agent can be a partner, but an agent's own
  deliveries generate nothing.
- **A referral earns for a limited time** from the person's registration: 6 months today, set by Wi-Mall. Read
  the end date from `expiresAt`.
- **A reward is earned when Wi-Mall receives its commission,** 3 days after delivery, and for cash orders once the
  cash reached Wi-Mall. An order placed before the end date can still earn nothing.
- **A reward can be withdrawn after a wait** (`program.rewardWaitDays`, 14 days today), and it goes down if the
  order is refunded. Later refunds can leave the partner owing money, which later rewards pay first.
- **The minimum withdrawal is `program.minPayoutAmount`** (1,000 FCFA today). The whole available balance is withdrawn.

Render the numbers from the API. Never write 3%, 6 months, 14 days or 1,000 in code or copy.

## The page in each state

| `status` | Show |
|---|---|
| `none` + `canApply: true` | What the program is, the Partner Terms, and the application form |
| `none` + `canApply: false` | The program is not open |
| `pending` | "We're reviewing your application" |
| `active` | Code, link, share buttons, balances, referred accounts, rewards, withdrawal |
| `rejected` | `statusReason`. The form again only if `canApply` |
| `suspended` | `statusReason`, a notice that the link earns nothing for now and the balance is frozen, and the history |
| `terminated` | `statusReason`, the same notice, the history, and the form only if `canApply` |

Always show the balances and history to a former partner: earned rewards stay recorded.

## The application form

A checkbox for the Partner Terms (`https://cdn.wi-mall.com/legal/referral-partner-terms-{en,fr}.html`) and an
optional text box. The button stays disabled until the box is ticked, and the request sends `termsAccepted: true`.

## Sharing

Use `links.registerUrl` for a vendor, an agency or an agent, and for a customer on the website. It opens the
landing `/register` page, which routes each role. Offer `links.whatsappUrl` and `links.telegramUrl` for people who
will shop through the chat.

## The registration form

Any form that creates an account: keep `?ref=` from the URL (or offer an optional "Referral code" field) and send
it as `referral_code`. It never refuses a registration and nothing in the response reports on it, so show no
success or error message about the code. Never send it when adding a role.

## Withdrawing

Show the masked destination from `payoutDestination`. See [me/referrals.md § The payout destination](./me/referrals.md).

## Who is notified

By WhatsApp, for all four roles, and by email only when WhatsApp cannot deliver: approved (with the code), rejected,
suspended, reinstated, terminated, balance released, allowed to apply again, withdrawal sent, withdrawal refused and
transfer failed. There are no in-app or push notifications, so the page itself must always show the current status and
`statusReason`: a WhatsApp message outside the 24-hour window points at the page instead of quoting the reason.
