import { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { AvailabilityRule } from '../models/availability-rule.model';
import { validateTimezone } from '../../vendors/utils/timezone.util';

const productRepository = new ProductRepositoryMongo();

// Zod schemas
const CreateAvailabilityRuleSchema = z.object({
    dayOfWeek: z.number().int().min(0).max(6, 'Day of week must be 0-6 (Sun-Sat)'),
    startTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:mm)'),
    endTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:mm)'),
    // Optional: omitted means "use the vendor's timezone", which is the source of
    // truth. Previously this defaulted to the literal 'UTC' and was never validated
    // OR read — so a rule could claim any string and the hours were silently
    // resolved against the server's clock instead.
    timezone: z
        .string()
        .refine(validateTimezone, 'Not a recognised IANA timezone (e.g. Africa/Douala)')
        .optional(),
    isActive: z.boolean().default(false), // Draft by default
});

// Update schema: exclude isActive (use toggle endpoint instead)
const UpdateAvailabilityRuleSchema = CreateAvailabilityRuleSchema.omit({ isActive: true }).partial();

// Toggle schema: explicitly set the active state via request body
const ToggleAvailabilityRuleSchema = z.object({
    isActive: z.boolean(),
});


/**
 * VendorAvailabilityController
 *
 * Manages availability rules for service products.
 * Includes draft/publish workflow via isActive flag.
 *
 * Errors are raised with createAppError and propagated to the global error
 * handler via asyncHandler — never written inline.
 */
export class VendorAvailabilityController {
    /**
     * POST /api/vendor/products/:id/availability-rules
     * Create one or more availability rules in a single request (each starts as draft).
     *
     * Accepts either a single rule object (backward compatible) or an array of rules,
     * so the frontend can define a full weekly schedule in one call instead of one
     * request per day. All rules are validated up front; if any rule is invalid or
     * overlaps (against existing rules OR another rule in the same batch) the whole
     * request is rejected and nothing is persisted.
     */
    static createRule = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        // Validate product
        const product = await productRepository.findById(productId, vendorId);
        if (!product) {
            throw createAppError(ERROR_CODES.AVAILABILITY_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        if (product.type !== 'service') {
            throw createAppError(ERROR_CODES.AVAILABILITY_INVALID_PRODUCT_TYPE, 400, 'Only service products can have availability rules');
        }

        // Normalise the body into a list: accept a bare array, a `{ rules: [...] }`
        // wrapper, or a single rule object.
        const rawRules = Array.isArray(req.body)
            ? req.body
            : Array.isArray(req.body?.rules)
                ? req.body.rules
                : [req.body];

        const inputs = z
            .array(CreateAvailabilityRuleSchema)
            .min(1, 'At least one availability rule is required')
            .parse(rawRules);

        // Validate each rule's time range
        for (const input of inputs) {
            if (input.startTime >= input.endTime) {
                throw createAppError(
                    ERROR_CODES.AVAILABILITY_INVALID_TIME_RANGE,
                    400,
                    `Start time must be before end time (dayOfWeek ${input.dayOfWeek})`
                );
            }
        }

        // Detect overlaps within the incoming batch (same day, overlapping hours)
        for (let i = 0; i < inputs.length; i++) {
            for (let j = i + 1; j < inputs.length; j++) {
                const a = inputs[i];
                const b = inputs[j];
                if (a.dayOfWeek === b.dayOfWeek && a.startTime < b.endTime && a.endTime > b.startTime) {
                    throw createAppError(
                        ERROR_CODES.AVAILABILITY_TIME_OVERLAP,
                        409,
                        `Two rules in the request overlap (dayOfWeek ${a.dayOfWeek})`
                    );
                }
            }
        }

        // Detect overlaps against existing non-deleted rules for this product
        const daysInBatch = [...new Set(inputs.map((r) => r.dayOfWeek))];
        const existingRules = await AvailabilityRule.find({
            productId: new Types.ObjectId(productId),
            dayOfWeek: { $in: daysInBatch },
            deletedAt: null,
        });

        for (const input of inputs) {
            const overlapping = existingRules.find(
                (rule) =>
                    rule.dayOfWeek === input.dayOfWeek &&
                    rule.startTime < input.endTime &&
                    rule.endTime > input.startTime
            );
            if (overlapping) {
                throw createAppError(
                    ERROR_CODES.AVAILABILITY_TIME_OVERLAP,
                    409,
                    `Time range overlaps with existing rule (dayOfWeek ${input.dayOfWeek})`
                );
            }
        }

        const results = await AvailabilityRule.insertMany(
            inputs.map((input) => ({
                productId: new Types.ObjectId(productId),
                vendorId: new Types.ObjectId(vendorId),
                ...input,
            }))
        );

        res.status(201).json({
            success: true,
            data: results,
            message: `${results.length} availability rule${results.length === 1 ? '' : 's'} created`,
        });
    });

