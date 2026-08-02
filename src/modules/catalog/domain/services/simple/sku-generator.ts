/**
 * SKU generation for simple-mode products.
 *
 * A vendor listing one pair of shoes should not have to invent an inventory
 * code, but SKU is not a free-form label here — it carries two constraints:
 *
 *   1. It is GLOBALLY unique across every vendor (unique index `{ sku: 1 }` on
 *      product-variant.model.ts), so a naive slug would collide the moment two
 *      shops both sell "black-sneakers".
 *   2. For an option-less variant it doubles as the `optionSignature`, which is
 *      unique per `{ productId, optionSignature }` — so it must also be stable
 *      for the life of the variant.
 *
 * Appending the product's own ObjectId satisfies both **by construction**: the
 * id is globally unique and immutable, so there is no probe, no retry loop, and
 * no read-then-write race. The readable prefix is there purely so the value is
 * recognisable in a vendor's inventory export.
 */

/** Longest readable prefix kept before the id. 24 + 1 + 24 = 49, well under the 100-char cap. */
const MAX_PREFIX_LENGTH = 24;

/** Used when a title has no ASCII-alphanumeric characters at all (e.g. pure CJK or emoji). */
const FALLBACK_PREFIX = 'ITEM';

/**
 * Build a stable, globally-unique SKU from a product title and its id.
 *
 * Never regenerate this for an existing variant — orders and the storefront
 * reference the SKU, and `optionSignature` mirrors it.
 */
export function generateSimpleSku(title: string, productId: string): string {
    const prefix = title
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_PREFIX_LENGTH)
        // A trailing '-' can survive the slice above when the cut lands on a separator.
        .replace(/-+$/g, '');

    // The id is lowercase hex; uppercasing keeps the whole SKU in one case so it
    // reads as an inventory code rather than a bug. Hex uppercases bijectively,
    // so the global-uniqueness guarantee is untouched.
    return `${prefix || FALLBACK_PREFIX}-${productId.toUpperCase()}`;
}
