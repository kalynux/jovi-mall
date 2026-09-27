import { Request, Response, NextFunction } from 'express';
import { VendorAnalyticsService } from '../services/vendor-analytics.service';
import { AnalyticsQuerySchema, SalesQuerySchema, ProductQuerySchema } from '../validators/analytics.validator';
import { IVendor } from '../vendor.model';
import { toAnalyticsPeriod } from '../analytics/net-revenue';

/**
 * VendorAnalyticsController — `/api/vendor/analytics/*`.
 *
 * Every endpoint resolves the timezone (query → vendor profile → `Africa/Douala`) and builds the
 * period in it. Since the 2026-09-27 rebuild that timezone is USED — it decides which local day
 * a sale falls on — where the old endpoints echoed it into `meta` and ignored it.
 *
 * Responses keep this mount's historical `{ data, meta }` shape with no `success` key
 * (documented in `api-doc/vendor/analytics.md`).
 */
export class VendorAnalyticsController {
    private analyticsService = new VendorAnalyticsService();

    private periodOf(req: Request, query: { from: string; to: string; timezone?: string }) {
        const vendor = req.auth?.role_entity as IVendor;
        const timezone = query.timezone || vendor.timezone || 'Africa/Douala';
        return { vendorId: vendor._id.toString(), period: toAnalyticsPeriod(query.from, query.to, timezone) };
    }

    /** GET /api/vendor/analytics/dashboard */
    getDashboard = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { vendorId, period } = this.periodOf(req, AnalyticsQuerySchema.parse(req.query));
            res.json(await this.analyticsService.getDashboardMetrics(vendorId, period));
        } catch (error) {
            next(error);
        }
    };

    /** GET /api/vendor/analytics/sales?breakdown=daily|none */
    getSales = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const query = SalesQuerySchema.parse(req.query);
            const { vendorId, period } = this.periodOf(req, query);
            res.json(await this.analyticsService.getSalesMetrics(vendorId, period, query.breakdown === 'daily'));
        } catch (error) {
            next(error);
        }
    };

    /** GET /api/vendor/analytics/products?limit=1..50 */
    getProducts = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const query = ProductQuerySchema.parse(req.query);
            const { vendorId, period } = this.periodOf(req, query);
            res.json(await this.analyticsService.getProductMetrics(vendorId, period, query.limit));
        } catch (error) {
            next(error);
        }
    };

    /** GET /api/vendor/analytics/customers */
    getCustomers = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { vendorId, period } = this.periodOf(req, AnalyticsQuerySchema.parse(req.query));
            res.json(await this.analyticsService.getCustomerMetrics(vendorId, period));
        } catch (error) {
            next(error);
        }
    };
}
