# Agency dashboard: analytics, true earnings, roster counts and a summable feed (2026-09-27)

**Audience:** agency-dash, and the agency half of the agency/agent app. Contracts:
[agency/analytics.md](./analytics.md), [agency/earnings.md](./earnings.md) and
[agency/agent-roster.md](./agent-roster.md). This change only adds things: nothing existing is removed.

## 1. New: `GET /api/agency/analytics`

This is the first analytics endpoint for agencies. It covers fees earned, COD fees, agents'
shares, agency net, delivery outcomes, the COD cash position (collected, deposited, remitted,
owed now), a per-agent breakdown and payouts over a date range. Every figure is **what was actually
credited**, not an estimate.

## 2. Changed: `agencyEarning` on shipment rows

| Before | Now |
|---|---|
| `estimated` was always `true` | `estimated: false` once the delivery has been paid out. The figures are then the real entries, and `allocationStatus` (`held` / `released` / `reversed`) is added. |
| A returned **cash-on-delivery** shipment showed the RTO fee plus a COD fee | It shows **`0`**. No cash was collected, so nothing is paid. |
| A shipment of an agent whose contract ended quoted the **whole fee** as yours | It uses that agent's last contract, and the real entries once paid. |

## 3. Roster and `/agents/eligible`

- **New `activeShipmentsForYou`** beside `activeShipmentCount`. `activeShipmentCount` is unchanged and counts the agent's active shipments across **all** agencies, which shows how busy they are. `activeShipmentsForYou` counts only yours.
- **`trustScore` is now the effective score.** If an administrator has pinned a score, that is what you see. It is the same number the agent sees in their own app. The field is unchanged; only the value can differ.

## 4. Changed: `GET /api/agency/transactions`

- `direction` can now be **`internal`**, meaning money moved between your own balances: a release from escrow, a COD reserve move, or a payout that is pending, rejected or failed. **Leave `internal` rows out of totals.** Before this change a hold and its release were both `in`, so every earning was counted twice.
- `category=payout` now returns your payout requests. It used to always be empty.
- COD reserve rows no longer say "Earning reversed (refund)".

## 5. Work to do in agency-dash

- [ ] **Add an Analytics screen** backed by `GET /api/agency/analytics` with a date range:
  - earnings summary (fees earned, COD fees, agents' shares, net);
  - delivery outcomes;
  - a **separate** COD cash panel, because cash is a liability, not income;
  - a per-agent table;
  - payouts.
- [ ] **Shipment list and detail money column:** show the figure as final when `estimated` is `false` (optionally with `allocationStatus`), and as "estimated" otherwise. A returned COD shipment now reads 0.
- [ ] **Roster and eligible-agents list:** show both counts, for example "3 active · 1 for you".
- [ ] **Transactions tab:** leave `internal` rows out of totals and render them muted. A "Payouts" filter now works.
- [ ] Update the local types: `estimated: boolean`, optional `allocationStatus`, `activeShipmentsForYou: number`, and `direction: 'in' | 'out' | 'internal'`.
