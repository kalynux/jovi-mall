import { parseCommand } from './command-parser';
import { COMMANDS } from './command-registry';

/**
 * The website's **Bargain** button, as it arrives in a chat.
 *
 * ── TWO SPELLINGS OF ONE REQUEST, BECAUSE THE TWO CHANNELS ALLOW DIFFERENT THINGS ──
 * The storefront opens the bot with a first message that must start a haggle on one exact
 * product, the way a `bargain:<productId>:<variantId>` tap does. The channels constrain that
 * message differently:
 *
 *   WhatsApp  `wa.me/<number>?text=…` prefills ANY text, and the customer may edit it before
 *             sending. The site sends a slash command on the first line —
 *             `/bargain <productId> <variantId>` — and may add a sentence in the visitor's
 *             language after it, which is read as the command's free-text tail and ignored.
 *   Telegram  `t.me/<bot>?start=<payload>` sends the literal text `/start <payload>`, and the
 *             payload is at most 64 characters of `[A-Za-z0-9_-]` — no colon, no space. The site
 *             sends `bargain_<productId>_<variantId>` (57 characters).
 *
 * Both arrive through the ONE door n8n already uses for every message beginning with `/`
 * (`detect command` → `POST /api/internal/bot/command`), which is why neither needed an n8n
 * change: the automation layer forwards the raw text and parses nothing.
 *
 * ── ⚠ A HINT, NEVER A CREDENTIAL ───────────────────────────────────────────
 * Everything here is text the customer could have typed or edited. The ids name a product and
 * nothing else — no price, no session, no account — and every rule that decides what happens
 * (published? in stock? negotiable?) is re-read live by `bargain-entry.service.ts`. A forged or
 * edited id therefore buys exactly what typing the same ids by hand buys: a refusal, or a
 * question about a product the customer could have asked about anyway.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 * No I/O. It imports the parser and the registry, both pure, so the grammar is testable with
 * no database — the discipline `command-parser.ts` keeps.
 */

/** What either spelling carries. `variantId` null means "the product's default variant". */
export interface BargainEntryIds {
    productId: string;
    variantId: string | null;
}

/** The `/start` payload prefix. Never a colon: Telegram refuses one in a deep-link payload. */
export const BARGAIN_START_PREFIX = 'bargain_';

/** Telegram's own cap on a `start` payload. Checked, not assumed, by the builder below. */
export const TELEGRAM_START_PAYLOAD_MAX = 64;

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export function isObjectIdHex(value: string | null | undefined): value is string {
    return typeof value === 'string' && OBJECT_ID.test(value);
}

/**
 * Build the Telegram payload — the one place its grammar is written down, so the storefront's
 * documentation and this parser cannot disagree. Throws on an id that is not one, because a
 * payload built from garbage is a link that opens the bot and does nothing.
 */
export function bargainStartPayload(productId: string, variantId?: string | null): string {
    if (!isObjectIdHex(productId) || (variantId != null && !isObjectIdHex(variantId))) {
        // eslint-disable-next-line no-restricted-syntax -- a programming error in the caller
        throw new Error('[BotCommands] bargainStartPayload needs 24-hex ObjectIds');
    }
    const payload = variantId ? `${BARGAIN_START_PREFIX}${productId}_${variantId}` : `${BARGAIN_START_PREFIX}${productId}`;
    if (payload.length > TELEGRAM_START_PAYLOAD_MAX) {
        // eslint-disable-next-line no-restricted-syntax -- unreachable with two ObjectIds (57)
        throw new Error(`[BotCommands] start payload is ${payload.length} chars, cap ${TELEGRAM_START_PAYLOAD_MAX}`);
    }
    return payload;
}

/**
 * Read a `/start` payload. `null` when it is not a bargain payload at all — `/start` with any
 * other argument keeps meaning "start here", exactly as before this existed.
 *
 * ⚠ **A payload that IS shaped `bargain_…` but carries a bad id is still a bargain request**, and
 * comes back with the bad value in place rather than null, so the caller refuses it in words. A
 * customer who pressed Bargain and got a generic welcome would reasonably conclude the button is
 * broken — which it is, and the refusal is what says so.
 */
export function parseBargainStartPayload(payload: string | null | undefined): BargainEntryIds | null {
    if (typeof payload !== 'string' || !payload.startsWith(BARGAIN_START_PREFIX)) return null;

    const [productId = '', variantId, ...rest] = payload.slice(BARGAIN_START_PREFIX.length).split('_');
    // A third segment is not a shape anybody builds; carry it as an unreadable variant so the
    // refusal fires instead of the extra silently vanishing.
    if (rest.length > 0) return { productId, variantId: [variantId, ...rest].join('_') };
    return { productId, variantId: variantId === undefined || variantId === '' ? null : variantId };
}

/**
 * Is this raw message the website's Bargain link, in either spelling?
 *
 * Used where the command router has not run and cannot run — a Telegram chat with no account
 * yet, refused by the identity guard before any handler (`bargain-entry-hold.middleware.ts`).
 * It goes through the SAME parser and registry the router uses, so an alias or a colon form the
 * router accepts is accepted here too, and one it refuses is refused here.
 */
export function bargainEntryFromText(text: string | null | undefined): BargainEntryIds | null {
    const parsed = parseCommand(text, COMMANDS);
    if (parsed.kind !== 'matched') return null;

    if (parsed.name === 'bargain') {
        return { productId: parsed.args.product ?? '', variantId: parsed.args.variant ?? null };
    }
    if (parsed.name === 'start') {
        return parseBargainStartPayload(parsed.args.payload);
    }
    return null;
}

/** Both ids well-formed (the variant may be absent). The one validity test every caller uses. */
export function bargainEntryIdsAreValid(ids: BargainEntryIds): boolean {
    return isObjectIdHex(ids.productId) && (ids.variantId === null || isObjectIdHex(ids.variantId));
}
