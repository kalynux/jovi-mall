import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';

/**
 * SlugService: Pure domain service for generating URL-safe, unique slugs
 * 
 * PURITY CONSTRAINTS:
 * - ❌ MUST NOT save anything
 * - ❌ MUST NOT mutate Product entities
 * - ❌ MUST NOT use transactions
 * - ✅ Only returns strings
 */
export class SlugService {
  constructor(private readonly productRepository: IProductRepository) {}

  /**
   * Generate a URL-safe slug from a title and ensure uniqueness per vendor
   * @param title - Product title
   * @param vendorId - Vendor ID for uniqueness scope
   * @returns Unique slug for the vendor
   */
  async generate(title: string, vendorId: string): Promise<string> {
    const baseSlug = this.slugify(title);
    return this.ensureUnique(baseSlug, vendorId);
  }

  /**
   * Ensure slug is unique for the vendor, auto-incrementing if needed
   * @param baseSlug - Base slug to check
   * @param vendorId - Vendor ID for uniqueness scope
   * @returns Unique slug (e.g., "my-product", "my-product-2", etc.)
   */
  async ensureUnique(baseSlug: string, vendorId: string): Promise<string> {
    let candidateSlug = baseSlug;
    let counter = 2;

    // Check uniqueness and auto-increment
    while (await this.productRepository.existsBySlug(candidateSlug, vendorId)) {
      candidateSlug = `${baseSlug}-${counter}`;
      counter++;
    }

    return candidateSlug;
  }

  /**
   * Convert title to URL-safe slug
   * - Lowercase
   * - Replace spaces with hyphens
   * - Remove special characters
   * - Remove consecutive hyphens
   */
  private slugify(title: string): string {
    return title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-')     // Replace spaces with hyphens
      .replace(/-+/g, '-')      // Replace consecutive hyphens with single hyphen
      .replace(/^-+|-+$/g, ''); // Trim hyphens from start/end
  }
}
