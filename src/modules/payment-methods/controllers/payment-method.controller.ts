import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { paymentMethodService } from '../services/payment-method.service';
import { AddPaymentMethodSchema } from '../validators/payment-method.validators';
import { UserRole } from '../../users/user.model';

/**
 * PaymentMethodController — role-agnostic CRUD over the current user's saved
 * payment methods. The owner is resolved from `req.auth`, so the same handlers
 * serve every authenticated role.
 *
 * Service / Zod errors propagate to the global error handler via asyncHandler.
 */
export class PaymentMethodController {
    /** GET /api/me/payment-methods */
    static list = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const ownerRole = req.auth!.role as UserRole;
        const ownerId = req.auth!.role_entity._id.toString();
        const methods = await paymentMethodService.list(ownerRole, ownerId);
        res.json({ success: true, data: methods });
    });

    /** GET /api/me/payment-methods/default */
    static getDefault = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const ownerRole = req.auth!.role as UserRole;
        const ownerId = req.auth!.role_entity._id.toString();
        const method = await paymentMethodService.getDefault(ownerRole, ownerId);
        res.json({ success: true, data: method });
    });

    /** POST /api/me/payment-methods */
    static add = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const ownerRole = req.auth!.role as UserRole;
        const ownerId = req.auth!.role_entity._id.toString();
        const input = AddPaymentMethodSchema.parse(req.body);
        const method = await paymentMethodService.add(ownerRole, ownerId, input);
        res.status(201).json({ success: true, data: method, message: 'Payment method added' });
    });

    /** PATCH /api/me/payment-methods/:id/default */
    static setDefault = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const ownerRole = req.auth!.role as UserRole;
        const ownerId = req.auth!.role_entity._id.toString();
        const method = await paymentMethodService.setDefault(ownerRole, ownerId, req.params.id);
        res.json({ success: true, data: method, message: 'Default payment method updated' });
    });

    /** DELETE /api/me/payment-methods/:id */
    static remove = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const ownerRole = req.auth!.role as UserRole;
        const ownerId = req.auth!.role_entity._id.toString();
        await paymentMethodService.remove(ownerRole, ownerId, req.params.id);
        res.json({ success: true, message: 'Payment method removed' });
    });
}
