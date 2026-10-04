# FRONTEND-CHANGELOG — agency dashboard: product categories (2026-10-04)

Shared shape: [../FRONTEND-CHANGELOG-product-categories.md](../FRONTEND-CHANGELOG-product-categories.md).
Endpoint reference: [products.md](./products.md).

Products now have **1 to 5 categories** from one shared list, instead of one free-text string.
Agencies don't edit products, so the only change on this side is a field on product rows.

## What to change

`GET /api/agency/products` rows now carry:

```ts
categories: Array<{ id: string; name: string; slug: string }>;  // first = primary
category: string | null;                                       // ⚠ deprecated — categories[0].name
```

- Render the categories from `categories`. Show the primary one, or all of them as chips.
- Stop reading `category`. It still works during the transition, but it only ever holds the
  first category.
- `categories` can be `[]` on data that hasn't been converted yet. Render it as no category.

Nothing else on the agency side changed.
