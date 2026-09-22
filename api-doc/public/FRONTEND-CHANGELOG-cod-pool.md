# Landing — agent plans now publish their COD pool

> **Date:** 2026-09-21 · **Audience:** the marketing landing page (pricing section) · **Breaking:** no
>
> Cross-role summary: [../FRONTEND-CHANGELOG-cod-pool.md](../FRONTEND-CHANGELOG-cod-pool.md)

The public plan catalogue ([README.md](./README.md), `role=agent`) has one new field on every plan:

| Field | Type | Meaning |
|---|---|---|
| `max_cod_pool` | `number \| null` | **Agent plans only.** The cash-on-delivery money (XAF) an agent on this tier may carry once their identity is verified. `null` on every vendor and agency plan |

Seeded values: **Agent Free 500 000 · Agent Plus 1 000 000 · Agent Pro 2 000 000.** (Plus and Pro
are `is_active: false` today, so they only appear with `includeInactive=true`.)

**Render it on the agent tier cards** next to the delivery cap, for example "Carry up to 500 000 XAF in
cash-on-delivery payments". Add a footnote that it applies after identity verification.

⚠ **`null` means "no cash on delivery", never "unlimited".** That is the opposite of
`max_unterminated_shipments`, where `null` does mean unlimited. Don't share one formatter between
the two.
