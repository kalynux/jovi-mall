import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { toPublicReviewDto, toRatingSummaryDto } from '../../../reviews/dto/review.dto';
import { reviewAggregateRepository } from '../../../reviews/repositories/review-aggregate.repository';
import { reviewService } from '../../../reviews/services/review.service';

/**
 * What customers have said about one product — the READ behind every review control.
 *
 * ── ⚠ ONE READ, SEVERAL DOORS ───────────────────────────────────────────────
 * The same question is asked from three places and must answer identically in all of them: the
 * chat's review summary (a star average and two quotes under a **Read all** button), the reviews
 * section on the in-app product screen, and — later — the WhatsApp Flow drawing the same product.
 * The rule this module already follows for similar products applies here for the same reason: a
 * second projection is a second opinion, and the two drift on the day somebody changes one.
 *
 * No Express, no session, no handle. A caller decides what to render.
 *
 * ── WHAT IS PUBLIC HERE, AND WHAT IS DELIBERATELY ABSENT ────────────────────
 * ✅ **There is no author to strip.** `PublicReviewDto` is rating, title, body and the published
 * date — the public review shape carries no name, no id and no avatar — so a quote in a chat
 * discloses nothing about who wrote it. That is a property of the DTO, not of this file, and it is
 * why a review quote was safe to put in a chat message at all.
 *
 * ── ⚠ THE PRODUCT IS CHECKED FIRST, AND THE ANSWER IS 404, NOT AN EMPTY LIST ─
 * The storefront's own review route answers an empty page for an unknown product, deliberately, so
 * that it cannot be used as an existence oracle for drafts. This door is different: it is reached
 * with a product id the CUSTOMER was shown, and "no reviews yet" about a product that has been
 * taken off sale is a sentence that sends them back to a card that no longer works. So the
 * publishability read runs first and a product that is gone refuses — the same refusal every other
 * door on this surface gives, carrying the same customer sentence.
 */

/**
 * ⭐ **A rating is RENDERED HERE, exactly as a price is** — `★★★★☆` and `4.3`, as strings.
 *
 * ── WHY, AND IT IS THE SAME ARGUMENT THE MONEY RULE MAKES ───────────────────
 * `test:inapp-catalog` refuses `toFixed`, `parseFloat` and `Intl.NumberFormat` in any screen,
 * because a WebView that computes money is a second implementation of it in the one place nothing
 * tests. The rule is about arithmetic reaching a customer, not about money specifically: three
 * surfaces draw this rating — a chat message, the product screen, and a WhatsApp Flow later — and
 * three roundings of 4.25 is how one product shows 4.3 in a chat and 4.2 on a screen.
 *
 * ⚠ **Stars are drawn, never described**, so the rating reads identically in all five languages,
 * and the number stays beside them because ★★★★☆ alone cannot tell 4.3 from 3.6.
 */
export function ratingDisplay(average: number): { stars: string; averageText: string } {
    const full = Math.max(0, Math.min(5, Math.round(average)));
    return {
        stars: '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full),
        averageText: average.toFixed(1),
    };
}

/** One quote, exactly as a chat or a screen may show it. */
export interface ProductReviewQuote {
    rating: number;
    /** The same rating as `★★★★☆`, so no renderer repeats the rounding. */
    stars: string;
    title: string | null;
    /** Never empty — a quote with no words is not a quote. Truncated; see `QUOTE_MAX_CHARS`. */
    body: string;
    publishedAt: string | null;
}

export interface ProductRating {
    average: number;
    count: number;
    /** `★★★★☆` and `4.3` — rendered once, here. See `ratingDisplay`. */
    stars: string;
    averageText: string;
}

export interface ProductReviewSummary {
    /** The product's own title, so a caller can name what is being reviewed. */
    title: string;
    /** Null when nothing is published — the DTO's own contract, and it is not the same as 0. */
    rating: ProductRating | null;
    /** At most `QUOTE_COUNT`, most recent first. Empty when nobody has written anything. */
    quotes: ProductReviewQuote[];
}

/**
 * Two quotes, because that is what fits above a button on both channels without becoming a wall of
 * text, and because the owner's decision was the two most RECENT written reviews rather than the
 * "best" ones — a rating this platform has no basis to compute and no business curating.
 */
const QUOTE_COUNT = 2;

/**
 * ⚠ **A quote is cut to fit a chat message, not to hide anything.** The whole review is one tap
 * away on the screen, and a 900-character review under a 20-character button is the thing that
 * makes a bot message unreadable. The ellipsis is the signal that there is more.
 */
