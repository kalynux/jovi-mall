# Product Service API Documentation

## Frontend Product Upload Reference

> **Document Purpose**: This is a **frontend-consumable API reference** for uploading and persisting products in the Jovi Mall platform. It is **NOT** a backend implementation guide.

**Intended Audience**: Frontend engineers implementing product upload UI

---

## Table of Contents

1. [High-Level Product Upload Lifecycle](#high-level-product-upload-lifecycle)
2. [Product Creation Flow (Common to All Types)](#product-creation-flow-common-to-all-types)
3. [Physical Product Upload Flow](#physical-product-upload-flow)
4. [Digital Product Upload Flow](#digital-product-upload-flow)
5. [Service Product Upload Flow](#service-product-upload-flow)
6. [Media Handling](#media-handling)
7. [Variant Strategy](#variant-strategy)
8. [Publishing & Status Transitions](#publishing--status-transitions)
9. [Frontend Implementation Guidelines](#frontend-implementation-guidelines)

---

## High-Level Product Upload Lifecycle

The product upload process follows a **deterministic state machine** with the following phases:

```
┌─────────────────────────────────────────────────────────────┐
│                    PRODUCT UPLOAD LIFECYCLE                  │
└─────────────────────────────────────────────────────────────┘

Phase 1: DRAFT CREATION
   ↓
   • Product created in 'draft' status
   • type, title, and category required
   • Returns productId for subsequent operations

Phase 2: CORE PRODUCT CONFIGURATION
   ↓
   • Update description, SEO fields
   • Configure type-specific settings (if applicable)
   • Non-blocking - can be done incrementally

Phase 3: MEDIA UPLOAD & LINKING
   ↓
   • Upload files via UploadIntakeService
   • Receive fileIds
   • Link fileIds to product/variant

Phase 4: VARIANT CREATION (Physical products only)
   ↓
   • Create product options (Size, Color, etc.)
   • Create product option values (S, M, L, Red, Blue)
   • Create variants with pricing, stock, dimensions

Phase 5: TYPE-SPECIFIC CONFIGURATION
   ↓
   • Physical: Configure delivery, inventory
   • Digital: Upload digital asset, configure access
   • Service: Configure duration, booking mode, availability

Phase 6: VALIDATION & PUBLISHING
   ↓
   • Frontend validates completeness
   • Backend validates requirements for activation
   • Change status from 'draft' → 'active'
```

### State Transitions

| From Status | To Status | Requirements |
|------------|-----------|--------------|
| draft | active | Type-specific validation must pass |
| draft | pending_review | Manual submission for review |
| active | archived | None |
| archived | active | Type-specific validation must pass |
| active | suspended | Admin action only |

---

## Product Creation Flow (Common to All Types)

All product types follow a common baseline creation flow before diverging into type-specific configurations.

### Step 1: Create Product Draft

**Purpose**: Initialize a product record in the database</br>
**Blocking**: Yes (must complete before any other operations)</br>
**Frontend Responsibility**: Collect type and title; call API</br>
**Backend Expectation**: Create product with 'draft' status

#### API Details

**Endpoint**: `POST /api/vendor/products`</br>
**HTTP Method**: POST</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `application/json`

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Product type: `'physical'`, `'digital'`, or `'service'` |
| `title` | string | Product title (3-200 characters) |
| `category` | string | Category the product belongs to (non-empty string) |

#### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Product description |
| `tags` | string[] | Array of unique, non-empty tag strings |
| `seoTitle` | string | SEO title (max 60 chars) |
| `seoDescription` | string | SEO description (max 160 chars) |
| `fileIds` | string[] | Array of file ObjectIds (24-char hex strings) |
| `digitalConfig` | object | Digital product configuration (see Digital Product Flow) |
| `serviceConfig` | object | Service product configuration (see Service Product Flow) |

#### Validation Rules

- `type` must be one of: `'physical'`, `'digital'`, `'service'`
- `title` must be 3-200 characters, trimmed
- `category` must be a non-empty string
- `tags`, if provided, must be an array of non-empty, unique strings
- `seoTitle` max 60 characters
- `seoDescription` max 160 characters
- `fileIds` must be valid ObjectId format (24-char hex)

#### Example Request

```json
POST /api/vendor/products
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "type": "physical",
  "title": "Premium Cotton T-Shirt",
  "category": "Apparel"
}
```

#### Example Response

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f191e810c19729de860ea",
    "type": "physical",
    "status": "draft",
    "title": "Premium Cotton T-Shirt",
    "description": "",
    "slug": "premium-cotton-t-shirt",
    "category": "Apparel",
    "tags": [],
    "seo": {},
    "hasVariants": false,
    "fileIds": [],
    "createdAt": "2026-02-12T17:30:00.000Z",
    "updatedAt": "2026-02-12T17:30:00.000Z"
  },
  "message": "Product created successfully"
}
```

**When to Call**: Immediately when user clicks "Create Product" or equivalent

---

### Step 2: Update Product Details (Optional)

**Purpose**: Add description, SEO fields, and type-specific configuration</br>
**Blocking**: No (can be done incrementally)</br>
**Frontend Responsibility**: Collect fields; call when ready to save</br>
**Backend Expectation**: Partial update of product fields

#### API Details

**Endpoint**: `PATCH /api/vendor/products/:id`</br>
**HTTP Method**: PATCH</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `application/json`

#### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Product title (3-200 characters) |
| `description` | string | Product description |
| `category` | string | Product category (non-empty string) |
| `tags` | string[] | Tags — replaces entire array; must be unique |
| `seoTitle` | string | SEO title (max 60 chars) |
| `seoDescription` | string | SEO description (max 160 chars) |
| `fileIds` | string[] | **FULL REPLACEMENT** of fileIds array |
| `digitalConfig` | object | Digital product configuration |
| `serviceConfig` | object | Service product configuration |

> **⚠️ CRITICAL**: The `fileIds` field is a **full array replacement**, not an append operation. Always send the complete array.

#### Validation Rules

- At least one field must be provided
- Same validation as creation for respective fields
- `fileIds` replaces entire array (not appended)

#### Example Request

```json
PATCH /api/vendor/products/507f1f77bcf86cd799439011
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "description": "High-quality cotton t-shirt with modern fit",
  "category": "Apparel",
  "tags": ["cotton", "summer", "casual"],
  "seoTitle": "Premium Cotton T-Shirt | Modern Fit",
  "seoDescription": "Shop our premium cotton t-shirt with modern fit. Available in multiple sizes and colors."
}
```

#### Example Response

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f191e810c19729de860ea",
    "type": "physical",
    "status": "draft",
    "title": "Premium Cotton T-Shirt",
    "description": "High-quality cotton t-shirt with modern fit",
    "slug": "premium-cotton-t-shirt",
    "category": "Apparel",
    "tags": ["cotton", "summer", "casual"],
    "seo": {
      "title": "Premium Cotton T-Shirt | Modern Fit",
      "description": "Shop our premium cotton t-shirt with modern fit. Available in multiple sizes and colors."
    },
    "hasVariants": false,
    "fileIds": [],
    "createdAt": "2026-02-12T17:30:00.000Z",
    "updatedAt": "2026-02-12T17:35:00.000Z"
  },
  "message": "Product updated successfully"
}
```

**When to Call**: When user clicks "Save" on product details form, or auto-save after debounce

---

## Physical Product Upload Flow

Physical products represent tangible goods that require inventory tracking, shipping configuration, and potentially variants.

### Complete Flow Sequence

```
1. Create Product Draft (type: 'physical')
2. Upload Media Files → Get fileIds → Link to product
3. Create Product Options (e.g., Size, Color)
4. Create Product Option Values (e.g., S, M, L / Red, Blue)
5. Create Variants (with pricing, stock, dimensions)
6. Link Media to Variants (optional variant-specific images)
7. Configure Variant Delivery Agency (optional, fallback to vendor default)
8. Configure Pricing & Comparison Price
9. Publish (change status → 'active')
```

### Step-by-Step Details

#### 3.1 Create Product Options

**Purpose**: Define which attributes can vary (e.g., Size, Color)</br>
**Blocking**: No, but required if using variants</br>
**Frontend Responsibility**: Collect option names; call API for each option

**Endpoint**: `POST /api/vendor/products/:productId/options`</br>
**HTTP Method**: POST</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `application/json`

##### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Option name (1-50 chars, alphanumeric + spaces/hyphens only) |

##### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `position` | number | Display order (auto-assigned if not provided) |

##### Validation Rules

- Only physical products can have options
- Option name must be unique per product
- Option name: alphanumeric characters, spaces, and hyphens only

##### Example Request

```json
POST /api/vendor/products/507f1f77bcf86cd799439011/options
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "name": "Size",
  "position": 1
}
```

##### Example Response

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439012",
    "productId": "507f1f77bcf86cd799439011",
    "name": "Size",
    "position": 1,
    "createdAt": "2026-02-12T17:30:00.000Z",
    "updatedAt": "2026-02-12T17:30:00.000Z"
  },
  "message": "Option created successfully"
}
```

**Additional Endpoints**:
- `GET /api/vendor/products/:productId/options` - List all options for a product
- `PATCH /api/vendor/products/:productId/options/:optionId` - Update option name or position
- `PUT /api/vendor/products/:productId/options/reorder` - Reorder options (Body: `{ "optionIds": [...] }`)
- `DELETE /api/vendor/products/:productId/options/:optionId` - Delete option (cascade deletes all values)

---

#### 3.2 Create Product Option Values

**Purpose**: Define specific values for each option (e.g., S, M, L for Size)</br>
**Blocking**: No, but required if using variants

**Endpoint**: `POST /api/vendor/products/:productId/options/:optionId/values`</br>
**HTTP Method**: POST</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `application/json`

##### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `value` | string | Option value (1-100 chars) |

##### Example Request

```json
POST /api/vendor/products/507f1f77bcf86cd799439011/options/507f1f77bcf86cd799439012/values
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "value": "Medium"
}
```

##### Example Response

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439013",
    "optionId": "507f1f77bcf86cd799439012",
    "value": "Medium",
    "createdAt": "2026-02-12T17:31:00.000Z"
  },
  "message": "Option value created successfully"
}
```

**Bulk Create Endpoint**:
- `POST /api/vendor/products/:productId/options/:optionId/values/bulk`
  - Body: `{ "values": ["S", "M", "L", "XL"] }`
  - Max 50 values per request
  - Useful for creating multiple values at once

**Additional Endpoints**:
- `GET /api/vendor/products/:productId/options/:optionId/values` - List all values for an option
- `DELETE /api/vendor/products/:productId/options/:optionId/values/:valueId` - Delete option value

#### 3.3 Create Variants

**Purpose**: Define SKU-level products with specific attributes, pricing, and stock</br>
**Blocking**: Not mandatory for physical products</br>
**Frontend Responsibility**: Collect variant data; call API for each variant

**Endpoint**: `POST /api/vendor/products/:id/variants`</br>
**HTTP Method**: POST</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `application/json`

##### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `sku` | string | Unique SKU identifier (1-100 chars) |
| `price` | number | Variant price (must be >= 0) |
| `stock` | number | Stock quantity (integer >= 0) |
| `isInfiniteStock` | boolean | If true, stock is unlimited |

##### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `compareAtPrice` | number | Original/comparison price (for discounts) |
| `weight` | number | Weight in grams (>= 0) |
| `length` | number | Length in cm (>= 0) |
| `width` | number | Width in cm (>= 0) |
| `height` | number | Height in cm (>= 0) |
| `optionValueIds` | string[] | Array of ProductOptionValue IDs |
| `deliveryAgencyId` | string | Delivery agency for this variant (ObjectId) |

##### Validation Rules

- `sku` must be globally unique across all variants
- `price` must be non-negative
- `stock` must be non-negative integer
- `deliveryAgencyId` must be valid ObjectId format
- `deliveryAgencyId` **only applicable for physical products**

##### Example Request

```json
POST /api/vendor/products/507f1f77bcf86cd799439011/variants
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "sku": "TSHIRT-RED-M",
  "price": 29.99,
  "compareAtPrice": 39.99,
  "stock": 100,
  "isInfiniteStock": false,
  "weight": 200,
  "length": 30,
  "width": 20,
  "height": 2,
  "optionValueIds": ["507f1f77bcf86cd799439012", "507f1f77bcf86cd799439013"],
  "deliveryAgencyId": "507f1f77bcf86cd799439014"
}
```

##### Example Response

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439015",
    "productId": "507f1f77bcf86cd799439011",
    "sku": "TSHIRT-RED-M",
    "status": "active",
    "optionSignature": "507f1f77bcf86cd799439012|507f1f77bcf86cd799439013",
    "price": 29.99,
    "compareAtPrice": 39.99,
    "stock": 100,
    "isInfiniteStock": false,
    "low_stock_threshold": null,
    "allow_oversell": false,
    "weight": 200,
    "length": 30,
    "width": 20,
    "height": 2,
    "optionValueIds": ["507f1f77bcf86cd799439012", "507f1f77bcf86cd799439013"],
    "fileIds": [],
    "deliveryAgencyId": "507f1f77bcf86cd799439014",
    "createdAt": "2026-02-12T17:40:00.000Z",
    "updatedAt": "2026-02-12T17:40:00.000Z"
  },
  "message": "Variant created successfully"
}
```

**When to Call**: After product options/values are created; when user adds a variant

---

#### 3.4 Stock Configuration

**Purpose**: Configure low-stock alerts and oversell behavior</br>
**Field-Level Explanation**:
- `low_stock_threshold` (number | null): When stock falls below this value, vendor receives alert. `null` = no alerts
- `allow_oversell` (boolean): If `true`, stock can go negative (backorder allowed). Default: `false`

These fields are **not editable during variant creation** but can be updated via:

**Endpoint**: `PATCH /api/vendor/products/:productId/variants/:variantId`

```json
{
  "low_stock_threshold": 10,
  "allow_oversell": true
}
```

---

#### 3.5 Delivery Configuration

**Purpose**: Assign delivery agency for variant fulfillment</br>
**Field-Level Explanation**:
- `deliveryAgencyId` (string | undefined): ObjectId of delivery agency. If undefined, uses vendor's `default_delivery_agency_id`

**Delivery Resolution Logic** (Backend):
1. If `variant.deliveryAgencyId` is set → use that agency
2. Else → fallback to `vendor.default_delivery_agency_id`
3. If neither set → order cannot be fulfilled (blocking)

**Frontend Responsibility**: Provide UI to select delivery agency; optional field; show fallback indicator if not set

---

#### 3.6 Pricing & Comparison Price

**Purpose**: Display pricing with optional discounts</br>
**Field-Level Explanation**:
- `price`: Current selling price
- `compareAtPrice`: Original/MSRP price (optional). If set and greater than `price`, frontend should show as discount

**Frontend Display Logic**:
```javascript
if (variant.compareAtPrice && variant.compareAtPrice > variant.price) {
  const discount = ((variant.compareAtPrice - variant.price) / variant.compareAtPrice * 100).toFixed(0);
  // Show: "$29.99  ~~$39.99~~  (25% off)"
} else {
  // Show: "$29.99"
}
```

---

#### 3.7 Publishing Physical Product

**Purpose**: Make product visible to customers</br>
**Blocking**: Yes (final step)

**Endpoint**: `PATCH /api/vendor/products/:id/status`</br>
**HTTP Method**: PATCH</br>
**Body**: `{ "status": "active" }`

**Universal Publishing Validation Rules** (applies to ALL product types):
1. **Must have at least one variant** - All product types require variants for pricing
2. **Every active variant must have price > 0**
3. **Default variant must be set** - `defaultVariantId` must be populated

**Physical Product Specific Rules**:
- At least one variant with pricing and stock configuration
- Variants should have options/option values if using variant matrix

**Possible Errors**:
| Error Code | Message | Resolution |
|------------|---------|------------|
| `VALIDATION_ERROR` | Physical product must have at least one variant before publishing | Create at least one variant |
| `VALIDATION_ERROR` | Variant "SKU" must have a price greater than 0 | Set variant price > 0 |
| `VALIDATION_ERROR` | Physical product must have a default variant | Set defaultVariantId |
| `NOT_FOUND` | Product not found | Verify productId is correct |

---

## Digital Product Upload Flow

Digital products represent downloadable or streamable content (ebooks, music, videos, licenses, etc.).

### Complete Flow Sequence

```
1. Create Product Draft (type: 'digital')
   → Backend auto-creates default variant named "Default" if product is in draft
2. Upload Media Files → Get fileIds → Link to product (product images)
3. Configure digitalConfig:
   - Upload digital asset (the actual downloadable file)
   - Set maxDownloads (or null for unlimited)
   - Set expiresAfterDays (or null for no expiration)
4. Optional: Create additional variants (e.g., PDF vs EPUB format)
5. Publish (change status → 'active')
```

> **Auto-Created Variant**: When a digital product is created and updated with `digitalConfig`, the backend automatically creates a default variant named "Default" if the product is in draft status and has no existing variants. This ensures the product has the required variant for publishing.

### Step-by-Step Details

#### 4.1 Upload Digital Asset

**Purpose**: Upload the actual file customers will download</br>
**Blocking**: Yes (required before activation)</br>
**Frontend Responsibility**: Use multipart/form-data; handle file upload progress

**Endpoint**: `POST /api/vendor/products/:id/digital/asset`</br>
**HTTP Method**: POST</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `multipart/form-data`

##### Form Fields

| Field Name | Type | Description |
|------------|------|-------------|
| [file](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/api/controllers/file-upload.controller.ts#36-40) | File | The digital asset file to upload |

##### File Validation

- Max file size: Configured in backend (default: 100MB)
- Allowed MIME types: Configured per environment
- File sniffing + fingerprinting performed for security

##### Example Request (Using FormData)

```javascript
const formData = new FormData();
formData.append('file', fileBlob, 'ebook.pdf');

fetch('/api/vendor/products/507f1f77bcf86cd799439011/digital/asset', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${vendorJwt}`
  },
  body: formData
});
```

##### Example Response

```json
{
  "success": true,
  "message": "Digital asset uploaded successfully",
  "data": {
    "id": "507f1f77bcf86cd799439020",
    "productId": "507f1f77bcf86cd799439011",
    "mediaId": "507f1f77bcf86cd799439021",
    "downloadLimit": null,
    "isUnlimited": true,
    "expiresAt": null
  }
}
```

**When to Call**: When user selects digital asset file and confirms upload

---

#### 4.2 Configure Digital Access

**Purpose**: Define download limits and expiration</br>
**Blocking**: No (defaults apply if not set)</br>
**Frontend Responsibility**: Collect access configuration; update product

**Endpoint**: `PATCH /api/vendor/products/:id`</br>
**Body**:

```json
{
  "digitalConfig": {
    "assetId": "507f1f77bcf86cd799439021",
    "maxDownloads": 5,
    "expiresAfterDays": 30,
    "isActive": true
  }
}
```

##### Field Explanations

| Field | Type | Description |
|-------|------|-------------|
| `assetId` | string | ObjectId of uploaded digital asset |
| `maxDownloads` | number \| null | Max downloads per customer. `null` = unlimited |
| `expiresAfterDays` | number \| null | Days until access expires after purchase. `null` = never expires |
| `isActive` | boolean | Can be toggled to temporarily disable downloads |

**What Happens Post-Purchase** (High-Level):
1. Customer completes payment
2. Order record created with `digitalConfig` snapshot
3. Customer can access download link from order page
4. Download count incremented on each download
5. Access revoked when `maxDownloads` reached or expiration date passed

---

#### 4.3 Replace Digital Asset

**Purpose**: Replace existing digital asset with new version</br>
**Blocking**: No

**Endpoint**: `PUT /api/vendor/products/:id/digital/asset`</br>
**HTTP Method**: PUT</br>
**Content-Type**: `multipart/form-data`

> **Note**: Old asset is **atomically replaced**. Previous file is deleted after successful upload.

---

#### 4.4 Remove Digital Asset

**Purpose**: Unlink and mark asset for deletion</br>
**Blocking**: No

**Endpoint**: `DELETE /api/vendor/products/:id/digital/asset`</br>
**HTTP Method**: DELETE

---

#### 4.5 Toggle Digital Asset Availability

**Purpose**: Temporarily disable downloads without deleting asset</br>
**Blocking**: No

**Endpoint**: `PATCH /api/vendor/products/:id/digital/toggle`</br>
**HTTP Method**: PATCH

---

#### 4.6 Digital Product Variants (Optional)

**Purpose**: Offer same content in different formats (e.g., PDF vs EPUB)</br>
**Requirement**: Variants are **optional** for digital products

If using variants:
- Each variant can have its own `digitalConfig`
- Use same variant creation API as physical products
- Stock management **does not apply** to digital products

---

#### 4.7 Publishing Digital Product

**Validation Requirements**:
1. **Must have at least one variant** - Auto-created "Default" variant or manually created variants
2. **Every active variant must have price > 0**
3. **Default variant must be set** 
4. **digitalConfig.assetId must be set** - Digital asset must be uploaded

**Error Examples**:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Digital product must have at least one variant before publishing"
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Digital product must have digitalConfig.assetId set before publishing"
  }
}
```

---

## Service Product Upload Flow

Service products represent bookable services (appointments, consultations, classes, rentals, etc.).

### Complete Flow Sequence

```
1. Create Product Draft (type: 'service')
   → Backend auto-creates default variant named "Standard Service" if product is in draft
