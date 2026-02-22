import { z } from 'zod';

/**
 * Product Option Validation Schemas
 * 
 * Validators for CRUD operations on product options and option values.
 * Options define product attributes (e.g., "Size", "Color").
 * Option values define specific choices (e.g., "S", "M", "L" for Size option).
 */

// ============================================================================
// Product Option Schemas
// ============================================================================

export const CreateOptionSchema = z.object({
    name: z.string()
        .min(1, 'Option name is required')
        .max(50, 'Option name must be at most 50 characters')
        .regex(/^[a-zA-Z0-9\s-]+$/, 'Option name can only contain letters, numbers, spaces, and hyphens'),
    position: z.number()
        .int('Position must be an integer')
        .min(1, 'Position must be at least 1')
        .optional(), // Auto-assigned if not provided
});

export const UpdateOptionSchema = z.object({
    name: z.string()
        .min(1)
        .max(50)
        .regex(/^[a-zA-Z0-9\s-]+$/)
        .optional(),
    position: z.number()
        .int()
        .min(1)
        .optional(),
});

export const ReorderOptionsSchema = z.object({
    optionIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be valid MongoDB ObjectId'))
        .min(1, 'At least one option ID is required')
        .max(10, 'Cannot reorder more than 10 options at once'),
});

// ============================================================================
// Option Value Schemas
// ============================================================================

export const CreateOptionValueSchema = z.object({
    value: z.string()
        .min(1, 'Option value is required')
        .max(100, 'Option value must be at most 100 characters'),
});

export const UpdateOptionValueSchema = z.object({
    value: z.string()
        .min(1)
        .max(100)
        .optional(),
});

export const BulkCreateOptionValuesSchema = z.object({
    values: z.array(z.string().min(1).max(100))
        .min(1, 'At least one value is required')
        .max(50, 'Cannot create more than 50 values at once'),
});

// ============================================================================
// Type Exports
// ============================================================================

export type CreateOptionInput = z.infer<typeof CreateOptionSchema>;
export type UpdateOptionInput = z.infer<typeof UpdateOptionSchema>;
export type ReorderOptionsInput = z.infer<typeof ReorderOptionsSchema>;
export type CreateOptionValueInput = z.infer<typeof CreateOptionValueSchema>;
export type UpdateOptionValueInput = z.infer<typeof UpdateOptionValueSchema>;
export type BulkCreateOptionValuesInput = z.infer<typeof BulkCreateOptionValuesSchema>;
