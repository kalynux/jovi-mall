# COD cash hand-overs now need a proof image; the reference is optional

> **Date:** 2026-09-27 · **Audience:** every app that touches COD cash · **Breaking:** 🔴 **yes**
> for the agent app and the agency dashboard (two request bodies change format)
>
> Per app: [agent app](./agent/FRONTEND-CHANGELOG-cod-cash-proof.md) ·
> [agency dashboard](./agency/FRONTEND-CHANGELOG-cod-cash-proof.md) ·
> [admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-cod-cash-proof.md).
> The vendor dashboard, the customer app and the landing site are **not affected**.

## The rule

When someone **declares** that they handed COD cash on, they must attach **one photo** as
evidence: the receipt, the transfer screenshot, or a picture of the hand-over. The party that
confirms the declaration looks at the photo before confirming.

The **transaction reference is now optional** everywhere, like the note. Before this change it was
required on an agency remittance and on an agent's direct-to-platform deposit.

## What changes, by app

| App | Endpoint | Change |
|---|---|---|
| Agent app | `POST /api/agent/cod/deposits` | 🔴 Body is now **`multipart/form-data`** with a required image in field `file`. `reference` is optional for both recipients |
| Agent app | `GET /api/agent/cod/deposits` | Each row gains `proof` |
| Agent app | `GET /api/agent/cod/deposits/:id/proof/file` | **New.** The image bytes |
| Agency dashboard | `POST /api/agency/cod/remittances` | 🔴 Body is now **`multipart/form-data`** with a required image in field `file`. `reference` is optional |
| Agency dashboard | `GET /api/agency/cod/deposits`, `GET /api/agency/cod/remittances` | Each row gains `proof` |
| Agency dashboard | `GET /api/agency/cod/deposits/:id/proof/file`, `GET /api/agency/cod/remittances/:id/proof/file` | **New.** The image bytes |
| Agency dashboard | `POST /api/agency/cod/deposits` (recording cash at the desk) | **Unchanged.** No proof is asked for, because the agency has the cash in hand |
| Admin dashboard | `GET /api/v1/cod/deposits[/:id]`, `GET /api/v1/cod/remittances[/:id]`, `GET /api/v1/cod/discrepancies/:id` | Rows and details gain `proof`. Show it with the existing `GET /api/v1/files/:fileId/content` |

## The `proof` field

A standard `FileDetail`, or `null`:

```json
"proof": {
  "id": "665f1f77bcf86cd799439401",
  "key": "cod-proofs/2026/09/…webp",
  "url": null,
  "access": "authorized",
  "mimeType": "image/webp",
  "size": 184320,
  "originalName": "receipt.jpg"
}
```

- **`url` is always `null`.** The image is a private file: receipts carry account numbers and
  names. Load the bytes from the app's own route (table above) with the normal auth. Never build
  a URL from `key`.
- **`null` is normal** in two cases: a deposit an agency recorded itself at the desk, and any
  declaration made before 2026-09-27. Show "No proof attached". Don't treat it as an error.
- `mimeType` can differ from what was uploaded. PNG is converted to WebP, and large images are
  resized to at most 2048 px.

## New errors

| Code | Status | When |
|---|---|---|
| `COD_PROOF_FILE_REQUIRED` | 400 | No image in field `file`. **An un-updated client sending the old JSON body gets this.** |
| `UPLOAD_POLICY_VIOLATION` | 400 | Not a JPEG, PNG or WebP, or larger than 10 MB. `details.violations[]` says which |
| `CATALOG_FILE_TOO_LARGE` | 413 | Larger than 20 MB. The request is refused before it is read |
| `COD_PROOF_NOT_FOUND` | 404 | From a `…/proof/file` route: the record has no proof |

`COD_DEPOSIT_REFERENCE_REQUIRED` **no longer exists**. Remove any copy that branches on it.

## Rollout

The backend change is live in the same release as this page. Until each app ships its update,
**its declare button fails** with `COD_PROOF_FILE_REQUIRED`. Ship the agent app and the agency
dashboard together with the backend, or right after it.