2. Upload Media Files → Get fileIds → Link to product (service images)
3. Configure serviceConfig:
   - Set durationMinutes
   - Set bufferBeforeMinutes / bufferAfterMinutes
   - Set bookingMode ('calendar', 'manual', 'capacity')
4. Optional: Create additional variants (e.g., different service tiers/durations)
5. Create Availability Rules (when service can be booked)
6. Publish (change status → 'active')
```

> **Auto-Created Variant**: When a service product is created and updated with `serviceConfig`, the backend automatically creates a default variant named "Standard Service" if the product is in draft status and has no existing variants. This ensures the product has the required variant for publishing.

### Step-by-Step Details

#### 5.1 Configure Service Settings

**Purpose**: Define duration and booking behavior</br>
**Blocking**: Yes (required before activation)</br>
**Frontend Responsibility**: Collect service configuration; update product

**Endpoint**: `PATCH /api/vendor/products/:id`</br>
**Body**:

```json
{
  "serviceConfig": {
    "durationMinutes": 60,
    "bufferBeforeMinutes": 15,
    "bufferAfterMinutes": 15,
    "bookingMode": "calendar"
  }
}
```

##### Field Explanations

| Field | Type | Description |
|-------|------|-------------|
| `durationMinutes` | number | Service duration in minutes (required, min: 1) |
| `bufferBeforeMinutes` | number | Buffer time before service (default: 0) |
| `bufferAfterMinutes` | number | Buffer time after service (default: 0) |
| `bookingMode` | string | `'calendar'`, `'manual'`, or `'capacity'` |

##### Booking Mode Explanations

| Mode | Description | Use Case |
|------|-------------|----------|
| `calendar` | Time-slot based booking | Appointments, consultations |
| `manual` | Vendor manually confirms bookings | Custom services, quotes |
| `capacity` | Multiple bookings per time slot | Classes, events |

---

#### 5.2 Service Variants (Optional)

**Purpose**: Offer different service tiers or durations</br>
**Requirement**: Variants are **optional** for service products

If using variants:
- Each variant can have different pricing
- Duration is defined at **product level**, not variant level
- Stock management **does not apply** to service products
- Availability is shared across all variants

**Example Variant Usage**:
- Service: "Haircut"
- Variant 1: "Basic Cut" - $30
- Variant 2: "Premium Cut with Styling" - $60

Use same variant creation API as physical products.

---

#### 5.3 Create Availability Rules

**Purpose**: Define when service can be booked</br>
**Blocking**: Recommended (but not strictly required)</br>
**Frontend Responsibility**: Collect availability rules; call API

**Endpoint**: `POST /api/vendor/products/:id/availability-rules`</br>
**HTTP Method**: POST</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `application/json`

##### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `dayOfWeek` | number | Day of week (0-6, where 0 = Sunday, 6 = Saturday) |
| `startTime` | string | Start time in HH:mm format (24-hour) |
| `endTime` | string | End time in HH:mm format (24-hour) |

##### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `timezone` | string | Timezone for the rule (default: UTC) |
| `bufferBefore` | number | Buffer time before in minutes (default: 0) |
| `bufferAfter` | number | Buffer time after in minutes (default: 0) |
| `isActive` | boolean | Rule active state (default: false - starts as draft) |

##### Validation Rules

- Only service products can have availability rules
- `dayOfWeek` must be 0-6
- `startTime` and `endTime` must be valid HH:mm format
- `startTime` must be before `endTime`
- No overlapping rules for same day

##### Example Request

```json
POST /api/vendor/products/507f1f77bcf86cd799439011/availability-rules
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "dayOfWeek": 1,
  "startTime": "09:00",
  "endTime": "17:00",
  "timezone": "UTC",
  "bufferBefore": 15,
  "bufferAfter": 15,
  "isActive": false
}
```

##### Example Response

```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439014",
    "productId": "507f1f77bcf86cd799439011",
    "vendorId": "507f191e810c19729de860ea",
    "dayOfWeek": 1,
    "startTime": "09:00",
    "endTime": "17:00",
    "timezone": "UTC",
    "bufferBefore": 15,
    "bufferAfter": 15,
    "isActive": false,
    "deletedAt": null
  },
  "message": "Availability rule created"
}
```

**Additional Endpoints**:
- `GET /api/vendor/products/:id/availability-rules` - List all availability rules
- `PATCH /api/vendor/availability-rules/:ruleId` - Update availability rule (except `isActive`)
- `PATCH /api/vendor/availability-rules/:ruleId/activate` - Activate availability rule
- `PATCH /api/vendor/availability-rules/:ruleId/toggle` - Toggle availability rule active state
- `DELETE /api/vendor/availability-rules/:ruleId` - Delete availability rule (soft delete)

> **Note**: The `isActive` field controls whether the rule is active or not. Use the toggle endpoint to change this field, **not** the update endpoint. This ensures clear intent and prevents accidental state changes.

---

#### 5.4 How Duration Affects Pricing

**Duration vs Pricing Resolution**:
- `durationMinutes` is defined at **product level**
- `price` is defined at **variant level** (or product level if no variants)
- Pricing is **NOT** automatically calculated from duration
- Frontend must **not** derive pricing from duration

**Frontend Responsibility**: Display duration and price as independent attributes

---

#### 5.5 What the Frontend Must Collect vs Derive

**Frontend Must Collect**:
- Service duration (user input)
- Buffer times (user input)
- Booking mode (user selection)
- Pricing per variant (user input)
- Availability rules (user input)

**Frontend Must NOT Derive**:
- Pricing from duration (always user input)
- Availability (must be explicitly defined via rules)

---

#### 5.6 Publishing Service Product

**Validation Requirements**:
1. **Must have at least one variant** - Auto-created "Standard Service" variant or manually created variants
2. **Every active variant must have price > 0**
3. **Default variant must be set**
4. **serviceConfig.durationMinutes must be set** (min: 1)

**Error Examples**:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Service product must have at least one variant before publishing"
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Service product must have serviceConfig.durationMinutes set before publishing"
  }
}
```

