# Vendor dashboard: a delivery agency can be barred from cash on delivery

**2026-10-10 · not deployed yet · additive.** Nothing changes for agencies nobody restricted.

## What it is

An administrator can switch cash on delivery off for one delivery agency, and back on. While it is
off, that agency receives **no new cash-on-delivery shipment**. Parcels it already holds carry on
to the end, and prepaid shipments are not affected at all.

For the vendor this shows up in three places.

## 1. A new hold kind on a pending shipment

`codLimitHold.kind` (order detail and list) gains a third value:

| `kind` | Meaning | What the vendor can do |
|---|---|---|
| `agency_limit` | the agency is at its cash limit | wait, change agency, or **dispatch anyway** (`force: true`) |
| `vendor_terms` | your own per-agency cap | wait, raise the cap, or **dispatch anyway** |
| **`agency_restricted`** (new) | the agency cannot take cash-on-delivery shipments at the moment | **change agency only**. Hide "dispatch anyway" |

For `agency_restricted`, `limit` is `0` and the amounts are not meaningful: do not render a
"X of Y used" line for it.

It is written when auto-redirect is on and a paid cash-on-delivery order would have gone to a
restricted agency: the shipment stays `pending`, and the existing `shipment.cod_limit_held`
notification is sent with the sentence "the agency cannot take cash-on-delivery orders at the
moment — choose another agency for it".

## 2. A new refusal on manual dispatch and on change-agency

`POST …/dispatch` (single and bulk) and the change-agency endpoint can answer:

```json
{ "success": false, "error": { "code": "COD_AGENCY_RESTRICTED", "statusCode": 422,
  "category": "business_rule",
  "details": { "kind": "agency_restricted", "agencyId": "…", "shipmentId": "…",
               "hint": "This delivery agency cannot take cash-on-delivery shipments at the moment. Choose another agency for these items; force does not apply." } } }
```

⚠ **`force: true` does not get past this one.** It is a different code from
`COD_AGENCY_LIMIT_EXCEEDED` on purpose: do not offer a "dispatch anyway" retry. Offer the
change-agency flow. Nothing of the order is dispatched when it is returned.

A prepaid order to the same agency dispatches normally.

## 3. Customers stop seeing cash on delivery for that agency's baskets

While the agency is restricted, checkout refuses cash on delivery for a basket whose shipments it
would carry (the customer sees the existing "cash on delivery not available" for your shop). If
your products point at that agency, your cash-on-delivery sales stop until you move them to another
agency or the restriction is lifted.

## What you are not told

The reason. It is the platform's note about another business and no vendor endpoint returns it.

## Checklist

- [ ] `codLimitHold.kind === 'agency_restricted'`: own copy, no amounts, no "dispatch anyway"
- [ ] Handle `422 COD_AGENCY_RESTRICTED` on dispatch, bulk dispatch and change-agency: route to change-agency, never retry with `force`
