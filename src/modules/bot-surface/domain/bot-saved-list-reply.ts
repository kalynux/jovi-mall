/**
 * The shape shared by the two "things I have saved" lists: addresses and payment methods.
 *
 * ── WHY ONE FILE RATHER THAN THE SAME FORTY LINES TWICE ─────────────────────
 * The two live in different controllers over different services and will keep diverging in
 * what they hold. What must NOT diverge is how a customer operates them, because they sit two
 * rows apart in one menu: pick from a list, then Make default / Remove. Written twice, they
 * drift one button at a time until the same gesture means different things on adjacent rows.
 *
 * Nothing here knows what an address or a card IS — it takes rows and titles that the owning
 * controller has already projected, so neither service leaks into the other's file.
 */
import { Request } from 'express';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome, type BotChromeKey } from './bot-chrome-copy';
import { accountActionId } from './bot-action-id';

/** One row of a saved list, already projected by whoever owns the collection. */
export interface SavedListRow {
    id: string;
    /** What the row says. An address label, a card's masked tail. */
    title: string;
    /** The longer form a WhatsApp list row can carry underneath. */
    detail?: string | null;
    isDefault: boolean;
    /**
     * Whether "Make default" is worth offering at all. Absent means yes.
     *
     * ⚠ **This is not the same question as `isDefault`.** A row can be eligible to become the
     * default and not be it (offer the button), be the default already (no button — nothing
     * would change), or be INELIGIBLE — an expired card, which the service would happily
     * accept as the default and which would then fail at the till. The third case is the one
     * this field exists for, and it is the out-of-stock Buy button in another costume.
     */
    mayBeDefault?: boolean;
}

/**
 * The list itself, as a choice.
 *
 * ⚠ **A choice, never a sentence with buttons**, and the reason is a platform limit rather
 * than taste: WhatsApp renders at most three reply buttons and silently drops the fourth, so a
 * customer with four saved addresses would lose one without any error anywhere. A choice
 * becomes a list of up to ten rows on that channel and a column of buttons on Telegram.
 *
 * ⚠ **The default is marked in the ROW, not reordered into a different position**, because the
 * controllers already sort it to the front — marking it as well means a customer scanning a
 * list of near-identical addresses can see which one checkout will use.
 */
export function setSavedListReply(
    req: Request,
    language: string | null,
    section: string,
    prompt: BotChromeKey,
    rows: readonly SavedListRow[],
): void {
    setBotReply(req, {
        kind: 'choice',
        text: botChrome(prompt, language),
        options: rows.map((row) => ({
            id: accountActionId(section, row.id),
            label: row.isDefault ? `${row.title} ✓` : row.title,
            shortLabel: row.title,
            description: row.detail ?? null,
        })),
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });
}

/**
 * One chosen row, with what can be done to it.
 *
 * ⚠ **"Make default" is absent on the row that already IS the default.** A button whose only
 * possible outcome is "nothing changed" teaches a customer that buttons here do nothing, and
 * it is the same class of control as the out-of-stock Buy button the discovery stream is
 * removing this round — drawn because the shape has a slot for it, not because it can act.
 */
export function setSavedItemReply(
    req: Request,
    language: string | null,
    section: string,
    row: SavedListRow,
): void {
    const offerDefault = !row.isDefault && row.mayBeDefault !== false;

    const actions = [
        ...(offerDefault
            ? [{
                id: accountActionId(section, row.id, 'def'),
                label: botChrome('setDefaultButton', language),
            }]
            : []),
        { id: accountActionId(section, row.id, 'rm'), label: botChrome('removeButton', language) },
    ];

    setBotReply(req, {
        kind: 'text',
        text: row.detail ? `${row.title}\n${row.detail}` : row.title,
        actions,
    });
}

/**
 * Split `<id>[:<op>]`.
 *
 * ⚠ **An unknown operation must not fall through as "no operation"**, which would silently
 * turn `acct:addr:<id>:delete` — a typo, or a client built against a guessed vocabulary — into
 * a harmless-looking redraw of the row. The caller gets `null` and refuses.
 */
export function parseSavedItemAction(rest: string): { id: string; op: 'def' | 'rm' | null } | null {
    if (rest === '') return null;

    const colon = rest.indexOf(':');
    if (colon < 0) return { id: rest, op: null };

    const id = rest.slice(0, colon);
    const op = rest.slice(colon + 1);
    if (id === '' || (op !== 'def' && op !== 'rm')) return null;

    return { id, op };
}
