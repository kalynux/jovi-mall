import { MessagingChannel } from '../../channel-connections';

/**
 * What the bot says back, and where the magic link points.
 *
 * ── ENGLISH ONLY, and it is a constraint rather than an oversight ────────────
 * Every other piece of outbound copy in this service is localised from a catalog
 * keyed on the recipient's `preferred_language` — which lives on a role entity.
 * At `/login` time there may be no account at all (that is the whole premise),
 * and even when there is, guessing a language from a phone prefix is wrong often
 * enough to be worse than not trying. Once signed in, everything the platform
 * sends is localised. Same position `/connect`'s reply takes, for the same
 * reason.
 */

/** The command a user sends to either bot. */
export const LOGIN_COMMAND = '/login';

/**
 * The storefront path the magic link lands on. The PAGE then POSTs the token to
 * `/api/auth/magic/link`.
 */
export const MAGIC_LINK_PATH = '/login/magic';

/**
 * The magic link, or null when no storefront is configured.
 *
 * ⚠ **`STOREFRONT_URL`, never `API_PUBLIC_URL`, and the link must point at a
 * PAGE rather than at this API.** Two reasons, and the first is a live bug if
 * ignored:
 *
 *   1. **Link previews would spend the token.** WhatsApp and Telegram FETCH URLs
 *      to build preview cards. A `GET` endpoint that signs you in is therefore
 *      consumed by the crawler before the user ever taps — a dead link, every
 *      time, for every user. A `POST` issued by a page the crawler does not
 *      execute cannot be triggered that way.
 *   2. It follows the password-reset precedent, recorded there for the same
 *      reason: a browser flow needs a page, and only the frontend has one.
 *
 * `test:messaging-login` scans this file for `API_PUBLIC_URL`, because the two
 * variables are interchangeable-looking and the failure is silent — the link
 * would still be well-formed, and would still be dead.
 *
 * A missing variable disables the LINK, never the flow: the reply falls back to
 * the code alone, which is a complete way to sign in.
 */
export function buildMagicLinkUrl(token: string): string | null {
  const base = process.env.STOREFRONT_URL?.replace(/\/+$/, '');
  if (!base) return null;

  return `${base}${MAGIC_LINK_PATH}?t=${encodeURIComponent(token)}`;
}

