# Vendor Order Management - Missing Features Implementation Plan

## Overview

This plan addresses missing vendor order management capabilities identified in the gap analysis. It maintains existing fulfillment status values and focuses on adding:

1. Delivery agency assignment
2. Order type filtering
3. Digital order entitlement management
4. Enhanced vendor permissions

---

## Phase 1: Physical Order Management Enhancements

### 1.1 Add Delivery Agency Assignment Endpoint

**Goal**: Allow vendors to assign or change delivery agency for physical order items

#### Files to Create/Modify

**1. Validator: `src/modules/vendor/validators/vendor-order.validator.ts`**

Add new schema:
```typescript
export const UpdateDeliveryAgencySchema = z.object({
  deliveryAgencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid delivery agency ID')
});

export type UpdateDeliveryAgencyDto = z.infer<typeof UpdateDeliveryAgencySchema>;
```

**2. Service: `src/modules/orders/vendor-order.service.ts`**

Add new method:
```typescript
/**
 * Update delivery agency for physical order
 * 
 * RULES:
 * - Only for physical orders
 * - Only for orders not yet delivered
 * - Agency must exist and be active
 */
async updateDeliveryAgency(
  orderId: string,
  vendorId: string,
  deliveryAgencyId: string
): Promise<any> {
  // 1. Validate order ownership and type
  const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);
  
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  
  if (order.order_type !== 'physical') {
    throw new ValidationError('Delivery agency can only be updated for physical orders');
  }
  
  // 2. Check order not yet delivered
  if (['delivered', 'cancelled'].includes(order.fulfillment_status)) {
    throw new UnprocessableEntityError(
      `Cannot update delivery agency: order is ${order.fulfillment_status}`
    );
  }
  
  // 3. Validate delivery agency exists (optional: check if active)
  const { DeliveryAgencyModel } = await import('../delivery/models/delivery-agency.model');
  const agency = await DeliveryAgencyModel.findById(deliveryAgencyId);
  
  if (!agency) {
    throw new NotFoundError('Delivery agency not found');
  }
  
  // 4. Update all order items with new agency
  const updatedOrder = await this.vendorOrderRepo.updateDeliveryAgency(
    orderId,
    vendorId,
    deliveryAgencyId
  );
  
  if (!updatedOrder) {
    throw new NotFoundError('Order not found after update');
  }
  
  // 5. Append timeline entry
  await this.timelineRepo.appendEvent({
    orderId,
    eventType: 'delivery.agency_updated',
    description: `Delivery agency changed to ${agency.name || deliveryAgencyId}`,
    metadata: {
      newAgencyId: deliveryAgencyId,
      agencyName: agency.name
    },
    actorType: 'vendor',
    actorId: vendorId
  });
  
  // 6. Return updated order
  return this.getOrderDetails(orderId, vendorId);
}
```

**3. Repository: `src/modules/orders/vendor-order.repository.ts`**

Add new method:
```typescript
/**
 * Update delivery agency for all items in an order
 */
async updateDeliveryAgency(
  orderId: string,
  vendorId: string,
  deliveryAgencyId: string
): Promise<IOrder | null> {
  const result = await OrderModel.findOneAndUpdate(
    {
      _id: new Types.ObjectId(orderId),
      vendor_id: new Types.ObjectId(vendorId)
    },
    {
      $set: {
        'items.$[].delivery.agency_id': new Types.ObjectId(deliveryAgencyId),
        updated_at: new Date()
      }
    },
    { new: true }
  ).lean();
  
  return result;
}
```

**4. Controller: `src/modules/vendor/controller/vendor-order.controller.ts`**

Add new method:
```typescript
/**
 * PATCH /api/vendor/orders/:id/delivery-agency
 * 
 * Update delivery agency for physical order
 */
static async updateDeliveryAgency(req: Request, res: Response): Promise<void> {
  try {
    const vendorId = req.auth!.role_entity._id.toString();
    const orderId = req.params.id;
    
    // Validate request body
    const { deliveryAgencyId } = UpdateDeliveryAgencySchema.parse(req.body);
    
    const order = await vendorOrderService.updateDeliveryAgency(
      orderId,
      vendorId,
      deliveryAgencyId
    );
    
    res.json({
      success: true,
      data: order,
      message: 'Delivery agency updated successfully'
    });
  } catch (error) {
    VendorOrderController.handleError(error, res);
  }
}
```

