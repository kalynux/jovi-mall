# Agent app — COD pool from your plan, and who can see your emergency contact

> **Date:** 2026-09-21 · **Audience:** the agent mobile app · **Breaking:** no
>
> Cross-role summary: [../FRONTEND-CHANGELOG-cod-pool.md](../FRONTEND-CHANGELOG-cod-pool.md)

Two changes reach this app:

1. **The COD pool now sets itself.** It comes from the agent's plan once their identity is
   verified. Agents gain one new control: **carry less**.
2. **The emergency contact the agent enters is now visible to platform staff** on the admin
   dashboard. No API change for this app, but the form's copy should say so.

Nothing existing breaks. Every change below is additive.

---

## 1 · The COD pool

### What changed

The **COD pool** (`maxThreshold`) is the most cash-on-delivery money an agent may carry across
every agency combined. Each agency's COD limit for the agent is a slice of it.

| | Before 2026-09-21 | Now |
|---|---|---|
| New agent | pool `0` | pool `0` (unchanged) |
| Agent verified | still `0` until an administrator typed a number | **opens automatically** at the plan's value |
| Plan changed | nothing happened | pool **resets** to the new plan's value |
| Verification withdrawn | nothing happened | pool drops to **0** |
| Agent wants to carry less | impossible | **`PUT /api/agent/cod/pool`** |

Plan values (the plan's `max_cod_pool`):

| Plan | COD pool once verified |
|---|---|
| Agent Free (`agent_free`) | **500 000 XAF** |
| Agent Plus (`agent_plus`) | **1 000 000 XAF** |
| Agent Pro (`agent_pro`) | **2 000 000 XAF** |

An administrator can also set a value for one agent (`pool.source: "override"`), above or below the
plan. It still never applies while the agent is unverified.

### `GET /api/agent/cod/allocation`: three new fields

```json
{
  "agentId": "…",
  "maxThreshold": 500000,
  "allocated": 350000,
  "headroom": 150000,
  "overAllocatedBy": 0,
  "pool": {
    "maxThreshold": 500000,
    "ceiling": 500000,
    "source": "plan",
    "planCode": "agent_free",
    "selfLimited": false,
    "syncedAt": "2026-09-21T09:30:00.000Z"
  },
  "contracts": [ … unchanged … ]
}
```

| Field | Use it for |
|---|---|
| `pool.ceiling` | The most the agent can set. The slider's maximum |
| `pool.source` | `"plan"` · `"override"` · `"not_verified"`. Pick the explanatory copy (below). **Display only**, never a business rule |
| `pool.planCode` | Name the plan in the copy ("Your Agent Free plan allows up to …"). `null` unless `source` is `"plan"` |
| `pool.selfLimited` | `true` → show "You chose to carry less than your limit" and a "Use my full limit" action |
| `pool.syncedAt` | `null` → the account predates this change and has not been synced yet. Show the numbers as they are; it converges by itself |
| `overAllocatedBy` | `> 0` → your agencies hold more than your pool (after a downgrade, or verification withdrawn). Warn the agent that agencies cannot raise their limits, and that dispatches are capped at the pool |

Suggested copy by `pool.source`:

| `source` | Copy |
|---|---|
| `not_verified` | "Cash on delivery opens once your identity is verified." Link to the identity-verification screen ([identity-verification.md](./identity-verification.md)) |
| `plan` | "Your {plan name} plan lets you carry up to {ceiling} XAF." Plus an upgrade link if a higher plan exists |
| `override` | "Your limit was set by the platform: up to {ceiling} XAF." Do **not** invent a reason; the API does not give one to the agent, on purpose |

### New: `PUT /api/agent/cod/pool`

Lets the agent carry **less** than the ceiling. It can never go higher.

```http
PUT /api/agent/cod/pool
{ "maxThreshold": 300000 }     ← carry at most 300 000
{ "maxThreshold": null }       ← back to the full ceiling
```

- The answer is the same body as `GET /api/agent/cod/allocation`, so update the screen from it.
- The choice stays until the ceiling changes (new plan, new verification decision, or a change by
  an administrator). Then the pool resets to the new ceiling.
- Errors (full table in [cod-cash.md](./cod-cash.md#put-apiagentcodpool)):
  - `422 AGENT_COD_POOL_ABOVE_CEILING`: more than `details.ceiling`. Show `details.hint`.
  - `422 AGENT_COD_THRESHOLD_BELOW_ALLOCATED`: agencies already hold more than that.
    `details.contracts[]` names them. Suggest a number ≥ `details.currentlyAllocated`.
  - `409 AGENT_COD_POOL_CONFLICT`: the pool changed at that moment. Re-read and retry.

**Suggested UI:** a slider (or number field) from `0` to `pool.ceiling`, with its minimum shown as
`allocated` and a "Use my full limit" button that sends `null`. Don't let the agent submit below
`allocated`: the API refuses it anyway.

### Plans now show the COD pool

`GET /api/agent/plans` and `GET /api/agent/plan` carry **`max_cod_pool`** on each agent plan. Show it
on the plan cards next to the delivery cap. ⚠ `null` means **no COD**, never "unlimited", the
opposite of `max_unterminated_shipments`. See [billing.md](./billing.md).

### Unchanged

- `GET /api/agent/cod/balance`: same fields. `effectiveExposureLimit` was already derived from the
  pool; it now also agrees with the dispatch gate, which since today never allows more than the pool.
- Each agency still sets its own slice. Contract screens are unchanged.

---

## 2 · Emergency contact: platform staff can now see it

`PATCH /api/agent/profile` → `emergency_contact: { name, phone }` is unchanged
([profile.md](./profile.md)).

What changed: platform administrators now see the name and phone on the agent's page in the admin
dashboard. Until today it was hidden from them, deliberately. The owner reversed that, because the
contact exists so that somebody can be reached if something happens to the agent on a delivery,
and staff are the people who would make that call. It is **not** shown to agencies, vendors or
customers, and not on any list.

**Suggested copy** under the form: "Platform staff can see this contact and will only use it in an
emergency involving you."

---

## Checklist

- [ ] COD screen: read `pool` from `GET /api/agent/cod/allocation` and show the source-specific copy
- [ ] COD screen: "carry less" control → `PUT /api/agent/cod/pool` (`null` = full limit)
- [ ] Handle `AGENT_COD_POOL_ABOVE_CEILING`, `AGENT_COD_THRESHOLD_BELOW_ALLOCATED`, `AGENT_COD_POOL_CONFLICT`
- [ ] Warn when `overAllocatedBy > 0`
- [ ] Plan cards: show `max_cod_pool` (`null` → "No cash on delivery")
- [ ] Emergency-contact form: add the visibility notice
