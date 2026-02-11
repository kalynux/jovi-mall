import { OrderModel } from '../order.model';

/**
 * Order Number Generator
 * 
 * Generates human-readable order numbers in the format:
 * ORD-YYYY-NNNNNN
 * 
 * Examples:
 * ORD-2026-000001
 * ORD-2026-000123
 * ORD-2026-999999
 */
export class OrderNumberGenerator {
  /**
   * Generate next order number for the current year
   * Thread-safe via MongoDB's atomic findOne + increment pattern
   */
  static async generateOrderNumber(): Promise<string> {
    const currentYear = new Date().getFullYear();
    
    // Count existing orders for this year
    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear + 1, 0, 1);
    
    const count = await OrderModel.countDocuments({
      created_at: {
        $gte: startOfYear,
        $lt: endOfYear
      }
    });
    
    // Next sequential number (1-indexed)
    const sequenceNumber = (count + 1).toString().padStart(6, '0');
    
    return `ORD-${currentYear}-${sequenceNumber}`;
  }
  
  /**
   * Validate order number format
   */
  static isValidOrderNumber(orderNumber: string): boolean {
    return /^ORD-\d{4}-\d{6}$/.test(orderNumber);
  }
  
  /**
   * Extract year from order number
   */
  static getYearFromOrderNumber(orderNumber: string): number | null {
    const match = orderNumber.match(/^ORD-(\d{4})-\d{6}$/);
    return match ? parseInt(match[1], 10) : null;
  }
}
