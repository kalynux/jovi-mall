# Vendor — product categories

**Base:** `/api/vendor/categories` · role `vendor` · since 2026-10-04.
**Overview and the other dashboards:** [FRONTEND-CHANGELOG-product-categories.md](../FRONTEND-CHANGELOG-product-categories.md).

There is **one marketplace-wide category list**. A product carries **1–5** of its entries.
A vendor never creates a category directly: they **name** one on a product write, and the
backend's duplicate check decides between three outcomes:
- reuse an existing category, for a spelling variant;
- ask "Did you mean …?", for a probable typo;
- create a new category, for anything else.

There is deliberately no `POST /api/vendor/categories`.

## GET /api/vendor/categories

| Query | Type | Default | Notes |
|---|---|---|---|
| `q` | string ≤ 200 | — | Typed text. Absent: the whole list, alphabetical |
| `limit` | 1–200 | 50 | |

**Without `q`**, the whole list:

```json
{ "success": true, "data": {
  "categories": [ { "id": "66ff…a1", "name": "Shoes", "slug": "shoes" } ],
  "total": 214
} }
```

**With `q`**, the autocomplete. Each row says how it matched, in this order:

| `match` | Meaning |
|---|---|
| `exact` | The same category spelled differently: case, accents, spacing, hyphens, `&`/`and`/`et`, singular/plural (EN + FR), or a spelling merged in by an administrator |
| `prefix` | Its normalised name starts with what was typed |
| `contains` | Its normalised name contains what was typed |
| `similar` | A probable typo ("shose" → "Shoes"). Render it as "Did you mean …?" |

```json
{ "success": true, "data": { "categories": [
  { "id": "66ff…a1", "name": "Shoes", "slug": "shoes", "match": "exact" },
  { "id": "66ff…a2", "name": "Shoe Polish", "slug": "shoe-polish", "match": "prefix" }
] } }
```

## POST /api/vendor/categories/check

Optional. It tells you what saving would do with each typed name, so the editor can ask its
question while the vendor types instead of on save. **It writes nothing.**

Body: `{ "names": string[] }`, 1–5 entries.

```json
{ "success": true, "data": { "results": [
  { "name": "shoes",  "status": "existing", "category": { "id": "66ff…a1", "name": "Shoes", "slug": "shoes" }, "via": "name" },
  { "name": "Shose",  "status": "similar",  "suggestions": [ { "id": "66ff…a1", "name": "Shoes", "slug": "shoes" } ] },
  { "name": "garden tools", "status": "new", "displayName": "garden tools" },
  { "name": "!!",     "status": "invalid" }
] } }
```

## Naming categories on a product

Every product write takes `categories`: 1–5 entries, each one of

```ts
{ id: string }                          // picked from the list above
{ name: string; confirmNew?: boolean }  // typed
```

A name is cleaned first: trimmed, inner spaces collapsed, 2–60 characters, at least one letter
or digit. The vendor's **capitalisation is kept** on a new category. Order is kept and the
first entry is the product's primary. Duplicates in the list are ignored.

When a typed name is a probable typo of an existing category and `confirmNew` is absent, the
write is refused with `422 CATEGORY_SIMILAR_EXISTS`, listing every conflict
(`details.conflicts[] = { name, suggestions[] }`). **Nothing is written, not even the
genuinely new names in the same request.** Re-submit with either the suggested
`{ id }` or `{ name, confirmNew: true }`.

Two notes for the editor:
- **Under 4 characters, nothing is ever suggested.** "Cup" is never matched to "Cap", so a
  short new name is simply created.
- **A translation is not matched.** "Chaussures" is a different category from "Shoes"
  until an administrator merges them. After that merge, typing "chaussure" resolves to
  "Shoes" with no question.