    /**
     * GET /api/vendor/products/:id/availability-rules
     * List all availability rules for a product
     */
    static listRules = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) {
            throw createAppError(ERROR_CODES.AVAILABILITY_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        const rules = await AvailabilityRule.find({
            productId: new Types.ObjectId(productId),
            deletedAt: null,
        }).sort({ dayOfWeek: 1, startTime: 1 });

        res.json({ success: true, data: rules });
    });

    /**
     * PATCH /api/vendor/products/availability-rules/:ruleId
     * Update an availability rule
     */
    static updateRule = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { ruleId } = req.params;

        const rule = await AvailabilityRule.findOne({ _id: ruleId, deletedAt: null });
        if (!rule) {
            throw createAppError(ERROR_CODES.AVAILABILITY_RULE_NOT_FOUND, 404, 'Availability rule not found');
        }

        if (rule.vendorId.toString() !== vendorId) {
            throw createAppError(ERROR_CODES.AVAILABILITY_FORBIDDEN, 403, 'Unauthorized');
        }

        const input = UpdateAvailabilityRuleSchema.parse(req.body);

        // Validate time range if both times provided
        if (input.startTime && input.endTime && input.startTime >= input.endTime) {
            throw createAppError(ERROR_CODES.AVAILABILITY_INVALID_TIME_RANGE, 400, 'Start time must be before end time');
        }

        Object.assign(rule, input);
        await rule.save();

        res.json({ success: true, data: rule, message: 'Availability rule updated' });
    });

    /**
     * PATCH /api/vendor/products/availability-rules/:ruleId/toggle
     * Set the active state of an availability rule from the `isActive` flag in the request body.
     */
    static toggleRule = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { ruleId } = req.params;

        const rule = await AvailabilityRule.findOne({ _id: ruleId, deletedAt: null });
        if (!rule) {
            throw createAppError(ERROR_CODES.AVAILABILITY_RULE_NOT_FOUND, 404, 'Availability rule not found');
        }

        if (rule.vendorId.toString() !== vendorId) {
            throw createAppError(ERROR_CODES.AVAILABILITY_FORBIDDEN, 403, 'Unauthorized');
        }

        const { isActive } = ToggleAvailabilityRuleSchema.parse(req.body);

        rule.isActive = isActive;
        await rule.save();

        res.json({
            success: true,
            data: rule,
            message: `Availability rule ${rule.isActive ? 'activated' : 'deactivated'}`
        });
    });

    /**
     * DELETE /api/vendor/products/availability-rules/:ruleId
     * Delete an availability rule (soft delete)
     */
    static deleteRule = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { ruleId } = req.params;

        const rule = await AvailabilityRule.findOne({ _id: ruleId, deletedAt: null });
        if (!rule) {
            throw createAppError(ERROR_CODES.AVAILABILITY_RULE_NOT_FOUND, 404, 'Availability rule not found');
        }

        if (rule.vendorId.toString() !== vendorId) {
            throw createAppError(ERROR_CODES.AVAILABILITY_FORBIDDEN, 403, 'Unauthorized');
        }

        rule.deletedAt = new Date();
        await rule.save();

        res.json({ success: true, message: 'Availability rule deleted' });
    });
}
