# FRONTEND-CHANGELOG — storefront: product categories (2026-10-04)

Shared shape and transition rules:
[../FRONTEND-CHANGELOG-product-categories.md](../FRONTEND-CHANGELOG-product-categories.md).
Endpoint reference: [catalog.md](./catalog.md), mainly `GET /api/public/categories` and the
`category` query parameter.

## In one paragraph

A product can now be listed under **1 to 5 categories** from one shared list, instead of one
free-text string. Every category has a stable `id` and a URL-friendly `slug`. A product shows
up under **every** one of its categories.

## What to change

### 1. Category chips and category pages

`GET /api/public/categories` now returns:

```json
[ { "id": "66ff…a1", "name": "Fashion", "slug": "fashion", "productCount": 48 } ]
```

- It still lists only categories with at least one product on sale.
- The order is still by count, then by name.
- `productCount` counts a multi-category product once in **each** of its categories.

Build category links and routes from **`slug`**, for example `/shop?category=fashion` or
`/category/fashion`.

### 2. The category filter

`GET /api/public/products?category=<value>` accepts a **slug** (preferred), an **id** or a
**name**:
- A name may be any spelling variant: `shoe` finds "Shoes".
- A typo does **not** match.
- An unknown value returns an **empty page** (`200`, `total: 0`), not an error. Render it as
  "No products in this category".
- Old links that use a category name still work.

### 3. Product cards and the product page

Product list rows, the product detail and the by-ids read carry:

```ts
categories: Array<{ id: string; name: string; slug: string }>;  // first = primary
category: string | null;                                       // ⚠ deprecated — categories[0].name
```

- Show the categories as links (by `slug`) on the product page, using breadcrumbs or tags.
- On a card, show the primary (`categories[0]`).
- Stop reading `category`.
- `categories` can be `[]` on data that hasn't been converted yet. Render it as no category.

### 4. Related products

The fallback strip (`meta.source: 'same_category'`) now means "shares any category with this
product". The wire shape is unchanged, so there is nothing to do beyond the copy if you show a
heading ("More in these categories").

## SEO notes

- Prefer the `slug` in category URLs. When an administrator renames a category its slug
  changes, but its `id` doesn't. If you need permanent URLs, include the id, or redirect from
  an old slug by looking up the id.
- Category names are vendor- or admin-written and are not translated. Show them as given.
