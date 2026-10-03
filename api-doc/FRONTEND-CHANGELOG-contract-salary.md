# Frontend changelog — monthly-salary pay model (2026-10-02)

The agency↔agent contract's `fee_split` gains a **third pay model**, `monthly_salary`. Percentage
and flat-per-delivery are unchanged. Additive: no field was renamed or removed, and every existing
body still parses.

## What it means

| | `percentage` | `flat` | `monthly_salary` (new) |
|---|---|---|---|
| amount field | `agent_share_percent` (0–100) | `agent_flat_fee` (minor units / delivery) | `agent_monthly_salary` (minor units / **month**, integer > 0) |
| platform pays the agent per delivery | % of the fee | the flat fee (capped at the fee) | **0** |
| agency keeps | fee − agent cut (+ COD handling fee) | fee − agent cut (+ COD handling fee) | **the whole fee** (+ COD handling fee) |
| quote `basis` | `contract_percentage` | `contract_flat` | `contract_salary` |

⚠ **The salary is paid by the agency OUTSIDE Wi-Mall.** The platform does not schedule, track,
remind about or pay it, and no earnings entry, payout or balance ever reflects it. The figure is
stored only so both parties see what they agreed. Never render it as a platform earning, a balance
or a payout.

It is negotiated **exactly like the other split terms** — at formation (invite / join request /
counter) and on a live contract via terms proposals — and the **agent may propose it too**.

## Wire shape

Write bodies (`fee_split` in any terms body — request, counter, `PATCH …/terms`, terms proposal):

```json
{ "fee_split": { "model": "monthly_salary", "agent_monthly_salary": 150000, "currency": "XAF" } }
```

- `agent_monthly_salary`: integer ≥ 1, minor units, or `null`.
- When the body names a `model`, the **other models' amount fields must be omitted or `null`**,
  otherwise `400` (Zod). E.g. `{ "model": "monthly_salary", "agent_share_percent": 20 }` is refused.
- After merging over the stored split, the model in force must carry its own field, otherwise
  `422 CONTRACT_FEE_SPLIT_INVALID` (`details.hint` names the field). Same rule as before for
  percentage/flat.

Read DTOs (`feeSplit`, camelCase) gain one field:

```json
"feeSplit": { "model": "monthly_salary", "agentSharePercent": null, "agentFlatFee": null,
              "agentMonthlySalary": 150000, "currency": "XAF" }
```

**Only the amount matching `model` is meaningful.** A switch that sends only `model` keeps the
other stored values (that is how a partial patch works), so a stale `agentSharePercent` can sit
beside `model: "monthly_salary"` — ignore it.

Agent earning quote (offers, shipment list/detail — the `earning` block) gains `salary`:

```json
"earning": { "amount": 0, "currency": "XAF", "estimated": true, "deliveryFee": 2000,
             "basis": "contract_salary",
             "salary": { "monthlyAmount": 150000, "currency": "XAF", "paidBy": "agency_off_platform" } }
```

`salary` is `null` under the per-delivery models. Agency quote (`agencyEarning`) gains only the new
`basis` value; under it `agentCut` is `0`.

Terms-proposal `diff` entries may now carry the path `fee_split.agent_monthly_salary`.

## Agency dashboard

- Contract terms forms (invite, counter, pending `PATCH …/terms`, live terms proposal): add
  "Monthly salary" to the pay-model picker with a monthly amount input; clear/omit the other two
  amounts when it is chosen (sending them non-null with `model` is a 400).
- Roster / contract detail: render `model: "monthly_salary"` as e.g. "Salaried — 150 000 XAF / month
  (paid by you, outside Wi-Mall)".
- Shipment money (`agencyEarning`): with `basis: "contract_salary"`, `agentCut` is `0` — label it
  "agent salaried" rather than "no cut configured".
- Analytics: a salaried agent's deliveries now appear under `perAgent` with `agentShare: 0`
  (they used to drop out of `perAgent` when no agent earnings row existed — that also applied to
  agents on an unconfigured 0% split).
- Proposal diff: label `fee_split.agent_monthly_salary` as "Monthly salary".

## Agent app

- Same picker + amount in the join-request terms, counter and live-proposal screens.
- Contract view: show the salary and that the agency pays it directly.
- Offer / shipment earning: when `basis === "contract_salary"`, do **not** show "0 XAF earned" bare —
  show e.g. "Covered by your monthly salary from <agency> (150 000 XAF / month, paid by the agency)"
  using `earning.salary`. Keep the existing "0 is a real answer" handling for the other bases.
- Earnings balance: unchanged — salaried runs add nothing to it, by design.
- Analytics: salaried deliveries count in `deliveries` but contribute `0` to earnings.

## Admin dashboard (wi-admin)

- `GET /api/v1/…` contract reads (`terms.feeSplit`, see `admin/api-doc/api/contracts.md`) gain
  `agentMonthlySalary`; `model` may be `monthly_salary`. Render as "Salaried — X / month (agency
  pays off-platform)". No write path in wi-admin changed.

## Backend references

- Model: `src/modules/agents/models/agent-agency-membership.model.ts` (`FEE_SPLIT_MODELS`,
  `FEE_SPLIT_FIELD_BY_MODEL`).
- Arithmetic: `src/modules/earnings/services/earnings-quote.service.ts` (`applyFeeSplit`,
  `basisOf`, `salaryOf`).
- Suite: `npm run test:contract-salary`.