**5. Routes: `src/modules/vendor/routes.ts`**

Add new route:
```typescript
/**
 * PATCH /api/vendor/orders/:id/delivery-agency
 * Update delivery agency for physical order
 */
router.patch('/orders/:id/delivery-agency', VendorOrderController.updateDeliveryAgency);
```

---

### 1.2 Add Order Type Filter

**Goal**: Allow vendors to filter orders by type (physical/digital)

#### Files to Modify

**1. Validator: `src/modules/vendor/validators/vendor-order.validator.ts`**

Update `ListOrdersQuerySchema`:
```typescript
export const ListOrdersQuerySchema = z.object({
  // Filters
  status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'fulfilled', 'cancelled']).optional(),
  paymentStatus: z.enum(['pending', 'AWAITING_PAYMENT', 'paid', 'failed', 'refunded']).optional(),
  orderType: z.enum(['physical', 'digital']).optional(), // NEW
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  q: z.string().max(100).optional(),
  
  // Pagination (unchanged)
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['created_at', 'updated_at', 'total_amount']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});
```

**2. Controller: `src/modules/vendor/controller/vendor-order.controller.ts`**

Update `listOrders` method:
```typescript
static async listOrders(req: Request, res: Response): Promise<void> {
  try {
    const vendorId = req.auth!.role_entity._id.toString();
    
    const query = ListOrdersQuerySchema.parse(req.query);
    
    // Build filters
    const filters: any = {};
    if (query.status) filters.status = query.status;
    if (query.paymentStatus) filters.paymentStatus = query.paymentStatus;
    if (query.orderType) filters.orderType = query.orderType; // NEW
    if (query.dateFrom) filters.dateFrom = new Date(query.dateFrom);
    if (query.dateTo) filters.dateTo = new Date(query.dateTo);
    if (query.q) filters.q = query.q;
    
    // ... rest unchanged
```

**3. Repository: `src/modules/orders/vendor-order.repository.ts`**

Update `findByVendor` to support `orderType` filter:
```typescript
async findByVendor(
  vendorId: string,
  filters: OrderFilters = {},
  pagination: PaginationOptions = { page: 1, limit: 20, sort: { created_at: -1 } }
): Promise<Page<IOrder>> {
  const query: any = {
    vendor_id: new Types.ObjectId(vendorId)
  };
  
  // Existing filters
  if (filters.status) {
    query.fulfillment_status = filters.status;
  }
  
  if (filters.paymentStatus) {
    query.payment_status = filters.paymentStatus;
  }
  
  // NEW: Order type filter
  if (filters.orderType) {
    query.order_type = filters.orderType;
  }
  
  // ... rest of method unchanged
```

**4. Types: `src/modules/orders/vendor-order.repository.ts`**

Update `OrderFilters` interface:
```typescript
export interface OrderFilters {
  status?: FulfillmentStatus;
  paymentStatus?: PaymentStatus;
  orderType?: 'physical' | 'digital'; // NEW
  dateFrom?: Date;
  dateTo?: Date;
  q?: string;
}
```

---

## Phase 2: Digital Order Management

### 2.1 View Digital Entitlements for Order

**Goal**: Allow vendors to see entitlements granted for digital orders

#### Files to Create/Modify

**1. Service: `src/modules/orders/vendor-order.service.ts`**

