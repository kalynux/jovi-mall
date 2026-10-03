# Agency app — agents' COD pools are now automatic

> ⚠ **PARTLY SUPERSEDED 2026-10-02** — the plan **no longer** sets an agent's COD pool. Every verified agent without an administrator pin gets **500 000**, `pool.source` is `"default"` (was `"plan"`) and `pool.planCode` is always `null`. Plan cards must stop advertising `max_cod_pool` as a benefit. Everything else here (KYC gate, "carry less", the admin pin) still holds. See [FRONTEND-CHANGELOG-cod-limits.md](../FRONTEND-CHANGELOG-cod-limits.md).

> **Date:** 2026-09-21 · **Audience:** the agency dashboard / agency app · **Breaking:** no
>
> Cross-role summary: [../FRONTEND-CHANGELOG-cod-pool.md](../FRONTEND-CHANGELOG-cod-pool.md)

No endpoint of yours changed shape. What changed is the **agent's side** of the COD limit you
negotiate with them, and one new error detail tells you when that side is the one refusing.

---

## What changed underneath your COD slice

Your contract's COD limit (`PATCH /api/agency/agents/:membershipId/cod-limit`, `{ "threshold" }`)
is a **slice** of the agent's own **COD pool**, which every agency they serve shares.

| | Before | Since 2026-09-21 |
|---|---|---|
| A newly verified agent's pool | `0` until an administrator set it. Every slice you tried to give was refused with `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` | **Their plan's value, automatically**: Free 500 000 · Plus 1 000 000 · Pro 2 000 000 XAF |
| An unverified agent's pool | `0` | `0` (unchanged). ⚠ *This row said "they can't hold a contract anyway" — no longer true since 2026-09-27: an unverified agent can hold a contract, its COD slice is accepted but DORMANT, and COD shipments to them are refused `422 AGENT_KYC_NOT_VERIFIED`. See [../FRONTEND-CHANGELOG-verification-no-longer-gates-work.md](../FRONTEND-CHANGELOG-verification-no-longer-gates-work.md)* |
| Who can lower it | an administrator | the **agent** (`PUT /api/agent/cod/pool`), or an administrator |
| When it drops (plan downgrade, verification withdrawn) | not applicable | your slice stays as agreed, but no dispatch can use more than the pool |

**Practical effect:** the "why can't I give this agent any COD" support case goes away for
verified agents. You can grant a slice up to whatever the agent has left unallocated.

---

## `COD_AGENT_EXPOSURE_EXCEEDED` gained `details.poolBinds`

Assigning a COD shipment is still refused with `422 COD_AGENT_EXPOSURE_EXCEEDED` when the agent's
held and expected cash would pass their effective limit. The limit is now:

```
min(your slice, the agent's pool) × trust multiplier
```

The two are equal while your slice fits in the pool, which is the normal case. They differ only
when the agent's pool went down after you set your slice. Then:

```json
{
  "code": "COD_AGENT_EXPOSURE_EXCEEDED",
  "details": {
    "currentExposure": 480000,
    "additionalAmount": 60000,
    "effectiveLimit": 500000,
    "poolBinds": true
  }
}
```

| `poolBinds` | Tell the dispatcher |
|---|---|
| `false` | Your slice is the limit. Raise it (`/cod-limit`) or wait for the agent to deposit cash |
| `true` | **The agent's own pool** is the limit, not your slice. Raising your slice will not help; the agent must deposit cash, or their pool must go back up |

Additive field. An old client ignores it safely.

---

## `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM`: new hint text

Same code, status and `details` keys (`requested`, `headroom`, `shortfall`, `hint`). The `hint`
string was reworded to describe the automatic pool. **Display `hint`; never parse it.**

---

## Checklist

- [ ] On `COD_AGENT_EXPOSURE_EXCEEDED`, branch the explanation on `details.poolBinds`
- [ ] Remove any copy telling agencies to "ask the platform to set the agent's COD limit"
- [ ] Make sure `hint` strings are displayed as-is, not matched
