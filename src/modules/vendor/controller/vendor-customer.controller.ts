import { Request, Response } from 'express';
import { VendorCustomerService } from '../service/vendor-customer.service';
import {
    ListCustomersQuerySchema,
    UpdateCustomerNameSchema,
    SetCustomerFlagsSchema,
    CreateFlagSchema,
    UpdateFlagSchema
} from '../validators/vendor-customer.validator';
import { asyncHandler } from '../../../api/middlewares/async-handler';

const vendorCustomerService = new VendorCustomerService();

/**
 * Vendor Customer Management Controller
 *
 * HTTP layer for the vendor "Customer Management" tab:
 * - Vendor-defined customer flags (CRUD)
 * - Customer listing + detail (derived from orders)
 * - Vendor-local name override + flag assignment
 *
 * SECURITY: all routes are protected by requireAuth + requireRole(['vendor']).
 * The vendor id is taken from req.auth and enforced in every service call.
 */
export class VendorCustomerController {
    // ─── Flags ────────────────────────────────────────────────────────────────

    static listFlags = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const flags = await vendorCustomerService.listFlags(vendorId);
        res.json({ success: true, data: flags });
    });

    static createFlag = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const input = CreateFlagSchema.parse(req.body);
        const flag = await vendorCustomerService.createFlag(vendorId, input);
        res.status(201).json({ success: true, data: flag, message: 'Flag created successfully' });
    });

    static updateFlag = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const flagId = req.params.id;
        const input = UpdateFlagSchema.parse(req.body);
        const flag = await vendorCustomerService.updateFlag(vendorId, flagId, input);
        res.json({ success: true, data: flag, message: 'Flag updated successfully' });
    });

    static deleteFlag = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const flagId = req.params.id;
        await vendorCustomerService.deleteFlag(vendorId, flagId);
        res.json({ success: true, message: 'Flag deleted successfully' });
    });

    // ─── Customers ──────────────────────────────────────────────────────────────

    static listCustomers = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const query = ListCustomersQuerySchema.parse(req.query);
        const result = await vendorCustomerService.listCustomers(vendorId, query);
        res.json({ success: true, data: result.data, meta: result.meta });
    });

    static getCustomerDetail = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const customerId = req.params.id;
        const customer = await vendorCustomerService.getCustomerDetail(vendorId, customerId);
        res.json({ success: true, data: customer });
    });

    static updateCustomerName = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const customerId = req.params.id;
        const { displayName } = UpdateCustomerNameSchema.parse(req.body);
        const customer = await vendorCustomerService.updateCustomerName(vendorId, customerId, displayName);
        res.json({ success: true, data: customer, message: 'Customer name updated successfully' });
    });

    static setCustomerFlags = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const customerId = req.params.id;
        const { flagIds } = SetCustomerFlagsSchema.parse(req.body);
        const customer = await vendorCustomerService.setCustomerFlags(vendorId, customerId, flagIds);
        res.json({ success: true, data: customer, message: 'Customer flags updated successfully' });
    });
}
