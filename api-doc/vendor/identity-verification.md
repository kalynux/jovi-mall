# Vendor Identity Verification

**Written against source on 2026-09-14** — routes and guards against
`src/modules/identity-verification/routes/kyc.routes.ts` and `src/api/index.ts`; the slot table
against `domain/kyc-subject.ts`; the payload against `dto/kyc.dto.ts`; the lock against
`services/kyc-submission.service.ts`; the file rules against
`core/uploads/upload-config.ts` (`getKycDocumentUploadConfig`); and the privacy verdict against
`core/storage/storage-trees.ts` (`kyc: 'private'`).

Base path: **`/api/vendor/kyc`**

The documents an administrator looks at when deciding whether to verify the shop. Before this
existed, the only thing a vendor could submit was a national ID **number** typed into a text
box, which nobody could check against anything — so a verification decision was a guess.

> Related: [Profile](./profile.md) (where `business_addresses` are edited) ·
> [Store](./store.md) · [File management](./file-management.md) ·
> [Onboarding](./onboarding.md) — **verification is not an onboarding step**; it can be
> submitted at any time and does not gate the dashboard.

## Authentication

Bearer token or cookie session with the **vendor** role. **There is no vendor id in any path** —
every route is scoped to the calling vendor's own record. There is no way to read or write
somebody else's documents, by design: the payload is a photograph of a person holding their
identity card.

---

## ⚠ Nothing is required, and that is deliberate

You can save one field and submit. You can submit an empty record. **Every field on every
endpoint is optional and the API enforces no completeness rule anywhere**, including on
`POST /submit`.

This is a decision, not a gap. The required/optional rules are a *review policy* and they live
in the administration dashboard, which uses them to show the reviewer an estimated verdict and a
pre-filled rejection reason. A backend that refused an incomplete submission would also take
away the only useful outcome of a review: a human telling the vendor what is missing.

**What that means for your UI.** You own the "you still need X" guidance. The table below is the
rule the reviewers apply — implement it client-side as guidance, and let the vendor submit
anyway if they insist. They will simply be rejected with a reason, and can resubmit.

### What the administrator checks

| What they check | Where it comes from | Rule |
|---|---|---|
| The store address on the account is valid (geocoded) | `business_addresses[].geo` — edited on [the profile](./profile.md), **not here** | optional |
| The home address is valid (geocoded) | `homeAddress` | **required only if the vendor has no physical store** |
| A scan of the ID card, front and back | `id_card_front`, `id_card_back` | required |
| The ID number | `idNumber` | required |
| A selfie holding the ID card | `selfie_with_id` | required |
| A hand-drawn screenshot of the home address location | `home_address_sketch` | **required only if the vendor has no physical store** |
| A hand-drawn screenshot of the store address location | `store_address_sketch` | **required only if a store address is set up** |

> The two conditional rows are the reason a vendor working from home is not asked for a shop
> sketch, and a vendor with a shop is not asked where they live. Decide "has a physical store"
> however your screen decides it — the backend does not model the question.

---

## The lifecycle, and when the record freezes

```
  draft  ──POST /submit──▶  under review  ──▶ verified   (frozen, permanently)
    ▲                                     │
    └──────────── rejected ◀──────────────┘   (unfrozen — fix and resubmit)
```

The read returns `locked`, which is the only field you need to decide whether to disable the
form:

| `status` | `submittedAt` | `locked` | Meaning |
|---|---|---|---|
| `pending` | `null` | `false` | Draft. Nobody has looked. Edit freely. |
| `pending` | set | `true` | Under review. Every write answers `409 KYC_LOCKED`. |
| `verified` | set | `true` | Approved, and frozen for good — an approved ID card must not be swappable. Changing it is a support request. |
| `rejected` | set | `false` | Refused. `rejectionReason` says why; edit and submit again. |

> ⚠ **`status: "pending"` does not mean "waiting for review".** It is the schema default, so it
> also means *"never touched"*. `submittedAt` is what tells them apart. If your screen shows a
> status pill, derive it from both.

