/**
 * The sign-in message, assembled from fixed phrases — pure, and language-agnostic.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `buildLoginReply` composes this message in **English only**, by concatenating sentences
 * around three values (the website, the code, the minutes). Every other sentence this surface
 * sends is written in the customer's own language, so a French or Arabic speaker asking to
 * sign in gets the one message in the product that ignores their language — and it is the
 * message that decides whether they get in at all.
 *
 * The copy table deliberately holds **fixed sentences and interpolates nothing**
 * (`contactEmailChangeStarted` records why: a placeholder is one more thing to get wrong in
 * five languages, and a half-filled one reaches the customer as `{{email}}`). So this does not
 * interpolate either. It stacks **label lines and value lines**:
 *
 *     Tap to sign in on this device:        ← phrase
 *     https://wi-mall.com/s/abc123          ← value
 *
 *     Or sign in with your phone number and this code:
 *     482913
 *
 *     Website:
 *     wi-mall.com
 *
 *     Valid for:
 *     15 min
 *
 *     If you did not ask to sign in, ignore this message.
 *
 * ── THE THREE PROPERTIES THAT DECIDED THIS SHAPE ────────────────────────────
 *
 * **1 · No value is ever inside a sentence.** A value on its own line is the same shape in
 * every language and needs no grammar around it — no agreement, no word order, no article.
 *
 * **2 · It is therefore SAFE IN ARABIC**, which is the property a concatenated sentence
 * cannot promise. Mixing a left-to-right run (a URL, a digit string, `15 min`) into a
 * right-to-left sentence makes the bidirectional algorithm reorder the line around it, and
 * the failure looks like a corrupted code rather than a layout bug. On its own line there is
 * no surrounding text to reorder against.
 *
 * **3 · The duration dodges the plural trap rather than solving it.** "15 minutes" needs a
 * different word for 1, for 2 (Arabic has a dual), for 3–10 and for 11+ — four forms in one
 * language, and a conditional per language is exactly what a fixed-phrase table is for
 * avoiding. `min` is the international symbol, does not inflect, and is read correctly in all
 * five. So the number never chooses a word.
 */

/** The fixed phrases, already in the customer's language. Supplied by the caller. */
export interface SignInPhrases {
    /** Above the magic link. */
    tapToOpen: string;
    /** Above the code, when a link was offered as well. */
    codeIntro: string;
    /** Above the code, when it is the only credential. */
    codeOnly: string;
    /** Above the site name. */
    website: string;
    /** Above the duration. */
    validFor: string;
    /** The closing warning. */
    ignore: string;
}

export interface SignInValues {
    /** The one-tap link, when there is one. */
    magicLink: string | null;
    /** The site to type the code into. Null when the deployment has not named one. */
    site: string | null;
    code: string;
    ttlSeconds: number;
}

/** What a caller must not be allowed to send half of. */
export class SignInMessageError extends Error {}

/**
 * Assemble it.
 *
 * ⚠ **Refuses rather than printing a gap.** A missing code or a nonsensical lifetime would
 * otherwise reach a customer as an empty line or `NaN min`, on the message they need in order
 * to get into their account — and it would look like a platform that had lost their code
 * rather than a caller that forgot an argument. Every phrase must be present for the same
 * reason: a blank label line is indistinguishable from a formatting bug.
 */
export function composeSignInMessage(phrases: SignInPhrases, values: SignInValues): string {
    for (const [name, phrase] of Object.entries(phrases)) {
        if (typeof phrase !== 'string' || phrase.trim() === '') {
            throw new SignInMessageError(`sign-in phrase "${name}" is missing`);
        }
    }

    const code = values.code?.trim();
    if (!code) throw new SignInMessageError('sign-in code is missing');

    if (!Number.isFinite(values.ttlSeconds) || values.ttlSeconds <= 0) {
        throw new SignInMessageError('sign-in lifetime is missing or not positive');
    }

    /**
     * ⚠ **Rounded UP, never to nearest.** A code with 90 seconds left described as "1 min" is
     * a promise that expires before the customer finishes typing; "2 min" is honest by a
     * margin in the direction that does not lock anybody out. Anything under a minute still
     * reads "1 min" rather than "0 min", which would tell a customer their code is already
     * dead while it still works.
     */
    const minutes = Math.max(1, Math.ceil(values.ttlSeconds / 60));

    const groups: string[][] = [];

    if (values.magicLink) groups.push([phrases.tapToOpen, values.magicLink]);
    groups.push([values.magicLink ? phrases.codeIntro : phrases.codeOnly, code]);
    if (values.site) groups.push([phrases.website, values.site]);
    groups.push([phrases.validFor, `${minutes} min`]);
    groups.push([phrases.ignore]);

    return groups.map((lines) => lines.join('\n')).join('\n\n');
}
