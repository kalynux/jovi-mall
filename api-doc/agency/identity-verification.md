# Agency Identity Verification

**Written against source on 2026-09-14** — routes and guards against
`src/modules/identity-verification/routes/kyc.routes.ts` and `src/api/index.ts`; the slot table
against `domain/kyc-subject.ts`; the payload against `dto/kyc.dto.ts`; the lock against
`services/kyc-submission.service.ts`; the file rules against
`core/uploads/upload-config.ts` (`getKycDocumentUploadConfig`); and the privacy verdict against
`core/storage/storage-trees.ts` (`kyc: 'private'`).

Base path: **`/api/agency/kyc`**

The documents an administrator looks at when deciding whether to verify the agency. Before this
existed, the whole of a verification decision rested on `registration_number` and
`transport_license_id` — two numbers typed into text boxes, neither checkable, and **both about
a company rather than about the person who will be holding customers' cash**.

> Related: [Profile](./profile.md) · [Magazin](./magazin.md) (where the depot/HQ addresses are
> edited) · [File management](./file-management.md) · [Onboarding](./onboarding.md) —
> **verification is not an onboarding step**; it can be submitted at any time and does not gate
> the dashboard.

## Authentication

Bearer token or cookie session with the **agency** role. **There is no agency id in any path** —
every route is scoped to the calling agency's own record. There is no way to read or write
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
away the only useful outcome of a review: a human telling the agency what is missing.

**What that means for your UI.** You own the "you still need X" guidance. The table below is the
rule the reviewers apply — implement it client-side as guidance, and let the agency submit
anyway if they insist. They will be rejected with a reason, and can resubmit.

### What the administrator checks

| What they check | Where it comes from | Rule |
|---|---|---|
| The magazin/store address on the account is valid (geocoded) | `headquarters_addresses[].geo` on the [Magazin](./magazin.md), **not here** | optional |
| The home address is valid (geocoded) | `homeAddress` | **required only if the agency has no physical store/magazin** |
| A scan of the ID card, front and back | `id_card_front`, `id_card_back` | required |
| The ID number | `idNumber` | required |
| A selfie holding the ID card | `selfie_with_id` | required |
| A hand-drawn screenshot of the home address location | `home_address_sketch` | **required only if the agency has no physical store/magazin** |
| A hand-drawn screenshot of the magazin/store address location | `store_address_sketch` | **required only if a magazin/store address is set up** |

> An agency legitimately has no premises of its own — it may work only for vendors who each have
> their own physical store. That is what makes the home address **conditional** rather than
> simply optional: if there is no depot to inspect, the reviewer needs to know where the person
> running the business actually is.

> ⚠ **`idNumber` is the PERSON's national identity number**, not the company registration
> number. `registration_number` and `transport_license_id` stay where they are, on
> [the profile](./profile.md); this is the field the ID scans corroborate, and it is new.

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
> also means *"never touched"*. `submittedAt` is what tells them apart.

> ⚠ This `status` is the **KYC verdict** and is a different thing from the agency's own
> `status` (`pending_verification` / `active` / `inactive`). A rejection here does **not** move
> the agency's account status — every gate that matters already refuses a non-`active` agency,
> so the two stay separate on purpose.

Resubmitting clears `rejectionReason` and re-stamps `submittedAt`. The **verdict** stays
`rejected` until an administrator moves it.

---

## Endpoints

### `GET /api/agency/kyc`

The whole record. Safe to call at any time; returns a fully-formed empty record for an agency
that has never touched verification.

```jsonc
{
  "success": true,
  "data": {
    "role": "agency",
    "status": "pending",
    "submittedAt": null,
    "locked": false,
    "rejectionReason": null,
    "verifiedAt": null,

    "idNumber": "1084563219",          // the person's national ID, not the company registration

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
      "vehicleWithAgent": null,            // always null for an agency
      "homeAddressSketches":  [],
      "storeAddressSketches": [ { "id": "66f…c1", "url": null, "access": "authorized", "mimeType": "application/pdf", "size": 220144 } ]
    },

    "limits": { "multiSlotMaxFiles": 10 }
  }
}
```

> `storeAddresses` and `review` appear only on the administrator's copy of this payload. An
> agency reads its own depot addresses from [the Magazin](./magazin.md).

---

### `PATCH /api/agency/kyc`

The typed half. Both fields optional; both **clearable** — send `""` or `null` to remove a value,
omit the key to leave it alone.

| Field | Type | Notes |
|---|---|---|
| `idNumber` | string, 1–64 chars, or `null` | The **person's** national identity number as printed on the card. **No format check** — Cameroonian ID formats have changed more than once and a regex derived from today's cards would silently refuse a valid older one. It is checked against the scans, by a person. |
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

### `POST /api/agency/kyc/documents/:slot`

`multipart/form-data`, field name **`documents`**. Returns `201` with the whole record.

