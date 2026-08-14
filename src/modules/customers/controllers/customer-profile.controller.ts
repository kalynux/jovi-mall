import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { CustomerProfileService } from '../services/customer-profile.service';
import {
    UpdateCustomerProfileSchema,
    AddCustomerAddressSchema,
    UpdateCustomerAddressSchema,
    AddCustomerPaymentMethodSchema,
} from '../validators/customer-onboarding.validator';

const customerProfileService = new CustomerProfileService();

/**
 * CustomerProfileController
 *
 * Service errors (createAppError) and Zod validation errors propagate to the
 * global error handler via asyncHandler — never written inline.
 */
export class CustomerProfileController {
    static getProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const profile = await customerProfileService.getProfile(customerId);
        res.json({ success: true, data: profile });
    });

    static updateProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const input = UpdateCustomerProfileSchema.parse(req.body);
        const profile = await customerProfileService.updateProfile(customerId, input);
        res.json({ success: true, data: profile, message: 'Profile updated successfully' });
    });

    static getCompletionStatus = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const status = await customerProfileService.getCompletionStatus(customerId);
        res.json({ success: true, data: status });
    });

    static addAddress = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const input = AddCustomerAddressSchema.parse(req.body);
        const profile = await customerProfileService.addAddress(customerId, input);
        res.status(201).json({ success: true, data: profile, message: 'Address added' });
    });

    /**
     * PATCH /api/customer/addresses/:id — edit in place.
     *
     * The `_id` survives, which is the reason this exists: delete + re-add mints a new one,
     * and past orders reference the old through `deliveryAddressId`.
     */
    static updateAddress = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const input = UpdateCustomerAddressSchema.parse(req.body ?? {});
        const profile = await customerProfileService.updateAddress(customerId, req.params.id, input);
        res.json({ success: true, data: profile, message: 'Address updated' });
    });

    static removeAddress = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const profile = await customerProfileService.removeAddress(customerId, req.params.id);
        res.json({ success: true, data: profile, message: 'Address removed' });
    });

    static setDefaultAddress = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const profile = await customerProfileService.setDefaultAddress(customerId, req.params.id);
        res.json({ success: true, data: profile, message: 'Default address updated' });
    });

    static addPaymentMethod = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const input = AddCustomerPaymentMethodSchema.parse(req.body);
        const profile = await customerProfileService.addPaymentMethod(customerId, input);
        res.status(201).json({ success: true, data: profile, message: 'Payment method added' });
    });

    static removePaymentMethod = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const profile = await customerProfileService.removePaymentMethod(customerId, req.params.id);
        res.json({ success: true, data: profile, message: 'Payment method removed' });
    });
}