---

##  Global File Upload

The system provides a global file upload endpoint that can be used by all authenticated users with role-based size limits.

### File Upload Endpoint

**Purpose**: Upload 1-10 files in a single request with automatic security processing</br>
**Endpoint**: `POST /api/files/upload`</br>
**HTTP Method**: POST</br>
**Authentication**: Required (Any authenticated user)</br>
**Content-Type**: `multipart/form-data`

#### Role-Based Size Limits

| Role | Max File Size | Use Case |
|------|---------------|----------|
| Customer | 100 MB | Profile pictures, attachments |
| Vendor | 500 MB | Product media, documents |
| Agent | 1 GB | Delivery documents, proofs |
| Admin | 2 GB | System files, backups |

#### Request Limits

- Minimum: 1 file per request
- Maximum: 10 files per request
- Each file validated against role-based limit
- Early rejection if any file exceeds limit

#### Form Fields

| Field Name | Type | Description |
|------------|------|-------------|
| `files` | File[] | Array of files to upload (1-10 files) |

#### Security Pipeline

All uploaded files go through:
1. File sniffing (detect actual MIME type)
2. Fingerprinting (hash-based deduplication)
3. Virus scanning
4. Image processing (resize, compress)
5. Upload to storage provider
6. Database record creation with ownership tracking

