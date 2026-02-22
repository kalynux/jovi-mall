import { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { Types } from 'mongoose';
import { AppError } from '../../../core/errors';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { AvailabilityRule } from '../models/availability-rule.model';

const productRepository = new ProductRepositoryMongo();

// Zod schemas
const CreateAvailabilityRuleSchema = z.object({
    dayOfWeek: z.number().int().min(0).max(6, 'Day of week must be 0-6 (Sun-Sat)'),
    startTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:mm)'),
    endTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:mm)'),
    timezone: z.string().default('UTC'),
    bufferBefore: z.number().int().min(0).default(0),
    bufferAfter: z.number().int().min(0).default(0),
    isActive: z.boolean().default(false), // Draft by default
});

// Update schema: exclude isActive (use toggle endpoint instead)
const UpdateAvailabilityRuleSchema = CreateAvailabilityRuleSchema.omit({ isActive: true }).partial();


/**
 * VendorAvailabilityController
 * 
 * Manages availability rules for service products.
 * Includes draft/publish workflow via isActive flag.
 */
export class VendorAvailabilityController {
    /**
     * POST /api/vendor/products/:id/availability-rules
     * Create a new availability rule (starts as draft)
     */
    static async createRule(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate product
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Product not found' } });
                return;
            }

            if (product.type !== 'service') {
                res.status(400).json({ success: false, error: { code: 'INVALID_PRODUCT_TYPE', message: 'Only service products can have availability rules' } });
                return;
            }

            const input = CreateAvailabilityRuleSchema.parse(req.body);

            // Validate time range
            if (input.startTime >= input.endTime) {
                res.status(400).json({ success: false, error: { code: 'INVALID_TIME_RANGE', message: 'Start time must be before end time' } });
                return;
            }

            // Check for overlaps (same day, overlapping hours, active=true)
            const overlapping = await AvailabilityRule.findOne({
                productId: new Types.ObjectId(productId),
                dayOfWeek: input.dayOfWeek,
                deletedAt: null,
                $or: [
                    { startTime: { $lt: input.endTime }, endTime: { $gt: input.startTime } }
                ]
            });

            if (overlapping) {
                res.status(409).json({ success: false, error: { code: 'TIME_OVERLAP', message: 'Time range overlaps with existing rule' } });
                return;
            }

            const result = await AvailabilityRule.create({
                productId: new Types.ObjectId(productId),
                vendorId: new Types.ObjectId(vendorId),
                ...input,
            });

            res.status(201).json({ success: true, data: result, message: 'Availability rule created' });
        } catch (error) {
            VendorAvailabilityController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/products/:id/availability-rules
     * List all availability rules for a product
     */
    static async listRules(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Product not found' } });
                return;
            }

            const rules = await AvailabilityRule.find({
                productId: new Types.ObjectId(productId),
                deletedAt: null,
            }).sort({ dayOfWeek: 1, startTime: 1 });

            res.json({ success: true, data: rules });
        } catch (error) {
            VendorAvailabilityController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/availability-rules/:ruleId
     * Update an availability rule
     */
    static async updateRule(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { ruleId } = req.params;

            const rule = await AvailabilityRule.findOne({ _id: ruleId, deletedAt: null });
            if (!rule) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Availability rule not found' } });
                return;
            }

            if (rule.vendorId.toString() !== vendorId) {
                res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Unauthorized' } });
                return;
            }

            const input = UpdateAvailabilityRuleSchema.parse(req.body);

            // Validate time range if both times provided
            if (input.startTime && input.endTime && input.startTime >= input.endTime) {
                res.status(400).json({ success: false, error: { code: 'INVALID_TIME_RANGE', message: 'Start time must be before end time' } });
                return;
            }

            Object.assign(rule, input);
            await rule.save();

            res.json({ success: true, data: rule, message: 'Availability rule updated' });
        } catch (error) {
            VendorAvailabilityController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/availability-rules/:ruleId/activate
     * Activate (publish) an availability rule
     */
    static async activateRule(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { ruleId } = req.params;

            const rule = await AvailabilityRule.findOne({ _id: ruleId, deletedAt: null });
            if (!rule) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Availability rule not found' } });
                return;
            }

            if (rule.vendorId.toString() !== vendorId) {
                res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Unauthorized' } });
                return;
            }

            rule.isActive = true;
            await rule.save();

            res.json({ success: true, data: rule, message: 'Availability rule activated' });
        } catch (error) {
            VendorAvailabilityController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/availability-rules/:ruleId/toggle
     * Toggle availability rule active state
     */
    static async toggleRule(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { ruleId } = req.params;

            const rule = await AvailabilityRule.findOne({ _id: ruleId, deletedAt: null });
            if (!rule) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Availability rule not found' } });
                return;
            }

            if (rule.vendorId.toString() !== vendorId) {
                res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Unauthorized' } });
                return;
            }

            // Toggle isActive
            rule.isActive = !rule.isActive;
            await rule.save();

            res.json({
                success: true,
                data: rule,
                message: `Availability rule ${rule.isActive ? 'activated' : 'deactivated'}`
            });
        } catch (error) {
            VendorAvailabilityController.handleError(error, res);
        }
    }


    /**
     * DELETE /api/vendor/availability-rules/:ruleId
     * Delete an availability rule (soft delete)
     */
    static async deleteRule(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { ruleId } = req.params;

            const rule = await AvailabilityRule.findOne({ _id: ruleId, deletedAt: null });
            if (!rule) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Availability rule not found' } });
                return;
            }

            if (rule.vendorId.toString() !== vendorId) {
                res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Unauthorized' } });
                return;
            }

            rule.deletedAt = new Date();
            await rule.save();

            res.json({ success: true, message: 'Availability rule deleted' });
        } catch (error) {
            VendorAvailabilityController.handleError(error, res);
        }
    }

    private static handleError(error: any, res: Response): void {
        if (error instanceof ZodError) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: error.errors } });
            return;
        }
        if (error instanceof AppError) {
            res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
            return;
        }
        console.error('[VendorAvailabilityController]', error);
        res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
    }
}
