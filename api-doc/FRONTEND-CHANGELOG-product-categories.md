# FRONTEND-CHANGELOG — product categories, the cross-role half (2026-10-04)

**Backend:** jovi-mall `src/modules/categories/`. Record: `PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md`.

This file holds only what every app shares. Your app's own tasks are in
`FRONTEND-CHANGELOG-product-categories.md` inside your role folder.

## What changed

A product used to carry one free-text `category`, so "Shoes", "shoes" and "Shoe" were three
different shelves. Now there is **one marketplace-wide category list**, and a product holds
**1 to 5** of its entries. Vendors create entries by naming them on a product. The backend
handles each name:
- **Spelling variants** are reused silently: case, accents, spacing, hyphens, `&`/`and`/`et`,
  and singular/plural in English and French.
- **Probable typos** are answered with "Did you mean …?".
- **Anything else** is created on the spot.

Administrators curate the list: rename, merge and delete.

## The shared shape

Every product payload from every endpoint now carries:

```ts
categories: Array<{ id: string; name: string; slug: string }>;  // 1–5, vendor's order; [0] is the primary
category: string | null;                                       // ⚠ DEPRECATED — categories[0].name
```

- `id` is stable across renames, and an id that was merged away still resolves to the category
  it was merged into.
- `slug` is URL-shaped, but it changes on a rename.
- Store and link by **id** or **slug**. **Never by name.**

## The transition

- Every product **write** still accepts the old single `category` string, as long as
  `categories` is absent. Sending both is a `400`.
- Every product **read** still returns `category`, holding the primary category's name.

Move to `categories` now. The old field will be removed later, and that removal will be
announced.

## Existing data

A one-time conversion runs every old category string through the same duplicate check.
"wellness" and "Wellness" become one category. On an environment where it has not run yet,
products show `categories: []` and `category: null`. Render that as "no category"; it is not
an error.

## Error codes (all apps)

| Code | Status | Meaning |
|---|---|---|
| `CATEGORY_SIMILAR_EXISTS` | 422 | Product write: a typed name looks like an existing category. It asks a question; nothing was written (`details.conflicts`) |
| `CATEGORY_NAME_INVALID` | 400 | Product write: an unusable name, or both `categories` and `category` sent |
| `CATEGORY_NOT_FOUND` | 404 | An `{ id }` that no longer exists |

Full table: [errors/README.md § Product categories](./errors/README.md#product-categories--2026-10-04).
