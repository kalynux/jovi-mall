import { Request, Response, NextFunction } from 'express';
import { VendorAnalyticsService } from '../services/vendor-analytics.service';
import { AnalyticsQuerySchema, SalesQuerySchema, ProductQuerySchema } from '../validators/analytics.validator';
import { IVendor } from '../vendor.model';

/**
 * VendorAnalyticsController - Analytics API endpoints
 * 
 * All endpoints:
 * - Require vendor authentication
 * - Validate query parameters with Zod
 * - Use vendor's timezone as default
 * - Return meta + data structure
 * - Handle AggregationNotReadyError → 503
 */

export class VendorAnalyticsController {
    private analyticsService: VendorAnalyticsService;

    constructor() {
        this.analyticsService = new VendorAnalyticsService();
    }

    /**
     * GET /api/vendor/analytics/dashboard
     * 
     * Overview metrics for dashboard
     */
    getDashboard = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const vendor = req.auth?.role_entity as IVendor;
            const vendorId = vendor._id.toString();

            // Parse and validate query
            const query = AnalyticsQuerySchema.parse(req.query);
            const timezone = query.timezone || vendor.timezone || 'Africa/Douala';

            // Fetch metrics
            const result = await this.analyticsService.getDashboardMetrics(vendorId, {
                from: query.from,
                to: query.to
            });

            res.json({
                ...result,
                meta: {
                    ...result.meta,
                    timezone
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/vendor/analytics/sales
     * 
     * Sales metrics with optional daily breakdown
     */
    getSales = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const vendor = req.auth?.role_entity as IVendor;
            const vendorId = vendor._id.toString();

            // Parse and validate query
            const query = SalesQuerySchema.parse(req.query);
            const timezone = query.timezone || vendor.timezone || 'Africa/Douala';
            const breakdown = query.breakdown === 'daily';

            // Fetch metrics
            const result = await this.analyticsService.getSalesMetrics(vendorId, {
                from: query.from,
                to: query.to
            }, breakdown);

            res.json({
                ...result,
                meta: {
                    ...result.meta,
                    timezone,
                    breakdown: query.breakdown
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/vendor/analytics/products
     * 
     * Top products by revenue and quantity
     */
    getProducts = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const vendor = req.auth?.role_entity as IVendor;
            const vendorId = vendor._id.toString();

            // Parse and validate query
            const query = ProductQuerySchema.parse(req.query);
            const timezone = query.timezone || vendor.timezone || 'Africa/Douala';

            // Fetch metrics
            const result = await this.analyticsService.getProductMetrics(vendorId, {
                from: query.from,
                to: query.to
            }, query.limit);

            res.json({
                ...result,
                meta: {
                    ...result.meta,
                    timezone
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/vendor/analytics/customers
     * 
     * Customer metrics (total, repeat, repeat rate)
     */
    getCustomers = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const vendor = req.auth?.role_entity as IVendor;
            const vendorId = vendor._id.toString();

            // Parse and validate query
            const query = AnalyticsQuerySchema.parse(req.query);
            const timezone = query.timezone || vendor.timezone || 'Africa/Douala';

            // Fetch metrics
            const result = await this.analyticsService.getCustomerMetrics(vendorId, {
                from: query.from,
                to: query.to
            });

            res.json({
                ...result,
                meta: {
                    ...result.meta,
                    timezone
                }
            });
        } catch (error) {
            next(error);
        }
    }
}
