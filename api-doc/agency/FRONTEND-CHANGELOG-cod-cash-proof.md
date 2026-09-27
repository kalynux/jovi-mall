# Agency dashboard: remittances need a photo, and agents' deposits now carry one

> **Date:** 2026-09-27 · **Audience:** the agency dashboard · **Breaking:** 🔴 **yes**:
> `POST /api/agency/cod/remittances` changes from JSON to `multipart/form-data`
>
> Cross-role summary: [../FRONTEND-CHANGELOG-cod-cash-proof.md](../FRONTEND-CHANGELOG-cod-cash-proof.md) ·
> Full contract: [cod-cash-management.md](./cod-cash-management.md)

| # | Change | Kind |
|---|---|---|
| 1 | Declaring a remittance **requires a photo** and is sent as `multipart/form-data` | 🔴 **breaking** |
| 2 | A remittance's `reference` is **optional** | relaxed rule |
| 3 | Deposit rows carry the **agent's proof photo**. Show it on the confirm/reject screen | additive |
| 4 | Remittance rows gain `proof` | additive |
| 5 | Two routes for the photo bytes | additive |
| — | `POST /api/agency/cod/deposits` (recording cash at the desk) | **unchanged**, no photo |

---

## 1 · Declaring a remittance

### Before

```ts
api.post('/agency/cod/remittances', { amount, reference, note });
```

### Now

```ts
const form = new FormData();
form.append('file', proofFile);                 // required: a File from <input type="file">
form.append('amount', String(amount));          // required: integer, minor units
if (reference.trim()) form.append('reference', reference.trim()); // optional
if (note.trim()) form.append('note', note.trim());                // optional
api.postForm<CodRemittanceResponse>('/agency/cod/remittances', form);
```

- **`file`**: exactly one image, JPEG, PNG or WebP, at most **10 MB**. The field name must be
  exactly `file`. Any other name is refused as `400 VALIDATION_ERROR`, not as a missing proof.
- `api.postForm` already exists in `src/services/api.ts` (the policy-document upload uses it). It
  lets the browser set the multipart boundary. **Don't set `Content-Type` yourself.**
- **Every value is a string** in `FormData`, and the server converts `amount`. An empty
  `reference` or `note` means "none".

### In this codebase

| File | Today | Change |
|---|---|---|
| `src/services/cod-cash.service.ts` | `declareRemittance(amount, reference: string, note?)` posts JSON | Take a `File`, make `reference` optional, and use `postForm` as above |
| `src/hooks/useCodCashActions.ts` | passes `(amount, reference, note)` | Pass the file through |
| `src/components/cash/RemittancesTab.tsx` | The submit button is disabled until `reference.trim()` is set (lines ~85 and ~121) | Disable until a **photo** is attached instead. The reference no longer gates anything |

Add an image picker to the form (`accept="image/jpeg,image/png,image/webp"`) with a thumbnail
preview, and check the 10 MB limit before upload. ⚠ iPhone photos can be **HEIC**, which the
server refuses. `accept` steers the file dialog but doesn't guarantee the format, so show the
server's rejection clearly.

### Errors, in the order the server checks them

| Status · code | When | Copy |
|---|---|---|
| `400 VALIDATION_ERROR` | A malformed field, or the photo under the wrong field name | Field messages from `details` |
| `400 COD_PROOF_FILE_REQUIRED` | No photo in `file` | "Attach the transfer receipt or a screenshot." |
| `422 COD_REMITTANCE_INVALID_AMOUNT` · `422 COD_REMITTANCE_EXCEEDS_LIABILITY` | **Unchanged** | As before |
| `400 UPLOAD_POLICY_VIOLATION` | Not JPEG, PNG or WebP, or over 10 MB (`details.violations[].code`) | "This image can't be used. Try a JPEG or PNG under 10 MB." |
| `413 CATALOG_FILE_TOO_LARGE` | Over 20 MB | Same as above |

The amount check runs **before** the photo is stored, so a refused declaration leaves nothing
behind.

### Success

`201`, with the same body as before plus `proof`. `reference` can now be `null`:

```json
{
  "success": true,
  "data": {
    "id": "665f1f77bcf86cd799439500",
    "amount": 300000,
    "currency": "XAF",
    "reference": null,
    "proof": {
      "id": "665f1f77bcf86cd799439501", "key": "cod-proofs/2026/09/…webp", "url": null,
      "access": "authorized", "mimeType": "image/webp", "size": 201344, "originalName": "transfer.png"
    },
    "status": "declared",
    "declaredAt": "2026-09-27T19:00:00.000Z"
  },
  "message": "Remittance declared — awaiting platform confirmation."
}
```

⚠ **`reference` can be `null` on new rows.** The remittances table renders it as a column, a
`title` and a search field. Show "—" for null, and check that nothing calls a string method on it
without `?.`.

---

## 2 · The agent's proof on deposits you must answer

Agents now attach a photo to every hand-over they declare. `GET /api/agency/cod/deposits` rows gain
`proof`:

```json
{ "id": "665f…400", "status": "declared", "amount": 78000, "reference": null,
  "proof": { "id": "665f…401", "key": "cod-proofs/2026/09/…jpg", "url": null,
             "access": "authorized", "mimeType": "image/jpeg", "size": 184320 }, … }
```

**Show the photo on the declared-deposit card, next to Confirm and Reject.** Checking it before
confirming is the reason the photo exists. Clicking it can open it full size.

- `proof: null` → a deposit **you** recorded at the desk (`declaredAt: null`), or one declared
  before this change. Show nothing, or "No photo". It is not an error.
- A `recipient: "platform"` deposit also carries a photo. Showing it is optional, since the
  platform answers those, not you.

---

## 3 · Loading the photo

`url` is always `null` (private file), so load the bytes with the session, exactly as
`shipments.service.ts` already does for the delivery-proof photo:

```ts
const blob = await api.getBlob(`/agency/cod/deposits/${depositId}/proof/file`);
const src = URL.createObjectURL(blob);   // revoke it when the image unmounts
```

| Route | For |
|---|---|
| `GET /api/agency/cod/deposits/:id/proof/file` | An agent's proof on a deposit made under your contracts |
| `GET /api/agency/cod/remittances/:id/proof/file` | Your own remittance's proof |

Errors: `404 COD_DEPOSIT_NOT_FOUND` / `404 COD_REMITTANCE_NOT_FOUND` (not yours) and
`404 COD_PROOF_NOT_FOUND` (no photo). Responses are `Cache-Control: private, no-store`.

`fileAccessState` in `src/services/files.service.ts` reads `access` first, so a proof is
correctly `authorized` already. For completeness, add `'cod-proofs/'` to
`AUTHORIZED_KEY_PREFIXES`, which is the fallback for payloads without `access`.

---

## Checklist

- [ ] `declareRemittance` sends `FormData` through `postForm`, with the photo in `file`
- [ ] The remittance form requires a photo, and the reference is optional
- [ ] `COD_PROOF_FILE_REQUIRED` and `UPLOAD_POLICY_VIOLATION` have copy
- [ ] The declared-deposit card shows the agent's photo before Confirm and Reject
- [ ] The remittance list handles `reference: null`, and shows the proof in the row or detail
- [ ] `CodDeposit` and `CodRemittance` types gain `proof: ApiFile | null`
- [ ] `'cod-proofs/'` is added to `AUTHORIZED_KEY_PREFIXES`
- [ ] Update the local api-doc mirror from [cod-cash-management.md](./cod-cash-management.md)