Add new method:
```typescript
/**
 * Get digital entitlements for an order
 * 
 * Only works for digital orders
 */
async getOrderEntitlements(
  orderId: string,
  vendorId: string
): Promise<any[]> {
  // 1. Validate order ownership and type
  const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);
  
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  
  if (order.order_type !== 'digital') {
    throw new ValidationError('Entitlements are only available for digital orders');
  }
  
  // 2. Fetch entitlements
  const { CustomerDigitalEntitlementModel } = await import(
    '../digital-delivery/models/customer-digital-entitlement.model'
  );
  
  const entitlements = await CustomerDigitalEntitlementModel.find({
    orderId: new Types.ObjectId(orderId),
    vendorId: new Types.ObjectId(vendorId),
    deletedAt: null
  })
    .populate('productId', 'title')
    .populate('assetId', 'originalName')
    .sort({ createdAt: -1 });
  
  const now = new Date();
  
  // 3. Transform to vendor-friendly DTO
  return entitlements.map((e: any) => {
    const isExpired = e.expiresAt !== null && e.expiresAt < now;
    const isRevoked = e.revokedAt !== null;
    const hasDownloadsRemaining =
      e.maxDownloads === null || e.downloadsUsed < e.maxDownloads;
    const isActive = !isExpired && !isRevoked && hasDownloadsRemaining;
    
    return {
      id: e._id.toString(),
      orderItemId: e.orderItemId.toString(),
      productId: e.productId._id.toString(),
      productTitle: e.productId.title,
      assetId: e.assetId._id.toString(),
      assetName: e.assetId.originalName,
      customerId: e.customerId.toString(),
      
      // Download tracking
      downloadsUsed: e.downloadsUsed,
      maxDownloads: e.maxDownloads,
      downloadsRemaining: e.maxDownloads === null 
        ? 'unlimited' 
        : e.maxDownloads - e.downloadsUsed,
      
      // Status
      grantedAt: e.createdAt,
      expiresAt: e.expiresAt,
      revokedAt: e.revokedAt,
      isExpired,
      isRevoked,
      isActive,
      
      // Metadata
      lastDownloadAt: e.lastDownloadAt || null
    };
  });
}
```

**2. Controller: `src/modules/vendor/controller/vendor-order.controller.ts`**

Add new method:
```typescript
/**
 * GET /api/vendor/orders/:id/entitlements
 * 
 * Get digital entitlements for order
 */
static async getOrderEntitlements(req: Request, res: Response): Promise<void> {
  try {
    const vendorId = req.auth!.role_entity._id.toString();
    const orderId = req.params.id;
    
    const entitlements = await vendorOrderService.getOrderEntitlements(
      orderId,
      vendorId
    );
    
    res.json({
      success: true,
      data: entitlements,
      meta: {
        count: entitlements.length,
        activeCount: entitlements.filter(e => e.isActive).length,
        revokedCount: entitlements.filter(e => e.isRevoked).length,
        expiredCount: entitlements.filter(e => e.isExpired).length
      }
    });
  } catch (error) {
    VendorOrderController.handleError(error, res);
  }
}
```

**3. Routes: `src/modules/vendor/routes.ts`**

Add new route:
```typescript
/**
 * GET /api/vendor/orders/:id/entitlements
 * Get digital entitlements for order (digital orders only)
 */
router.get('/orders/:id/entitlements', VendorOrderController.getOrderEntitlements);
```

---

### 2.2 Revoke Digital Entitlement

**Goal**: Allow vendors to revoke access to digital products

#### Files to Create/Modify

**1. Validator: `src/modules/vendor/validators/vendor-order.validator.ts`**

Add new schema:
```typescript
export const RevokeEntitlementSchema = z.object({
  reason: z.string()
    .min(10, 'Reason must be at least 10 characters')
    .max(500, 'Reason cannot exceed 500 characters')
});

export type RevokeEntitlementDto = z.infer<typeof RevokeEntitlementSchema>;
```

**2. Service: `src/modules/orders/vendor-order.service.ts`**

