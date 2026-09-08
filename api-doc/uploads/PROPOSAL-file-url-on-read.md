# PROPOSAL — a supported way to display a file you just uploaded

**Status: ✅ APPROVED by the owner and IMPLEMENTED, 2026-09-08.** All four recommendations in § 4
were taken as written. The contract page is [README.md](./README.md); the behaviour is covered by
`npm run test:uploads` (83 assertions — the helper, the superset property, all three `access`
values, and a source scan asserting all four endpoints go through it).

This document is kept as the **decision record**, in the tense it was written in. § 4's
"RECOMMEND" lines are what was approved.
**Raised:** 2026-09-08 (session S9) · **Scope:** jovi-mall only · **Decision needed on:** 4 points in § 4

Everything below was verified against source on 2026-09-08. Line references are real and were
read. The four claims the session brief made are all correct; this document adds two the brief
missed (§ 2) and sharpens the framing of the gap itself (§ 1), because the sharper version changes
what the right fix is.

---

## 1 · What is actually missing — and what is not

The gap is **not** "the platform gives you no way to render a file". It gives you a very good one,
and the contract already states it
([README.md](./README.md#filedetail-vs-the-file-record)):

> **upload, keep the `id`, attach the `id`, and render from whatever the owning entity gives you
> back.**

Every entity that references a file returns a **`FileDetail`** — `{ id, key, url, access,
mimeType, size, originalName? }` — built at the single choke point
`toFileDetail` ([file-detail.resolver.ts:67](../../src/modules/catalog/read-models/file-detail.resolver.ts#L67)),
which is the only place on the platform where a URL is ever computed and the only place that
decides `access`. That design is sound and this proposal does not touch it.

**What has no answer is the window before attachment.** A file that has been uploaded but not yet
attached to anything belongs to no entity, so no entity can return a `FileDetail` for it. Two real
screens live entirely inside that window:

| Screen | Why it is in the window |
|---|---|
| **A media library** — browse what I have uploaded, pick one | The file may never have been attached, or may be about to be attached to something else |
| **An upload confirmation** — "you just uploaded this, here it is" | Attachment has not happened yet, and may be cancelled |

For those two, the prescribed answer does not apply, and there is nothing else. That is the gap.

### Why it matters more than it looks

`toFileDetail` does not merely build a string. It is also where **three** rules are enforced, all
of which a client is left to reimplement if it has no `FileDetail`:

1. a **private-tree** file gets `url: null, access: 'authorized'` (ADR-A01 D-2);
2. a **quota-blocked** file gets `url: null, access: 'quota_blocked'`;
3. **blocked outranks private** — the order is load-bearing, so a blocked file in a private tree
   reports a billing problem rather than a permissions one.

So the missing field is not a convenience. It is the carrier for the platform's storage-privacy
and plan-quota decisions.

---

## 2 · Two things the brief did not mention, and both matter

### 2.1 · It is **four** endpoints, not two — and the one that matters most was not listed

| Endpoint | Returns today | Passes through `toFileDetail`? |
|---|---|---|
| `POST /api/files/upload` | `File[]` — raw records | no |
| `POST /api/files/upload/video` | `File[]` — raw records | no |
| **`GET /api/files`** (list) | `{ files: File[], storage, pagination }` | **no** |
| `GET /api/files/:id` | `{ ...file, usage }` | no |

**`GET /api/files` is the one a media library actually calls** — a library is a *list* screen, not
a by-id screen. It was absent from the brief and is the most important of the four.

The only route on the whole platform that answers a `FileDetail` for an arbitrary file id is
`POST /api/internal/admin/files/resolve`
([admin-file.routes.ts:109](../../src/modules/catalog/routes/admin-file.routes.ts#L109)) — behind
`requireAdminCaller` and wi-admin's `files.resolve` permission. Confirming the brief: an
administrator has a door here and a vendor, agency or agent has none.

### 2.2 · A client has already paid for this, and its workaround is wrong in three ways

`vendor-dash` has reimplemented the backend's classifier in
`src/services/files.service.ts`. Its own comment names the cause:

> 🔴 The key-based fallback exists for `GET /api/files`, which returns raw file records carrying
> **no `url` and no `access`** — reconstructing from `key` is the only option there, and the
> backend docs acknowledge that as a contract gap.

Compared against the backend it copies
([storage-trees.ts](../../src/core/storage/storage-trees.ts)), that copy diverges three times:

| # | Backend | vendor-dash copy | Consequence |
|---|---|---|---|
| 1 | `access` has **three** values | `type FileAccess = 'public' \| 'authorized'` — `quota_blocked` does not exist in the type | A quota-blocked file is **structurally unrepresentable**. The bytes are still on the static mount (blocking is a flag, not an unmount), so the library renders it normally and the plan-quota enforcement is **invisible on the screen built to show storage** |
| 2 | `isPrivateStorageKey` **fails closed** — an unclassified tree is private | `PRIVATE_KEY_PREFIXES.some(...)` — an unlisted prefix is **public** | A private tree added later is rendered as a public URL by this client until someone edits a hardcoded array in another repository |
| 3 | `treeOfKey` normalises **backslashes** (the local provider builds keys with `path.join`, so a key written on Windows carries `\`) | strips a leading `/` only | A `shipments\2026\…` key classifies as **public** |

It has also introduced a **third** place the public base URL is configured
(`VITE_FILE_BASE_URL`, falling back to `${BASE_URL}/files`), beside jovi-mall's `STORAGE_LOCAL_URL`
and wi-admin's copy of the same four variables. A mismatch in any of them is silent and presents as
*"the files are gone"* rather than as a misconfiguration.

**This is the argument for fixing it in the backend rather than documenting the workaround better.**
The rules are not hard, but they are subtle in exactly the way that makes every independent
reimplementation wrong somewhere, and each one is wrong somewhere different.

---

## 3 · Who is affected

| App | Calls these endpoints? | Impact |
|---|---|---|
| **vendor-dash** | yes — list + upload, with the workaround above | Would delete `resolveFileUrl` / `fileAccessForKey` / `PRIVATE_KEY_PREFIXES` and read the fields directly. **Three latent defects close with it.** |
| **agency-dash** | yes — `/files/upload`, `/files/upload/video`, `/files/storage` | Uploads only; no library screen. **No change required.** |
| **agent_app** | yes — `/files/upload`, `/files/storage` | Uploads by id, renders from the owning entity. **No change required.** |
| **landing** | yes — `/api/files/upload` | Uploads by id. **No change required.** |
| **admin-dash** | **no** | Uses wi-admin's own media library (`/files/library`, BR-015 / ADR-021 D-3), which builds `FileDetail.url` itself from `STORAGE_*`. **Unaffected — it already has a door.** |

**Nobody is forced to change.** Under the recommended option (§ 4.1) every existing field stays,
so all five apps keep working untouched; vendor-dash *chooses* to delete its workaround.

---

## 4 · The four decisions

### 4.1 · Add the computed fields, or replace the shape? → **RECOMMEND: ADD**

Add `url` and `access` to the records these four endpoints already return. Do not replace the
record with a `FileDetail`.

Replacing is cleaner in the abstract and wrong here, for a concrete reason: the file record carries
**15** fields and `FileDetail` carries **7**, so replacement drops **10** —
`provider, checksum, ownerType, ownerId, orphanedAt, quotaBlockedAt, createdAt, updatedAt,
deletedAt, purgeAt`.

Two of those are load-bearing on the very endpoint that needs this most: `GET /api/files` accepts
`sortBy` ∈ `{createdAt, updatedAt, size, originalName}`
([file-management.validator.ts:42](../../src/api/validators/file-management.validator.ts#L42)).
**Replacing the shape would let a client sort by upload date and never display it.**

The result is a strict superset — the same object plus two fields — so no client breaks, and a
client that wants a `FileDetail` can read the seven fields it needs straight off it.

> ⚠ **Whatever is decided, the two fields must come from `toFileDetail` itself, not from a second
> computation.** A second implementation of "is this private / is this blocked / which wins" is
> precisely the defect § 2.2 documents, and putting one in the backend would be worse than the
> frontend one because it would look authoritative.

### 4.2 · Does `usage` stay on `GET /api/files/:id`? → **RECOMMEND: YES, unchanged**

It answers a different question ("what breaks if I delete this?") and has no overlap with `url`.
Under § 4.1 there is no conflict at all — the response stays `{ ...file, usage }` and simply gains
two fields. This decision only becomes hard if § 4.1 is answered *replace*, which is the other
reason not to.

### 4.3 · What about the private trees? → **RECOMMEND: all three `access` values, verbatim**

`url: null` for `authorized` and for `quota_blocked`, with **blocked outranking private**. A media
library must render all three as normal states:

| `access` | Render |
|---|---|
| `public` | the image |
| `authorized` | a placeholder — the bytes come from the owning entity's authorized route, keyed on `id`. **Never** a hand-built URL; the private trees are off the static mount and it would 404 |
| `quota_blocked` | a placeholder plus a link to the plan page. **Not** an error, not "file missing" — nothing was deleted and it returns unchanged on upgrade |

This needs no new logic: it is what `toFileDetail` already does. It needs saying because
**vendor-dash's type cannot express the third value today**, so "just add the fields" without this
being explicit would leave the defect in place on the client side.

### 4.4 · Does the upload response change too, or only the read? → **RECOMMEND: change both**

Changing only the read is defensible but costs every client a second round trip after every upload,
for two fields the server has already computed — and an upload confirmation is one of the two
screens in § 1 that motivated this.

⚠ It does mean **deliberately reversing** the advice now in
[README.md](./README.md#post-filesupload): *"Do not build a display URL out of the upload
response, and do not expect one there."* That sentence is correct today and would become wrong.
Changing it is a contract edit that must land in the same change, in `api-doc/uploads/README.md`
and in the four frontend mirrors of it.

**If this one is declined**, the read-only version is still worth doing on its own — it closes the
media library, which is the larger of the two screens.

---

## 5 · Cost, and what is explicitly not proposed

**Cost.** Four handlers gain a `getStorageProvider()` call and a `.map(toFileDetail)`; no schema
change, no migration, no new route, no permission change. `GET /api/files` already loads full
records, so there is no extra query. Estimated: small.

**Not proposed here** — flagged so a decision is not read as covering them:

- **No change to `toFileDetail`, to `FileDetail`, or to the private-tree map.** This proposal adds
  a *caller*, nothing more.
- **No authorized-byte route for non-administrators.** `url: null` stays null for private files;
  the bytes still come from the owning entity's own scoped route. Adding a general one would
  rebuild the entity's authorization rules on a file route, which ADR-A01 D-2 exists to prevent.
- **No signed URLs.**
- **No change to wi-admin or geo-tracker.** Single-repository change.

---

## 6 · If this is approved

1. Add the two fields at the four endpoints, sourced from `toFileDetail`.
2. Update `api-doc/uploads/README.md` — the § "`FileDetail` vs the file record" table, and the two
   ⚠ notes that currently tell clients there is no `url` (only if § 4.4 is approved for the upload
   half).
3. Propagate to the four frontend mirrors of that page.
4. vendor-dash: delete `resolveFileUrl`, `fileAccessForKey` and `PRIVATE_KEY_PREFIXES`; widen
   `FileAccess` to the three values.
5. No other app changes.

## 7 · If this is declined

The gap stays open and § 2.2's three client defects stay live. The minimum honest follow-up is to
widen vendor-dash's `FileAccess` to three values and make its classifier fail closed — the
workaround is then merely duplicated rather than duplicated *and* wrong.
