# Agent Identity Verification

**Written against source on 2026-09-14** — routes and guards against
`src/modules/identity-verification/routes/kyc.routes.ts` and `src/api/index.ts`; the slot table
against `domain/kyc-subject.ts`; the payload against `dto/kyc.dto.ts`; the lock against
`services/kyc-submission.service.ts`; the file rules against
`core/uploads/upload-config.ts` (`getKycDocumentUploadConfig`); and the privacy verdict against
`core/storage/storage-trees.ts` (`kyc: 'private'`).

Base path: **`/api/agent/kyc`**

The documents an administrator looks at when deciding whether to verify the agent — **and this
is the verdict that decides whether the agent can work at all.** Dispatch eligibility passes only
on `kyc.status === 'verified'`, so an unverified agent is offered nothing, however online and
available they are.

Before this existed, the whole of that decision rested on a national ID **number** the agent
typed in, plus `kyc.reference` — a free-text note an *administrator* had written themselves. The
platform held no documents at all.

> Related: [Profile](./profile.md) · [Vehicle profile](./vehicle-profile.md) (where
> `plate_number` and the public vehicle photo live) · [Storage](./storage.md) ·
> [Onboarding](./onboarding.md) — **verification is not an onboarding step**; it can be
> submitted at any time and does not gate the app.

## Authentication

Bearer token or cookie session with the **agent** role. **There is no agent id in any path** —
every route is scoped to the calling agent's own record. There is no way to read or write
somebody else's documents, by design: the payload is a photograph of a person holding their
identity card.

---

## ⚠ Nothing is required, and that is deliberate

An agent can save one field and submit. They can submit an empty record. **Every field on every
endpoint is optional and the API enforces no completeness rule anywhere**, including on
`POST /submit`.

This is a decision, not a gap. The required/optional rules are a *review policy* and they live
in the administration dashboard, which uses them to show the reviewer an estimated verdict and a
pre-filled rejection reason. A backend that refused an incomplete submission would also take
away the only useful outcome of a review: a human telling the agent what is missing.

**What that means for your UI.** You own the "you still need X" guidance — and here it matters
more than for the other two roles, because until this is approved the agent earns nothing. Show
the checklist prominently; let them submit anyway if they insist.

### What the administrator checks

| What they check | Where it comes from | Rule |
|---|---|---|
| The home address is valid (geocoded) | `homeAddress` | **required** |
| A hand-drawn screenshot of the home address location | `home_address_sketch` | **required** |
| The plate number | `plateNumber` — set on [the vehicle profile](./vehicle-profile.md), **not here** | optional |
| A picture of the vehicle with the agent standing beside it | `vehicle_with_agent` | required |
| A scan of the ID card, front and back | `id_card_front`, `id_card_back` | required |
| The ID number | `idNumber` | required |
| A selfie holding the ID card | `selfie_with_id` | required |

> Unlike the vendor and agency checklists, **nothing here is conditional**: an agent has no
> premises, so the home address and its sketch are simply required.

> The plate number is optional by rule — plenty of two-wheelers in this market carry no readable
> plate. The photograph of the rider beside the vehicle is what actually identifies it.

### ⚠ `vehicle_with_agent` is not the vehicle photo you already have

There are **two** vehicle pictures on an agent, and they are not interchangeable:

| | `vehicle_info.photo` | `documents.vehicleWithAgent` |
|---|---|---|
| Set on | [Vehicle profile](./vehicle-profile.md) | Here |
| Shows | The vehicle | The vehicle **with the agent standing beside it** |
| Visibility | Public — agencies browsing the directory see it | Private, KYC only |
| Answers | "What will arrive at the customer's door?" | "Is this the person who owns it?" |

Do not reuse one for the other. Pointing the KYC slot at the profile photo would publish it to
the agency directory.

---

## The lifecycle, and when the record freezes

```
  unverified ──POST /submit──▶  pending (under review) ──▶ verified   (frozen, permanently)
      ▲                                                │
      └───────────────── rejected ◀────────────────────┘   (unfrozen — fix and resubmit)
```

The read returns `locked`, which is the only field you need to decide whether to disable the
form:

| `status` | `submittedAt` | `locked` | Meaning |
|---|---|---|---|
| `unverified` | `null` | `false` | Draft. Nobody has looked. Edit freely. |
| `pending` | set | `true` | Under review. Every write answers `409 KYC_LOCKED`. |
| `verified` | set | `true` | Approved — the agent can now be dispatched. Frozen for good; changing a document is a support request. |
| `rejected` | set | `false` | Refused. `rejectionReason` says why; edit and submit again. |

