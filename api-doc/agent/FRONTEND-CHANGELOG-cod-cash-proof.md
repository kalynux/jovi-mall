# Agent app: declaring a cash hand-over now needs a photo

> **Date:** 2026-09-27 · **Audience:** the agent mobile app · **Breaking:** 🔴 **yes**:
> `POST /api/agent/cod/deposits` changes from JSON to `multipart/form-data`
>
> Cross-role summary: [../FRONTEND-CHANGELOG-cod-cash-proof.md](../FRONTEND-CHANGELOG-cod-cash-proof.md) ·
> Full contract: [cod-cash.md § POST /api/agent/cod/deposits](./cod-cash.md#declare-deposit)

| # | Change | Kind |
|---|---|---|
| 1 | Declaring a deposit **requires a photo** and is sent as `multipart/form-data` | 🔴 **breaking** |
| 2 | `reference` is **optional** for both recipients, including `platform` | relaxed rule |
| 3 | Deposit rows gain a `proof` field | additive |
| 4 | New route for the photo's bytes: `GET /api/agent/cod/deposits/:id/proof/file` | additive |

---

## 1 · Declaring a deposit

### Before

```http
POST /api/agent/cod/deposits
Content-Type: application/json

{ "agencyId": "…", "amount": 78000, "recipient": "platform", "reference": "OM-88231" }
```

### Now

```http
POST /api/agent/cod/deposits
Content-Type: multipart/form-data; boundary=…

file       = <the photo>                 (required)
agencyId   = 507f1f77bcf86cd799439099    (required)
amount     = 78000                       (required, integer, minor units)
recipient  = agency | platform           (optional, default agency)
reference  = OM-88231                    (optional)
note       = Evening cash-desk deposit   (optional)
```

- **`file`**: exactly one image, JPEG, PNG or WebP, at most **10 MB**. The field name must be
  exactly `file`. Any other field name is refused as `400 VALIDATION_ERROR` ("unexpected
  field"), not as a missing proof.
- **Every other value is a text field.** Send `amount` as its integer string, like `"78000"`; the
  server converts it.
- **An empty `reference` or `note` means "none".** You can send `""` or leave the field out.
- **The photo is required for both recipients.** For `agency` the agency checks it before
  confirming, and for `platform` an administrator does.

### In this codebase

`lib/features/cod_cash/data/datasources/cod_remote_datasource.dart` → `declareDeposit` still posts
a JSON map, and its comment says a platform deposit "must carry a real" reference. Both are now
wrong.

`lib/shared/services/file_upload_service.dart` → `buildUploadForm` already does what this needs.
It builds a dio `FormData` under a named field and refuses an oversized file on the phone, in the
same `UPLOAD_POLICY_VIOLATION` shape the server uses. The delivery-proof upload uses it the same
way. A sketch:

```dart
final form = await buildUploadForm(
  field: 'file',
  sources: [proofSource],          // from image_picker
  limitOverride: 10 * 1024 * 1024, // the server's cap for this route
);
form.fields
  ..add(MapEntry('agencyId', agencyId))
  ..add(MapEntry('amount', amount.toString()))
  ..add(MapEntry('recipient', recipient.wireValue));
if (reference?.trim().isNotEmpty ?? false) form.fields.add(MapEntry('reference', reference!.trim()));
if (note?.trim().isNotEmpty ?? false)      form.fields.add(MapEntry('note', note!.trim()));
// POST it through the same `_api.post` so the bearer interceptor still applies.
```

⚠ **This POST is not idempotent.** A retry after a lost response creates a second declaration.
The app's retry interceptor already retries only idempotent methods, so keep this call on the
ordinary `post`.

### The screen

- **Add a required "Proof" step** with *Take photo* and *Choose from gallery*, and show a
  thumbnail of the picked image. Keep *Declare* disabled until a photo is attached.
- **Make the reference field optional** for both recipients, and remove any "required when paying
  the platform" validation and copy.
- ⚠ **iPhone photos can be HEIC**, which the server refuses. Ask `image_picker` for JPEG output,
  for example by setting `imageQuality`, which re-encodes to JPEG. Large photos are fine: the
  server resizes them.

### Errors, in the order the server checks them

| Status · code | When | What to show |
|---|---|---|
| `400 VALIDATION_ERROR` | A missing or malformed field (`agencyId`, `amount`…), or the photo sent under the wrong field name | Field-level messages from `details` |
| `400 COD_PROOF_FILE_REQUIRED` | No photo in `file` | "Attach a photo of the receipt or the hand-over." |
| `404 AGENT_MEMBERSHIP_NOT_FOUND` · `422 COD_DEPOSIT_*` · `422 CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` | The amount or contract rules. **Unchanged** | As before |
| `400 UPLOAD_POLICY_VIOLATION` | Not JPEG, PNG or WebP, or over 10 MB (`details.violations[].code`) | "This photo can't be used. Take another one." |
| `413 CATALOG_FILE_TOO_LARGE` | Over 20 MB | Same as above |

The amount rules run **before** the photo is stored, so a refused declaration leaves nothing
behind. The agent can simply correct the amount and resubmit.

`COD_DEPOSIT_REFERENCE_REQUIRED` **no longer exists**. Delete its copy.

### Success

`201`, with the same body as before plus `proof`:

```json
{
  "success": true,
  "data": {
    "id": "665f1f77bcf86cd799439400",
    "agencyId": "507f1f77bcf86cd799439099",
    "amount": 78000,
    "currency": "XAF",
    "recipient": "agency",
    "status": "declared",
    "reference": null,
    "proof": {
      "id": "665f1f77bcf86cd799439401", "key": "cod-proofs/2026/09/…jpg", "url": null,
      "access": "authorized", "mimeType": "image/jpeg", "size": 184320, "originalName": "receipt.jpg"
    },
    "declaredAt": "2026-09-27T17:40:00.000Z"
  },
  "message": "Deposit declared — your agency will confirm receipt. Your cash balance falls when they do."
}
```

---

## 2 · Showing the proof on the deposit history

`GET /api/agent/cod/deposits` rows gain `proof` (a `FileDetail` or `null`):

- **`url` is always `null`**, because the photo is private. Load it from
  **`GET /api/agent/cod/deposits/:id/proof/file`** with the bearer token, the same way the app
  loads a delivery-proof photo. The response is the image bytes, with the right `Content-Type`
  and `Cache-Control: private, no-store`.
- **`proof: null`** means either the agency recorded the deposit itself at its desk, or the
  deposit is older than this change. Show nothing, or "No photo". It is not an error.

Errors from the byte route: `404 COD_DEPOSIT_NOT_FOUND` (not this agent's deposit) and
`404 COD_PROOF_NOT_FOUND` (the deposit has no photo).

### In this codebase

- **Model.** Add `proof` to `CodDepositModel` as a nullable `FileRef` (`core/domain/file_ref.dart`),
  the type `ShipmentDetail.deliveryProof` already uses for the same situation.
- ⚠ **`lib/core/network/media_url.dart` → `_authorizedOnlyTrees` must gain `'cod-proofs/'`.**
  That list names the storage folders that have no public URL. A key outside it gets rebuilt into
  `<api>/files/<key>` by `resolveMediaUrl`, which **404s** for a private folder. Without this
  line, any code path that passes a proof through `resolveMediaUrl` shows a broken image instead
  of being refused.

---

## Checklist

- [ ] `declareDeposit` sends `multipart/form-data`, with the photo in `file`
- [ ] The declare screen requires a photo and makes the reference optional for both recipients
- [ ] HEIC is avoided at pick time (JPEG output)
- [ ] `COD_PROOF_FILE_REQUIRED` and `UPLOAD_POLICY_VIOLATION` have copy, and `COD_DEPOSIT_REFERENCE_REQUIRED` copy is removed
- [ ] `CodDepositModel` parses `proof` as a `FileRef?`, and the history and detail screens show the photo through the byte route
- [ ] `'cod-proofs/'` is added to `_authorizedOnlyTrees` in `media_url.dart`
- [ ] Update the local api-doc mirror from [cod-cash.md](./cod-cash.md)
