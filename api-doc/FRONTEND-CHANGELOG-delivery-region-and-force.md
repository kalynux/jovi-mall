# Delivery regions are validated · forced pushes to agents and agencies — 2026-10-02

**Not deployed yet.** Cross-role page; each app has its own:
[customer](./customer/FRONTEND-CHANGELOG-delivery-region-and-force.md) ·
[vendor](./vendor/FRONTEND-CHANGELOG-delivery-region-and-force.md) ·
[agency](./agency/FRONTEND-CHANGELOG-delivery-region-and-force.md) ·
[agent](./agent/FRONTEND-CHANGELOG-delivery-region-and-force.md) ·
[admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-delivery-region-and-force.md).

## The bug

A customer's drop-off was stored with region `"Centre Region"` (what the geocoder returned). Every
agent contract covering that area said `centre`. The two never matched, so the delivery was never
offered to any agent, and the agency could not push it through either.

## What changed

| # | Change | Who sees it |
|---|---|---|
| 1 | Region matching sees through spellings: `"Centre Region"`, `"Région du Centre"`, `"Center"`, `"North West"`, `"Adamawa"` all match their region. **Existing orders benefit immediately**: nothing is re-saved, the comparison changed | Nobody has to do anything |
| 2 | A customer address must name one of its country's regions (directly or by its city), or the save is refused with `400 ADDRESS_REGION_INVALID` and a list of regions to pick from. The stored region becomes the canonical name (`"Centre"`) | Customer app, website, bot |
| 2b | The same rule for pickup addresses: a **new or edited** vendor business address or agency headquarters address must name a real region, or `400 ADDRESS_REGION_INVALID` (with `index`/`label` naming the entry). Untouched old entries still save | Vendor app, agency app |
| 3 | The agency's `force: true` on assign/reassign now also waives `CONTRACT_COVERAGE_REGION_NOT_COVERED` (it already waived the COD amount limit) | Agency app |
| 4 | Administrators, at every tier, can push a shipment to an agent past every eligibility check except an active contract with the agency, and move a shipment to another agency past the inactive-agency and COD-limit checks | Admin dashboard |
| 5 | Offers carry `coverageForced` and `adminOverride` | Agent app, agency app |

New error codes: `ADDRESS_REGION_INVALID` (400), `DELIVERY_AGENCY_NOT_ACTIVE` (422, admin only).
See [errors/README.md](./errors/README.md) → "Delivery regions and forced pushes".