| Slot | Cardinality | What it is |
|---|---|---|
| `id_card_front` | **one** — re-uploading replaces | Scan or photo of the front of the ID card |
| `id_card_back` | **one** — re-uploading replaces | The back of the same card |
| `selfie_with_id` | **one** — re-uploading replaces | The person holding the card, face visible |
| `home_address_sketch` | **many**, ≤ 10 — appends | Hand-drawn map screenshot(s) of where they live |
| `store_address_sketch` | **many**, ≤ 10 — appends | Hand-drawn map screenshot(s) of the magazin/depot(s) |

Any other slot name answers `400 KYC_SLOT_UNKNOWN` with `details.allowed` listing the five.
It is a refusal rather than a silent no-op on purpose: a write that reports success having
stored nothing is the hardest kind of bug to see from a client.

> An agency with several depots can upload a sketch per depot, up to ten. The backend does not
> pair a sketch with the address it depicts — that pairing is a judgement only a reviewer
> looking at both can make, and a stored foreign key would assert it had already been made.

**File rules**

| | |
|---|---|
| Accepted | `image/jpeg`, `image/png`, `image/webp`, **`application/pdf`** |
| Max per file | 10 MB |
| Max per request | 10 files |
| Multi-slot ceiling | 10 files **in the slot**, checked against what is already there *before* anything uploads |
| Virus scanned | Yes, every file |
| Counts against | The agency's own plan media-storage cap |

> **PDF is accepted everywhere here.** A scan arrives from a phone as a JPEG and from a scanner
> app or a printer as a PDF; making the agency convert is the step at which a legible document
> becomes an illegible one.

> ⚠ **Images are transformed server-side, PDFs are not.** An image is resized to fit 3000×3000
> and recompressed, so what comes back is not byte-identical to what was sent. A PNG is **not**
> converted to WebP here (unlike product media) — this is evidence, and re-encoding it through a
> lossy format to save a few kilobytes is a bad trade. The 3000px ceiling is higher than
> elsewhere on the platform because an ID number and a sketched street name are small features.

Replacing a single-value slot deletes the previous file immediately.

---

### `DELETE /api/agency/kyc/documents/:slot/:fileId`

Remove one file from a slot. `404 KYC_DOCUMENT_NOT_FOUND` if that file is not in that slot.
Returns the whole record.

---

### `POST /api/agency/kyc/submit`

Hands the record to the reviewers: stamps `submittedAt`, clears any previous
`rejectionReason`, and **freezes the record**. No body.

⚠ **It accepts anything**, including an empty record — see the section above. It does **not**
re-open a verified record: that answers `409 KYC_LOCKED`.

---

### `GET /api/agency/kyc/documents/:fileId/content`

The bytes of one of the agency's **own** documents. This is the only way to display them.

Answers the raw file — `Content-Type` from the stored file, `Content-Disposition: inline`,
`Cache-Control: private, no-store`. **Not** a JSON envelope.

Works while the record is locked: an agency under review still has to be able to see what it
submitted.

---

## ⚠ `url` is always `null`. Displaying a document

Every file in this module lives in a **private storage tree**, so its `FileDetail` comes back as:

```json
{ "id": "66f…a1", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 842113 }
```

That is the correct, expected answer — **not a broken file**. The `id` is the handle; fetch
`GET /api/agency/kyc/documents/:fileId/content` and render the blob.

```js
const res  = await fetch(`/api/agency/kyc/documents/${doc.id}/content`, { credentials: 'include' });
const blob = await res.blob();
img.src = URL.createObjectURL(blob);   // remember URL.revokeObjectURL on unmount
```

> ⚠ **Do not write `<img src={doc.url}>`.** `url` is typed `string | null` precisely so this is
> a compile error rather than a blank rectangle. It is `null` for a reason: an identity card at
> a public URL is fetchable forever by anyone who ever sees the link.

A `FileDetail` can also come back with `access: "quota_blocked"` and `url: null` — that is a
**billing** state (over the plan's storage cap), not a privacy one, and the content route will
not help. Render it as "over your storage limit", not as a missing file.

---

## Errors

| Status | Code | When |
|---|---|---|
| `400` | `KYC_SLOT_UNKNOWN` | `:slot` is not one of the five. `details.allowed` lists them |
| `400` | `KYC_FILE_REQUIRED` | The upload carried no file — almost always the wrong multipart field name (it is `documents`) |
| `400` | `VALIDATION_ERROR` | A malformed `homeAddress`, or an `idNumber` over 64 characters |
| `404` | `KYC_SUBJECT_NOT_FOUND` | No agency record for the session |
| `404` | `KYC_DOCUMENT_NOT_FOUND` | That file is not in that slot (or not this agency's) |
| `409` | `KYC_LOCKED` | Under review, or verified. `details.status` / `details.submittedAt` say which |
| `409` | `STORAGE_DOWNLOAD_NOT_SUPPORTED` | This deployment's storage provider cannot stream files. A configuration state, not an outage |
| `422` | `KYC_SLOT_FULL` | The slot is full. `details.max`, `details.current`, `details.offered` |
| `422` | `UPLOAD_POLICY_VIOLATION` | Wrong type, too large, too many, or a virus detected. `details.violations[]` |

Every error carries the platform's usual envelope — see [Errors](../errors/README.md).