#### Example Request (Using FormData)

```javascript
const formData = new FormData();
formData.append('files', file1);
formData.append('files', file2);
formData.append('files', file3);

fetch('/api/files/upload', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});
```

#### Example Response

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439020",
      "key": "products/abc123.jpg",
      "provider": "local",
      "mimeType": "image/jpeg",
      "size": 245678,
      "originalName": "product1.jpg",
      "usageCount": 0,
      "ownerType": "vendor",
      "ownerId": "507f191e810c19729de860ea"
    },
    {
      "id": "507f1f77bcf86cd799439021",
      "key": "products/def456.png",
      "provider": "local",
      "mimeType": "image/png",
      "size": 189234,
      "originalName": "product2.png",
      "usageCount": 0,
      "ownerType": "vendor",
      "ownerId": "507f191e810c19729de860ea"
    }
  ],
  "message": "Successfully uploaded 2 file(s)",
  "meta": {
    "count": 2,
    "roleLimit": "500 MB"
  }
}
```

#### Error Responses

| Status | Error Code | Message | Cause |
|--------|------------|---------|-------|
| 400 | NO_FILES_UPLOADED | At least one file is required | No files in request |
| 400 | TOO_MANY_FILES | Maximum 10 files per request | More than 10 files uploaded |
| 413 | FILE_TOO_LARGE | File "name" exceeds role limit | File exceeds role-based limit |
| 400 | UPLOAD_POLICY_VIOLATION | Policy violation message | Security validation failed |

**When to Call**: Early in the upload flow to get `fileIds` for linking to products/variants

---

## Media Handling

Media (images, videos) can be attached to both products and variants. The system uses a **File-as-Entity** pattern with reference counting.

### Media Upload Flow

```
┌─────────────────────────────────────────────────────────────┐
│                      MEDIA UPLOAD FLOW                       │
└─────────────────────────────────────────────────────────────┘

