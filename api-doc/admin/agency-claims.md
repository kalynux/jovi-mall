# Admin — damage claims on an agency (`/api/internal/admin/agency-claims`)

> **Caller: wi-admin only.** Service-to-service, behind `requireAdminCaller`. No public twin.
> Design record: `../PRODUCTION-READINESS/REFUND-FEES-AND-AGENCY-LIABILITY-PLAN.md` § 4.4 (owner
> decision F-8, 2026-10-22).

A **damage claim** charges a delivery agency for **one parcel** damaged in delivery. It is allowed only:

- **inside the agency's own window**: its damage-claim deadline (`policies.damage.claim_deadline_days`)
  counted from **its parcel's** delivery, and at least the 3-day protection window when it pays
  returns. The problem is dated by the **earliest** of the order's own customer's problem report
  (about the order or the parcel), the refund request it follows (`refundRequestId`), or now;
- **up to its own limit**: `policies.damage.max_refund_per_item × itemCount`. An agency that set no
  per-item limit cannot be claimed against.

Applying a claim, in **one transaction**:

| Who | What |
|---|---|
| **Agency** | charged `amount + investigation_fee`: first its own shares of that parcel (held, then each share's reserve slice and available), then its available balance, then **debt**. Its **rider is never charged**. |
| **Vendor** | credited `amount` — they carried the broken goods — as an earnings share (`source_type: 'agency_claim'`) the nightly sweep releases, paying the vendor's debt first. |
| **Platform** | credited the investigation fee the same way. |

Every movement is an `earnings_adjustments` row with `reason_code: 'damage_claim'`, the sentence
the agency reads, and `agency_claim_id`. **One claim per parcel** (unique index). Claims are
append-only: never edited or deleted.

---

## `GET /eligibility?shipmentId=&refundRequestId=`

Read-only. Whether a claim on this parcel is possible now, and its limits.

```jsonc
{
  "shipmentId": "…", "orderId": "…", "orderNumber": "ORD-2026-000123", "trackingNumber": "TRK-…",
  "agencyId": "…", "vendorId": "…", "currency": "XAF",
  "deliveredAt": "2026-10-20T09:00:00.000Z",   // its own parcel's delivery; null = not delivered
  "firstProblemAt": "2026-10-21T08:00:00.000Z",// the order's own customer's earliest problem report, or null
  "raisedAt": "2026-10-21T08:00:00.000Z",      // what a claim made now counts as raised at
  "windowDays": 2, "windowEndsAt": "2026-10-22T09:00:00.000Z", "insideWindow": true,
  "maxPerItem": 5000, "investigationFee": 1000,
  "existingClaimId": null,
  "eligible": true,
  "reason": null   // not_delivered · no_agency · no_per_item_limit · outside_window · already_claimed
}
```

`404 SHIPMENT_NOT_FOUND`.

## `POST /`

```jsonc
{
  "shipmentId": "…",          // required
  "itemCount": 1,             // required, 1..1000
  "amount": 5000,             // required, whole XAF, ≤ maxPerItem × itemCount
  "note": "Screen cracked; photos on ticket T-…",   // required, 3..1000 — read by the next administrator
  "refundRequestId": "…"      // optional: the refund it follows (its opening date can start the window)
}
```

Strict: an unknown key is a `400`. The actor is `X-Actor-Id` / `X-Actor-Name`. **`201`**, `data` =
the claim (below).

| Status | Code | When |
|---|---|---|
| 404 | `SHIPMENT_NOT_FOUND` | no such parcel |
| 409 | `AGENCY_CLAIM_EXISTS` | the parcel already has a claim (`details.claimId`) |
| 422 | `AGENCY_CLAIM_OUTSIDE_WINDOW` | raised after the agency's window (`details`: `deliveredAt`, `raisedAt`, `windowDays`, `windowEndsAt`) |
| 422 | `AGENCY_CLAIM_EXCEEDS_CAP` | above `maxPerItem × itemCount` (`details`: `claimed`, `cap`, `maxPerItem`, `itemCount`) |
| 422 | `AGENCY_CLAIM_NOT_ELIGIBLE` | not delivered, no agency, no per-item limit, or a non-positive amount (`details.reason`) |

## `GET /` and `GET /:id`

List (newest first; filters `agencyId`, `vendorId`, `shipmentId`; `page`, `limit` ≤ 100) and one
claim. The administrator's shape:

```jsonc
{
  "id": "…", "kind": "damage",
  "shipmentId": "…", "orderId": "…", "orderNumber": "ORD-…", "trackingNumber": "TRK-…",
  "agencyId": "…", "vendorId": "…", "refundRequestId": null,
  "itemCount": 1, "claimedAmount": 5000, "maxPerItem": 5000, "cap": 5000,
  "amount": 5000, "investigationFee": 1000, "currency": "XAF",
  "deliveredAt": "…", "raisedAt": "…", "windowDays": 2,
  "note": "Screen cracked…", "createdBy": { "id": "<wi-admin id>", "name": "Alice" },
  "reasonCode": "damage_claim",
  "reasonParams": { "itemCount": 1, "maxPerItem": 5000, "amount": 5000, "investigationFee": 1000, "windowDays": 2, … },
  "explanation": "Damage claim on order ORD-…, parcel TRK-…: 1 item(s) damaged in delivery, reported on 2026-10-21, within your 2-day damage-claim window. Your terms allow up to 5,000 XAF per item, so 5,000 XAF was charged, plus your investigation fee of 1,000 XAF.",
  "takenFrom": { "pending": 1500, "reserve": 0, "available": 0, "debt": 4500 },
  "createdAt": "…"
}
```

The agency and the vendor read the same claim **without** `note`, `createdBy`, `claimedAmount`,
`takenFrom`, `agencyId`, `vendorId` and `refundRequestId`:
`GET /api/agency/earnings/claims`, `GET /api/vendor/earnings/agency-claims`.
