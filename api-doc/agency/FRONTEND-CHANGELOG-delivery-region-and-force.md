# Agency app — `force` now covers the region (2026-10-02)

Cross-role context: [../FRONTEND-CHANGELOG-delivery-region-and-force.md](../FRONTEND-CHANGELOG-delivery-region-and-force.md).

## `force: true` waives one more refusal

`PATCH /api/agency/shipments/:id/assign-agent` and `POST /api/agency/shipments/:id/reassign` (with
an `agentId`) already took `force: true` for `422 COD_AGENT_EXPOSURE_EXCEEDED`. It now also waives
**`422 CONTRACT_COVERAGE_REGION_NOT_COVERED`**: you can send your own contracted agent to a delivery
outside the regions their contract lists.

When you get that code, show `details.deliveryRegion` and `details.coveredRegions` and offer
**"Send anyway"**, which resends with `force: true`.

Still never waived: no active contract, the value ceiling, KYC / trust / cash shortfall, and the
eligibility rules (offline, at capacity, tracking off).

## Two new offer fields

- `offer.coverageForced: { byUserId, byRole, at } | null`: you sent this offer outside the agent's
  regions.
- `offer.adminOverride: { byName, reason, at } | null`: a platform administrator pushed this offer
  past the eligibility rules. You cannot set it; show it.

## Fewer stuck deliveries

Deliveries whose region was spelled differently from your contracts (`"Centre Region"` vs
`centre`) now match without forcing. Shipments stuck for that reason can simply be auto-assigned
again.

Full reference: [assignment.md → Forcing an offer](./assignment.md).

## Headquarters addresses: region is validated

A **new or edited** headquarters address (onboarding and `PATCH` of the magazin) must name a
region of your country, directly or by its city, or the save is refused with
`400 ADDRESS_REGION_INVALID`. `details.index` / `details.label` name the entry and
`details.allowedRegions` is the picker: set that entry's `geo.components.region` to the picked
`key` and resend. Unchanged entries still save. The stored `region` is the canonical name
(`"Centre"`). Reference: [magazin.md](./magazin.md).
