import type { ListingPage } from '../../../bot-surface/miniapp/surfaces/product-listing.read';
import { screenResponse, type FlowResponseBody } from '../domain/flow-protocol';
import { PRODUCT_LISTING_SCREEN } from '../definitions/product-listing.flow';
import { NOTICE_SCREEN } from '../definitions/notice.screen';
import type { FlowCopy } from './flow-copy';
import { FLOW_CAPS, fitText, joinFitted, wouldCut } from './flow-text';

/**
 * The page size the listing Flow asks `readListingPage` for.
 *
 * ⚠ **Meta's `RadioButtonsGroup` cap, and passing it is this side's job.** `readListingPage`
 * clamps `pageSize` to the catalogue's own 1–100, which does not protect a 20-option control.
 * Its default is 24, which would overflow.
 */
export const FLOW_LISTING_PAGE_SIZE = FLOW_CAPS.radioOptions;

/** The answer when a screen has nothing to show: one sentence and a way back to the chat. */
export function noticeResponse(message: string, copy: FlowCopy): FlowResponseBody {
    return screenResponse(NOTICE_SCREEN, {
        message: fitText(message, FLOW_CAPS.body),
        closeLabel: fitText(copy.flowBackToChat, FLOW_CAPS.footerLabel),
    });
}

/**
 * One page of the listing, reshaped for the Flow's `PRODUCTS` screen.
 *
 * ── ⚠ RESHAPES, NEVER RE-DERIVES ────────────────────────────────────────────
 * Every value comes from `readListingPage`, the same read the Telegram page's `/data` calls.
 * The price is its `priceText`, and whether a row can be opened is its `variantId`. Nothing here
 * decides what a product costs, whether it's visible, or whether it's in stock. Those rules have
 * one home, and a second copy on the channel nobody can open in a browser would drift unseen.
 *
 * ⚠ **`enabled` follows `variantId`, not `inStock`,** the same distinction the grid draws. A
 * product with nothing sellable is a muted card that can't be opened. An out-of-stock product
 * with a variant still opens, so its detail screen can say what's sold out.
 */
export function toListingScreen(page: ListingPage, copy: FlowCopy): FlowResponseBody {
    if (page.products.length === 0) {
        return noticeResponse(copy.listingEmpty, copy);
    }

    const products = page.products.slice(0, FLOW_CAPS.radioOptions).map((product) => ({
        id: product.productId,
        title: fitText(product.title, FLOW_CAPS.optionTitle),
        /**
         * A title cut to 30 characters is repeated whole here, because two kettles whose names
         * differ only after character 30 would otherwise be indistinguishable rows.
         */
        description: joinFitted(
            [
                wouldCut(product.title, FLOW_CAPS.optionTitle) && product.title,
                product.priceText,
                product.storeName,
                !product.inStock && copy.outOfStock,
            ],
            FLOW_CAPS.optionDescription,
        ),
        enabled: product.variantId !== null,
    }));

    return screenResponse(PRODUCT_LISTING_SCREEN, {
        heading: fitText(page.heading ?? copy.listingHeading, FLOW_CAPS.heading),
        products,
        openLabel: fitText(copy.flowOpenProduct, FLOW_CAPS.footerLabel),
    });
}
