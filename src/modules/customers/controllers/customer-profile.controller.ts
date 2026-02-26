import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { CustomerProfileService } from '../services/customer-profile.service';
import {
    UpdateCustomerProfileSchema,
    AddCustomerAddressSchema,
    AddCustomerPaymentMethodSchema,
} from '../validators/customer-onboarding.validator';
import { AppError } from '../../../core/errors';

const customerProfileService = new CustomerProfileService();

function handleError(error: unknown, res: Response): void {
    if (error instanceof ZodError) {
        res.status(400).json({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
            },
        });
        return;
    }
    if (error instanceof AppError) {
        res.status(error.statusCode).json({
            success: false,
            error: { code: error.code, message: error.message },
        });
        return;
    }
    console.error('[CustomerProfileController] Unexpected error:', error);
    res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
}

export class CustomerProfileController {
    static async getProfile(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const profile = await customerProfileService.getProfile(customerId);
            res.json({ success: true, data: profile });
        } catch (error) { handleError(error, res); }
    }

    static async updateProfile(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const input = UpdateCustomerProfileSchema.parse(req.body);
            const profile = await customerProfileService.updateProfile(customerId, input);
            res.json({ success: true, data: profile, message: 'Profile updated successfully' });
        } catch (error) { handleError(error, res); }
    }

    static async getCompletionStatus(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const status = await customerProfileService.getCompletionStatus(customerId);
            res.json({ success: true, data: status });
        } catch (error) { handleError(error, res); }
    }

    static async addAddress(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const input = AddCustomerAddressSchema.parse(req.body);
            const profile = await customerProfileService.addAddress(customerId, input);
            res.status(201).json({ success: true, data: profile, message: 'Address added' });
        } catch (error) { handleError(error, res); }
    }

    static async removeAddress(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const profile = await customerProfileService.removeAddress(customerId, req.params.id);
            res.json({ success: true, data: profile, message: 'Address removed' });
        } catch (error) { handleError(error, res); }
    }

    static async setDefaultAddress(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const profile = await customerProfileService.setDefaultAddress(customerId, req.params.id);
            res.json({ success: true, data: profile, message: 'Default address updated' });
        } catch (error) { handleError(error, res); }
    }

    static async addPaymentMethod(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const input = AddCustomerPaymentMethodSchema.parse(req.body);
            const profile = await customerProfileService.addPaymentMethod(customerId, input);
            res.status(201).json({ success: true, data: profile, message: 'Payment method added' });
        } catch (error) { handleError(error, res); }
    }

    static async removePaymentMethod(req: Request, res: Response): Promise<void> {
        try {
            const customerId = req.auth!.role_entity._id.toString();
            const profile = await customerProfileService.removePaymentMethod(customerId, req.params.id);
            res.json({ success: true, data: profile, message: 'Payment method removed' });
        } catch (error) { handleError(error, res); }
    }
}
