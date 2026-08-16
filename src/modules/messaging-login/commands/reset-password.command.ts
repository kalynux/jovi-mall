import { z } from 'zod';
import { CommandHandler } from '../../command-bus/command-bus';
import { MessagingChannel } from '../../channel-connections';
import {
  passwordResetService,
  RESET_TOKEN_TTL_MINUTES,
} from '../../auth/services/password-reset.service';
import {
  loginIdentityResolver,
  ResetIdentityResolution,
} from '../services/identity-resolver.service';
import { pendingIntentStore } from '../services/pending-intent.store';
import {
  buildContactPrompt,
  buildResetReply,
  LoginCommandReply,
  RESET_REFUSALS,
} from '../dto/messaging-login.dto';
import { LoginCommandContext, normalizeHandle, resolveSender } from './webhook-context';

export const command_name = 'reset_password';

/**
 * `/reset-password` — a password-reset link, from either bot, for ANY role.
 *
 * The same link `POST /auth/forgot-password` emails and WhatsApps, obtained from a chat
 * instead of a form. The token, its 30-minute lifetime, its Redis key space and its
 * redemption at `POST /auth/reset-password` are all the existing ones — this command is a
 * new *entrance*, not a second reset mechanism. A second one is how the two drift on
 * single-use, on expiry, or on the `password_changed_at` stamp that makes a reset revoke
 * every live session.
 *
 * ── EVERY ROLE, unlike `/login` ──────────────────────────────────────────────
 * `/login` mints a customer SESSION and is therefore customer-only. A password belongs to
 * the `users` row, so vendors, agencies, agents and customers all reset the same way. Gating
 * this on the customer role would lock out exactly the people most likely to have a password
 * to forget — customers largely do not have one at all (they are registered with a generated
 * one they are never told).
 *
 * So this is the command that turns a passwordless customer into one with a password, and
 * the only self-service recovery a vendor or an agency has from a chat.
 *
 * ── WHY THE LINK IS RETURNED RATHER THAN EMAILED ─────────────────────────────
 * The reply goes to the chat the request came from, and the automation layer relays it —
 * the same one-path rule `/connect` and `/login` follow. Emailing it as well would be a
 * second delivery with a second failure mode for a link the person is already looking at.
 *
 * ── AND WHY IT MAY SAY "no account", WHEN THE HTTP ENDPOINT MAY NOT ──────────
 * `POST /auth/forgot-password` must answer identically for a real and an imaginary account,
 * because an anonymous caller can feed it a list of phone numbers. This caller has already
 * proved they control the messaging account — WhatsApp's sender id *is* the number, and
 * Telegram's contact is verified at signup — so telling them their own number is unrecognised
 * discloses nothing. The enumeration oracle needs an attacker who can *choose* the identifier,
 * and here they cannot.
 */

/**
 * The payload the automation layer sends.
 *
 * Cosmetic only. **Nothing here is trusted for identity** — see `webhook-context.ts`, where
 * that rule is load-bearing rather than merely correct.
 */
export const schema = z
  .object({
    name: z.string().trim().max(120).optional(),
    username: z.string().trim().max(120).optional(),
  })
  .partial()
  .default({});

/** Turn a resolver verdict into something the bot can say. */
async function replyFor(
  resolution: ResetIdentityResolution,
  channel: MessagingChannel,
  externalIdentity: string
): Promise<LoginCommandReply> {
  switch (resolution.status) {
    case 'resolved': {
      const link = await passwordResetService.issueResetLinkFor({
        _id: resolution.account.userId,
      });

      /**
       * The identity, never the link. This line is written on every `/reset-password`, and a
       * reset token in a log is a live credential for somebody's account.
       */
      console.log(
        `[MessagingLogin] issued a password-reset link for ${channel}:${externalIdentity}`
      );

      return {
        success: true,
        channel,
        message: buildResetReply(link, RESET_TOKEN_TTL_MINUTES),
        expiresInSeconds: RESET_TOKEN_TTL_MINUTES * 60,
      };
    }

    case 'needs_contact': {
      // Remembered so the contact-share that follows completes THIS command rather than
      // signing the person in — see `pending-intent.store.ts`.
      await pendingIntentStore.remember(channel, externalIdentity, 'reset');

      return {
        success: true,
        channel,
        message: buildContactPrompt('reset your password'),
        expiresInSeconds: 0,
        requestContact: true,
      };
    }

    case 'no_account':
      return { success: false, channel, message: RESET_REFUSALS.no_account };

    case 'account_inactive':
      return { success: false, channel, message: RESET_REFUSALS.account_inactive };

    case 'identity_taken':
      return { success: false, channel, message: RESET_REFUSALS.identity_taken };

    /**
     * Unreachable: the resolver's `reset` gate never produces it, because a password belongs
     * to the account rather than to a role. Handled rather than left to the exhaustiveness
     * check so that widening the gate later cannot silently fall through to a generic reply.
     */
    case 'not_customer':
      return { success: false, channel, message: RESET_REFUSALS.no_account };

    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

export { replyFor as buildResetCommandReply };

export const handler: CommandHandler<z.infer<typeof schema>, LoginCommandReply> = async (
  payload,
  context: LoginCommandContext
) => {
  const { channel, externalIdentity } = resolveSender(context);

  const resolution = await loginIdentityResolver.resolveForReset(channel, externalIdentity, {
    displayName: payload.name ?? null,
    handle: channel === 'telegram' ? normalizeHandle(payload.username) : null,
  });

  return replyFor(resolution, channel, externalIdentity);
};
