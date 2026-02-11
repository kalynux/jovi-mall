import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { InventoryAvailabilityCalculator } from './InventoryAvailabilityCalculator';

export interface LowStockAlert {
    variantId: string;
    productId: string;
    sku: string;
    productTitle: string;
    currentStock: number;
    activeReservations: number;
    availableStock: number;
    threshold: number;
    stockPercentage: number | null;
}

/**
 * InventoryAlertService
 * 
 * Computes low-stock alerts for vendor based on configured thresholds.
 * 
 * Leverages InventoryAvailabilityCalculator for consistency.
 */
export class InventoryAlertService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository,
        private readonly reservationRepository: IStockReservationRepository,
        private readonly availabilityCalculator: InventoryAvailabilityCalculator
    ) { }

    async getAlerts(vendorId: string, page: number = 1, limit: number = 50): Promise<{
        alerts: LowStockAlert[];
        total: number;
        pagination: {
            page: number;
            limit: number;
            totalPages: number;
        };
    }> {
        // 1. Find all active variants for vendor with configured thresholds
        const variants = await this.variantRepository.findByVendorWithThreshold(vendorId);

        // 2. Process each variant to compute alerts
        const alertsPromises = variants.map(async (variant) => {
            // Count active, non-expired reservations
            const activeReservations = await this.reservationRepository.countActiveByVariant(variant.id);

            // Calculate available stock using centralized calculator
            const availableStock = this.availabilityCalculator.calculate({
                stock: variant.stock,
                activeReservations,
                allowOversell: variant.allowOversell
            });

            // Check if low stock
            const isLow = this.availabilityCalculator.isLowStock({
                availableStock,
                threshold: variant.lowStockThreshold
            });

            if (!isLow) {
                return null; // Not low stock
            }

            // Get product for title
            const product = await this.productRepository.findById(variant.productId, vendorId);

            if (!product) {
                return null; // Product not found (shouldn't happen)
            }

            // Calculate stock percentage
            const stockPercentage = this.availabilityCalculator.calculateStockPercentage({
                stock: variant.stock,
                activeReservations,
                allowOversell: variant.allowOversell,
                threshold: variant.lowStockThreshold
            });

            return {
                variantId: variant.id,
                productId: variant.productId,
                sku: variant.sku,
                productTitle: product.title,
                currentStock: variant.stock,
                activeReservations,
                availableStock,
                threshold: variant.lowStockThreshold!,
                stockPercentage
            } as LowStockAlert;
        });

        // 3. Resolve all promises and filter nulls
        const allAlerts = (await Promise.all(alertsPromises)).filter((a): a is LowStockAlert => a !== null);

        // 4. Apply pagination
        const total = allAlerts.length;
        const skip = (page - 1) * limit;
        const paginatedAlerts = allAlerts.slice(skip, skip + limit);

        return {
            alerts: paginatedAlerts,
            total,
            pagination: {
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        };
    }
}
