import { PublicProductDetailDto, PublicVariantDto } from '../../../catalog/dto/public-product.dto';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { botChrome } from '../../domain/bot-chrome-copy';
import { formatBotPrice } from '../../domain/product-card';
import { PurchaseVerb, resolvePurchaseAffordance } from '../../domain/purchase-affordance';
import { ImageSource, toImageSource } from './image-source';

/**
 * The product detail's READ — one product, one set of rules, rendered by two channels.
 *
 * ── ⚠ WHY THIS IS A SEPARATE FILE FROM ITS CONTROLLER ───────────────────────
 * The same product is drawn twice: as option chips and a live button in the Telegram Mini App
 * (`product-detail.controller.ts` → `pd.html`), and as one flat list of variants in a WhatsApp
 * Flow (`whatsapp/flows`). A second projection there would be a second opinion about the
 * purchase ladder, the service price and the ship-from privacy rule — each of which has
 * already been got wrong once somewhere on this platform.
 *
 * So the read lives here and **both renderings import it**. No Express, no session, no handle:
 * a Flow authenticates differently, and sliding an `ia_` session's lifetime is the Mini App's
 * business, not a side effect of fetching data.
 *
 * ── ⚠ THE PURCHASE BUTTON IS DECIDED HERE, ONCE ─────────────────────────────
 * `resolvePurchaseAffordance()` is the single source of truth for Bargain · Add to cart · Buy
 * now · Book, and it is resolved **per variant** with its label already translated through
 * `botChrome()` — the call the chat card makes. No rendering may narrow it: dropping a disabled
 * affordance or substituting a label would show a customer one word in the chat and another on
 * the screen. And the write path **re-resolves it** rather than trusting anything sent back, so
 * no renderer ever needs to send a verb.
 *
 * ⚠ **The picture is NOT resolved here** — `imageSourceUrl` is raw, because the right rule
 * depends on who fetches it. See `browser-image-url.ts`.
 */

export interface DetailVariant {
    variantId: string;
    /**
     * What the variant is called — `PublicVariantDto.name`, i.e. `buildVariantDisplayName`: a
     * vendor-set name, else the selection spelled out (`"Size: M, Colour: Red"`), else the SKU.
     *
     * For a renderer that lists variants flat (a WhatsApp Flow) rather than as option chips.
     * ⚠ The format is that function's, not a " · "-joined one; do not test against an example.
     */
    label: string;
    /**
     * One value id per entry of `options`, **in the same order** — for a renderer that matches
     * a chip selection positionally (the Mini App). An empty string where this variant carries
     * no value for that option, which matches nothing, which is the safe outcome.
     */
    valueIds: string[];
    /** Formatted. A service renders "from {priceFrom} · {priceUnit}", never its bare unit rate. */
    priceText: string;
    inStock: boolean;
    /** `resolvePurchaseAffordance()`, verbatim, with its label translated. Never narrowed. */
    affordance: { verb: PurchaseVerb; label: string; enabled: boolean };
}

export interface ProductDetailView {
    productId: string;
    title: string;
    storeName: string;
    /** ⚠ City only. A vendor's ship-from addresses are private. */
    storeCity: string | null;
    description: string | null;
    /** ⚠ Raw. Each channel applies its own fetch rule. */
    imageSourceUrl: string | null;
    /** The hero picture as a stored file, for a renderer that needs its bytes — see `image-source.ts`. */
    image: ImageSource | null;
    /** Only values some sellable variant can actually reach — see `selectableOptions`. */
    options: Array<{ name: string; values: Array<{ id: string; label: string }> }>;
    variants: DetailVariant[];
    defaultVariantId: string | null;
}

/**
 * One product, projected for every channel.
 *
 * ⚠ **Read live on every call.** A held price is a price a customer can hold us to.
 *
 * ⚠ **Throws `CATALOG_PRODUCT_NOT_FOUND` (404) for a product that has gone** — unpublished,
 * suspended or deleted since whatever opened it. That is deliberate: swallowing it into an
 * empty view would show a customer a product page for something that is not for sale. Each
 * renderer turns the refusal into its own "ask me again".
 *
 * @param language translates each variant's affordance label. It changes no other field:
 *   product text is vendor-authored in one language and is not translated here.
 */
export async function readProductDetail(
    productId: string,
    language: string | null,
): Promise<ProductDetailView> {
    const product = await publicCatalogService.getProductById(productId);

    /**
     * ⚠ **Computed ONCE and used for both halves, because a chip renderer matches them
     * POSITIONALLY.** `pd.html` builds the customer's selection as one value per entry of
     * `options`, in order, and compares it against each variant's `valueIds` index by index. So
     * the two arrays are one data structure in two pieces: derive `valueIds` from the product's
     * full option list while sending a filtered `options`, and every comparison silently
     * misaligns — no variant ever matches, the button never enables, and nothing fails anywhere.
     */
    const picker = selectableOptions(product);

    return {
        productId: product.id,
        title: product.title,
        storeName: product.store.name,
        /**
         * ⚠ **City only — a ship-from address stays private.** `business_addresses[]` are the
         * places a vendor ships from — a home or a warehouse, with a street line and exact
         * coordinates. The public DTO publishes nothing but the city, and nothing here reaches
         * past it. Proved live: a literal ship-from line in a fixture appears nowhere.
         */
        storeCity: product.store.city,
        description: product.description || null,
        imageSourceUrl: product.images[0]?.url ?? null,
        image: toImageSource(product.images[0]),
        /**
         * The option id is the join key this file needs and no renderer does — chips select by
         * value id and match by position — so it stays inside rather than being published.
         */
        options: picker.map(({ name, values }) => ({ name, values })),
        variants: product.variants.map((variant) => toDetailVariant(variant, picker, product, language)),
        defaultVariantId: product.defaultVariantId,
    };
}

