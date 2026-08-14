import { z } from 'zod';

/**
 * Variant Validation Schemas
 * 
 * Zod schemas for variant CRUD operations
 */

// Digital-specific per-variant config. `assetId` is NOT accepted here — it is set
// only by the file-upload endpoints, preventing vendors from claiming arbitrary asset IDs.
const VariantDigitalConfigSchema = z.object({
    maxDownloads: z.number().int().positive().nullable().optional(),
    expiresAfterDays: z.number().int().positive().nullable().optional(),
});

// 'HH:mm' 24-hour time string.
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a HH:mm time');

// Optional peak-hours surcharge for service variants. The surcharge applies only to
// the portion of a booking that overlaps [startTime, endTime] on the selected days.
const VariantPeakHoursSchema = z.object({
    daysOfWeek: z.array(z.number().int().min(0).max(6))
        .refine((arr) => new Set(arr).size === arr.length, { message: 'daysOfWeek must be unique' })
        .default([]),
    startTime: timeOfDay,
    endTime: timeOfDay,
    priceType: z.enum(['fixed', 'percentage']),
    value: z.number().min(0, 'Peak value must be non-negative'),
}).refine((p) => p.startTime < p.endTime, {
    message: 'peakHours.endTime must be after startTime',
    path: ['endTime'],
});

// Service-specific per-variant config. Carries scheduling + the optional peak-hours
// surcharge. `price` (on the variant) is the base price per `durationMinutes`.
const VariantServiceConfigSchema = z.object({
    durationMinutes: z.number().int().min(1, 'Duration must be at least 1 minute'),
    bufferBeforeMinutes: z.number().int().min(0).default(0),
    bufferAfterMinutes: z.number().int().min(0).default(0),
    bookingMode: z.enum(['calendar', 'manual', 'capacity']),
    // Seats per slot for capacity mode (e.g. a class with N spots). Required when
    // bookingMode === 'capacity'; ignored by calendar/manual modes.
    maxBookings: z.number().int().min(1, 'maxBookings must be at least 1').optional(),
    peakHours: VariantPeakHoursSchema.optional(),
}).refine(
    (c) => c.bookingMode !== 'capacity' || c.maxBookings !== undefined,
    { message: "maxBookings is required when bookingMode is 'capacity'", path: ['maxBookings'] }
);

// Partial variant of the above for PATCH — every field optional (peakHours stays
// fully-validated when present). The capacity↔maxBookings invariant can't be checked
// here (the merged value isn't visible); it is enforced at product activation.
const VariantServiceConfigPatchSchema = z.object({
    durationMinutes: z.number().int().min(1).optional(),
    bufferBeforeMinutes: z.number().int().min(0).optional(),
    bufferAfterMinutes: z.number().int().min(0).optional(),
    bookingMode: z.enum(['calendar', 'manual', 'capacity']).optional(),
    maxBookings: z.number().int().min(1, 'maxBookings must be at least 1').optional(),
    peakHours: VariantPeakHoursSchema.nullable().optional(),
});

// Variant media. Full-array replacement; duplicates are rejected so the same image
// can't be attached twice. Matches the product validator's fileIds rules.
// Per-type count caps (physical 3 / digital 1) are enforced in the controller,
// where the parent product type is known.
const variantFileIdsSchema = z.array(
    z.string().regex(/^[0-9a-fA-F]{24}$/, 'Each fileId must be a valid MongoDB ObjectId')
).refine(
    (arr) => new Set(arr).size === arr.length,
    { message: 'File IDs must be unique' }
);

/**
 * Bargainable pricing — the window a buyer may haggle within.
 *
 * `maxPrice` is required: it is the only number a vendor genuinely has to choose,
 * since `minPrice` IS the variant's price and defaults to it. Sending a `minPrice`
 * that disagrees with the price is refused by the rule, not here.
 *
 * `.min(0)` rather than `.positive()`, mirroring `price`'s own `.min(0)` below —
 * a bound stricter than the price it is defined to equal would reject
 * `{ price: 0, bargain: { minPrice: 0, maxPrice: 100 } }` while accepting the same
 * thing with `minPrice` omitted. (A zero-priced variant is already unactivatable
 * via CATALOG_PRODUCT_VARIANT_ZERO_PRICE.)
 *
 * NOTE the check that is deliberately NOT here: `maxPrice >= minPrice`. That
 * violation also arrives as `price` + `bargain` siblings, and as a bare `price`
 * against stored state — neither visible to a schema. Enforcing the visible third
 * here would raise one error code at both 400 and 422, which `npm run test:errors`
 * refuses. It lives in `bargain-price.rule.ts`, at 422, for all three shapes.
 */
