# Option / Value / Variant Management — Frontend Developer Guide

This document is the definitive reference for frontend developers implementing the product options, option values,
and variant management UI for **physical products** on Jovi Mall.

---

## Table of Contents

1. [Mental Model & Terminology](#1-mental-model--terminology)
2. [System Constraints (Know Before You Build)](#2-system-constraints-know-before-you-build)
3. [Core Data Shapes](#3-core-data-shapes)
4. [API Reference Cheatsheet](#4-api-reference-cheatsheet)
5. [Phase 1 — Initial Product Setup (Create Flow)](#5-phase-1--initial-product-setup-create-flow)
6. [Phase 2 — Editing Options & Regenerating Variants](#6-phase-2--editing-options--regenerating-variants)
7. [Variant Table UI](#7-variant-table-ui)
8. [UI State Machine](#8-ui-state-machine)
9. [Frontend Responsibility: Variant Matrix Generation](#9-frontend-responsibility-variant-matrix-generation)
10. [Common Scenarios with Code Examples](#10-common-scenarios-with-code-examples)
11. [Critical Rules & Common Pitfalls](#11-critical-rules--common-pitfalls)
12. [Error Codes Reference](#12-error-codes-reference)

---

## 1. Mental Model & Terminology

Understanding the data hierarchy is essential before building any UI:

```
Product (physical)
 ├── Options (attributes that define variant dimensions)
 │    ├── Option: "Color"  → position: 1
 │    │    ├── Value: { id: "val_001", value: "Black" }
 │    │    ├── Value: { id: "val_002", value: "White" }
 │    │    └── Value: { id: "val_003", value: "Navy" }
 │    └── Option: "Size"   → position: 2
 │         ├── Value: { id: "val_010", value: "S" }
 │         ├── Value: { id: "val_011", value: "M" }
 │         └── Value: { id: "val_012", value: "L" }
 │
 └── Variants (one per unique combination of option values)
      ├── Variant: { sku, price, stock, optionValueIds: ["val_001", "val_010"] }  → Black / S
      ├── Variant: { sku, price, stock, optionValueIds: ["val_001", "val_011"] }  → Black / M
      ├── Variant: { sku, price, stock, optionValueIds: ["val_001", "val_012"] }  → Black / L
      ├── Variant: { sku, price, stock, optionValueIds: ["val_002", "val_010"] }  → White / S
      └── ... (9 total for 3 colors × 3 sizes)
```

| Term | Definition |
|------|-----------|
| **Option** | An attribute dimension (e.g., "Color", "Size"). A product can have **max 3 options**. |
| **Option Value** | A specific choice within an option (e.g., "Black", "Medium"). Max **50 per bulk create**. |
| **Variant** | A unique SKU combining one value from each option. Holds price, stock, dimensions. |
| **optionValueIds** | The array of value ObjectIds on a variant — the IDs that tell you which option values it represents. |
| **optionSignature** | A system-computed read-only string derived from sorted `optionValueIds`. Used by the backend to prevent duplicate combinations. **Never send this.** |
| **Cartesian Product** | The full matrix of combinations: 3 colors × 3 sizes = 9 variants. |
| **Variant Regeneration** | The process of reconciling variants when options/values change. Handled on the **frontend** by archiving removed variants and creating new ones. |

---

## 2. System Constraints (Know Before You Build)

These are hard limits enforced by the backend. Plan your UI around them.

| Constraint | Limit | Notes |
|------------|-------|-------|
| Max options per product | **3** | Attempting a 4th option returns a 422 error |
| Max values per option (bulk) | **50** | Values beyond 50 must be added in separate requests |
| Max variants per product | **1,000** | 10 colors × 100 sizes would exceed this |
| Option name characters | Alphanumeric + spaces + hyphens only | Regex: `/^[a-zA-Z0-9\s-]+$/` |
| Option name length | 1–50 chars | |
| Option value length | 1–100 chars | |
| Option values are unique per option | Case-insensitive | "Black" and "black" are the same — the backend will return a `409` |
| Variants apply to physical products only | — | Digital/service products cannot have `optionValueIds` |
| `optionValueIds` cannot be updated | — | To change a variant's options, archive it and create a new one |
| `optionSignature` is read-only | — | Never send this in a request body |

---

## 3. Core Data Shapes

### Option Object (returned by API)
```json
{
  "id": "507f1f77bcf86cd799439020",
  "productId": "507f1f77bcf86cd799439011",
  "name": "Color",
  "position": 1,
  "values": [
    { "id": "507f1f77bcf86cd799439030", "optionId": "507f1f77bcf86cd799439020", "value": "Black" },
    { "id": "507f1f77bcf86cd799439031", "optionId": "507f1f77bcf86cd799439020", "value": "White" }
  ]
}
```

> **Note:** The `values` array in `GET /options` is joined by the backend at query time — it fetches all values for the product's options in a single batch query and nests them by `optionId`. The values are NOT stored on the option document itself in the DB.

### Variant Object (returned by API)
```json
{
  "id": "507f1f77bcf86cd799439015",
  "productId": "507f1f77bcf86cd799439011",
  "sku": "TSHIRT-BLK-M",
  "name": "Black / Medium",
  "status": "active",
  "optionSignature": "507f1f77bcf86cd799439030|507f1f77bcf86cd799439031",
  "price": 29.99,
  "compareAtPrice": 39.99,
  "stock": 100,
  "isInfiniteStock": false,
  "lowStockThreshold": 10,
  "allowOversell": false,
  "weight": 200,
  "length": 30,
  "width": 20,
  "height": 2,
  "optionValueIds": ["507f1f77bcf86cd799439030", "507f1f77bcf86cd799439031"],
  "files": [],
  "deliveryAgencyId": "507f1f77bcf86cd799439050"
}
```

---

## 4. API Reference Cheatsheet

All endpoints require `Authorization: Bearer <vendor_jwt>`.

### Option Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/vendor/products/:productId/options` | Create a new option |
| `GET` | `/api/vendor/products/:productId/options` | List options (with nested values) |
| `PATCH` | `/api/vendor/products/:productId/options/:optionId` | Rename option or update position |
| `PUT` | `/api/vendor/products/:productId/options/reorder` | Reorder options |
| `DELETE` | `/api/vendor/products/:productId/options/:optionId` | Delete option **and all its values** (cascade) |

### Option Value Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/vendor/products/:productId/options/:optionId/values` | Add a single value |
| `POST` | `/api/vendor/products/:productId/options/:optionId/values/bulk` | Add multiple values (max 50) |
| `GET` | `/api/vendor/products/:productId/options/:optionId/values` | List values for an option |
| `PATCH` | `/api/vendor/products/:productId/options/:optionId/values/:valueId` | Rename a value |
| `DELETE` | `/api/vendor/products/:productId/options/:optionId/values/:valueId` | Delete a single value |

### Variant Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/vendor/products/:id/variants` | Create a variant |
| `GET` | `/api/vendor/products/:id/variants` | List variants (filterable by status) |
| `GET` | `/api/vendor/products/:productId/variants/:variantId` | Get single variant |
| `PATCH` | `/api/vendor/products/:productId/variants/:variantId` | Update price, stock, dimensions, etc. |
| `DELETE` | `/api/vendor/products/:productId/variants/:variantId` | Archive a variant (soft delete) |

---

## 5. Phase 1 — Initial Product Setup (Create Flow)

This is the exact sequence to follow when setting up options and variants for a **brand new physical product**.

### Step 1: Create the Product Draft

```http
POST /api/vendor/products
{
  "type": "physical",
  "title": "Classic T-Shirt",
  "category": "Apparel"
}
```

**Save the returned `id`** — this is `productId` for all subsequent calls.

---

### Step 2: Create Options

Create one option per attribute dimension. Max 3 options per product.

```http
POST /api/vendor/products/:productId/options
{ "name": "Color" }
```

Response:
```json
{ "id": "opt_color_id", "name": "Color", "position": 1 }
```

```http
POST /api/vendor/products/:productId/options
{ "name": "Size" }
```

Response:
```json
{ "id": "opt_size_id", "name": "Size", "position": 2 }
```

**Save each option's `id`** — you need it to add values.

---

### Step 3: Add Option Values (Bulk)

Add values to each option. The **returned IDs are critical** — they become the `optionValueIds` on variants.

```http
POST /api/vendor/products/:productId/options/opt_color_id/values/bulk
{ "values": ["Black", "White", "Navy"] }
```

Response:
```json
{
  "data": [
    { "id": "val_black", "value": "Black" },
    { "id": "val_white", "value": "White" },
    { "id": "val_navy",  "value": "Navy"  }
  ]
}
```

```http
POST /api/vendor/products/:productId/options/opt_size_id/values/bulk
{ "values": ["S", "M", "L", "XL"] }
```

Response:
```json
{
  "data": [
    { "id": "val_s",  "value": "S"  },
    { "id": "val_m",  "value": "M"  },
    { "id": "val_l",  "value": "L"  },
    { "id": "val_xl", "value": "XL" }
  ]
}
```

**Store all these IDs in your frontend state immediately.** They are used in the next step.

---

### Step 4: Generate & Create Variants (Cartesian Product)

The frontend is responsible for computing the combination matrix and making individual POST calls for each.

```javascript
// Example: Build the cartesian product from your stored option values
function cartesian(...arrays) {
  return arrays.reduce((acc, arr) =>
    acc.flatMap(combo => arr.map(val => [...combo, val])),
    [[]]
  );
}

const colors = [
  { id: "val_black", value: "Black" },
  { id: "val_white", value: "White" },
  { id: "val_navy",  value: "Navy"  }
];
const sizes = [
  { id: "val_s", value: "S" },
  { id: "val_m", value: "M" },
  { id: "val_l", value: "L" },
  { id: "val_xl", value: "XL" }
];

const combinations = cartesian(colors, sizes);
// → [
//     [{ id: "val_black", value: "Black" }, { id: "val_s", value: "S" }],
//     [{ id: "val_black", value: "Black" }, { id: "val_m", value: "M" }],
//     ...12 total
//   ]
```

Create each variant via POST:

```javascript
for (const combo of combinations) {
  const name = combo.map(v => v.value).join(' / ');          // "Black / S"
  const sku  = `TSHIRT-${combo.map(v => v.value.toUpperCase()).join('-')}`; // "TSHIRT-BLACK-S"
  const optionValueIds = combo.map(v => v.id);               // ["val_black", "val_s"]

  await fetch(`/api/vendor/products/${productId}/variants`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sku,
      name,
      price: 29.99,         // Default price; vendor edits per-variant later
      stock: 0,
      isInfiniteStock: false,
      optionValueIds,
      // Optional: weight, length, width, height, deliveryAgencyId
    })
  });
}
```

> **Do NOT send `optionSignature`** — the backend auto-computes it from sorted `optionValueIds`.

> **After the first variant is created**, the backend automatically sets `product.hasVariants = true` and `product.defaultVariantId` to that variant's ID. No separate action needed.

---

### Step 5: Show the Variant Table

After all variants are created, fetch them and render a table (see [Section 7](#7-variant-table-ui)):

```http
GET /api/vendor/products/:productId/variants
```

---

## 6. Phase 2 — Editing Options & Regenerating Variants

This is the most complex scenario. When a vendor **adds, removes, or renames** options or values on an existing product that already has variants, the frontend must **reconcile the variant matrix** — because the backend does not do this automatically via a single endpoint.

---

### Scenario A: Renaming an Option (Safe — No Variants Affected)

Renaming an option (e.g., "Color" → "Shade") does **not** affect variant `optionValueIds`.
However, if you use the auto-generated variant names like "Black / M", you should update those variant `name` fields manually via PATCH after renaming the option.

```http
PATCH /api/vendor/products/:productId/options/:optionId
{ "name": "Shade" }
```

Then update affected variant names:
```javascript
for (const variant of affectedVariants) {
  const newName = resolveVariantName(variant.optionValueIds, updatedOptions);
  await fetch(`/api/vendor/products/${productId}/variants/${variant.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName })
  });
}
```

---

### Scenario A½: Renaming an Option Value (Safe — No Variants Affected)

Renaming a value (e.g., "Blk" → "Black") changes only the display string. The value's `id` is unchanged, so **no variant `optionValueIds` or `optionSignature` are affected**. No variant re-creation needed.

```http
PATCH /api/vendor/products/:productId/options/:optionId/values/:valueId
{ "value": "Black" }
```

Response:
```json
{
  "success": true,
  "data": { "id": "val_001", "optionId": "opt_color_id", "value": "Black" },
  "message": "Option value updated successfully"
}
```

If variant names include the value string (e.g., "Blk / M"), update them afterward:
```javascript
for (const variant of affectedVariants) {
  const newName = resolveVariantName(variant.optionValueIds, updatedOptions);
  await fetch(`/api/vendor/products/${productId}/variants/${variant.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName })
  });
}
```

> **Key difference from deleting + re-creating:** Renaming preserves the value ID, so existing variants stay valid. Deleting and re-creating would orphan variant `optionValueIds` and force a full variant matrix rebuild.

---

### Scenario B: Adding a New Option Value (Additive — Safe)

Adding a new color "Red" to an existing product with "Black" and "White" means you need to create **new variants** for every combination involving "Red".

```http
POST /api/vendor/products/:productId/options/:optionId/values
{ "value": "Red" }
```

Response gives you `{ "id": "val_red", "value": "Red" }`.

Then create new variants for every existing size:
```javascript
const newColor = { id: "val_red", value: "Red" };
const existingSizes = [
  { id: "val_s", value: "S" },
  { id: "val_m", value: "M" },
  // ...
];

for (const size of existingSizes) {
  await createVariant({
    sku: `TSHIRT-RED-${size.value.toUpperCase()}`,
    name: `Red / ${size.value}`,
    optionValueIds: [newColor.id, size.id],
    price: 29.99,
    stock: 0,
    isInfiniteStock: false
  });
}
```

Existing variants for "Black" and "White" are **untouched**.

---

### Scenario C: Removing an Option Value (Destructive — Archive Variants)

Removing "Navy" from colors means **all Navy variants must be archived**. The backend cascade-deletes the option value document but does NOT automatically archive the variants.

**Step 1: Find affected variants** (frontend lookup — match by optionValueIds containing the deleted value's ID):
```javascript
const allVariants = await fetchVariants(productId);
const affectedVariants = allVariants.filter(v => v.optionValueIds.includes(valueIdToDelete));
```

**Step 2: Archive each affected variant**:
```javascript
for (const variant of affectedVariants) {
  await fetch(`/api/vendor/products/${productId}/variants/${variant.id}`, {
    method: 'DELETE' // soft archive
  });
}
```

**Step 3: Delete the option value**:
```javascript
await fetch(`/api/vendor/products/${productId}/options/${optionId}/values/${valueId}`, {
  method: 'DELETE'
});
```

> ⚠️ **Order matters**: Archive the variants FIRST, then delete the value. Reversing the order leaves orphaned `optionValueIds` in the DB (the variants still reference a non-existent value).

---

### Scenario D: Removing an Entire Option (Cascade — Full Regeneration)

Removing the "Color" option entirely is the most destructive operation. All color-differentiated variants become invalid.

**Step 1: Get all current variants**
```javascript
const allVariants = await fetchVariants(productId);
const activeVariants = allVariants.filter(v => v.status === 'active');
```

**Step 2: Get the option's value IDs** (so you know which variants reference this option)
```javascript
const optionValues = await fetchOptionValues(productId, optionId);
const deletedValueIds = new Set(optionValues.map(v => v.id));
```

**Step 3: Archive all variants that reference any of those values**
```javascript
for (const variant of activeVariants) {
  const isAffected = variant.optionValueIds.some(id => deletedValueIds.has(id));
  if (isAffected) {
    await archiveVariant(productId, variant.id);
  }
}
```

**Step 4: Delete the option** (backend cascades all its values)
```javascript
await fetch(`/api/vendor/products/${productId}/options/${optionId}`, {
  method: 'DELETE'
});
```

**Step 5: Create new variants** for the remaining option combinations.

---

### Scenario E: Full Option Matrix Reset (Complete Redo)

When the vendor completely rethinks their variants (e.g., going from Size × Color to just Size), perform a clean slate:

```javascript
async function resetVariantMatrix(productId, oldOptions, newOptions) {
  // 1. Archive all active variants
  const variants = await fetchVariants(productId);
  await Promise.all(
    variants
      .filter(v => v.status === 'active')
      .map(v => archiveVariant(productId, v.id))
  );

  // 2. Delete all old options (cascades values)
  await Promise.all(
    oldOptions.map(opt =>
      fetch(`/api/vendor/products/${productId}/options/${opt.id}`, { method: 'DELETE' })
    )
  );

  // 3. Create new options + values
  const createdOptions = [];
  for (const opt of newOptions) {
    const option = await createOption(productId, opt.name);
    const values = await bulkCreateValues(productId, option.id, opt.values);
    createdOptions.push({ ...option, values });
  }

  // 4. Generate and create new variant matrix
  await generateAndCreateVariants(productId, createdOptions);
}
```

---

## 7. Variant Table UI

The variant table is where vendors configure price, stock, and dimensions per SKU.

### Table Column Structure

| Column | Editable | Notes |
|--------|----------|-------|
| Option Labels (e.g., "Color", "Size") | No (read) | Resolved from `optionValueIds` by looking up value names |
| SKU | Yes (`PATCH sku`) | Must be globally unique |
| Price | Yes (`PATCH price`) | Required > 0 to publish |
| Compare At Price | Yes | Optional; shows "was" price |
| Stock | Yes | Ignored if `isInfiniteStock: true` |
| Infinite Stock | Yes (toggle) | — |
| Weight/Length/Width/Height | Yes | Physical only |
| Delivery Agency | Yes | Per-variant override |
| Status | Yes (archive button) | Cannot un-archive via PATCH — only archive |
| Images | Yes | Opens file picker; `PATCH fileIds` |

### Resolving Option Labels from optionValueIds

The API returns `optionValueIds` as an array of IDs. To show "Black / Medium" in the table, you need to resolve those IDs against your locally-cached option values:

```javascript
function resolveVariantLabel(optionValueIds, allOptions) {
  // allOptions is the result of GET /options (includes nested values)
  const valueMap = {};
  for (const option of allOptions) {
    for (const val of option.values) {
      valueMap[val.id] = { optionName: option.name, value: val.value, position: option.position };
    }
  }

  return optionValueIds
    .map(id => valueMap[id])
    .filter(Boolean)
    .sort((a, b) => a.position - b.position) // sort by option position
    .map(v => v.value)
    .join(' / '); // → "Black / Medium"
}
```

### Inline Editing

For inline cell editing in the variant table:

```javascript
async function updateVariantField(productId, variantId, field, value) {
  const res = await fetch(
    `/api/vendor/products/${productId}/variants/${variantId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ [field]: value })
    }
  );

  if (!res.ok) {
    const err = await res.json();
    // Show field-level error (e.g., SKU conflict → 409)
    throw new Error(err.error.message);
  }

  return res.json(); // updated variant
}
```

### Archiving a Variant

```javascript
async function archiveVariant(productId, variantId) {
  // The backend auto-reassigns defaultVariantId to the next active variant
  await fetch(`/api/vendor/products/${productId}/variants/${variantId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}
```

---

## 8. UI State Machine

The option/variant management UI has three distinct modes. Build your state around these:

```
MODE: NO_OPTIONS
 ├── Shown when: product has no options defined
 ├── Display: "This product has no options. Add options to create variants with different attributes."
 ├── CTA: "Add option" button → transitions to EDITING_OPTIONS
 └── Variant table: show simple 1-variant form (sku, price, stock only)

MODE: EDITING_OPTIONS
 ├── Shown when: vendor is in the process of configuring options and values
 ├── Display: Option builder UI (add/remove options, add/remove values per option)
 ├── "Apply & Generate Variants" button
 │     → Triggers frontend Cartesian product computation
 │     → Shows preview: "This will create N variants"
 │     → On confirm: creates all variants via API
 └── Transitions to: MANAGING_VARIANTS

MODE: MANAGING_VARIANTS
 ├── Shown when: product has options + generated variants
 ├── Display: Variant table (editable grid)
 ├── "Edit Options" button → shows warning dialog → transitions to EDITING_OPTIONS
 │     Warning: "Changing options may archive existing variants. Proceed?"
 └── "Add Variant" button (advanced, for manual variant creation without generator)
```

---

## 9. Frontend Responsibility: Variant Matrix Generation

Because `VariantRegenerationService` is not yet a public API endpoint, **the frontend owns the variant reconciliation logic**. Here is the complete algorithm to implement:

```javascript
/**
 * Reconcile variants with updated options.
 * Call this after the vendor finishes editing options and clicks "Apply".
 *
 * @param {string} productId
 * @param {Object[]} updatedOptions - Array of { id, name, position, values: [{ id, value }] }
 * @param {Object[]} existingVariants - Active variants from GET /variants
 */
async function reconcileVariants(productId, updatedOptions, existingVariants) {
  // 1. Compute expected combinations from updated options
  const valueArrays = updatedOptions
    .sort((a, b) => a.position - b.position)
    .map(opt => opt.values);

  const combinations = cartesian(...valueArrays); // [[val1, val2], [val1, val3], ...]

  // 2. Build a signature for each expected combination
  // Signature = sorted value IDs joined with "|" — mirrors backend's optionSignature
  const expectedSignatures = new Map(); // signature → combination
  for (const combo of combinations) {
    const sig = combo.map(v => v.id).sort().join('|');
    expectedSignatures.set(sig, combo);
  }

  // 3. Build a signature for each existing active variant
  const existingSignatures = new Map(); // signature → variant
  for (const variant of existingVariants.filter(v => v.status === 'active')) {
    const sig = [...variant.optionValueIds].sort().join('|');
    existingSignatures.set(sig, variant);
  }

  // 4. Determine what needs to be archived (exists in DB but not in new matrix)
  const toArchive = [];
  for (const [sig, variant] of existingSignatures) {
    if (!expectedSignatures.has(sig)) {
      toArchive.push(variant);
    }
  }

  // 5. Determine what needs to be created (in new matrix but not in DB)
  const toCreate = [];
  for (const [sig, combo] of expectedSignatures) {
    if (!existingSignatures.has(sig)) {
      toCreate.push(combo);
    }
  }

  // 6. Unchanged = in both sets → leave them alone
  // They keep their existing price, stock, dimensions, etc.

  // ---- Confirm with vendor ----
  const confirmed = await showConfirmDialog({
    toCreate: toCreate.length,
    toArchive: toArchive.length,
    unchanged: existingSignatures.size - toArchive.length
  });
  if (!confirmed) return;

  // ---- Execute ----

  // Archive removed variants
  for (const variant of toArchive) {
    await archiveVariant(productId, variant.id);
  }

  // Create new variants
  for (const combo of toCreate) {
    const name = combo.map(v => v.value).join(' / ');
    const sku  = generateSku(productId, combo); // your SKU generation logic
    await createVariant(productId, {
      sku,
      name,
      price: inferDefaultPrice(existingVariants), // average of existing or 0
      stock: 0,
      isInfiniteStock: false,
      optionValueIds: combo.map(v => v.id)
    });
  }
}

// Helper: average price from existing variants (use as default for new ones)
function inferDefaultPrice(variants) {
  const prices = variants.filter(v => v.status === 'active' && v.price > 0).map(v => v.price);
  if (prices.length === 0) return 0;
  return Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
}

// Helper: Cartesian product
function cartesian(...arrays) {
  return arrays.reduce((acc, arr) =>
    acc.flatMap(combo => arr.map(val => [...combo, val])),
    [[]]
  );
}
```

### Confirm Dialog Copy

Show this to the vendor before applying changes:

```
Applying these changes will:
  ✅ Keep 6 unchanged variants (existing price & stock preserved)
  ➕ Create 3 new variants (you'll need to set their price)
  ⚠️  Archive 2 variants that no longer match the option matrix

This cannot be undone. Archived variants' orders and history are preserved.
[Cancel]  [Apply Changes]
```

---

## 10. Common Scenarios with Code Examples

### Add a Single Option Value (e.g., add "XS" to sizes)

```javascript
async function addOptionValue(productId, optionId, value) {
  const res = await fetch(
    `/api/vendor/products/${productId}/options/${optionId}/values`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ value })
    }
  );
  if (res.status === 409) throw new Error('This value already exists');
  const data = await res.json();
  return data.data; // { id, optionId, value }
}
```

Then create new variants for every other option combination involving this new value (see Scenario B in Section 6).

---

### Reorder Options (drag-and-drop)

```javascript
async function reorderOptions(productId, orderedOptionIds) {
  // orderedOptionIds = option IDs in the new display order
  await fetch(`/api/vendor/products/${productId}/options/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ optionIds: orderedOptionIds })
  });
}
```

> Reordering options is display-only and does NOT affect variants.

---

### Bulk Update Variant Prices

The API does not support bulk updates. Loop through variants individually:

```javascript
async function bulkUpdatePrices(productId, variantUpdates) {
  // variantUpdates = [{ variantId, price }]
  const results = await Promise.allSettled(
    variantUpdates.map(({ variantId, price }) =>
      updateVariant(productId, variantId, { price })
    )
  );

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    showError(`${failed.length} price update(s) failed`);
  }
}
```

---

### Detect Variants with No Price Set

Use this before showing the "Publish" button:

```javascript
function getZeroPricedVariants(variants) {
  return variants.filter(v => v.status === 'active' && v.price <= 0);
}
```

---

### Count Total Variant Combinations Before Generating

Show a preview count to the vendor before creating variants — helps avoid accidentally hitting the 1,000-variant limit:

```javascript
function countCombinations(options) {
  if (options.length === 0) return 0;
  return options.reduce((count, opt) => count * (opt.values?.length ?? 0), 1);
}

const count = countCombinations(options);
if (count > 1000) {
  showError(`This would create ${count} variants. Maximum allowed is 1,000. Please reduce your option values.`);
  return;
}
```

---

## 11. Critical Rules & Common Pitfalls

### ❌ Never Send `optionSignature`

```javascript
// ❌ WRONG
await createVariant({ sku: '...', optionSignature: 'color:black|size:m', optionValueIds: [...] });

// ✅ CORRECT — backend computes optionSignature from optionValueIds automatically
await createVariant({ sku: '...', optionValueIds: ['val_black', 'val_m'] });
```

---

### ❌ Never Try to Update `optionValueIds` via PATCH

`optionValueIds` is immutable on a variant. If the option combination changes, archive the old variant and create a new one.

```javascript
// ❌ WRONG — backend ignores this field on PATCH
await updateVariant(productId, variantId, { optionValueIds: ['val_red', 'val_m'] });

// ✅ CORRECT
await archiveVariant(productId, oldVariantId);
await createVariant(productId, { optionValueIds: ['val_red', 'val_m'], sku: '...', price: 29.99, stock: 0 });
```

---

### ❌ Delete Option Value BEFORE Archiving Variants

Always archive variants first, then delete the option value. If you delete the value first, the remaining variants have orphaned IDs in `optionValueIds`.

---

### ❌ Don't Use Option Names as Identifiers

Never use string values like "Black" or "M" as keys. Always use the IDs (`val_black`, `val_m`) returned by the API. Names can change; IDs cannot.

---

### ❌ Appending to `fileIds`

Both product and variant `fileIds` are **full replacement arrays**. To add a file:

```javascript
// ❌ WRONG
await updateVariant(productId, variantId, { fileIds: [newFileId] }); // loses existing images

// ✅ CORRECT
const variant = await getVariant(productId, variantId);
const existingIds = variant.files.map(f => f.id);
await updateVariant(productId, variantId, { fileIds: [...existingIds, newFileId] });
```

---

### ⚠️ SKU Must Be Globally Unique

SKUs are unique **across all vendors and all products** in the entire system — not just within a product. A `409 CATALOG_VARIANT_SKU_EXISTS` error means the SKU is already in use by another vendor's product.

---

### ⚠️ Options Apply to Physical Products Only

Calling the options endpoints for a `digital` or `service` product returns `400 CATALOG_PRODUCT_INVALID_TYPE`. Guard against this in your UI by only showing the options builder when `product.type === 'physical'`.

---

## 12. Error Codes Reference

| Code | HTTP | Trigger | Resolution |
|------|------|---------|-----------|
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | productId is wrong or vendor doesn't own product | Verify product ID and auth |
| `CATALOG_PRODUCT_INVALID_TYPE` | 400 | Options/variants called on digital/service product | Only show for physical products |
| `CATALOG_VARIANT_SKU_EXISTS` | 409 | SKU already in use globally | Ask vendor to choose a different SKU |
| `CATALOG_VARIANT_NOT_FOUND` | 404 | variantId wrong or belongs to different product | Refresh variant list |
| `CATALOG_OPTION_NOT_FOUND` | 404 | optionId/valueId wrong or belongs to different product | Refresh options list |
| `CATALOG_INVALID_OPTION_ID` | 400 | Reorder array contains an unknown optionId | Validate IDs before sending reorder |
| `CATALOG_VARIANT_NO_OPTIONS` | 422 | Generator called with no options defined | Add options first |
| `CATALOG_VARIANT_OPTION_EMPTY` | 422 | An option has no values | Add values to all options |
| `CATALOG_VARIANT_LIMIT_EXCEEDED` | 422 | Combination count > 1,000 | Reduce option values; preview count before generating |
| `CATALOG_OPTION_REQUIRES_NO_OPTIONS` | 422 | DefaultVariantService called when options exist | Only use for simple (option-less) products |
| `CATALOG_PRODUCT_NO_VARIANTS` | 422 | Activation attempted with no variants | Create at least one variant |
| `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | 422 | Active variant has price = 0 | Update variant price > 0 |
| `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | 422 | defaultVariantId is unset or archived | First variant auto-sets it; use /default-variant to fix |
| `VALIDATION_ERROR` | 400 | Request body failed schema validation | See `error.details` array for field-level messages |

---

*Last updated: 2026-05-20*