Resubmitting clears `rejectionReason` (the old text describes documents that have been replaced)
and re-stamps `submittedAt`. The **verdict** stays `rejected` until an administrator moves it —
a vendor cannot approve themselves.

---

## Endpoints

### `GET /api/vendor/kyc`

The whole record. Safe to call at any time; returns a fully-formed empty record for a vendor who
has never touched verification.

```jsonc
{
  "success": true,
  "data": {
    "role": "vendor",
    "status": "pending",
    "submittedAt": null,
    "locked": false,
    "rejectionReason": null,
    "verifiedAt": null,

    "idNumber": "1084563219",

    "homeAddress": {
      "label": "Home",
      "formattedAddress": "Bonapriso, Douala, Littoral, Cameroon",
      "coordinates": [9.7043, 4.0286],   // ⚠ [lng, lat] — GeoJSON order, not [lat, lng]
      "provider": "locationiq",
      "geocoded": true
    },

    "documents": {
      "idCardFront":  { "id": "66f…a1", "key": "kyc/2026/09/…jpg", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 842113, "originalName": "cni-recto.jpg" },
      "idCardBack":   null,
      "selfieWithId": null,
      "vehicleWithAgent": null,            // always null for a vendor
      "homeAddressSketches":  [],
      "storeAddressSketches": [ { "id": "66f…c1", "url": null, "access": "authorized", "mimeType": "application/pdf", "size": 220144 } ]
    },

    "limits": { "multiSlotMaxFiles": 10 }
  }
}
```

> `storeAddresses` and `review` appear only on the administrator's copy of this payload. A
> vendor reads their own shop addresses from [the profile](./profile.md).

---

### `PATCH /api/vendor/kyc`

