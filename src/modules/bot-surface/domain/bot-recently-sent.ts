import type { BotReplyIntent } from './channel-reply';
import type { PendingQuestionOwner } from './bot-pending-question';

/**
 * ⭐ **WHAT THE PLATFORM HAS RECENTLY SENT THIS CUSTOMER** — the short rolling record handed to
 * the model on every message.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The model does not see most of what this platform says to the customer, and there are three
 * separate reasons for that, none of which the model can work around:
 *
 *   1. **A button TAP never passes the model at all.** It goes straight to `/catalog/action`,
 *      the handler draws its own reply, and the conversation the model remembers simply does
 *      not contain that turn.
 *   2. **A message a TOOL drew is the tool's, not the model's.** The order summary, "Added to
 *      your basket", a product card, a checkout confirmation — all of them are composed here
 *      (`channel-reply.ts`) and sent by the automation layer verbatim. The model's own memory
 *      records the tool CALL, never the sentence the customer read.
 *   3. **A NOTIFICATION is sent entirely outside the conversation.** "Payment received", "your
 *      order is on its way" — `customer-notification-event-handler.service.ts` dispatches those
 *      from a background consumer that has never heard of a chat turn.
 *
 * So the bot answers as though those messages never happened, which the owner saw repeatedly on
 * a handset test: a customer replies "ok thanks" to a notification and the model has no idea
 * what they are thanking anyone for.
 *
 * This is the record that closes it — at most the last five things the PLATFORM sent, per
 * conversation, for two hours.
 *
 * ── IT IS A SIBLING OF THE PENDING QUESTION, NOT A REPLACEMENT ──────────────
 * `bot-pending-question.ts` answers *"is there one specific Yes/No question a typed word may
 * ACT on"* — a single record with two live button tokens, spent atomically. This answers
 * *"what has this customer just been shown"* — several entries, no tokens, no action, read-only.
 * The two are deliberately separate: one is a capability, the other is context. They share the
 * owner type (`PendingQuestionOwner`) because they are scoped to the same thing — one account's
 * conversation on one channel — and keying them differently would let them disagree about whose
 * chat they belong to.
 *
 * ⛔ **NOTHING HERE IS A SECURITY BOUNDARY THE CUSTOMER CROSSES** — every entry is a message
 * that customer already received. The reason the redaction below is strict anyway is the
 * DESTINATION: this record lands in an AI prompt, and from there in an n8n execution log, which
 * is a third store with its own retention and its own readers. See `stripUrls`.
 *
 * ── WHY THIS FILE IS PURE ───────────────────────────────────────────────────
 * Every decision — what is recorded, how it is worded, what is stripped, what expires — is a
 * function of its arguments, so `test:recently-sent` drives all of it with no Redis, no server
 * and no clock. The store (`services/bot-recently-sent.store.ts`) only persists.
 */

/** At most this many entries, newest LAST. The owner's figure. */
export const RECENTLY_SENT_MAX = 5;

/**
 * How long an entry stays interesting. Two hours — **the bot's own chat-memory TTL**, chosen so
 * the two cannot disagree: a message the model can no longer remember discussing must not still
 * be presented to it as recent.
 */
export const RECENTLY_SENT_TTL_SECONDS = 2 * 60 * 60;

/** How much of a message is kept. See `compactSentText`. */
export const RECENTLY_SENT_TEXT_MAX = 160;

/** One thing the platform sent. */
export interface BotRecentlySentEntry {
    /** ISO. Also the authority on expiry, over and above the Redis TTL — see `readRecentlySent`. */
    at: string;
    /** The one-line rendering. Already clipped, already stripped of URLs. */
    text: string;
}

