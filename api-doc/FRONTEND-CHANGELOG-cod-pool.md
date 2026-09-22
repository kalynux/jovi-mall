# COD pool from the plan, and the agent's emergency contact for administrators — cross-role

> **Date:** 2026-09-21 · **Breaking:** one endpoint, admin dashboard only (a required `reason`)

This page is the rule and the map. Each app's page has the endpoint detail.

| App | Page | What it has to do |
|---|---|---|
| **Agent app** | [agent/FRONTEND-CHANGELOG-cod-pool.md](./agent/FRONTEND-CHANGELOG-cod-pool.md) | Show where the pool comes from; new "carry less" control (`PUT /api/agent/cod/pool`); plan cards show `max_cod_pool`; emergency-contact visibility notice |
| **Agency app** | [agency/FRONTEND-CHANGELOG-cod-pool.md](./agency/FRONTEND-CHANGELOG-cod-pool.md) | Branch the COD refusal copy on `details.poolBinds` |
| **Landing** | [public/FRONTEND-CHANGELOG-cod-pool.md](./public/FRONTEND-CHANGELOG-cod-pool.md) | Show `max_cod_pool` on the agent tier cards |
| **Admin dashboard** | [admin/api-doc/FRONTEND-CHANGELOG-agent-cod-pool-and-emergency-contact.md](../../admin/api-doc/FRONTEND-CHANGELOG-agent-cod-pool-and-emergency-contact.md) | ⚠ Send `reason` when pinning a pool; new release action; show the emergency contact, the pool's source and the pin |
| Vendor dashboard · customer app · geo-tracker clients | none | Nothing to do |

---

## The rule (owner decision, 2026-09-21)

An agent's **COD pool** is the most cash-on-delivery money they may carry across every agency.
Each agency's COD limit is a slice of it.

```
ceiling = 0                       while the agent's identity (KYC) is not verified
        = an administrator's pin   when one is set, above or below the plan
        = plan.max_cod_pool        otherwise (Free 500 000 · Plus 1 000 000 · Pro 2 000 000 XAF)

pool    = anywhere from 0 up to the ceiling. The agent may lower it; a change of ceiling resets it.
```

- **Automatic.** Verification opens the pool from the plan, a plan change resets it, and
  withdrawn verification closes it. Nobody has to type a number any more (until today an
  administrator had to, and a pool nobody had set stayed at 0).
- **A plan's `max_cod_pool: null` means NO COD**, not unlimited. It is the one plan limit that fails
  closed, because it is cash.
- **The pool is now also a hard cap at dispatch.** The effective COD limit is
  `min(the agency's slice, the agent's pool) × trust`. This only makes a difference after an agent's
  pool went down below slices agencies already hold (`overAllocatedBy > 0`, `poolBinds: true`).
- `pool.source` (`plan` · `override` · `not_verified`) is a **label**. No client may branch business
  logic on it; the rule lives on the server.

## The emergency contact (owner decision, 2026-09-21)

The emergency contact an agent enters in the agent app (`emergency_contact: { name, phone }`) is now
shown to **platform administrators** on the agent's detail page. It is still never on a list,
and never shown to agencies, vendors or customers. The agent app should tell the agent this.

## Operations note (deploy day)

Agents that existed before this change carry no pool provenance (`pool.syncedAt: null`) and keep
their old pool until the first sync. The nightly worker `agent-cod-pool-reconcile` (04:30,
`AGENT_COD_POOL_RECONCILE_CRON`) converges them. **Trigger it once by hand right after deploying**
(admin dashboard → dev tools → workers). ⚠ A pool an administrator had set by hand under the old
model is **replaced** by the plan's value on that first sync. There is no way to tell a deliberate
old value from a default one. Re-apply it as a pin if it mattered.
