/**
 * WhatsApp Cloud API field length limits (Meta).
 *
 * Enforced by the service-message builders so we never emit a payload Meta
 * would reject (which would surface as a delivery error). Values reflect the
 * documented maximums for each component field.
 */
export const WA_LIMITS = {
    /** Plain text message body. */
    TEXT_BODY: 4096,
    /** Interactive message body text. */
    INTERACTIVE_BODY: 1024,
    /** Interactive header text. */
    HEADER_TEXT: 60,
    /** Interactive footer text. */
    FOOTER_TEXT: 60,
    /** Reply button title. */
    BUTTON_REPLY_TITLE: 20,
    /** CTA URL button visible label. */
    CTA_DISPLAY_TEXT: 20,
    /** List "open" button label. */
    LIST_BUTTON: 20,
    /** List section title. */
    LIST_SECTION_TITLE: 24,
    /** List row title. */
    LIST_ROW_TITLE: 24,
    /** List row description. */
    LIST_ROW_DESCRIPTION: 72,
    /** Media (image/video/document) caption. */
    MEDIA_CAPTION: 1024,
    /** Location name. */
    LOCATION_NAME: 1000,
    /** Location address. */
    LOCATION_ADDRESS: 1000
} as const;

/**
 * Hard-cap a string to `max` characters so it always satisfies a Meta limit.
 * Adds an ellipsis only when it fits without exceeding the cap. Non-strings and
 * within-limit values pass through unchanged.
 */
export function truncate(value: string | undefined, max: number): string | undefined {
    if (value === undefined || value === null) return value;
    if (value.length <= max) return value;
    if (max <= 1) return value.slice(0, max);
    return `${value.slice(0, max - 1)}…`;
}