/**
 * ⛔ **URLs are STRIPPED, never allowlisted** — replaced by the literal marker `[link]`.
 *
 * ── WHY STRIP RATHER THAN ALLOW-LIST ────────────────────────────────────────
 * Several of the links this platform sends a customer ARE the credential: a sign-in magic link
 * (`messaging-login`), a password-reset link, a digital-download token, a payment link
 * (`pay-link.ts`), an in-app screen handle (`inapp-url.ts`). An allowlist of "safe" hosts would
 * have to be right about every one of those today AND about every link a future turn adds — and
 * the failure direction is a live credential written into an AI prompt and an execution log,
 * where it is readable by anyone who can open the run. A strip is right by default and stays
 * right for links nobody has written yet, so it is the rule here even though it costs the model
 * the ability to repeat a URL back (which it must never do anyway — the customer already has the
 * message).
 *
 * ⚠ **The marker is kept rather than deleted.** "We sent you a payment link" is useful context;
 * "We sent you a " is a sentence the model will try to finish. No token survives either way.
 *
 * ⚠ **The identity `botToken` cannot reach here** — it lives on the DTO, never in a drawn
 * sentence — and the COD delivery code is withheld at its one drawing site rather than pattern-
 * matched out (see `withholdFromRecentlySent` in `bot-reply.middleware.ts`). A digit rule broad
 * enough to catch a delivery code would eat every price on the surface.
 *
 * Two patterns, because the links this platform actually sends take both shapes:
 *   - anything carrying a scheme (`https://…`, `tg://…`) or a bare `www.`
 *   - a dotted host with an ALPHABETIC final label followed by a path (`t.me/…`, `wa.me/…`).
 *     The alphabetic requirement is what keeps `3.5/10` and `12.000/mois` out of it.
 */
const URL_PATTERNS: readonly RegExp[] = Object.freeze([
    /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
    /\bwww\.\S+/gi,
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi,
]);

export const REDACTED_LINK = '[link]';

export function stripUrls(text: string): string {
    let out = text;
    for (const pattern of URL_PATTERNS) {
        // A fresh lastIndex each pass: these are module-level `g` regexes and `replace` resets
        // it, but reading one is cheaper than reasoning about whether it did.
        pattern.lastIndex = 0;
        out = out.replace(pattern, REDACTED_LINK);
    }
    return out;
}

/**
 * The one-line rendering: the body, then the button or row labels in parentheses.
 *
 * ⚠ **Whitespace is COLLAPSED, newlines included** — this lands in a prompt as one bullet, and a
 * checkout summary is fifteen lines. Runs of anything blank become one space.
 *
 * ⚠ **It keeps the BEGINNING, which is the opposite of `clipQuestionText`, and the two are
 * complementary rather than inconsistent.** That one keeps the END because every question on this
 * surface ends with the question, and its single job is to let the model judge whether a message
 * ANSWERS it. This one's job is to let the model recognise WHICH message was sent, and a message
 * is identified by how it opens ("Payment received for order JM-…"). The checkout confirmation is
 * the one message both describe, and between them the model gets its opening lines here and its
 * closing question in `pendingQuestion`.
 *
 * Clipped by code point, so an emoji or an Arabic letter is never cut in half.
 *
 * ⛔ **Labels only, never a button's id.** A token carries a confirm ref or a checkout
 * credential; the label is the word the customer read.
 */
export function compactSentText(
    body: string,
    labels: readonly string[] = [],
    max: number = RECENTLY_SENT_TEXT_MAX,
): string {
    const flat = stripUrls(body).replace(/\s+/g, ' ').trim();
    const chars = Array.from(flat);
    const clipped = chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;

    const shown = labels
        .map((label) => stripUrls(String(label)).replace(/\s+/g, ' ').trim())
        .filter((label) => label.length > 0);
    if (shown.length === 0) return clipped;

    return clipped.length > 0 ? `${clipped} (${shown.join(' · ')})` : `(${shown.join(' · ')})`;
}

/**
 * What a drawn reply says, as one line — or null when the intent carries nothing worth recording.
 *
 * ⚠ **A `switch` over the whole union, with an exhaustiveness check**, so an intent kind added
 * next year is a COMPILE ERROR here rather than a message the model silently never learns about.
 * That is the same reason `bot-onboarding-copy.ts` refuses to boot on a half-translated entry: a
 * gap in a context feed looks exactly like a quiet turn.
 */