Add new method:
```typescript
/**
 * Revoke digital entitlement
 * 
 * RULES:
 * - Vendor must own the entitlement
 * - Cannot revoke already-revoked entitlement
 * - Reason required for audit trail
 */
async revokeEntitlement(
  entitlementId: string,
  vendorId: string,
  reason: string
): Promise<any> {
  // 1. Validate entitlement exists and vendor owns it
  const { CustomerDigitalEntitlementModel } = await import(
    '../digital-delivery/models/customer-digital-entitlement.model'
  );
  
  const entitlement = await CustomerDigitalEntitlementModel.findOne({
    _id: new Types.ObjectId(entitlementId),
    vendorId: new Types.ObjectId(vendorId),
    deletedAt: null
  });
  
  if (!entitlement) {
    throw new NotFoundError('Entitlement not found');
  }
  
  // 2. Check not already revoked
  if (entitlement.revokedAt !== null) {
    throw new UnprocessableEntityError('Entitlement is already revoked');
  }
  
  // 3. Revoke entitlement
  entitlement.revokedAt = new Date();
  await entitlement.save();
  
  // 4. Append timeline entry to order
  await this.timelineRepo.appendEvent({
    orderId: entitlement.orderId.toString(),
    eventType: 'entitlement.revoked',
    description: `Digital entitlement revoked: ${reason}`,
    metadata: {
      entitlementId: entitlementId,
      productId: entitlement.productId.toString(),
      customerId: entitlement.customerId.toString(),
      reason
    },
    actorType: 'vendor',
    actorId: vendorId
  });
  
  // 5. Return revoked entitlement
  return {
    id: entitlement._id.toString(),
    revokedAt: entitlement.revokedAt,
    reason,
    message: 'Entitlement revoked successfully'
  };
}
```

**3. Controller: `src/modules/vendor/controller/vendor-order.controller.ts`**

Add new method:
```typescript
/**
 * POST /api/vendor/entitlements/:id/revoke
 * 
 * Revoke digital entitlement
 */
static async revokeEntitlement(req: Request, res: Response): Promise<void> {
  try {
    const vendorId = req.auth!.role_entity._id.toString();
    const entitlementId = req.params.id;
    
    // Validate request body
    const { reason } = RevokeEntitlementSchema.parse(req.body);
    
    const result = await vendorOrderService.revokeEntitlement(
      entitlementId,
      vendorId,
      reason
    );
    
    res.json({
      success: true,
      data: result,
      message: 'Entitlement revoked successfully'
    });
  } catch (error) {
    VendorOrderController.handleError(error, res);
  }
}
```

**4. Routes: `src/modules/vendor/routes.ts`**

Add new route:
```typescript
/**
 * POST /api/vendor/entitlements/:id/revoke
 * Revoke digital entitlement
 */
router.post('/entitlements/:id/revoke', VendorOrderController.revokeEntitlement);
```

---

### 2.3 Restore Digital Entitlement

**Goal**: Allow vendors to restore revoked access

#### Files to Modify

**1. Validator: `src/modules/vendor/validators/vendor-order.validator.ts`**

Add new schema:
```typescript
export const RestoreEntitlementSchema = z.object({
  reason: z.string()
    .min(10, 'Reason must be at least 10 characters')
    .max(500, 'Reason cannot exceed 500 characters')
});

export type RestoreEntitlementDto = z.infer<typeof RestoreEntitlementSchema>;
```

**2. Service: `src/modules/orders/vendor-order.service.ts`**

Add new method:
```typescript
/**
 * Restore revoked digital entitlement
 * 
 * RULES:
 * - Vendor must own the entitlement
 * - Can only restore revoked entitlements
 * - Cannot restore expired entitlements
 */
async restoreEntitlement(
  entitlementId: string,
  vendorId: string,
  reason: string
): Promise<any> {
  // 1. Validate entitlement exists and vendor owns it
  const { CustomerDigitalEntitlementModel } = await import(
    '../digital-delivery/models/customer-digital-entitlement.model'
  );
  
  const entitlement = await CustomerDigitalEntitlementModel.findOne({
    _id: new Types.ObjectId(entitlementId),
    vendorId: new Types.ObjectId(vendorId),
    deletedAt: null
  });
  
  if (!entitlement) {
    throw new NotFoundError('Entitlement not found');
  }
  
  // 2. Check is currently revoked
  if (entitlement.revokedAt === null) {
    throw new UnprocessableEntityError('Entitlement is not revoked');
  }
  
  // 3. Check not expired
  if (entitlement.expiresAt !== null && entitlement.expiresAt < new Date()) {
    throw new UnprocessableEntityError(
      'Cannot restore expired entitlement. Entitlement expired on ' +
      entitlement.expiresAt.toISOString()
    );
  }
  
  // 4. Restore entitlement
  entitlement.revokedAt = null;
  await entitlement.save();
  
  // 5. Append timeline entry
  await this.timelineRepo.appendEvent({
    orderId: entitlement.orderId.toString(),
    eventType: 'entitlement.restored',
    description: `Digital entitlement restored: ${reason}`,
    metadata: {
      entitlementId: entitlementId,
      productId: entitlement.productId.toString(),
      customerId: entitlement.customerId.toString(),
      reason
    },
    actorType: 'vendor',
    actorId: vendorId
  });
  
  // 6. Return restored entitlement
  return {
    id: entitlement._id.toString(),
    restoredAt: new Date(),
    reason,
    message: 'Entitlement restored successfully'
  };
}
```

