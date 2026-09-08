# Storage statements (vendor side)

**Verified against source on 2026-09-08** — R7 confirmed the vendor side is exactly the two read routes (`modules/inventory/storage-invoice.routes.ts:64,67` — no settle, void or dispute verb on this router), the three-value status filter (`controllers/storage-invoice.controller.ts:17`, matching the stored enum at `models/agency-storage-invoice.model.ts:10,112`) and the 404-never-403 rule (`controllers/storage-invoice.controller.ts:75,136`). No defects found.

What each delivery agency says you owe it for warehousing your stock, per month.

> The full contract — how a statement is produced, what its quantities mean, and why the
> platform does not move this money — is [the agency's page](../agency/storage-invoices.md).
> This page is the read-only half you can reach.

## Base Path
```
/api/vendor/storage-invoices
```

## Authentication
Bearer token (or cookie session) with the **vendor** role. Every query is scoped to the
caller; there is no `vendorId` in any path, and one supplied in the query string is ignored.

---

> [!IMPORTANT]
> **Nothing here charges you.** The platform records what an agency says it is owed; it does
> not collect it, and it takes no commission on it. You pay the agency the way you already
> do. A statement marked `settled` means **the agency** has said it was paid.

---

## Endpoints

| | |
|---|---|
| `GET /` | your statements, from every agency |
| `GET /:id` | one statement, with every line |

Both return exactly the shapes documented on the agency page. `agencyId` is on every row —
a vendor storing with two agencies gets statements from both, and they are not merged.

| Query | |
|---|---|
| `page` · `limit` | pagination, `limit` ≤ 100 |
| `status` | `open` · `settled` · `void` |
| `periodKey` | `YYYY-MM` |

An id belonging to somebody else answers `404 STORAGE_INVOICE_NOT_FOUND`, never a 403 —
whether a given statement exists is not information you are owed about another vendor.

---

## What you cannot do here

- **Settle.** That is the agency stating it received your money.
- **Void.** Same.
- **Dispute.** There is deliberately no such verb: the platform is not a party to this
  money, so a dispute recorded here would be a state nobody could resolve. Take it up with
  the agency — and note the numbers you are both looking at are the same ones, which is what
  this record is for.

## Reading a statement

The quantity on each line is what was **physically on the agency's shelf** when the
statement was issued — not your catalogue quantity for that SKU. The two are separate
numbers and are allowed to differ; see
[the agency page § 5](../agency/storage-invoices.md#5-how-a-statement-is-produced).
