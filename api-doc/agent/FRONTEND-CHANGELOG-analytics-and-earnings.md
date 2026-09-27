# Agent app: analytics, true earnings and a summable feed (2026-09-27)

**Audience:** the agent app. Contracts: [agent/analytics.md](./analytics.md) and
[agent/earnings.md](./earnings.md). This change only adds things: nothing existing is removed.

## 1. New: `GET /api/agent/analytics`

This covers your credited share, delivery outcomes (delivered, returned, failed), COD cash
(collected, handed over, held now) and payouts over a date range. Every figure is the entry
actually credited to you.

## 2. Changed: `earning` on shipment rows (lists and offers)

| Before | Now |
|---|---|
| `estimated` was always `true` | `estimated: false` once the delivery has been paid. `amount` is then what was credited, and `allocationStatus` (`held` / `released` / `reversed`) is added. |
| A **returned online-paid** shipment quoted your share of the full fee | It quotes your share of the agency's return (RTO) fee, which is what is actually paid. |
| A **returned cash-on-delivery** shipment quoted a share | It shows **`0`**. Nothing is paid for it. |
| A shipment under a contract that has since ended showed `earningUnavailable: "no_contract"` | It shows the real figure. |

## 3. Changed: `GET /api/agent/transactions`

- `direction` can now be **`internal`**: releases from escrow, and payouts that are pending, rejected or failed. Leave them out of totals.
- `category=payout` now lists your payout requests.

## 4. Work to do in agent_app

- [ ] **Add an "My earnings" analytics screen** backed by `GET /api/agent/analytics`, with a date range. Show COD cash **apart** from earnings.
- [ ] **Shipment and offer cards:** show "Earned" when `estimated` is `false`, and "Estimated" otherwise. A returned COD run shows 0.
- [ ] **Transactions list:** leave `internal` rows out of totals and render them muted. A "Payouts" filter now works.
- [ ] Update the models: `estimated: bool`, optional `allocationStatus`, and `direction` gains `internal`.
