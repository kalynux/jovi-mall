/**
 * Meta's character caps for the components these Flows use, and one way to fit text into them.
 *
 * Every number here is from Meta's Flow component reference, read 2026-09-16. A value over its
 * cap doesn't truncate on the handset: at best the screen fails to render, at worst the Flow
 * fails validation. So fitting happens here, once, before anything is sent.
 */
export const FLOW_CAPS = Object.freeze({
    /** `TextHeading.text`. */
    heading: 80,
    /** `TextBody.text`. */
    body: 4096,
    /** `TextCaption.text`. */
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
