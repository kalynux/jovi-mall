import { z } from 'zod';
import { CommandHandler } from '../../command-bus/command-bus';
import { MessagingChannel } from '../../channel-connections';
import {
  LoginIdentityResolution,
  loginIdentityResolver,
} from '../services/identity-resolver.service';
import { messagingLoginService } from '../services/messaging-login.service';
import {
  buildContactPrompt,
  buildLoginReply,
  buildMagicLinkUrl,
  LoginCommandReply,
  LOGIN_REFUSALS,
} from '../dto/messaging-login.dto';
import { pendingIntentStore } from '../services/pending-intent.store';
import { LoginCommandContext, normalizeHandle, resolveSender } from './webhook-context';

export const command_name = 'login';

/**
 * `/login` — passwordless customer sign-in, from either bot.
 *
 * Replies with TWO credentials for ONE session: a magic LINK to tap on the phone
 * in the user's hand, and an 8-character CODE to type on the desktop across the
 * room. Both expire in ten minutes; spending either kills the other.
 *
 * ── WHAT THIS COMMAND CAN AND CANNOT DO ──────────────────────────────────────
 * Unlike `/connect`, this one DOES reach an existing account: it mints a
 * credential that grants a session. That is the entire reason the module is
 * separate from `channel-connections` — folding them together would put a
 * passwordless login path inside the module every notification service imports,
 * and make one blast radius look like the other.
 *
 * What it still cannot do is choose whose account. The identity comes from the
 * webhook context (`webhook-context.ts`), never from the payload.
 *
 * ── ALWAYS `customer`, NEVER ANOTHER ROLE ────────────────────────────────────
 * A business account that messages the bot is told to use its password. The role
 * is a literal in `MessagingLoginService`; it is never negotiated here.
 */

/**
 * The payload the automation layer sends.
 *
 * Cosmetic only — a display name and a Telegram handle, which decorate the
 * connection row and the identity hint. **Nothing here is trusted for identity.**
 */
export const schema = z
  .object({
    /** WhatsApp profile name, or the Telegram first (+ last) name. */
    name: z.string().trim().max(120).optional(),
    /** Telegram `@username`. WhatsApp has no equivalent. */
    username: z.string().trim().max(120).optional(),
  })
  .partial()
  .default({});

/**
 * Turn a resolver verdict into something the bot can say.
 *
 * Every refusal is a normal reply rather than a thrown error: the user has to be
 * told, and a webhook error would reach n8n's failure branch and reach the
 * person as silence. The one exception is the contact-share guard in
 * `login-contact.command.ts`, which throws — see its header.
 *
 * Telling a sender that their OWN number is unrecognised leaks nothing: they
 * control it. What must not happen is minting a decoy credential to disguise the
 * answer — it would strand a real user with a code that can never work.
 */
async function replyFor(
  resolution: LoginIdentityResolution,
  channel: MessagingChannel,
  externalIdentity: string
): Promise<LoginCommandReply> {
  switch (resolution.status) {
    case 'resolved': {
      const issued = await messagingLoginService.mint(resolution.account);

      /**
       * The identity, never the credentials. This line is written on every
       * `/login`, and a token or a code in a log is a live session.
       */
      console.log(
        `[MessagingLogin] issued a sign-in session for ${channel}:${externalIdentity}`
      );

      return {
        success: true,
        channel,
        message: buildLoginReply(
          issued.code,
          buildMagicLinkUrl(issued.token),
          issued.ttlSeconds
        ),
        expiresInSeconds: issued.ttlSeconds,
      };
    }

    case 'needs_contact': {
      // Remembered so the contact-share that follows completes THIS command rather than
      // `/reset-password` — one keyboard now serves two commands. See `pending-intent.store.ts`.
      await pendingIntentStore.remember(channel, externalIdentity, 'login');

      return {
        success: true,
        channel,
        message: buildContactPrompt('sign you in'),
        expiresInSeconds: 0,
        // The marker n8n branches on to attach a `request_contact` keyboard.
        requestContact: true,
      };
    }

    case 'no_account':
      return { success: false, channel, message: LOGIN_REFUSALS.no_account };

    case 'not_customer':
      return { success: false, channel, message: LOGIN_REFUSALS.not_customer };

    case 'account_inactive':
      return { success: false, channel, message: LOGIN_REFUSALS.account_inactive };

    case 'identity_taken':
      return { success: false, channel, message: LOGIN_REFUSALS.identity_taken };

    default: {
      // Exhaustiveness: a resolver outcome added without copy fails to compile
      // here rather than silently falling through to a generic message.
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

export { replyFor as buildLoginCommandReply };

export const handler: CommandHandler<z.infer<typeof schema>, LoginCommandReply> = async (
  payload,
  context: LoginCommandContext
) => {
  const { channel, externalIdentity } = resolveSender(context);

  const resolution = await loginIdentityResolver.resolveForLogin(channel, externalIdentity, {
    displayName: payload.name ?? null,
    handle: channel === 'telegram' ? normalizeHandle(payload.username) : null,
  });

  return replyFor(resolution, channel, externalIdentity);
};
