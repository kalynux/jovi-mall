# FRONTEND CHANGELOG — why money was taken back (2026-10-22)

**Additive only.** One new GET route. Contract: [earnings.md](./earnings.md) (sections "Why money
was taken back", "When a refund takes your cut back").

## What changed for agents

Your cut of a delivery is taken back only when the team finds the **delivery at fault** and the
problem was raised inside your **agency's** window (its damage-claim deadline from your parcel's
delivery). Damage claims are charged to your agency, never to you.

## New route

`GET /api/agent/earnings/adjustments?page=&limit=` — every movement that took money from you, with a
sentence explaining it (`explanation`; `reasonCode` + `reasonParams` for French).

## What to change

**Earnings & payouts → "Adjustments" list:** date, amount, `explanation`. `takenFrom.debt > 0` →
"you now owe" / « vous devez désormais ».
