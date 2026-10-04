# FRONTEND-CHANGELOG — vendor dashboard: product categories (2026-10-04)

Shared shape and transition rules:
[../FRONTEND-CHANGELOG-product-categories.md](../FRONTEND-CHANGELOG-product-categories.md).
Endpoint reference: [categories.md](./categories.md).

## In one paragraph

A product now has **1 to 5 categories** from one marketplace-wide list, instead of one
free-text string. In the product editor (both the advanced flow and quick-add), the vendor
picks existing categories from an autocomplete or types new ones. The backend stops duplicates
in two ways:
- **Spelling variants** of an existing category are reused silently: "shoes", "SHOES",
  "Shoe" and "Shoes " all become **Shoes**.
- **Probable typos** ("Shose") are refused with a list of suggestions, so you can ask
  **"Did you mean Shoes?"**. The vendor picks the suggestion or confirms their own name.

## What to build

### 1. A multi-select category picker (1–5), in both editors

- **Autocomplete:** call `GET /api/vendor/categories?q=<typed text>&limit=20`, debounced.
  - Rows with `match` set to `exact`, `prefix` or `contains` are normal suggestions.
  - Rows with `match: 'similar'` are typo suggestions. Label them "Did you mean …?".
  - Without `q`, the endpoint returns the whole list alphabetically, for a browse dropdown.
- **Picked entries become chips.** A picked category is `{ id }`, and a typed, not-yet-existing
  name is `{ name }`. The first chip is the **primary**; let the vendor reorder if you can.
- **Limits:** stop at 5, and require at least 1 before submit.
- **Optional live check:** `POST /api/vendor/categories/check` with `{ names }` tells you, for
  each typed name, whether it is `existing`, `similar` (with `suggestions`), `new`
  (with `displayName`) or `invalid`. You can then show the "Did you mean" prompt before the
  vendor presses save. It writes nothing.

### 2. Send `categories` on every product write

These four endpoints now take `categories: Array<{ id } | { name, confirmNew? }>`:
- `POST /api/vendor/products`
- `PATCH /api/vendor/products/:id`
- `POST /api/vendor/products/simple`
- `PATCH /api/vendor/products/:id/simple`

Rules:
- **Create:** `categories` is required.
- **Update:** `categories` is optional. Leave it out to keep the current categories, or send it
  to **replace the whole list**.
- **Stop sending the old `category` string.** Sending both is a `400 CATEGORY_NAME_INVALID`.

### 3. Handle the "Did you mean …?" refusal

`422 CATEGORY_SIMILAR_EXISTS` means **nothing was saved**. `error.details.conflicts` lists
**every** problem name at once:

```json
{ "conflicts": [ { "name": "Shose", "suggestions": [ { "id": "66ff…a1", "name": "Shoes", "slug": "shoes" } ] } ] }
```

Show one dialog covering every conflict. For each one, the vendor either:
- **picks a suggestion:** replace that entry with `{ "id": "<suggestion id>" }`; or
- **keeps their own name:** resend it as `{ "name": "Shose", "confirmNew": true }`.

Then re-submit the same save. Keep the form state, because nothing else from the save was
applied.

### 4. Read `categories` everywhere a product is shown

- The product list rows and the product detail (`GET /api/vendor/products/:id`, plus every
  write response) carry `categories: [{ id, name, slug }]` and the deprecated `category`.
- Render the chips from `categories`.
- Hydrate the editor's picker from `categories`, as `{ id }` entries.

### 5. Errors to map

| Code | Status | UI |
|---|---|---|
| `CATEGORY_SIMILAR_EXISTS` | 422 | The "Did you mean" dialog above |
| `CATEGORY_NAME_INVALID` | 400 | "A category name must be 2–60 characters with at least one letter or digit" (`details.name` says which entry) |
| `CATEGORY_NOT_FOUND` | 404 | "That category no longer exists". Reload the list and let the vendor re-pick (it was probably merged by an administrator) |

## Behaviour worth knowing (do not re-implement)

- Matching happens on the server. Never de-duplicate names in the client beyond trimming.
- Names shorter than 4 characters never get a suggestion: "Cup" is never offered "Cap".
- A translation is not matched. "Chaussures" and "Shoes" stay two categories until an
  administrator merges them.
- A brand-new category is visible to every vendor immediately.
