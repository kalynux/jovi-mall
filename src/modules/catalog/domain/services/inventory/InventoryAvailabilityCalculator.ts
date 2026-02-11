/**
 * InventoryAvailabilityCalculator
 * 
 * First-class, centralized computation of available stock.
 * Single source of truth for "available stock" semantics.
 * 
 * Prevents divergent implementations across services.
 */

export interface CalculateAvailableStockParams {
    stock: number;
    activeReservations: number;
    allowOversell: boolean;
}

export interface IsLowStockParams {
    availableStock: number;
    threshold: number | null;
}

export class InventoryAvailabilityCalculator {
    /**
     * Calculate available stock for new reservations
     * 
     * Formula depends on oversell configuration:
     * - allowOversell = false: stock - activeReservations
     * - allowOversell = true: stock (ignores reservations)
     */
    calculate(params: CalculateAvailableStockParams): number {
        const { stock, activeReservations, allowOversell } = params;

        if (allowOversell) {
            // Overselling enabled: available stock = current stock
            // Reservations don't reduce availability
            return stock;
        }

        // Overselling disabled: subtract active reservations
        return stock - activeReservations;
    }

    /**
     * Determine if variant is low stock based on threshold
     * 
     * Returns false if threshold is null (no alert configured)
     */
    isLowStock(params: IsLowStockParams): boolean {
        const { availableStock, threshold } = params;

        if (threshold === null) {
            return false; // No threshold configured
        }

        return availableStock <= threshold;
    }

    /**
     * Calculate available stock percentage
     * Useful for UI indicators
     */
    calculateStockPercentage(params: CalculateAvailableStockParams & { threshold: number | null }): number | null {
        const { threshold } = params;

        if (threshold === null || threshold === 0) {
            return null; // Can't calculate percentage without threshold
        }

        const available = this.calculate(params);
        return Math.round((available / threshold) * 100);
    }
}