export const BargainRangeSchema = z.object({
    minPrice: z.number().min(0, 'bargain.minPrice must be non-negative').optional(),
    maxPrice: z.number().min(0, 'bargain.maxPrice must be non-negative'),
}).strict();

export const CreateVariantSchema = z.object({
    sku: z.string().min(1, 'SKU is required').max(100, 'SKU must be at most 100 characters'),
    name: z.string().min(1, 'Name is required').max(100, 'Name must be at most 100 characters').optional(), // Optional; digital read model falls back to "<asset> - <format> - <size>"
    price: z.number().min(0, 'Price must be positive'),
    compareAtPrice: z.number().min(0).optional(),
    bargain: BargainRangeSchema.optional(),
    stock: z.number().int().min(0, 'Stock must be non-negative').default(0),
    isInfiniteStock: z.boolean().default(false),
    weight: z.number().min(0).optional(),
    length: z.number().min(0).optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    optionValueIds: z.array(z.string()).optional().default([]),
    deliveryAgencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId').optional(),
    fileIds: variantFileIdsSchema.optional(),
    digitalConfig: VariantDigitalConfigSchema.optional(),
    serviceConfig: VariantServiceConfigSchema.optional(),
});

export const UpdateVariantSchema = z.object({
    sku: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(100).optional(),
    price: z.number().min(0).optional(),
    compareAtPrice: z.number().min(0).optional(),
    // Explicit null clears the range. Omitted leaves it untouched — except that a
    // `price` change auto-syncs `bargain.minPrice`, so the invariant holds without
    // the client having to know the field exists.
    bargain: BargainRangeSchema.nullable().optional(),
    stock: z.number().int().min(0).optional(),
    isInfiniteStock: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(1).nullable().optional(),
    allowOversell: z.boolean().optional(),
    weight: z.number().min(0).optional(),
    length: z.number().min(0).optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    optionValueIds: z.array(z.string()).optional(),
    deliveryAgencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId').optional(),
    fileIds: variantFileIdsSchema.optional(),
    digitalConfig: VariantDigitalConfigSchema.optional(),
    serviceConfig: VariantServiceConfigPatchSchema.optional(),
});

// Body for PATCH /products/:productId/variants/:variantId/service/config — patch the
// service variant's scheduling/peak config (at least one field required).
export const UpdateVariantServiceConfigSchema = VariantServiceConfigPatchSchema.refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one service config field must be provided' }
);

// Body for PATCH /products/:productId/variants/:variantId/digital/config
export const UpdateVariantDigitalConfigSchema = VariantDigitalConfigSchema.refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one of maxDownloads, expiresAfterDays must be provided' }
);

export const VariantQuerySchema = z.object({
    status: z.enum(['active', 'archived']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Body for PATCH /products/:productId/variants/:variantId/status — vendor-driven
// toggle between active and archived (e.g. temporarily disable a variant during
// a stock shortage). Activation runs through ProductStatusValidationService.
export const ChangeVariantStatusSchema = z.object({
    status: z.enum(['active', 'archived'], {
        required_error: 'Status is required',
    }),
});

export type CreateVariantInput = z.infer<typeof CreateVariantSchema>;
export type UpdateVariantInput = z.infer<typeof UpdateVariantSchema>;
export type VariantQueryInput = z.infer<typeof VariantQuerySchema>;
export type UpdateVariantDigitalConfigInput = z.infer<typeof UpdateVariantDigitalConfigSchema>;
export type UpdateVariantServiceConfigInput = z.infer<typeof UpdateVariantServiceConfigSchema>;
export type ChangeVariantStatusInput = z.infer<typeof ChangeVariantStatusSchema>;
