# FRONTEND CHANGELOG — when an agency gives back, and damage claims (2026-10-22)

**Additive only.** Two new GET routes; no existing response changed.
Contract: [earnings.md](./earnings.md) (sections "Why money was taken back", "When a refund takes
your delivery fee back", "Damage claims").

## What changed for agencies

Your **own terms** now decide what you answer for, the same terms that decide how long your
money is held:

1. **A refund takes your delivery fee back only when the delivery was at fault** (damaged or lost in
   delivery, as found by the team) **and** the problem was raised inside your window — your
   damage-claim deadline from your parcel's delivery (at least 3 days if you pay returns). Your
   agent's cut goes back with it; your **COD handling fee stays**. A wrong item or a change of mind
   never touches you. With a deadline of 0 and returns not on you, a refund never takes anything back.
2. **Damage claims.** Inside the same window the team can charge you for a damaged parcel: at most
   your own **max refund per item** × the damaged items, plus your **investigation fee**. It comes
   from your money held for that parcel, then your available balance, then as a debt your next
   earnings pay first. **Your agents are never charged.** One claim per parcel.

## New routes

- `GET /api/agency/earnings/adjustments?page=&limit=` — every movement that took money from you,
  paid your debt, or forgave it, **with a sentence explaining it** (`explanation`; `reasonCode` +
  `reasonParams` for French).
- `GET /api/agency/earnings/claims?page=&limit=` — damage claims charged to you, each with
  `explanation`, `amount`, `investigationFee`, `maxPerItem`, `windowDays`, `raisedAt`.

## What to change

1. **Earnings → "Adjustments" list:** date, amount, `explanation`; `takenFrom.debt > 0` → "you now owe".
2. **Earnings → "Damage claims" list:** order, parcel, `amount` + `investigationFee`, `explanation`.
3. **Policies screen**, next to "Damage claim deadline" and "Max refund per item", EN / FR:

   | EN | FR |
   |---|---|
   | Inside this deadline you can be charged for a parcel damaged in delivery, up to your max refund per item plus your investigation fee. | Pendant ce délai, un colis endommagé lors de la livraison peut vous être facturé, jusqu'à votre remboursement maximum par article plus vos frais d'enquête. |
