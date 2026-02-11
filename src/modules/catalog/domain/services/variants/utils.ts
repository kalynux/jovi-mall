import * as crypto from 'crypto';

/**
 * Generate a 32-character based hash from a string
 * Used for creating deterministic SKUs from option signatures
 */
export function hashString(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Generate an option signature from sorted option name-value pairs
 * Example: "size:s|color:red"
 * 
 * @param optionValuePairs - Array of {optionName, value} sorted by option position
 * @returns Deterministic signature string
 */
export function generateOptionSignature(optionValuePairs: Array<{ optionName: string; value: string }>): string {
  return optionValuePairs
    .map(pair => `${pair.optionName.toLowerCase()}:${pair.value.toLowerCase()}`)
    .join('|');
}

/**
 * Generate a SKU from product ID and option signature
 * Format: {productId}-{hash}
 * 
 * @param productId - Product ID
 * @param signature - Option signature
 * @returns Deterministic SKU
 */
export function generateSKU(productId: string, signature: string): string {
  const hash = hashString(signature);
  return `${productId}-${hash}`;
}

/**
 * Calculate cartesian product count without generating the full array
 * Used to check if generation would exceed MAX_VARIANTS_PER_PRODUCT
 * 
 * @param valueCounts - Array of value counts per option
 * @returns Total number of combinations
 */
export function calculateCartesianProductCount(valueCounts: number[]): number {
  if (valueCounts.length === 0) return 0;
  return valueCounts.reduce((acc, count) => acc * count, 1);
}

/**
 * Generate cartesian product from arrays of values
 * Returns all possible combinations
 * 
 * @param arrays - Arrays to combine
 * @returns All possible combinations
 */
export function cartesianProduct<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) return [];
  if (arrays.length === 1) return arrays[0].map(item => [item]);
  
  const [first, ...rest] = arrays;
  const restProduct = cartesianProduct(rest);
  
  const result: T[][] = [];
  for (const item of first) {
    for (const combination of restProduct) {
      result.push([item, ...combination]);
    }
  }
  
  return result;
}