Step 1: UPLOAD FILE
   ↓
   Frontend → UploadIntakeService (via API endpoint)
   File goes through security pipeline:
   - File sniffing (detect actual MIME type)
   - Fingerprinting (hash-based deduplication)
   - Virus scanning
   - Image processing (resize, compress)
   - Upload to storage provider (local/S3/GCS/R2)

Step 2: RECEIVE FILE RECORD
   ↓
   Backend creates File record in database
   Returns File entity with:
   - fileId (ObjectId)
   - key (storage path)
   - provider ('local', 's3', 'gcs', 'r2')
   - mimeType (detected MIME type)
   - size (bytes)
   - checksum (hash)
   - usageCount (initially 0)

Step 3: LINK FILE TO PRODUCT/VARIANT
   ↓
   Frontend calls product/variant update API
   Sends fileIds array (full replacement)
   Backend:
   - Authorizes file attachment
   - Updates product/variant fileIds
   - Atomically increments file.usageCount

Step 4: FILE USAGE TRACKING
   ↓
   - usageCount tracks references
   - When usageCount reaches 0 → eligible for garbage collection
   - Files are NEVER hard deleted, only marked for purging
```

### Upload Endpoint

> **⚠️ CRITICAL NOTE**: The primary file upload endpoint is **NOT exposed in vendor routes**. The upload system uses [UploadIntakeService](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/uploads/upload-intake.service.ts#28-138) which is the **ONLY** way to upload files, but the HTTP endpoint wrapping this service is not currently mapped in [vendor-products.routes.ts](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/catalog/routes/vendor-products.routes.ts).

**Expected Endpoint** (implementation may vary):
```
POST /api/vendor/files/upload
Content-Type: multipart/form-data
```

**Expected Form Fields**:
| Field | Type | Description |
|-------|------|-------------|
| [file](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/api/controllers/file-upload.controller.ts#36-40) | File | The file to upload |
| `folder` | string | Storage folder (optional) |

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439030",
    "key": "vendors/507f191e810c19729de860ea/products/image-1234.jpg",
    "provider": "local",
    "mimeType": "image/jpeg",
    "size": 245678,
    "checksum": "a3b2c1...",
    "originalName": "product-photo.jpg",
    "usageCount": 0,
    "ownerType": "vendor",
    "ownerId": "507f191e810c19729de860ea"
  }
}
```

