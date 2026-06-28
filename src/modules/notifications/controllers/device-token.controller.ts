import { Request, Response, NextFunction } from 'express';
import { DeviceTokenRepository } from '../repositories/device-token.repository';
import {
    RegisterDeviceTokenSchema,
    UnregisterDeviceTokenSchema
} from '../validators/device-token.validator';

/**
 * DeviceTokenController
 *
 * Manages FCM device-token registration for the authenticated user. Tokens are
 * keyed by user (not vendor) so the same registry can serve other roles later.
 */
export class DeviceTokenController {
    private static repo = new DeviceTokenRepository();

    /**
     * POST /api/vendor/devices
     * Register or refresh an FCM device token for the authenticated user.
     */
    static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = req.auth!.user._id;
            const body = RegisterDeviceTokenSchema.parse(req.body);

            const device = await DeviceTokenController.repo.upsertToken(
                userId as any,
                body.token,
                body.platform,
                { userAgent: body.userAgent }
            );

            res.json({
                success: true,
                data: {
                    id: device._id.toString(),
                    platform: device.platform,
                    lastUsedAt: device.lastUsedAt.toISOString()
                },
                message: 'Device registered for push notifications'
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * DELETE /api/vendor/devices
     * Unregister an FCM device token (e.g. on logout).
     */
    static async unregister(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = UnregisterDeviceTokenSchema.parse(req.body);

            await DeviceTokenController.repo.deleteByToken(body.token);

            res.json({
                success: true,
                message: 'Device unregistered from push notifications'
            });
        } catch (error) {
            next(error);
        }
    }
}
