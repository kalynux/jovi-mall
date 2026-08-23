# Storage statements

The monthly record of what a vendor owes this agency for warehousing their stock. One
statement per (agency, vendor, month).

> Related docs: [Inventory](./inventory.md) (the shelves being billed) ·
> [Magazin](./magazin.md) (the depots) · [Onboarding](./onboarding.md#pricing-policies)
> (where `monthly_storage_fee_per_sku` is set) ·
> [Vendor side](../vendor/storage-invoices.md).

## Base Path
```
/api/agency/storage-invoices
```

## Authentication
Bearer token (or cookie session) with the **agency** role. Identity flows token → agency;
there is no `agencyId` in any path, and every query is scoped to the caller.

---

> [!IMPORTANT]
> ## No money moves. This is a record.
>
> The platform does **not** charge the vendor, does **not** pay the agency, and takes no
> commission on storage rent. `monthly_storage_fee_per_sku` is still excluded from every
> per-order earnings split — it is rent, not a delivery fee.
>
> What the statement buys is that both sides read **the same number**, that it is durable
> and dated, and that "has this been paid" has somewhere to live. `settle` is you stating
> that the vendor paid you out of band. Nothing verifies it, and the vendor sees that you
> said so.
>
> Design record: `PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md` D-7.

---

## Endpoints

| | |
|---|---|
| [`GET /`](#1-list) | your statements |
| [`GET /:id`](#2-detail) | one statement, with every line |
| [`POST /:id/settle`](#3-settle) | the vendor paid it |
| [`POST /:id/void`](#4-void) | it was issued in error |

---

## 1. List

`GET /api/agency/storage-invoices?page=1&limit=20&status=open&periodKey=2026-08&vendorId=…`

Newest period first. **Lines are not included** — a year of statements with every line
expanded is a payload nobody reads; `skuCount` and `unitCount` are what a list row shows.

```json
{
  "success": true,
  "data": [
    {
      "id": "665f…",
      "agencyId": "665f…",
      "vendorId": "665f…",
      "periodKey": "2026-08",
      "periodStart": "2026-08-01T00:00:00.000Z",
      "periodEnd": "2026-09-01T00:00:00.000Z",
      "skuCount": 14,
      "unitCount": 412,
      "monthlyRatePerSku": 500,
      "total": 206000,
      "status": "open",
      "issuedAt": "2026-09-01T02:00:04.117Z",
      "settledAt": null,
      "note": null
    }
  ],
  "meta": { "total": 6, "page": 1, "limit": 20, "totalPages": 1 }
}
```

| Query | |
|---|---|
| `status` | `open` · `settled` · `void` |
| `periodKey` | `YYYY-MM` |
| `vendorId` | one vendor's statements |

---

## 2. Detail

`GET /api/agency/storage-invoices/:id` — the same object plus `lines`:

```json
{
  "lines": [
    {
      "stockLevelId": "665f…",
      "productId": "665f…",
      "variantId": "665f…",
      "sku": "TSHIRT-BLU-M",
      "productTitle": "Cotton t-shirt",
      "locationId": "665f…",
      "locationLabel": "Bonabéri depot",
      "quantity": 40,
      "monthlyRatePerSku": 500,
      "lineTotal": 20000
    }
  ]
}
```

Every value on a statement is **frozen at issue** — the rate, the quantities, the SKU
labels, the depot names. Raising your rate does not restate a month a vendor has already
paid, and a vendor renaming a SKU does not rewrite last month's statement.

---

## 3. Settle

`POST /api/agency/storage-invoices/:id/settle`

```json
{ "note": "bank transfer ref 88213" }
```

Compare-and-set from `open`. A statement already settled or voided answers
**`409 STORAGE_INVOICE_NOT_OPEN`** — never a 404: it is right there, it is just not in that
state. An id that is not yours answers `404 STORAGE_INVOICE_NOT_FOUND`.

There is deliberately no un-settle. If you settled the wrong one, void is not the remedy
either — voiding says the statement was wrong, not that the payment was. Raise it with the
vendor.

---

## 4. Void

`POST /api/agency/storage-invoices/:id/void`

```json
{ "reason": "duplicate of the August statement" }
```

`reason` is **required**. The statement is kept, never deleted — a missing month is
indistinguishable from a month nobody billed, and this record is what tells them apart.
Same `409` on anything not `open`.

⚠ Voiding does **not** re-open the month for re-issue. The identity of a statement is
`(agency, vendor, month)` and a voided row still holds it, so the monthly run will report
that month as already issued. That is deliberate: two statements for one month is exactly
the confusion this is meant to prevent.

---

## 5. How a statement is produced

A scheduled run on the **1st at 02:00** issues the previous month for every agency that
offers warehousing.

- **Only counted stock is billed.** A shelf you have never recorded a receipt on has no
  quantity the platform is willing to claim, so it is not on the statement at all. An
  agency that records no intake is invoiced for nothing — see
  [Inventory § 6](./inventory.md#6-counting-what-is-on-the-shelf).
- **Only agencies with `storage_based.enabled`** get statements. No rate was ever agreed
  otherwise, and a zero-total statement would imply one exists.
- **The quantity is what was on the shelf when the statement was issued** — not an average
  over the month. The platform keeps no daily snapshot of a shelf, and inferring an average
  from the movement ledger is a bigger feature than this one. It is stated here rather than
  left to be inferred, because "we billed you for 40 units" is a claim a vendor will check.
- **Months are UTC calendar months.** Every instance that computes a period has to agree on
  which month it is, or the same statement is issued twice under two names. The cost is a
  few hours of skew at the start and end of a month for an agency far from UTC.
- **Re-running issues nothing twice.** The generator upserts on (agency, vendor, month), so
  a restart mid-run, a manual re-trigger and two instances all converge on one statement.

---

## 6. Not built

1. **No payment path.** See the callout at the top — this is the deliberate design, not a
   gap waiting to be filled.
2. **No reminders.** Nothing chases an `open` statement, on either side.
3. **No dispute verb for the vendor.** The platform is not a party to this money, so a
   dispute it recorded would be a state nobody here could resolve.
4. **No monthly average.** See § 5.
