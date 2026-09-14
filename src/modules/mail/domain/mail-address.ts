/**
 * Splitting a `From:` value into the pieces a JSON API wants.
 *
 * PURE, and shared rather than written twice, because the two providers want the same value in
 * two different shapes and only one of them will tell you when you get it wrong:
 *
 *  - **Resend** takes `from` as an RFC 5322 string and parses `Name <a@b.c>` itself.
 *  - **Brevo** takes `sender: { email, name }` — a structured object. Handing it
 *    `"Wi-Mall <noreply@wi-mall.com>"` as the `email` is a `400 invalid_parameter`, so this
 *    is not an optional nicety: without the split, every Brevo send fails the moment somebody
 *    sets `MAIL_FROM_AUTH` to a display-name form.
 *
 * `MAIL_FROM_*` is operator-supplied free text and both forms are legitimate, so the parse has
 * to accept either.
 */

export interface MailAddress {
    email: string;
    name?: string;
}

const DISPLAY_NAME_FORM = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/;

/**
 * Parse `Name <a@b.c>` or a bare `a@b.c`.
 *
 * ⚠ Deliberately NOT a validator. `MailService.send` already refuses an invalid *recipient*
 * through `core/validation/email`, and the sender is operator configuration rather than user
 * input — so the useful behaviour for anything unparseable is to pass it through unchanged and
 * let the provider's own error name the real problem. Rejecting here would replace a provider
 * message that says which field is wrong with one of ours that does not.
 *
 * Surrounding quotes are stripped from the display name because `"Wi-Mall" <x@y.z>` is the
 * form most mail clients produce, and Brevo renders the quotes literally if they survive.
 */
export function parseMailAddress(value: string): MailAddress {
    const match = DISPLAY_NAME_FORM.exec(value);
    if (!match) return { email: value.trim() };

    const name = match[1].replace(/^"(.*)"$/, '$1').trim();
    const email = match[2].trim();

    return name ? { email, name } : { email };
}

/** Render a {@link MailAddress} back to the RFC 5322 form Resend and Nodemailer both accept. */
export function formatMailAddress(address: MailAddress): string {
    return address.name ? `${address.name} <${address.email}>` : address.email;
}
