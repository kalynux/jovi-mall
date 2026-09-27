import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { AnalyticsQuerySchema } from '../../vendors/validators/analytics.validator';
import { toAnalyticsPeriod } from '../../vendors/analytics/net-revenue';
import { deliveryAnalyticsService } from './delivery-analytics.service';

/**
 * `GET /api/agency/analytics` and `GET /api/agent/analytics` — query `from`, `to` (local days,
 * inclusive), `timezone?` (default `Africa/Douala`). Same query contract and validation as the
 * vendor analytics, so the three dashboards accept identical date pickers.
 *
 * Unlike the vendor mount, these answer through `sendSuccess` — the standard `{ success, data,
 * meta }` envelope. The vendor analytics' missing `success` key is a historical quirk of that
 * mount, not a pattern.
 */
function periodOf(req: Request) {
    const query = AnalyticsQuerySchema.parse(req.query);
    return toAnalyticsPeriod(query.from, query.to, query.timezone || 'Africa/Douala');
}

export const DeliveryAnalyticsController = {
    agency: asyncHandler(async (req: Request, res: Response) => {
        const result = await deliveryAnalyticsService.forAgency(req.auth!.role_entity._id.toString(), periodOf(req));
        sendSuccess(res, result.data, { meta: result.meta });
    }),
    agent: asyncHandler(async (req: Request, res: Response) => {
        const result = await deliveryAnalyticsService.forAgent(req.auth!.role_entity._id.toString(), periodOf(req));
        sendSuccess(res, result.data, { meta: result.meta });
    }),
};
