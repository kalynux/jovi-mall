# Agency dashboard: an administrator can switch your cash on delivery off

**2026-10-10 · not deployed yet · additive.** Nothing changes for an agency nobody restricted.

## What it is

An administrator can switch cash on delivery off for one agency, and back on. While it is off:

- customers cannot choose cash on delivery for a basket this agency would carry;
- no new cash-on-delivery shipment is handed to this agency (a vendor cannot force one through).

What does **not** change: shipments the agency already holds (cash on delivery included) run to
the end, agents keep collecting on them, deposits and remittances work as before, prepaid
shipments keep arriving, and the agency's own COD settings and cash limit are left exactly as they
were. When the restriction is lifted, everything is back to what the agency had configured.

## What you receive

`GET /api/agency/cod/limit` gains two fields:

```json
{
  "agencyId": "…",
  "limit": 1000000,
  "source": "default",
  "exposure": { "inFlight": 0, "collectedUnremitted": 250000, "total": 250000 },
  "headroom": 750000,
  "overLimit": false,
  "codRestricted": true,
  "codRestrictedAt": "2026-10-10T09:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `codRestricted` | `true` while an administrator has switched cash on delivery off for this agency |
| `codRestrictedAt` | when; `null` when not restricted |

When `codRestricted` is `true`, show a banner on the COD screen, for example: *"Cash on delivery
is paused for your agency by Wi-Mall. You will not receive new cash-on-delivery shipments. Contact
support for details."* `headroom` is still reported but no longer means "room for new COD work".

The agency's own `policies.cod.enabled` switch still reads whatever the agency set. Do not show it
as off because of the restriction, and do not let toggling it suggest it lifts the restriction.

## What you are not told

The reason and who set it. They are the administrator's and no agency endpoint returns them.

## Not built

The agency is **not notified** when the restriction is set or lifted; the banner above is how it
finds out. This is an open owner decision.

## Checklist

- [ ] Banner on the COD screen when `codRestricted` is `true`
- [ ] Do not present `headroom` as available COD capacity while restricted
