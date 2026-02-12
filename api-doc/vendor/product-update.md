# Vendor Product Workflow Guide

Primary guide for Frontend Developers implementing the "Add/Edit Product" user interface.
This document outlines the **required API instruction sequence** for creating Physical, Digital, and Service products.

> [!IMPORTANT]
> **Product vs Variant**
> All product types MUST have at least one **Variant**.
> - **Product**: Contains title, description, and type-specific config (files, booking rules).
> - **Variant**: Contains the **Price**, **Stock**, and **SKU**.
> You cannot activate a product without creating a variant first.

---

## 1. Physical Product Workflow
**Use Case**: Selling T-Shirts, Electronics, Furniture.

### Step 1: Create Draft Shell
Create the base product. It starts as `draft`.

```http
POST /api/vendor/products
```
**Payload:**
```json
{
  "title": "Vintage Leather Jacket",
  "type": "physical",
  "description": "<p>High quality leather...</p>"
}
```
**Return:** `{ "id": "prod_123", "status": "draft" }`

### Step 2: Upload Images (Optional but Recommended)
Upload images to the product.

```http
POST /api/vendor/products/prod_123/images
```
**Payload:** `FormData` (files)

### Step 3: Create Variant (The Inventory)
You must create at least one variant to set the price.

```http
POST /api/vendor/products/prod_123/variants
```
**Payload:**
```json
{
  "sku": "LEATHER-J-BLK-M",
  "price": 199.99,
  "stock": 50,
  "weight": 1.5,
  "dimensions": { "length": 30, "width": 20, "height": 5 },
  "optionSignature": "Color:Black|Size:M" 
}
```
**Return:** `{ "id": "var_456" }`

### Step 4: Validate and Publish
Backend will check if a Price/Variant exists.

```http
PATCH /api/vendor/products/prod_123/status
```
**Payload:** `{ "status": "active" }`

---

## 2. Digital Product Workflow
**Use Case**: Ebooks, Software, Music, Design Assets.
**Constraint**: 1 Product = 1 File. Use separate products for different file formats.

### Step 1: Create Draft Shell
Note: You do NOT send `digitalConfig` yet because you haven't uploaded the file.

```http
POST /api/vendor/products
```
**Payload:**
```json
{
  "title": "Ultimate Node.js Guide (PDF)",
  "type": "digital",
  "description": "Master Node.js in 30 days."
}
```
**Return:** `{ "id": "prod_789", "status": "draft" }`

### Step 2: Upload the Asset
Use the Product ID from Step 1 to upload the secure file.

```http
POST /api/vendor/products/prod_789/digital/asset
```
**Payload:** `FormData` (file: `ebook.pdf`)
**Return:**
```json
{
  "assetId": "asset_999",
  "filename": "ebook.pdf"
}
```
*The backend automatically updates `product.digitalConfig.assetId`.*

### Step 3: Create Pricing Variant
Even digital products need a variant for the price.

```http
POST /api/vendor/products/prod_789/variants
```
**Payload:**
```json
{
  "sku": "NODE-GUIDE-PDF",
  "price": 29.99,
  "isInfiniteStock": true,
  "stock": 0,    // Ignored
  "weight": 0,   // Ignored
  "optionSignature": "default"
}
```

### Step 4: Configure Access (Optional)
Set download limits if needed.

```http
PATCH /api/vendor/products/prod_789
```
**Payload:**
```json
{
  "digitalConfig": {
    "maxDownloads": 5,
    "expiresAfterDays": 365,
    "assetId": "asset_999" // optional if already set by upload
  }
}
```

### Step 5: Publish
```http
PATCH /api/vendor/products/prod_789/status
```
**Payload:** `{ "status": "active" }`

---

## 3. Service Product Workflow
**Use Case**: Consulting Calls, Haircuts, Classes.

### Step 1: Create Draft Shell
```http
POST /api/vendor/products
```
**Payload:**
```json
{
  "title": "1 Hour Consultation",
  "type": "service",
  "description": "Expert advice on..."
}
```
**Return:** `{ "id": "prod_555", "status": "draft" }`

### Step 2: Configure Service Rules
Define how long the service takes.

```http
PATCH /api/vendor/products/prod_555
```
**Payload:**
```json
{
  "serviceConfig": {
    "durationMinutes": 60,
    "bookingMode": "calendar", // or "manual"
    "bufferBeforeMinutes": 10,
    "bufferAfterMinutes": 10
  }
}
```

### Step 3: Create Pricing Variant
Create the "Price per session".

```http
POST /api/vendor/products/prod_555/variants
```
**Payload:**
```json
{
  "sku": "CONSULT-1H",
  "price": 150.00,
  "isInfiniteStock": true, // Availability is checked against calendar, not stock count
  "stock": 0,
  "optionSignature": "default"
}
```

### Step 4: Publish
```http
PATCH /api/vendor/products/prod_555/status
```
**Payload:** `{ "status": "active" }`

---

## 4. Updates & Deletions

### Partial Updates
You can update product details anytime.
```http
PATCH /api/vendor/products/:id
```
**Payload:** `{ "title": "New Title" }`

### Archive (Soft Delete)
To hide a product from customers without losing sales data.
```http
DELETE /api/vendor/products/:id
```
**Result**: Status becomes `archived`.

### Replacing Digital Files
To release "v2.0" of an ebook.
1.  **Call**: `PUT /api/vendor/products/:id/digital/asset`
2.  **Payload**: New File.
3.  **Result**: Old file deleted, new file linked, all *future* downloads get the new file.
