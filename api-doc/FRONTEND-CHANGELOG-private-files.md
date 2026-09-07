# Frontend changelog — private files leave the public URL

**Date:** 2026-08-19 · **Breaking** · jovi-mall
**Design record:** [`docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md`](../docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md) D-2

> ⚠ **Read this before your next release if you render a delivery-proof photo.** One field on
> one shared shape changes, and the change is deliberately a *type* change so your compiler
> points at every place that needs looking at.

---

## What changed, in one paragraph

Three storage trees — **`digital/`**, **`shipments/`** and **`ticket-attachments/`** — are no
longer served by the static file mount. Their files come from an authorized route instead.
Every `FileDetail` for a file in one of those trees now returns **`url: null`** and a new
field **`access: "authorized"`**.

Everything else — product imagery, avatars, store logos and banners, videos, documents
uploaded through the general intake — is **unchanged**. Same URLs, same behaviour.

## Why

The static mount served the whole of `storage/`, and a stored file's `url` *was* that path. So
anyone who had ever seen the URL could fetch the file, forever, with no session:

- a **digital product** a customer bought could be re-shared by URL indefinitely, bypassing the
  download token's single-use consumption, its download counter and its revocation — all three
  were advisory while the raw path existed, and nothing recorded that it happened;
- a **delivery-proof photo** is a place and a time about a real customer's address.

## The wire change

`FileDetail` is the shape every referenced file comes back as — product media, avatars, logos,
banners, proof photos, ticket attachments. It gains one field and one of its fields becomes
nullable:

```diff
  {
    "id": "66b1…",
    "key": "shipments/2026/08/9f2c…_proof.jpg",
-   "url": "https://api.example.com/api/files/shipments/2026/08/9f2c…_proof.jpg",
+   "url": null,
+   "access": "authorized",
    "mimeType": "image/jpeg",
    "size": 284119,
    "originalName": "proof.jpg"
  }
```

```jsonc
// a public file — unchanged except for the new field
{ "id": "…", "key": "images/…", "url": "https://…/api/files/images/…",
  "access": "public", "mimeType": "image/png", "size": 10241 }
```

| Field | Type | Meaning |
|---|---|---|
| `url` | `string \| null` | fetchable directly when a string. **`null` means there is no public URL** — use the authorized route below. |
| `access` | `"public" \| "authorized" \| "quota_blocked"` | which of the **three** this is. Always present. |

> ⚠ **`quota_blocked` was added after this page was written** (plan-quota enforcement,
> `modules/plan-quota/`), and it is **tested first** — before the private-tree check — so a
> blocked file inside a private tree reports `quota_blocked`, not `authorized`
> (`read-models/file-detail.resolver.ts:67-77`).
>
> It means **the owner is over their plan's storage cap and this file is one of the ones being
> held back**. `url` is `null`, exactly as for `authorized`, but the authorized byte routes below
> will not help — there is nothing wrong with the caller's permissions. It is **not a deletion**:
> the row, the bytes and the file's contribution to the owner's used-bytes total all survive, and
> an upgrade restores exactly the same files. Say "locked — over the storage limit", never
> "deleted".
>
> A two-value `switch` written against the table above will fall through to its `authorized`
> branch and send the user to the wrong support conversation.

**`url` is `null` rather than the authorized path on purpose.** An authorized path is a string
that looks exactly like a public URL, so a client keeps `<img src={url}>` and silently renders
nothing for anyone who is not signed in — a bug that shows up as "the photo is sometimes
missing" and takes a week to find. `null` breaks the build instead.

## What to do

**1. Anything rendering a file from `FileDetail.url` should branch on `access`.**

```ts
// TypeScript will now flag `url` as possibly null — that flag IS the migration list.
if (file.access === 'public' && file.url) {
  return <img src={file.url} />;
}
// authorized:     fetch through the owning entity's route (below), with credentials.
// quota_blocked:  no route will serve it. The OWNER is over their storage cap —
//                 show "locked, upgrade the plan", not a permissions error.
```

**2. Delivery-proof photos: use the new route.**

| Role | Route |
|---|---|
| agent | `GET /api/agent/shipments/:shipmentId/delivery-proof/file` |
| agency | `GET /api/agency/shipments/:shipmentId/delivery-proof/file` |

Both return the image bytes (`Content-Type` from the file, `Content-Disposition: inline`,
`Cache-Control: private, no-store`). Authorization is the **shipment's own** — the same scoping
as `GET /api/{agent,agency}/shipments/:id`, so if you can read the shipment you can read its
proof. A shipment that is not yours, or that has no proof, is **404** — never 403.

The metadata route is unchanged and still useful for `originalName` / `size` / "is there one":
`GET /api/agent/shipments/:id/delivery-proof`.

Because these are same-origin cookie-authenticated GETs, a browser `<img src="/api/agency/…">`
works directly. A bearer client (Capacitor / native) must fetch with its `Authorization` header
and turn the response into a blob URL.

**3. Digital products: nothing to do.** `GET /api/digital/download/:token` was already the
documented path and is unchanged. What changed is that it is now the *only* path — which is
what makes its single-use consumption, its counter and its revocation actually mean something.

**4. Ticket attachments: nothing to do today, and this is worth knowing.** The
`storage/ticket-attachments/` tree is legacy and holds one pre-existing file; a ticket
attachment today is an ordinary general-intake upload that lands in `images/` or `documents/`
and stays **public**. Making those private needs a dedicated upload path and is not in this
release — do not read this changelog as having closed that gap.

## What did NOT change

- Every public URL. Product imagery, avatars, logos, banners, videos and general documents keep
  the exact URLs they had.
- Any upload endpoint, request shape or response envelope.
- The 73 files already on disk — **this is a routing change, not a migration.** Nothing moved.
- Ticket attachment behaviour (see above).

## Please check before we ship

Per ADR-A01, the two surfaces most likely to be rendering a raw proof-photo URL are the
**agency dashboard** and the **agent app**. If either builds an `<img>` from
`shipment.deliveryProof.url`, it will render nothing after this release until it moves to the
route above. The backend cannot verify this from its own repository — hence this document.