> **Action Item**: Verify with backend team which endpoint to use for file uploads, or implement wrapper around [UploadIntakeService](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/uploads/upload-intake.service.ts#28-138).

---

### Linking Files to Products

**Endpoint**: `PATCH /api/vendor/products/:id`</br>
**Body**:

```json
{
  "fileIds": [
    "507f1f77bcf86cd799439030",
    "507f1f77bcf86cd799439031",
    "507f1f77bcf86cd799439032"
  ]
}
```

> **⚠️ CRITICAL**: `fileIds` is a **full array replacement**. Always send the complete array, not a diff.

**Backend Behavior**:
1. Validates each fileId exists
2. Authorizes file attachment (must be owned by vendor or system)
3. Replaces product.fileIds array
4. Atomically updates usageCount for added/removed files

---

### Linking Files to Variants

**Endpoint**: `PATCH /api/vendor/products/:productId/variants/:variantId`</br>
**Body**:

```json
{
  "fileIds": [
    "507f1f77bcf86cd799439033"
  ]
}
```

Same replacement logic applies.

---

### File Reuse Across Products & Variants

**Scenario**: Same image used for product and variant

**Backend Behavior**:
- File is stored **once** in storage
- File record `usageCount` incremented for each reference
- If product.fileIds includes `fileX` **AND** variant.fileIds includes `fileX` → `usageCount = 2`

**Frontend Responsibility**:
- Store fileIds locally in state
- Allow drag-and-drop reordering
- Allow multi-select for applying same image to product and variant
- On save, send complete fileIds arrays to backend

---

### What Frontend Should Store Locally vs Refetch

**Store Locally**:
- File upload progress/status
- Temporary file previews (blobs)
- fileIds array for UI state management

**Refetch from Backend**:
- File metadata (size, mimeType) after upload complete
- usageCount (for debugging/admin purposes)
- Signed URLs for displaying images (if using S3/GCS)

**Frontend Should NOT**:
- Attempt to manage usageCount (backend handles atomically)
- Delete files directly (backend garbage collector handles cleanup)

---

## Variant Strategy

Variants allow a single product to have multiple SKU-level configurations (size, color, material, etc.).

### When Variants Are Mandatory vs Optional

| Product Type | Variants Mandatory? | Notes |
|--------------|---------------------|-------|
| Physical | **Optional** | Use for products with options (size, color, etc.) |
| Digital | **Optional** | Use for different formats (PDF vs EPUB, etc.) |
| Service | **Optional** | Use for service tiers/durations |

---

### What Fields Belong to Product vs Variant

**Product-Level Fields**:
- `type` (physical, digital, service)
- `title` (overall product name)
- `description`
- `seo` (SEO metadata)
- `fileIds` (product-level images)
- `serviceConfig` (for service products)
- `digitalConfig` (for digital products)
- `hasVariants` (boolean flag)
- `defaultVariantId` (which variant to show by default)

**Variant-Level Fields**:
- `sku` (unique identifier)
- `price` (selling price)
- `compareAtPrice` (original price for discounts)
- `stock` (inventory quantity)
- `isInfiniteStock` (unlimited stock flag)
- `low_stock_threshold` (alert threshold)
- `allow_oversell` (backorder flag)
- `weight`, `length`, `width`, `height` (physical dimensions)
- `optionValueIds` (which option values this variant represents)
- `fileIds` (variant-specific images)
- `deliveryAgencyId` (delivery agency for this variant)

---

### How Pricing Is Resolved

**Resolution Logic**:
1. If product has variants:
   - Use `variant.price`
   - Use `variant.compareAtPrice` (if set)
2. If product has no variants:
   - Pricing not stored directly on product
   - **Variants are required to enable purchasing**

**Frontend Display**:
- Show price range if multiple variants: "$29.99 - $49.99"
- Show default variant price if `defaultVariantId` set
- Update price dynamically when user selects options

---

### How Stock Is Resolved

**Resolution Logic**:
1. If `variant.isInfiniteStock === true` → Stock is unlimited
2. Else → Stock is `variant.stock` (integer)

**Stock Updates** (Not part of upload flow, but for reference):
- When order placed: `stock` decremented
- If `allow_oversell === false` and `stock <= 0` → cannot purchase
- If `allow_oversell === true` → can purchase even if `stock < 0`

---

### How Fulfillment Is Resolved

**Delivery Agency Resolution** (Physical products only):
1. If `variant.deliveryAgencyId` is set → use that agency
2. Else → fallback to `vendor.default_delivery_agency_id`
3. If neither set → order cannot be fulfilled

**Frontend Responsibility**:
- Provide UI to select delivery agency for each variant
- Show visual indicator if using vendor default
- Warn if no agency configured

---

### Frontend UX Design Guidance

**Variant Builder UI Recommendations**:

1. **Option Matrix**:
   ```
   Step 1: Define Options
   - Option 1: Size (values: S, M, L, XL)
   - Option 2: Color (values: Red, Blue, Green)

   Step 2: Generate Variants
   - Auto-generate all combinations (4 sizes × 3 colors = 12 variants)
   - Pre-fill SKU pattern: "PRODUCT-{COLOR}-{SIZE}"
   - Allow bulk pricing (e.g., "Set all to $29.99")

   Step 3: Configure Stock & Images
   - Per-variant stock input
   - Drag-and-drop images to variants
   ```

2. **Media Assignment**:
   - Show product images in left panel
   - Show variant list in right panel
   - Drag images from product to variant to copy fileIds
   - Allow multi-select variants to apply same image

3. **Stock Alerts**:
   - Provide checkbox "Enable low stock alerts"
   - If checked, show input for `low_stock_threshold`
   - Provide checkbox "Allow backorders" → sets `allow_oversell`

---

## Publishing & Status Transitions

Products move through well-defined statuses throughout their lifecycle.

### Status Enum

| Status | Description |
|--------|-------------|
| `draft` | Product is being created; not visible to customers |
| `active` | Product is live and purchasable |
| `archived` | Product is hidden; can be restored |
| `pending_review` | Product submitted for admin approval |
| `suspended` | Product administratively disabled |

---

### Status Change API

**Endpoint**: `PATCH /api/vendor/products/:id/status`</br>
**HTTP Method**: PATCH</br>
**Authentication**: Required (Vendor JWT)</br>
**Content-Type**: `application/json`

**Request Body**:
```json
{
  "status": "active"
}
```

**Validation Logic** (Backend):
- If changing to `active`:
  - Physical: None (variants optional)
  - Digital: Must have `digitalConfig.assetId`
  - Service: Must have `serviceConfig.durationMinutes` and `bookingMode`
- No validation for `draft`, `archived`
- `suspended` is admin-only

---

### Validation Gates Before Publishing

**Physical Products**:
- No strict validation (variants are optional)
- Recommended: At least one variant OR explicit "no variants" flag

**Digital Products**:
- **REQUIRED**: `digitalConfig.assetId` must be set
- Error: `"Cannot activate digital product without uploading a digital asset"`

**Service Products**:
- **REQUIRED**: `serviceConfig.durationMinutes >= 1`
- **REQUIRED**: `serviceConfig.bookingMode` must be set
- Error: `"Service products must have serviceConfig defined before activation"`

---

### Expected Errors on Publishing Failure

**Error Response Format**:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Product validation failed",
    "details": [
      {
        "field": "digitalConfig.assetId",
        "message": "Digital asset is required for digital products"
      }
    ]
  }
}
```

**Common Error Codes**:
| Code | Meaning | Action |
|------|---------|--------|
| `VALIDATION_ERROR` | Product does not meet activation requirements | Check error details for specific field |
| `NOT_FOUND` | Product not found | Verify productId is correct |
| `FORBIDDEN` | Vendor does not own this product | Should not happen if UI is correct |

---

### Status Transition Matrix

| From → To | Allowed? | Validation | Notes |
|-----------|----------|------------|-------|
| draft → active | ✅ | Type-specific | Most common transition |
| draft → pending_review | ✅ | None | Manual review flow |
| active → draft | ✅ | None | Unpublish |
| active → archived | ✅ | None | Soft delete |
| archived → active | ✅ | Type-specific | Restore |
| * → suspended | ❌ | N/A | Admin-only |

---

## Frontend Implementation Guidelines

### Recommended UI Step Ordering

**For All Product Types**:
```
Step 1: Product Type Selection
   → Radio buttons: Physical / Digital / Service

