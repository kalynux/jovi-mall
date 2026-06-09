import { z } from 'zod';

/**
 * Vendor Customer Management API Validators
 *
 * Zod schemas for the customer-management tab: customer listing, the vendor-local
 * name override, flag assignment, and vendor-defined flag CRUD.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId');
const hexColor = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a valid hex color');

// ─── Customer listing ─────────────────────────────────────────────────────────

export const ListCustomersQuerySchema = z.object({
    search: z.string().max(100).optional(),     // Matches customer name or email
    flagId: objectId.optional(),                // Restrict to customers carrying this flag
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(['lastOrderAt', 'totalSpent', 'orderCount']).default('lastOrderAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc')
});

export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;

// ─── Name override ──────────────────────────────────────────────────────────

export const UpdateCustomerNameSchema = z.object({
    // null/empty clears the override and falls back to the real profile name
    displayName: z.string().trim().max(120).nullable()
});

export type UpdateCustomerNameDto = z.infer<typeof UpdateCustomerNameSchema>;

// ─── Flag assignment ──────────────────────────────────────────────────────────

export const SetCustomerFlagsSchema = z.object({
    flagIds: z.array(objectId).max(50)
});

export type SetCustomerFlagsDto = z.infer<typeof SetCustomerFlagsSchema>;

// ─── Flag CRUD (vendor-defined tags) ────────────────────────────────────────

export const CreateFlagSchema = z.object({
    name: z.string().trim().min(1, 'Name is required').max(60),
    color: hexColor,
    description: z.string().trim().max(200).nullable().optional()
});

export type CreateFlagDto = z.infer<typeof CreateFlagSchema>;

export const UpdateFlagSchema = z
    .object({
        name: z.string().trim().min(1).max(60).optional(),
        color: hexColor.optional(),
        description: z.string().trim().max(200).nullable().optional()
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field must be provided'
    });

export type UpdateFlagDto = z.infer<typeof UpdateFlagSchema>;