/** How to name the site in chat copy. The configured host beats a hardcoded brand. */
function storefrontLabel(): string {
  const base = process.env.STOREFRONT_URL;
  if (!base) return 'the Wi-Mall website';

  return base.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * The success reply — BOTH credentials, for one session.
 *
 * Two credentials because they solve different problems. The link is for the
 * phone already in the user's hand: one tap, no typing. The code is for the
 * desktop in front of them when WhatsApp is on a phone across the room.
 */
export function buildLoginReply(
  code: string,
  magicLink: string | null,
  ttlSeconds: number
): string {
  const minutes = Math.round(ttlSeconds / 60);
  const site = storefrontLabel();
  const lines: string[] = [];

  if (magicLink) {
    lines.push('Tap to sign in on this device:', magicLink, '');
    lines.push(`Or go to ${site} and sign in with your phone number and this code:`);
  } else {
    lines.push(`Go to ${site} and sign in with your phone number and this code:`);
  }

  lines.push(
    code,
    '',
    `${magicLink ? 'Both' : 'It'} expire${magicLink ? '' : 's'} in ${minutes} minutes and can be used once.`,
    'If you did not ask to sign in, ignore this message.'
  );

  return lines.join('\n');
}

/** The command that starts a password reset from a chat. */
export const RESET_COMMAND = '/reset-password';

/**
 * The `/reset-password` reply.
 *
 * One credential, not two: a reset link needs a form for the new password, and only the
 * frontend has one — so there is no "type this code" half to offer. That also means the
 * link here is safe from link-preview crawlers in a way the magic sign-in link is not: the
 * token is spent by the form's POST, not by fetching the page. See `buildResetLink`.
 */
export function buildResetReply(link: string, minutes: number): string {
  return [
    'Tap to choose a new password:',
    link,
    '',
    `This link expires in ${minutes} minutes and can be used once.`,
    'Your password has not changed yet — nothing happens until you set a new one.',
    'If you did not ask for this, ignore this message.',
  ].join('\n');
}

/**
 * The Telegram contact-share prompt.
 *
 * Says plainly that a forwarded contact will be refused — the guard exists whatever the copy
 * says, but a person who taps the wrong thing should understand the refusal rather than read
 * it as a bug.
 *
 * The first line names what they asked for, because the same button now serves two commands
 * and a prompt that said "to sign you in" after `/reset-password` would read as the wrong
 * thing happening.
 */
export function buildContactPrompt(purpose: 'sign you in' | 'reset your password'): string {
  return [
    `To ${purpose}, Telegram needs to confirm your phone number.`,
    '',
    'Tap "Share my phone number" below. Only a number Telegram has verified as '
      + 'yours will work — forwarding somebody else\'s contact card will be refused.',
    '',
    'Nothing happens until you tap, and your number is not shared with anyone else.',
  ].join('\n');
}

/** The refusal table's copy, in one place. */
export const LOGIN_REFUSALS = Object.freeze({
  no_account:
    "I don't recognise this number. Create an account on the website first, then send /login again.",
  /**
   * `not_customer` has no reset counterpart on purpose — a password belongs to the account,
   * so every role may reset one. See the resolver's gate.
   */
  /**
   * Never auto-provision a customer role. A business account reaching the bot is
   * told to use its password — it is not quietly given a shopping account.
   *
   * Says "business" rather than naming the role: the account may be a vendor, an
   * agency or an agent, and a message that guesses wrong reads as a bug.
   */
  not_customer:
    'This number is registered as a business account rather than a shopping account. '
    + 'Please sign in with your password on the website.',
  account_inactive: 'This account is not active. Please contact support.',
  identity_taken: 'This Telegram account is already connected to another account.',
  contact_unverified:
    'That contact is not yours. Please use the "Share my phone number" button so '
    + 'Telegram can confirm the number belongs to this account.',
} as const);

/**
 * The same table, worded for a password reset.
 *
 * Separate rather than shared because every line ends in a different instruction — "send
 * /login again" is the wrong advice to somebody who cannot sign in, which is the entire
 * reason they are here.
 */
export const RESET_REFUSALS = Object.freeze({
  no_account:
    "I don't recognise this number. If you have an account, send /reset-password from the "
    + 'number you registered with, or use the "Forgot password" link on the website.',
  account_inactive:
    'This account is not active, so its password cannot be reset. Please contact support.',
  identity_taken: 'This Telegram account is already connected to another account.',
} as const);

/**
 * What a `/login` command hands back to the automation layer.
 *
 * ⚠ **THERE IS NO `token` AND NO `code` FIELD, and there must never be one.**
 * `/connect` returns `code` beside `message` for the automation layer's
 * convenience; these are session credentials, and a webhook RESPONSE BODY is
 * logged in more places than a chat message — n8n execution history, HTTP
 * request logs, an error report. `message` carries them because it must; nothing
 * else should, and neither may ever be written to a log line.
 *
 * `test:messaging-login` asserts the absence of both by serialising a real
 * result, in the same style as the connections suite's DTO leak assertion.
 */
export interface LoginCommandResult {
  success: true;
  channel: MessagingChannel;
  /** The verbatim text the automation layer must relay. */
  message: string;
  expiresInSeconds: number;
  /**
   * Tells n8n to attach a `request_contact` keyboard to this reply.
   *
   * Present only on the Telegram first-contact prompt. Absent — not `false` —
   * everywhere else, so a client can branch on presence.
   */
  requestContact?: true;
}

/** A refusal is still a successful dispatch: the bot has something to say. */
export interface LoginCommandRefusal {
  success: false;
  channel: MessagingChannel;
  message: string;
}

export type LoginCommandReply = LoginCommandResult | LoginCommandRefusal;