export function sentTextForIntent(intent: BotReplyIntent | null | undefined): string | null {
    if (!intent) return null;

    switch (intent.kind) {
        case 'text':
            return compactSentText(intent.text, (intent.actions ?? []).map((action) => action.label));
        case 'choice':
            return compactSentText(intent.text, intent.options.map((option) => option.label));
        case 'contact_request':
            return compactSentText(intent.text, [intent.buttonLabel]);
        case 'location_request':
            return compactSentText(
                intent.text,
                intent.skipLabel ? [intent.buttonLabel, intent.skipLabel] : [intent.buttonLabel],
            );
        case 'link':
        case 'inapp':
            // ⚠ `intent.url` is deliberately NOT part of this — it is the whole class of value
            // `stripUrls` exists to keep out, and an in-app url carries a single-use handle.
            return compactSentText(intent.text, [intent.label]);
        case 'product_list':
            /**
             * ⚠ **The card TITLES rather than the button labels.** "Buy now · Add to cart" is the
             * same five words on every product list ever drawn and tells the model nothing; what
             * it needs to know is which products the customer is looking at, because their next
             * message is usually "the second one" or "how much is the red one".
             *
             * `text` is empty on a first page by design (the model has just written its own
             * sentence), so the browse prompt stands in.
             */
            return compactSentText(
                intent.text || intent.browsePrompt,
                intent.cards.map((card) => card.title),
            );
        default: {
            const exhaustive: never = intent;
            return exhaustive;
        }
    }
}

/**
 * Add one entry: newest LAST, oldest dropped, expired dropped.
 *
 * ⚠ **Expiry is applied on the way IN as well as on the way out**, because the Redis TTL is
 * refreshed on every write — a busy conversation would otherwise keep a three-hour-old message
 * alive indefinitely behind four newer ones.
 */
export function appendRecentlySent(
    entries: readonly BotRecentlySentEntry[],
    entry: BotRecentlySentEntry,
    now: Date,
    max: number = RECENTLY_SENT_MAX,
): BotRecentlySentEntry[] {
    return [...liveEntries(entries, now), entry].slice(-max);
}

function liveEntries(entries: readonly BotRecentlySentEntry[], now: Date): BotRecentlySentEntry[] {
    const floor = now.getTime() - RECENTLY_SENT_TTL_SECONDS * 1000;
    return entries.filter((entry) => {
        const at = Date.parse(entry.at);
        return Number.isFinite(at) && at > floor;
    });
}

/** The stored form: the entries plus the account they were drawn for. */
export function serializeRecentlySent(
    owner: PendingQuestionOwner,
    entries: readonly BotRecentlySentEntry[],
): string {
    return JSON.stringify({ owner: owner.userId, entries });
}

/**
 * Read a stored record back, refusing anything this service would not have written.
 *
 * Empty for a malformed record, a record for another account, and any entry past its two hours —
 * one bucket, whose answer is always "the platform has sent this conversation nothing recently".
 * The expiry is re-checked here for the reason `product-display.store.ts` gives: a key that
 * outlives its `EX` must not resurrect stale context.
 */
export function readRecentlySent(
    raw: string | null,
    owner: PendingQuestionOwner,
    now: Date,
): BotRecentlySentEntry[] {
    if (!raw) return [];

    let record: Record<string, unknown>;
    try {
        record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return [];
    }
    if (!record || typeof record !== 'object') return [];
    if (record.owner !== owner.userId) return [];
    if (!Array.isArray(record.entries)) return [];

    const entries: BotRecentlySentEntry[] = [];
    for (const candidate of record.entries) {
        if (!candidate || typeof candidate !== 'object') continue;
        const { at, text } = candidate as Record<string, unknown>;
        if (typeof at !== 'string' || typeof text !== 'string') continue;
        if (!Number.isFinite(Date.parse(at))) continue;
        entries.push({ at, text });
    }

    return liveEntries(entries, now).slice(-RECENTLY_SENT_MAX);
}

/**
 * What the model is shown on `/identity/sync` — newest last, never more than five.
 *
 * The stored shape and the wire shape are the same two fields, so this is a cap and a copy rather
 * than a projection. It exists anyway so the cap is applied at the boundary too: a record written
 * by an older build, or edited in the cache, cannot put a sixth line in a prompt.
 */
export function recentlySentView(
    entries: readonly BotRecentlySentEntry[] | null | undefined,
): BotRecentlySentEntry[] {
    if (!entries || entries.length === 0) return [];
    return entries.slice(-RECENTLY_SENT_MAX).map((entry) => ({ at: entry.at, text: entry.text }));
}