**3. Controller: `src/modules/vendor/controller/vendor-order.controller.ts`**

Add new method:
```typescript
/**
 * POST /api/vendor/entitlements/:id/restore
 * 
 * Restore revoked digital entitlement
 */
static async restoreEntitlement(req: Request, res: Response): Promise<void> {
  try {
    const vendorId = req.auth!.role_entity._id.toString();
    const entitlementId = req.params.id;
    
    // Validate request body
    const { reason } = RestoreEntitlementSchema.parse(req.body);
    
    const result = await vendorOrderService.restoreEntitlement(
      entitlementId,
      vendorId,
      reason
    );
    
    res.json({
      success: true,
      data: result,
      message: 'Entitlement restored successfully'
    });
  } catch (error) {
    VendorOrderController.handleError(error, res);
  }
}
```

**4. Routes: `src/modules/vendor/routes.ts`**

Add new route:
```typescript
/**
 * POST /api/vendor/entitlements/:id/restore
 * Restore revoked digital entitlement
 */
router.post('/entitlements/:id/restore', VendorOrderController.restoreEntitlement);
```

---

## Phase 3: Enhanced Digital Entitlement Model

### 3.1 Add Download Tracking Fields

**Goal**: Track when customers download digital products

#### Files to Modify

**1. Model: `src/modules/digital-delivery/models/customer-digital-entitlement.model.ts`**

Add new fields:
```typescript
export interface ICustomerDigitalEntitlement extends Document {
  // ... existing fields
  
  // Download tracking (NEW)
  lastDownloadAt: Date | null;           // Last time customer downloaded
  lastDownloadIp: string | null;         // IP address of last download (audit)
  downloadHistory: {                     // Full download history
    downloadedAt: Date;
    ipAddress: string;
  }[];
}

const CustomerDigitalEntitlementSchema = new Schema({
  // ... existing fields
  
  // Download tracking
  lastDownloadAt: { type: Date, default: null },
  lastDownloadIp: { type: String, default: null },
  downloadHistory: [{
    downloadedAt: { type: Date, required: true },
    ipAddress: { type: String, required: true }
  }]
}, { timestamps: true });
```

**2. Service: `src/modules/digital-delivery/services/digital-entitlement.service.ts`**

Add method to track downloads:
```typescript
/**
 * Record download event
 * 
 * Updates download count and history
 */
async recordDownload(
  entitlementId: string,
  customerId: string,
  ipAddress: string
): Promise<void> {
  const result = await CustomerDigitalEntitlementModel.updateOne(
    {
      _id: entitlementId,
      customerId: new Types.ObjectId(customerId),
      deletedAt: null
    },
    {
      $inc: { downloadsUsed: 1 },
      $set: {
        lastDownloadAt: new Date(),
        lastDownloadIp: ipAddress
      },
      $push: {
        downloadHistory: {
          downloadedAt: new Date(),
          ipAddress
        }
      }
    }
  );
  
  if (result.modifiedCount === 0) {
    throw new Error('Entitlement not found or customer mismatch');
  }
}
```

---

## Testing Strategy

### Phase 1 Tests

**1.1 Delivery Agency Assignment**
- ✅ Assign delivery agency to physical order → success
- ✅ Try to assign to digital order → 400 error
- ✅ Try to assign to delivered order → 422 error
- ✅ Try to assign non-existent agency → 404 error
- ✅ Timeline entry created → verify

**1.2 Order Type Filter**
- ✅ Filter by `orderType=physical` → only physical orders
- ✅ Filter by `orderType=digital` → only digital orders
- ✅ No filter → all orders

