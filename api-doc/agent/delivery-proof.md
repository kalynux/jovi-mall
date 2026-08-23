# Agent Delivery Proof

An agent may attach **one optional image** as proof of a delivery. The image is
uploaded to (and charged against) the **agency's** media storage — not the
agent's — and is attached to the shipment.

> Related: [Shipments](./shipments.md) · [Storage](./storage.md) (the agent's own
> media; proofs are the agency's) · [Agency → Storage](../agency/storage.md).

## Authentication
Bearer token / cookie session with the **agent** role. Every endpoint is scoped to
a shipment **assigned to the calling agent** — any other shipment id returns
`404 SHIPMENT_NOT_FOUND` (ownership is never leaked).

## When it's allowed
A proof can be attached only once the shipment has reached a **delivery outcome**:

| Shipment status | Proof upload |
|---|---|
| `agent_delivered`, `delivered`, `failed` | ✅ allowed |
| anything earlier (`assigned`, `picked_up`, `in_transit`, …) | ❌ `409 SHIPMENT_PROOF_NOT_ALLOWED` |

Exactly **one** proof exists per shipment: re-uploading **replaces** the previous
image (the old one is removed and its bytes freed from the agency).

---

## Endpoints

### POST /api/agent/shipments/:id/delivery-proof
Attach or replace the proof. `multipart/form-data`, single field **`file`**.

- Allowed types: `image/jpeg`, `image/png`, `image/webp`. Max **10 MB**, exactly **1** file.
- The file is owned by the shipment's agency and counts toward the
  **agency's** storage cap. If the agency is at 100% of its cap, the upload is
  rejected with `UPLOAD_POLICY_VIOLATION` (`QUOTA_EXCEEDED`).

- Since 2026-08-19 the bytes are **virus-scanned** and the type is checked against the
  **sniffed** bytes rather than the declared `Content-Type`. An infected file is a
  `VIRUS_DETECTED` violation inside `UPLOAD_POLICY_VIOLATION`; a scanner that could not be
  reached is `502 UPLOAD_VIRUS_SCAN_UNAVAILABLE` — a retryable dependency failure, **not** a
  verdict on the photo.

**Success** — `201 Created`:
```json
{
  "success": true,
  "data": {
    "id": "665f0c…",
    "key": "shipments/…webp",
    "url": null,
    "access": "authorized",
    "mimeType": "image/webp",
    "size": 184320,
    "originalName": "proof.jpg"
  },
  "message": "Delivery proof uploaded"
}
```

> 🔴 **`url` is `null`, and that is not a bug.** The `shipments/` storage tree left the public
> static mount on 2026-08-19 (ADR-A01 D-2): a proof photo is a place and a time about a real
> customer's address, and it used to be fetchable forever by anyone who had seen the URL. Use
> the byte route below. Full detail:
> [FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md).

### GET /api/agent/shipments/:id/delivery-proof
The current proof's **metadata** as a `FileDetail`, or `null` when none is attached. Use it to
know whether a proof exists and to render `originalName` / `size`.
```json
{ "success": true, "data": { "id": "…", "key": "shipments/…webp", "url": null,
  "access": "authorized", "mimeType": "image/webp", "size": 184320 } }
```

### GET /api/agent/shipments/:id/delivery-proof/file
**The image bytes** — the route that replaced the public URL.

| | |
|---|---|
| Returns | the raw image · `Content-Type` from the file |
| Headers | `Content-Disposition: inline` · `Cache-Control: private, no-store` |
| Authorization | the **shipment's own** — the same scoping as `GET /api/agent/shipments/:id` |
| Not the agent's shipment, or no proof attached | **404**, never 403 |

A bearer client must fetch with its `Authorization` header and turn the response into a blob;
a cookie-session browser can point an `<img>` at it directly. The agency's equivalent is
`GET /api/agency/shipments/:id/delivery-proof/file`, scoped by the agency's own shipment read.

### DELETE /api/agent/shipments/:id/delivery-proof
Remove the proof (frees the agency's bytes).
```json
{ "success": true, "message": "Delivery proof removed" }
```
Returns `404 SHIPMENT_PROOF_NOT_FOUND` when there is nothing attached.

---

## Where it appears
The resolved proof is included as `deliveryProof` (a `FileDetail` or `null`) on the
shipment detail for both the agent (`GET /api/agent/shipments/:id`) and the agency
(`GET /api/agency/shipments/:id`).

## Error reference
| Code | HTTP | Meaning |
|---|---|---|
| `SHIPMENT_NOT_FOUND` | 404 | Not the agent's shipment (or doesn't exist). |
| `SHIPMENT_PROOF_NOT_ALLOWED` | 409 | Shipment is not yet at a delivery outcome. |
| `SHIPMENT_PROOF_FILE_REQUIRED` | 400 | No `file` field in the request. |
| `SHIPMENT_PROOF_NOT_FOUND` | 404 | DELETE with no proof attached. |
| `UPLOAD_POLICY_VIOLATION` | 400 | Not an image / >10 MB / >1 file, or the agency is over its storage cap (`QUOTA_EXCEEDED`). |