The typed half. Both fields optional; both **clearable** — send `""` or `null` to remove a value
(the platform's usual PATCH convention), omit the key to leave it alone.

| Field | Type | Notes |
|---|---|---|
| `idNumber` | string, 1–64 chars, or `null` | The national identity number as printed on the card. **No format check** — Cameroonian ID formats have changed more than once and a regex derived from today's cards would silently refuse a valid older one. It is checked against the scans, by a person. |
| `homeAddress` | a selected `GET /api/geo/search` result, or `null` | The full candidate object, not a string. See [Geo](../geo/README.md). |

```json
{
  "idNumber": "1084563219",
  "homeAddress": {
    "formatted_address": "Bonapriso, Douala, Littoral, Cameroon",
    "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0286] },
    "provider": "locationiq",
    "provider_place_id": "…",
    "components": { "city": "Douala", "region": "Littoral", "country_code": "CM" },
    "raw_input": "bonapriso douala"
  }
}
```

Returns the whole record, exactly as `GET` does.

> ⚠ Send the candidate the geocoder returned, unmodified. `geocoded: true` on the way back
> **is** the administrator's badge for "this address is valid" — a hand-assembled object with
> made-up coordinates passes that check and fails the human one.

---

### `POST /api/vendor/kyc/documents/:slot`

`multipart/form-data`, field name **`documents`**. Returns `201` with the whole record.

| Slot | Cardinality | What it is |
|---|---|---|
| `id_card_front` | **one** — re-uploading replaces | Scan or photo of the front of the ID card |
| `id_card_back` | **one** — re-uploading replaces | The back of the same card |
| `selfie_with_id` | **one** — re-uploading replaces | The vendor holding the card, face visible |
| `home_address_sketch` | **many**, ≤ 10 — appends | Hand-drawn map screenshot(s) of where they live |
| `store_address_sketch` | **many**, ≤ 10 — appends | Hand-drawn map screenshot(s) of the shop(s) |

Any other slot name answers `400 KYC_SLOT_UNKNOWN` with `details.allowed` listing the five.
It is a refusal rather than a silent no-op on purpose: a write that reports success having
stored nothing is the hardest kind of bug to see from a client.

**File rules**

| | |
|---|---|
| Accepted | `image/jpeg`, `image/png`, `image/webp`, **`application/pdf`** |
| Max per file | 10 MB |
| Max per request | 10 files |
| Multi-slot ceiling | 10 files **in the slot**, checked against what is already there *before* anything uploads |
| Virus scanned | Yes, every file |
| Counts against | The vendor's own plan media-storage cap |

> **PDF is accepted everywhere here.** A scan arrives from a phone as a JPEG and from a scanner
> app or a printer as a PDF; making the vendor convert is the step at which a legible document
> becomes an illegible one.

> ⚠ **Images are transformed server-side, PDFs are not.** An image is resized to fit 3000×3000
> and recompressed, so what comes back is not byte-identical to what was sent. A PNG is **not**
> converted to WebP here (unlike product media) — this is evidence, and re-encoding it through a
> lossy format to save a few kilobytes is a bad trade. The 3000px ceiling is higher than
> elsewhere on the platform because an ID number and a sketched street name are small features,
> and a reviewer who cannot read the digits has been handed a file that proves nothing.

Replacing a single-value slot deletes the previous file immediately, so the vendor's storage
drops straight away rather than waiting for the orphan sweep.

---

### `DELETE /api/vendor/kyc/documents/:slot/:fileId`

Remove one file from a slot. `404 KYC_DOCUMENT_NOT_FOUND` if that file is not in that slot.
Returns the whole record.

---

### `POST /api/vendor/kyc/submit`

Hands the record to the reviewers: stamps `submittedAt`, clears any previous
`rejectionReason`, and **freezes the record**. No body.

⚠ **It accepts anything**, including an empty record — see the section above. It does **not**
re-open a verified record: that answers `409 KYC_LOCKED`.

---

### `GET /api/vendor/kyc/documents/:fileId/content`

The bytes of one of the vendor's **own** documents. This is the only way to display them.

Answers the raw file — `Content-Type` from the stored file, `Content-Disposition: inline`,
`Cache-Control: private, no-store`. **Not** a JSON envelope.

Works while the record is locked: a vendor under review still has to be able to see what they
submitted.

---

## ⚠ `url` is always `null`. Displaying a document

Every file in this module lives in a **private storage tree**, so its `FileDetail` comes back as:

```json
{ "id": "66f…a1", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 842113 }
```

That is the correct, expected answer — **not a broken file**. The `id` is the handle; fetch
`GET /api/vendor/kyc/documents/:fileId/content` and render the blob.

```js
const res  = await fetch(`/api/vendor/kyc/documents/${doc.id}/content`, { credentials: 'include' });
const blob = await res.blob();
img.src = URL.createObjectURL(blob);   // remember URL.revokeObjectURL on unmount
```

> ⚠ **Do not write `<img src={doc.url}>`.** `url` is typed `string | null` precisely so this is
> a compile error rather than a blank rectangle. It is `null` for a reason: an identity card at
> a public URL is fetchable forever by anyone who ever sees the link.

A `FileDetail` can also come back with `access: "quota_blocked"` and `url: null` — that is a
**billing** state (the vendor is over their plan's storage cap), not a privacy one, and the
content route will not help. Render it as "over your storage limit", not as a missing file.

---

## Errors

| Status | Code | When |
|---|---|---|
| `400` | `KYC_SLOT_UNKNOWN` | `:slot` is not one of the five. `details.allowed` lists them |
| `400` | `KYC_FILE_REQUIRED` | The upload carried no file — almost always the wrong multipart field name (it is `documents`) |
| `400` | `VALIDATION_ERROR` | A malformed `homeAddress`, or an `idNumber` over 64 characters |
| `404` | `KYC_SUBJECT_NOT_FOUND` | No vendor record for the session |
| `404` | `KYC_DOCUMENT_NOT_FOUND` | That file is not in that slot (or not this vendor's) |
| `409` | `KYC_LOCKED` | Under review, or verified. `details.status` / `details.submittedAt` say which |
| `409` | `STORAGE_DOWNLOAD_NOT_SUPPORTED` | This deployment's storage provider cannot stream files. A configuration state, not an outage |
| `422` | `KYC_SLOT_FULL` | The slot is full. `details.max`, `details.current`, `details.offered` |
| `422` | `UPLOAD_POLICY_VIOLATION` | Wrong type, too large, too many, or a virus detected. `details.violations[]` |

Every error carries the platform's usual envelope — see [Errors](../errors/README.md).