An agent's enum has a distinct `unverified` draft value, so — unlike a vendor or an agency —
`status` alone is unambiguous here. `submittedAt` is still the field the administrator's review
queue filters on.

Resubmitting clears `rejectionReason` and re-stamps `submittedAt`. The **verdict** stays
`rejected` until an administrator moves it — an agent cannot verify themselves.

> ⚠ Moving an agent **off** `verified` makes them undispatchable immediately. It does not touch
> their contracts, and shipments they are already carrying are unaffected.

---

## Endpoints

### `GET /api/agent/kyc`

The whole record. Safe to call at any time; returns a fully-formed empty record for an agent who
has never touched verification.

```jsonc
{
  "success": true,
  "data": {
    "role": "agent",
    "status": "unverified",
    "submittedAt": null,
    "locked": false,
    "rejectionReason": null,
    "verifiedAt": null,

    "idNumber": "1084563219",
    "driversLicenseNumber": "CM-DL-88213",   // agent only — read from legal_identity
    "plateNumber": "LT 4412 AB",             // agent only — read from vehicle_info

    "homeAddress": {
      "label": "Home",
      "formattedAddress": "Nylon, Douala, Littoral, Cameroon",
      "coordinates": [9.7530, 4.0350],   // ⚠ [lng, lat] — GeoJSON order, not [lat, lng]
      "provider": "locationiq",
      "geocoded": true
    },

    "documents": {
      "idCardFront":  { "id": "66f…a1", "key": "kyc/2026/09/…jpg", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 842113, "originalName": "cni-recto.jpg" },
      "idCardBack":   null,
      "selfieWithId": null,
      "vehicleWithAgent": { "id": "66f…d1", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 990455 },
      "homeAddressSketches":  [ { "id": "66f…b1", "url": null, "access": "authorized", "mimeType": "application/pdf", "size": 220144 } ],
      "storeAddressSketches": []             // always empty for an agent
    },

    "limits": { "multiSlotMaxFiles": 10 }
  }
}
```

> `storeAddresses` is **absent** from an agent's payload (not an empty array), and `review`
> appears only on the administrator's copy.

> ⚠ `homeAddress` is **not** `home_base`. `home_base` is the operational anchor auto-dispatch
> ranks against and the agent changes it freely — they may work from a depot, or a city they do
> not live in. This is an identity claim an administrator has approved. The two usually agree
> and never mean the same thing; setting one does not set the other.

---

### `PATCH /api/agent/kyc`

The typed half. Both fields optional; both **clearable** — send `""` or `null` to remove a value,
omit the key to leave it alone.

| Field | Type | Notes |
|---|---|---|
| `idNumber` | string, 1–64 chars, or `null` | The national identity number as printed on the card. Writes `legal_identity.national_id_number`, the same field [the profile](./profile.md) already exposes — one value, two doors. **No format check**: Cameroonian ID formats have changed more than once and a regex derived from today's cards would silently refuse a valid older one. |
| `homeAddress` | a selected `GET /api/geo/search` result, or `null` | The full candidate object, not a string. See [Geo](../geo/README.md). |

```json
{
  "idNumber": "1084563219",
  "homeAddress": {
    "formatted_address": "Nylon, Douala, Littoral, Cameroon",
    "coordinates": { "type": "Point", "coordinates": [9.7530, 4.0350] },
    "provider": "locationiq",
    "provider_place_id": "…",
    "components": { "city": "Douala", "region": "Littoral", "country_code": "CM" },
    "raw_input": "nylon douala"
  }
}
```

Returns the whole record, exactly as `GET` does.

> ⚠ Send the candidate the geocoder returned, unmodified. `geocoded: true` on the way back
> **is** the administrator's badge for "this address is valid" — a hand-assembled object with
> made-up coordinates passes that check and fails the human one.

> `driversLicenseNumber` and `plateNumber` are **read-only here**. They are edited on
> [the profile](./profile.md) and [the vehicle profile](./vehicle-profile.md) respectively, and
> are surfaced on this payload so the review screen does not need three calls.

---

### `POST /api/agent/kyc/documents/:slot`

`multipart/form-data`, field name **`documents`**. Returns `201` with the whole record.