### Phase 2 Tests

**2.1 View Entitlements**
- ✅ Get entitlements for digital order → success with stats
- ✅ Try to get entitlements for physical order → 400 error
- ✅ Verify download stats → correct counts

**2.2 Revoke Entitlement**
- ✅ Revoke active entitlement → success
- ✅ Try to revoke already revoked → 422 error
- ✅ Try to revoke entitlement from different vendor → 404 error
- ✅ Timeline entry created → verify

**2.3 Restore Entitlement**
- ✅ Restore revoked entitlement → success
- ✅ Try to restore active entitlement → 422 error
- ✅ Try to restore expired entitlement → 422 error
- ✅ Timeline entry created → verify

---

## Implementation Checklist

### Phase 1: Physical Orders (2-3 days)
- [ ] Update `vendor-order.validator.ts` with new schemas
- [ ] Add `updateDeliveryAgency` method to service
- [ ] Add `updateDeliveryAgency` method to repository
- [ ] Add `updateDeliveryAgency` controller method
- [ ] Add route for delivery agency update
- [ ] Update `ListOrdersQuerySchema` with `orderType` filter
- [ ] Update repository to support `orderType` filter
- [ ] Update controller to pass `orderType` filter
- [ ] Write tests for delivery agency assignment
- [ ] Write tests for order type filtering

### Phase 2: Digital Orders (2-3 days)
- [ ] Add `getOrderEntitlements` service method
- [ ] Add `getOrderEntitlements` controller method
- [ ] Add route for viewing entitlements
- [ ] Add `revokeEntitlement` service method
- [ ] Add `revokeEntitlement` controller method
- [ ] Add `RevokeEntitlementSchema` validator
- [ ] Add route for revoking entitlement
- [ ] Add `restoreEntitlement` service method
- [ ] Add `restoreEntitlement` controller method
- [ ] Add `RestoreEntitlementSchema` validator
- [ ] Add route for restoring entitlement
- [ ] Write tests for entitlement viewing
- [ ] Write tests for revoke/restore flows

### Phase 3: Download Tracking (1 day)
- [ ] Update `customer-digital-entitlement.model.ts` with tracking fields
- [ ] Add `recordDownload` method to service
- [ ] Update customer download endpoint to use `recordDownload`
- [ ] Write tests for download tracking

---

## API Summary

### New Endpoints

**Physical Orders:**
- `PATCH /api/vendor/orders/:id/delivery-agency` - Assign/change delivery agency

**Digital Orders:**
- `GET /api/vendor/orders/:id/entitlements` - View entitlements for digital order
- `POST /api/vendor/entitlements/:id/revoke` - Revoke customer access
- `POST /api/vendor/entitlements/:id/restore` - Restore customer access

**Enhanced Filters:**
- `GET /api/vendor/orders?orderType=physical` - Filter by order type
- `GET /api/vendor/orders?orderType=digital` - Filter digital orders only

---

## Migration Notes

**No Database Migrations Required** for Phase 1 & 2 (all fields already exist)

**Phase 3 Requires Migration**:
```javascript
// Add download tracking fields to existing entitlements
db.customerdigitalentitlements.updateMany(
  {},
  {
    $set: {
      lastDownloadAt: null,
      lastDownloadIp: null,
      downloadHistory: []
    }
  }
);
```

---

## Success Criteria

**Phase 1 Complete When:**
- ✅ Vendors can assign/change delivery agency for physical orders
- ✅ Vendors can filter orders by type (physical/digital)
- ✅ All tests passing

**Phase 2 Complete When:**
- ✅ Vendors can view entitlements for digital orders with download stats
- ✅ Vendors can revoke customer access to digital products
- ✅ Vendors can restore revoked access
- ✅ Timeline entries logged for all entitlement changes
- ✅ All tests passing

**Phase 3 Complete When:**
- ✅ Download events tracked with timestamp and IP
- ✅ Download history visible in entitlement details
- ✅ Download counts accurate
- ✅ All tests passing

---

## Estimated Timeline

- **Phase 1**: 2-3 days
- **Phase 2**: 2-3 days
- **Phase 3**: 1 day

**Total**: 5-7 days