const QUOTE_MAX_CHARS = 160;

/**
 * ⚠ **How far back the scan for WRITTEN reviews goes.**
 *
 * `listPublishedForSubject` sorts newest-first and does NOT filter on the body, because a rating
 * with no words is a perfectly good review and counts towards the average. So the two quotes are
 * the two most recent reviews that happen to have text, found by scanning one page of this size.
 *
 * It is bounded rather than exhaustive on purpose: a product whose last fifty reviews are all bare
 * stars shows none, which is correct and cheap, where paging until two are found is an unbounded
 * read on the busiest products. `noReviewsYetPrompt` covers the outcome either way.
 */
const QUOTE_SCAN_LIMIT = 25;

function truncate(value: string, max: number): string {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The star average, the count, and the most recent written reviews.
 *
 * Throws `CATALOG_PRODUCT_NOT_FOUND` (404) for a product that is not on sale to this caller — see
 * the header. Every other failure is thrown too: a caller that asked for reviews and silently got
 * none cannot tell "nobody has written one" from "the read failed", and those need different
 * sentences.
 */
export async function readProductReviewSummary(productId: string): Promise<ProductReviewSummary> {
    /**
     * ⚠ **The publishability gate and the product's title in one read**, through the same
     * `listByIds` the rest of this surface uses — it carries the publishable predicate, so a draft,
     * a suspended product or an unpublished vendor's product is absent rather than named.
     */
    const card = (await publicCatalogService.listByIds([productId])).get(productId);
    if (!card) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'That product is no longer on sale');
    }

    const [page, aggregate] = await Promise.all([
        reviewService.listPublicForProduct(productId, 1, QUOTE_SCAN_LIMIT),
        reviewAggregateRepository.find({
            targetType: 'product',
            targetId: productId,
            /**
             * ⚠ **Customer reviews only, and this is the same guard the storefront applies.** The
             * aggregate collection also holds agent and vendor ratings keyed by role; asking for
             * the product's customer aggregate by name is what keeps a delivery rating out of a
             * product's stars.
             */
            authorRole: 'customer',
        }),
    ]);

    const quotes = page.data
        .map(toPublicReviewDto)
        .filter((review) => (review.body ?? '').trim().length > 0)
        .slice(0, QUOTE_COUNT)
        .map((review) => ({
            rating: review.rating,
            stars: ratingDisplay(review.rating).stars,
            title: review.title,
            body: truncate(review.body as string, QUOTE_MAX_CHARS),
            publishedAt: review.publishedAt,
        }));

    return { title: card.title, rating: withDisplay(toRatingSummaryDto(aggregate)), quotes };
}

/** The aggregate plus its rendered form, or null when nothing is published. */
function withDisplay(summary: { average: number; count: number } | null): ProductRating | null {
    return summary ? { ...summary, ...ratingDisplay(summary.average) } : null;
}

/**
 * The star average and the count, alone.
 *
 * Split out because the two doors need different halves: the chat summary needs the quotes (and
 * pays for a 25-row scan to find them), while the screen draws the whole list underneath and needs
 * only the heading. Sharing the aggregate read is what keeps one definition of "the rating" —
 * customer reviews of the product, never a delivery rating that happens to share a target id.
 */
export async function readProductRating(productId: string): Promise<ProductRating | null> {
    return withDisplay(
        toRatingSummaryDto(
            await reviewAggregateRepository.find({
                targetType: 'product',
                targetId: productId,
                authorRole: 'customer',
            }),
        ),
    );
}

/** One page of published reviews, for the screen's own list. Newest first, as the storefront's is. */
export async function readProductReviewPage(
    productId: string,
    page: number,
    limit: number,
): Promise<{ reviews: ProductReviewQuote[]; total: number; hasMore: boolean }> {
    const result = await reviewService.listPublicForProduct(productId, page, limit);
    const reviews = result.data.map(toPublicReviewDto).map((review) => ({
        rating: review.rating,
        stars: ratingDisplay(review.rating).stars,
        title: review.title,
        /**
         * ⚠ **NOT truncated here, unlike a quote.** The screen is where the whole review is meant
         * to be readable; cutting it on both doors would leave the "Read all" button leading to the
         * same ellipsis the customer was trying to get past.
         */
        body: (review.body ?? '').trim(),
        publishedAt: review.publishedAt,
    }));

    return {
        reviews,
        total: result.meta.total,
        hasMore: result.meta.page < result.meta.pages,
    };
}
