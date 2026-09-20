/**
 * Meta's character caps for the components these Flows use, and one way to fit text into them.
 *
 * Every number here is from Meta's Flow component reference — the TEXT ones read 2026-09-16, the
 * input ones added 2026-09-20. A value over its cap doesn't truncate on the handset: at best the
 * screen fails to render, at worst the Flow fails validation. So fitting happens here, once,
 * before anything is sent.
 *
 * ── ⛔ EACH NUMBER NAMES THE ROW IT CAME FROM, AND HERE IS WHY ───────────────
 * Asked "what are the text limits", a documentation lookup on 2026-09-20 answered that
 * **`TextCaption` caps at 80** — and it does not; 80 is the row ABOVE it (`TextSubheading`), and
 * the summary had merged the two. Believed, it would have "fixed" `caption` from 409 down to 80,
 * which is shorter than the checkout screen's phone hint — so a correct constant would have been
 * broken, and the shipped screen with it, on the strength of a tidy-sounding answer.
 *
 * A narrower question — *quote the row for TextCaption* — returned "Caption | Character Limit |
 * 409", agreeing with what was already here. **So: before changing any number below, ask for its
 * ROW, not for the table**, and treat a summary that disagrees with a verified constant as a
 * reason to re-ask rather than as a finding. This is the same failure mode as a guard whose
 * comment carries a false example: the text reads more confidently than the thing it describes.
 */
export const FLOW_CAPS = Object.freeze({
    /** `TextHeading.text`. */
    heading: 80,
    /** `TextBody.text`. */
    body: 4096,
    /**
     * `TextCaption.text` — row "Caption | Character Limit | 409".
     *
     * ⚠ **409, not 80.** 80 is `TextSubheading`, the row above it. See the header: a summary
     * answer merged the two, and this is the number it would have broken.
     */
    caption: 409,
    /** A `RadioButtonsGroup` / `Dropdown` option `title`. */
    optionTitle: 30,
    /** A `RadioButtonsGroup` / `Dropdown` option `description`. */
    optionDescription: 300,
    /** `RadioButtonsGroup` options. */
    radioOptions: 20,
    /** `Dropdown` options with no images. */
    dropdownOptions: 200,
    /** `Footer.label`. */
    footerLabel: 35,
    /**
     * A `TextInput` / `TextArea` **label**.
     *
     * ⚠ **20, which is shorter than any other label on a screen** — a heading takes 80 and a
     * footer 35. Read 2026-09-20 from the same limits table. "Que s'est-il passé ?" is exactly
     * 20, so a French label here has no room at all: check a new one in every language.
     */
    inputLabel: 20,
    /** A `TextInput` / `TextArea` `helper-text`. ⚠ 80 — a caption beneath it takes 409. */
    helperText: 80,
    /** `TextArea`'s own default `max-length` — what a customer may type, not what we send. */
    textAreaMax: 600,
});

/**
 * Fit `text` into `max` characters, ending with an ellipsis when anything was cut.
 *
 * ⚠ **Counted in code points, not UTF-16 units.** `'Crème'.length` and `[...'Crème'].length`
 * agree, but an emoji or an astral character counts 2 in `.length`. Slicing on `.length` can
 * cut a surrogate pair in half, leaving a lone surrogate that renders as a replacement box on
 * the handset. Vendor-authored product titles contain emoji.
 */
export function fitText(text: string, max: number): string {
    const chars = [...text.trim()];
    if (chars.length <= max) return chars.join('');
    return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** Whether `fitText` would cut. Used to repeat a cut title in full where there is room for it. */
export function wouldCut(text: string, max: number): boolean {
    return [...text.trim()].length > max;
}

/** Join the non-empty parts with a middle dot, then fit. */
export function joinFitted(parts: Array<string | null | undefined | false>, max: number): string {
    return fitText(
        parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' · '),
        max,
    );
}