Step 2: Basic Info
   → Title
   → Description
   → SEO fields (collapsible)

Step 3: Media Upload
   → Product images (drag-and-drop)
   → Show upload progress
   → Allow reordering

Step 4: Type-Specific Configuration
   → Physical: Variants, Stock, Delivery
   → Digital: Asset Upload, Access Config
   → Service: Duration, Booking Mode, Availability

Step 5: Pricing
   → Variant-level for Physical
   → Product-level for Digital/Service (if no variants)

Step 6: Review & Publish
   → Show validation summary
   → "Save as Draft" vs "Publish"
```

---

### Which Steps Can Be Saved as Draft

**All steps can be incrementally saved as draft**:
- After creating product → status is `draft`
- Any PATCH to product maintains `draft` status
- Only explicit status change to `active` triggers validation

**Auto-Save Recommendations**:
- Auto-save on field blur (with debounce)
- Show "Saving..." indicator
- Show "All changes saved" confirmation
- Store local state in case of network failure

---

### Which API Calls Should Be Retried

**Retry on Network Error**:
- Product creation (POST /products)
- Product update (PATCH /products/:id)
- Variant creation (POST /variants)
- Variant update (PATCH /variants/:id)

**Do NOT Retry**:
- File uploads (use resumable upload pattern instead)
- Status changes (may cause double-activation)

**Retry Strategy**:
```javascript
async function retryableRequest(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        // Client error, don't retry
        throw error;
      }
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}
```

---

### Which Steps Are Irreversible

**Irreversible Operations**:
- None (all operations are reversible)

**Irreversible in Practice** (requires admin intervention):
- Status change to `suspended` (admin-only, cannot self-revert)

**Soft-Reversible** (with data loss):
- Deleting digital asset → can re-upload, but download links invalidated
- Archiving product → can restore, but may affect customer bookmarks

---

### Common Frontend Mistakes to Avoid

1. **❌ Appending to fileIds**
   ```javascript
   // WRONG
   product.fileIds.push(newFileId);
   updateProduct({ fileIds: product.fileIds });
   ```
   **✅ Correct**: Always send full array
   ```javascript
   updateProduct({ fileIds: [...product.fileIds, newFileId] });
   ```

2. **❌ Deriving pricing from duration**
   ```javascript
   // WRONG
   const price = serviceConfig.durationMinutes * RATE_PER_MINUTE;
   ```
   **✅ Correct**: Pricing is always user input, never calculated

3. **❌ Calculating usageCount client-side**
   ```javascript
   // WRONG (backend handles atomically)
   file.usageCount++;
   ```
   **✅ Correct**: Never touch usageCount

4. **❌ Publishing without validation check**
   ```javascript
   // WRONG
   changeStatus('active'); // May fail
   ```
   **✅ Correct**: Pre-validate before calling API
   ```javascript
   if (product.type === 'digital' && !product.digitalConfig?.assetId) {
     showError('Please upload digital asset before publishing');
     return;
   }
   changeStatus('active');
   ```

5. **❌ Assuming variants are required**
   ```javascript
   // WRONG
   if (product.variants.length === 0) {
     showError('Product must have at least one variant');
   }
   ```
   **✅ Correct**: Variants are optional for all product types

6. **❌ Not handling deliveryAgencyId fallback**
   ```javascript
   // WRONG
   if (!variant.deliveryAgencyId) {
     showError('Delivery agency is required');
   }
   ```
   **✅ Correct**: Show fallback indicator
   ```javascript
   const agencyId = variant.deliveryAgencyId || vendor.default_delivery_agency_id;
   if (!agencyId) {
     showWarning('No delivery agency configured. Order fulfillment will fail.');
   }
   ```

---

## Appendix: Complete API Reference

### Product Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/vendor/products` | List products with filters |
| POST | `/api/vendor/products` | Create product draft |
| GET | `/api/vendor/products/:id` | Get single product |
| PATCH | `/api/vendor/products/:id` | Update product |
| PATCH | `/api/vendor/products/:id/status` | Change product status |
| POST | `/api/vendor/products/:id/duplicate` | Duplicate product |
| DELETE | `/api/vendor/products/:id` | Archive product |
| POST | `/api/vendor/products/bulk/archive` | Bulk archive |
| POST | `/api/vendor/products/bulk/status` | Bulk status change |

