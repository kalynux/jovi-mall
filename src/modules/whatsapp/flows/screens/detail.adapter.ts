import type { ProductDetailView } from '../../../bot-surface/miniapp/surfaces/product-detail.read';
import { screenResponse, type FlowResponseBody } from '../domain/flow-protocol';
import {
    PRODUCT_DETAIL_NO_IMAGE_SCREEN,
    PRODUCT_DETAIL_SCREEN,
} from '../definitions/product-detail.flow';
import type { FlowCopy } from './flow-copy';
import { noticeResponse } from './listing.adapter';
import { FLOW_CAPS, fitText, joinFitted, wouldCut } from './flow-text';

/**
 * One product, reshaped for the Flow's product screen.
 *
 * ── ⚠ RESHAPES, NEVER RE-DERIVES ────────────────────────────────────────────
 * Every value comes from `readProductDetail`, the same read the Telegram page's `/data` calls.
 * The variant name is its `label` (`buildVariantDisplayName`), the price is its `priceText`,
 * and both whether a variant can be bought and what the button says come from its
 * `affordance`. No price, stock verdict or purchase verb is decided here.
 *
 * ⚠ **`valueIds` and `options` are deliberately NOT read.** They are the Telegram page's
 * positional chip-matching inputs, and the flattened list needs neither. Reading them here would
 * reintroduce the one defect flattening removed.
 *
 * @param imageBase64 the hero image already encoded, or null. ⚠ It must have been withheld
 *   **before** encoding when its `access` isn't `public`: see `image-bytes.ts`. This function
 *   can't check, and doesn't try.
 * @param openRef this open's reference, echoed back by the footer for the idempotency key. A
 *   redraw after a refusal passes the SAME one: it is still the same open.
 */
export function toDetailScreen(
    view: ProductDetailView,
    copy: FlowCopy,
    imageBase64: string | null,
    openRef: string,
): FlowResponseBody {
    const variants = view.variants.slice(0, FLOW_CAPS.dropdownOptions);

    /**
     * ⚠ **Nothing buyable means no form.** A drop-down whose every option is disabled is a
     * required field nobody can fill, so the footer would never enable and the customer would
     * be left with only the close button. One honest sentence and a way back is better than a
     * form that can't be finished. Telegram shows a disabled button, which a web page can.
     */
    if (!variants.some((v) => v.affordance.enabled)) {
        return noticeResponse(copy.outOfStock, copy);
    }

    if (view.variants.length > FLOW_CAPS.dropdownOptions) {
        // Silent loss is the thing the drop-down was chosen to avoid, so it is at least logged.
        console.warn(
            `[WhatsAppFlows] product ${view.productId} has ${view.variants.length} variants; `
            + `the form shows the first ${FLOW_CAPS.dropdownOptions}`,
        );
    }

    /**
     * The button label comes from the default variant's affordance, or else the first variant
     * that can be bought. The four verbs are product-level facts, so in practice every variant
     * of one product carries the same label.
     */
    const labelled =
        variants.find((v) => v.variantId === view.defaultVariantId && v.affordance.enabled)
        ?? variants.find((v) => v.affordance.enabled)!;

    const data: Record<string, unknown> = {
        title: fitText(view.title, FLOW_CAPS.heading),
        storeLine: joinFitted([view.storeName, view.storeCity], FLOW_CAPS.caption),
        description: fitText(view.description ?? '', FLOW_CAPS.body),
        chooseLabel: fitText(copy.detailChoose, 20),
        variants: variants.map((v) => ({
            id: v.variantId,
            title: fitText(v.label, FLOW_CAPS.optionTitle),
            description: joinFitted(
                [
                    wouldCut(v.label, FLOW_CAPS.optionTitle) && v.label,
                    v.priceText,
                    !v.inStock && copy.outOfStock,
                ],
                FLOW_CAPS.optionDescription,
            ),
            enabled: v.affordance.enabled,
        })),
        actionLabel: fitText(labelled.affordance.label, FLOW_CAPS.footerLabel),
        openRef,
    };

    if (imageBase64) {
        return screenResponse(PRODUCT_DETAIL_SCREEN, { image: imageBase64, ...data });
    }
    return screenResponse(PRODUCT_DETAIL_NO_IMAGE_SCREEN, data);
}
