# Vendor app — business address region is validated (2026-10-02)

Cross-role context: [../FRONTEND-CHANGELOG-delivery-region-and-force.md](../FRONTEND-CHANGELOG-delivery-region-and-force.md).

Business addresses are pickup points, so they now follow the same region rule as customer
drop-offs.

## One new error to handle: `400 ADDRESS_REGION_INVALID`

Returned by the two routes that save `business_addresses` (onboarding Step 3 and the profile
`PATCH`) when a **new or edited** entry names no region of the vendor's country: neither
`geo.components.region` (`"Centre Region"` and `"Région du Centre"` are fine) nor its city
(`"Yaoundé"` → Centre) matches. Entries you echo back unchanged are never refused.

```json
"details": {
  "index": 1, "label": "Warehouse",
  "region": "Mars", "city": "Nowhere", "countryCode": "CM",
  "allowedRegions": [{ "key": "centre", "name": { "en": "Centre", "fr": "Centre" } }, "…"]
}
```

**What to build:** highlight the address at `details.index`, show a region picker from
`details.allowedRegions` (label `name[locale]`), set that entry's `geo.components.region` to the
picked **`key`**, and resend the whole list.

## One visible change

Stored `geo.components.region` and `state` become the canonical name (`"Centre"`). Display them as
returned, and keep echoing `geo` back unchanged on untouched entries as before.

Reference: [onboarding.md Step 3](./onboarding.md#step-3-branding-optional--skippable) ·
[profile.md](./profile.md).
