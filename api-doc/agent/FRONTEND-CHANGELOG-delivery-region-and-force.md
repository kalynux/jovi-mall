# Agent app — two new offer fields (2026-10-02)

Cross-role context: [../FRONTEND-CHANGELOG-delivery-region-and-force.md](../FRONTEND-CHANGELOG-delivery-region-and-force.md).

Offers (`GET /api/agent/offers`, `GET /api/agent/offers/:id`) gain two nullable fields, beside the
existing `codLimitForced`:

| Field | Meaning | Suggested UI |
|---|---|---|
| `coverageForced: { byUserId, byRole, at } \| null` | Your agency sent you this delivery although it is outside the regions in your contract | A note: "Outside your usual regions" |
| `adminOverride: { byName, reason, at } \| null` | A Wi-Mall administrator assigned you this delivery directly, past the usual checks (for example while you were offline or at full capacity) | A note with `reason` |

Accepting works as before. A forced offer can be accepted even when the rule it skipped would
otherwise refuse; for an administrator's offer, that includes being at full capacity. The
`shipment.offer_created` event carries `coverageForced` and `adminOverride` as booleans.