### Variant Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/vendor/products/:id/variants` | Create variant |
| GET | `/api/vendor/products/:id/variants` | List variants |
| GET | `/api/vendor/products/:productId/variants/:variantId` | Get variant |
| PATCH | `/api/vendor/products/:productId/variants/:variantId` | Update variant |
| DELETE | `/api/vendor/products/:productId/variants/:variantId` | Archive variant |

### Digital Asset Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/vendor/products/:id/digital/asset` | Upload digital asset |
| PUT | `/api/vendor/products/:id/digital/asset` | Replace digital asset |
| DELETE | `/api/vendor/products/:id/digital/asset` | Remove digital asset |
| PATCH | `/api/vendor/products/:id/digital/toggle` | Toggle availability |

### Service Availability Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/vendor/products/:id/availability-rules` | Create availability rule |
| GET | `/api/vendor/products/:id/availability-rules` | List availability rules |
| PATCH | `/api/vendor/availability-rules/:ruleId` | Update availability rule |
| PATCH | `/api/vendor/availability-rules/:ruleId/activate` | Activate rule |
| DELETE | `/api/vendor/availability-rules/:ruleId` | Delete rule |

---

## Document Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-12 | Initial documentation created |

**Maintained By**: Platform Engineering Team  
**Last Reviewed**: 2026-02-12  
**Next Review**: 2026-03-12
