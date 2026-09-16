import { relatedProductsService } from '../../../catalog/services/related-products.service';

/**
 * Which products are "similar" to one product — the READ behind every Similar-items control.
 *
 * ── ⚠ ONE READ, SEVERAL DOORS ───────────────────────────────────────────────
 * The same question is asked from more than one place: the Similar-items button on the product
 * screen, and the one on an out-of-stock chat card. Both answer it here, so a customer who taps
 * either sees the same shelf — and a WhatsApp Flow can ask it later without a second opinion.
 *
 * No Express, no session, no handle: a caller decides what to do with the ids (the Mini App pins
 * them into a listing session; a chat card might draw them).
 *
 * ── WHAT "SIMILAR" MEANS HERE, AND IT IS NOT DECIDED HERE ───────────────────
 * `relatedProductsService` owns the ranking: products **bought together** with this one when
 * there are past orders, else **the same category, most recently ordered first**. It caches a
 * ranking for hours and re-reads the products live, so a suspended product drops out of the
 * shelf even while its ranking is cached. Nothing here re-ranks or filters — a second rule on
 * top would be a second definition of "similar".
 *
 * ⚠ **The shelf is a strip, not a catalogue** — at most `RELATED_PRODUCTS_LIMIT` (default 8)
 * products. A listing opened from it will not page, and that is correct: eight similar things
 * is the answer, not the first page of one.
 */

/**
 * The ids of the products similar to `productId`, best first. Empty when there are none.
 *
 * ⚠ **Throws `CATALOG_PRODUCT_NOT_FOUND` (404) when the product itself has gone** — the
 * question has no subject. Every OTHER failure is also thrown, deliberately: whether a missing
 * Similar-items button is acceptable is the caller's call, not this read's. The product screen
 * decides it is (see `similarAvailable`); an explicit tap decides it is not.
 */
export async function readSimilarProductIds(productId: string): Promise<string[]> {
    const { data } = await relatedProductsService.forProduct(productId);
    return data.map((row) => row.product.id);
}
