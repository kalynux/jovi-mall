# Customer app / website — address region is validated (2026-10-02)

Cross-role context: [../FRONTEND-CHANGELOG-delivery-region-and-force.md](../FRONTEND-CHANGELOG-delivery-region-and-force.md).

## One new error to handle: `400 ADDRESS_REGION_INVALID`

Returned by:

- `POST /api/customer/addresses`
- `PATCH /api/customer/addresses/:id` (when `geo` is sent)
- checkout, when the inline `delivery.address` or the saved address it uses names no region

It happens only when **neither** `geo.components.region` **nor** `geo.components.city` names a
region of the address's country. Most addresses pass: `"Centre Region"`, `"Région du Centre"` and
`"Yaoundé"` (by city) all resolve.

```json
"details": {
  "region": "Mars", "city": "Nowhere", "countryCode": "CM",
  "addressId": "664addr…",
  "allowedRegions": [{ "key": "centre", "name": { "en": "Centre", "fr": "Centre" } }, "…"]
}
```

**What to build:** a region picker from `details.allowedRegions` (label `name[locale]`). Resend the
same request with `geo.components.region` set to the picked **`key`** (e.g. `"far_north"`).
When `addressId` is present the problem is a saved address; offer to edit it.

## One visible change

The stored `geo.components.region` and `state` are now the region's canonical English name
(`"Centre"`, `"Far North"`), not the geocoder's text. Show them as they come.

Full reference: [profile.md → Region](./profile.md#region).