| Slot | Cardinality | What it is |
|---|---|---|
| `id_card_front` | **one** — re-uploading replaces | Scan or photo of the front of the ID card |
| `id_card_back` | **one** — re-uploading replaces | The back of the same card |
| `selfie_with_id` | **one** — re-uploading replaces | The agent holding the card, face visible |
| `vehicle_with_agent` | **one** — re-uploading replaces | The vehicle **with the agent standing beside it** |
| `home_address_sketch` | **many**, ≤ 10 — appends | Hand-drawn map screenshot(s) of where they live |

There is **no `store_address_sketch`** for an agent — naming it answers
`400 KYC_SLOT_UNKNOWN` with `details.allowed` listing the five above. It is a refusal rather
than a silent no-op on purpose: a write that reports success having stored nothing is the
hardest kind of bug to see from a client.

**File rules**

| | |
|---|---|
| Accepted | `image/jpeg`, `image/png`, `image/webp`, **`application/pdf`** |
| Max per file | 10 MB |
| Max per request | 10 files |
| Multi-slot ceiling | 10 files **in the slot**, checked against what is already there *before* anything uploads |
| Virus scanned | Yes, every file |
| Counts against | The agent's own plan media-storage cap |

> **PDF is accepted everywhere here**, including for the sketch — a drawing may come out of a
> notes app as a PDF. Making the agent convert is the step at which a legible document becomes
> an illegible one.

> ⚠ **Images are transformed server-side, PDFs are not.** An image is resized to fit 3000×3000
> and recompressed, so what comes back is not byte-identical to what was sent. A PNG is **not**
> converted to WebP here (unlike the delivery proof) — this is evidence, and re-encoding it
> through a lossy format to save a few kilobytes is a bad trade. The 3000px ceiling is higher
> than the delivery proof's 2048 because an ID number and a sketched street name are small
> features, and a reviewer who cannot read the digits has been handed a file that proves nothing.

> **Mobile note.** Uploading from a phone camera means real bytes over a real network. Upload
> one slot at a time, show progress, and let a failed slot be retried on its own — the record is
> per-slot, so a failure loses only that slot.

Replacing a single-value slot deletes the previous file immediately, so the agent's storage
drops straight away rather than waiting for the orphan sweep.

---

### `DELETE /api/agent/kyc/documents/:slot/:fileId`

Remove one file from a slot. `404 KYC_DOCUMENT_NOT_FOUND` if that file is not in that slot.
Returns the whole record.

---

### `POST /api/agent/kyc/submit`

Hands the record to the reviewers: moves `unverified` → `pending`, stamps `submittedAt`, clears
any previous `rejectionReason`, and **freezes the record**. No body.

⚠ **It accepts anything**, including an empty record — see the section above. It does **not**
re-open a verified record: that answers `409 KYC_LOCKED`.

---

### `GET /api/agent/kyc/documents/:fileId/content`

The bytes of one of the agent's **own** documents. This is the only way to display them.

Answers the raw file — `Content-Type` from the stored file, `Content-Disposition: inline`,
`Cache-Control: private, no-store`. **Not** a JSON envelope.

Works while the record is locked: an agent under review still has to be able to see what they
submitted.

---

## ⚠ `url` is always `null`. Displaying a document

Every file in this module lives in a **private storage tree**, so its `FileDetail` comes back as:

```json
{ "id": "66f…a1", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 842113 }
```

That is the correct, expected answer — **not a broken file**. The `id` is the handle; fetch
`GET /api/agent/kyc/documents/:fileId/content` and render the bytes.

This is the same shape as the [delivery proof](./delivery-proof.md), which the app already
handles — reuse that code path rather than writing a second one.

> ⚠ **Never bind an `<img>` to `doc.url`.** It is typed `string | null` precisely so this is a
> compile error rather than a blank rectangle. It is `null` for a reason: an identity card at a
> public URL is fetchable forever by anyone who ever sees the link.

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
| `404` | `KYC_SUBJECT_NOT_FOUND` | No agent record for the session |
| `404` | `KYC_DOCUMENT_NOT_FOUND` | That file is not in that slot (or not this agent's) |
| `409` | `KYC_LOCKED` | Under review, or verified. `details.status` / `details.submittedAt` say which |
| `409` | `STORAGE_DOWNLOAD_NOT_SUPPORTED` | This deployment's storage provider cannot stream files. A configuration state, not an outage |
| `422` | `KYC_SLOT_FULL` | The slot is full. `details.max`, `details.current`, `details.offered` |
| `422` | `UPLOAD_POLICY_VIOLATION` | Wrong type, too large, too many, or a virus detected. `details.violations[]` |

Every error carries the platform's usual envelope — see [Errors](../errors/README.md).