/**
 * The picker, with every value no surviving variant can reach removed.
 *
 * ── ⚠ WHY THIS FILTER EXISTS, AND WHAT IT LOOKS LIKE WITHOUT IT ────────────
 * `toPublicProductDetailDto` filters **variants** to the sellable ones — active and not
 * deleted — but builds `options[].values` from *every* option value on the product. The two
 * are not filtered together, and for a storefront that is fine: it can grey a chip out.
 *
 * On a chip screen it produces a dead end a customer cannot read. Archive the red T-shirt and
 * "Red" still draws as a chip; tapping it selects a combination no variant matches, so the
 * button falls back to **"Pick an option first"** — to somebody who has just picked one. They
 * tap again, get the same sentence, and conclude the screen is broken. Proved live: an archived
 * variant's "XL" is not offered.
 *
 * So a value is offered only if some sellable variant carries it, and an option left with no
 * values is dropped rather than drawn as an empty row.
 *
 * ⚠ **This does NOT make every remaining combination reachable, and it cannot.** A product sold
 * as Red-S and Blue-L has four chips and two valid pairings; Red then L is a real "that
 * combination is not available", not a defect. `inAppCopy` has no words for it, so the screen
 * still says "Pick an option first" — wrong but rare, and raised with the copy table's owner
 * rather than papered over here, where it would be copy outside the one table a boot assertion
 * proves complete in five languages.
 */
function selectableOptions(product: PublicProductDetailDto): PickerOption[] {
    const reachable = new Set(product.variants.flatMap((v) => v.optionValueIds));

    return product.options
        .map((option) => ({
            id: option.id,
            name: option.name,
            values: option.values
                .filter((value) => reachable.has(value.id))
                .map((value) => ({ id: value.id, label: value.value })),
        }))
        .filter((option) => option.values.length > 0);
}

/** One option as a picker draws it. `id` orders a variant's `valueIds` and is never published. */
interface PickerOption {
    id: string;
    name: string;
    values: Array<{ id: string; label: string }>;
}

/**
 * One variant → one selectable row with its button.
 *
 * ⚠ **`valueIds` is ordered by the PICKER actually returned**, never by the product's full
 * option list — see where `picker` is computed. ⚠ **Keyed on ids, never on `optionSignature`**:
 * renaming an option value is a documented safe operation that deliberately does not rewrite
 * that string, so a lookup built from displayed text stops finding variants that exist.
 */
function toDetailVariant(
    variant: PublicVariantDto,
    picker: PickerOption[],
    product: PublicProductDetailDto,
    language: string | null,
): DetailVariant {
    const byOptionId = new Map(variant.options.map((o) => [o.optionId, o.valueId]));

    /**
     * ⚠ **Resolved per VARIANT, not per product — the whole reason a detail view exists.** A
     * product may sell one variant at a fixed price and another with a bargaining window open,
     * so the list row's answer (its *default* variant's) cannot be applied across the picker.
     * `PublicVariantDto.negotiable` is the per-variant predicate, published for exactly this.
     */
    const affordance = resolvePurchaseAffordance({
        type: product.type,
        negotiable: variant.negotiable,
        inStock: variant.inStock,
        variantId: variant.id,
    });

    return {
        variantId: variant.id,
        label: variant.name,
        valueIds: picker.map((option) => byOptionId.get(option.id) ?? ''),
        priceText: priceTextOf(variant),
        inStock: variant.inStock,
        /**
         * ⚠ **Verbatim, translated here rather than by any renderer.** `labelKey` goes through
         * `botChrome()` against the customer's language — the same call the chat card makes —
         * so the word on the button is the same word everywhere. `verb` travels for a renderer's
         * own use and is **never** sent back on the write: the write path re-resolves the rung.
         */
        affordance: {
            verb: affordance.verb,
            label: botChrome(affordance.labelKey, language),
            enabled: affordance.enabled,
        },
    };
}

/**
 * A variant's price, formatted server-side.
 *
 * ⚠ **A SERVICE variant's `price` is a UNIT RATE, not a total**, and printing it as "the price"
 * misquotes the customer. The DTO ships `priceFrom` (the least a booking of the minimum duration
 * can cost) and `priceUnit` (e.g. "per 1 h") beside it for exactly this, and the documented
 * rendering is "from {priceFrom} · {priceUnit}". The bare rate would quote a 60-minute price to
 * somebody booking 90. Proved live: a service renders "5 000 XAF · per 1 h".
 *
 * ⚠ **No renderer does money maths** — the Mini App suites refuse `toFixed`, `parseFloat` and
 * `Intl.NumberFormat` in a page, and a Flow cannot compute at all.
 */
function priceTextOf(variant: PublicVariantDto): string {
    if (variant.service) {
        return `${formatBotPrice(variant.service.priceFrom, variant.currency)} · ${variant.service.priceUnit}`;
    }
    return formatBotPrice(variant.price, variant.currency);
}
