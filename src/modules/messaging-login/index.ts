/**
 * Bot-initiated account access — the module's public surface.
 *
 * It owns three things: resolving a messaging identity to an account, the Telegram
 * contact-share handshake, and the credentials that follow — `/login` (a customer
 * session) and `/reset-password` (a password-reset link, any role).
 *
 * ── WHY THIS IS NOT PART OF `channel-connections` ────────────────────────────
 * The two share an alphabet, a webhook and a command bus, and nothing else. One
 * mints a credential for a messaging identity NOBODY OWNS YET; these mint
 * credentials that reach an EXISTING account. Folding them together would put a
 * passwordless login path inside the module every notification service imports,
 * and would make one blast radius look like the other.
 *
 * ── AND WHY THE RESET COMMAND LIVES HERE RATHER THAN IN `auth` ───────────────
 * The reset TOKEN belongs to `auth` and stays there — this module calls
 * `PasswordResetService`. The command is the other way round: it is 90% identity
 * resolution, which lives here. Putting it in `auth` would mean auth importing
 * this module's resolver while this module imports auth's reset service, which is
 * the cycle that crashes at boot.
 *
 * The one thing it reaches into is `channel-connections/domain/connection-code.ts`,
 * for the shared code primitives — argued in `domain/login-code.ts`.
 */
export {
  messagingLoginService,
  MessagingLoginService,
} from './services/messaging-login.service';
export type { MagicSignInResult } from './services/messaging-login.service';

export {
  loginIdentityResolver,
  LoginIdentityResolver,
  messagingPhoneToE164,
} from './services/identity-resolver.service';
export type {
  MessagingAuthIntent,
  IdentityResolution,
  LoginIdentityResolution,
  ResetIdentityResolution,
  ResolvedLoginAccount,
  ResolvedResetAccount,
} from './services/identity-resolver.service';

export {
  pendingIntentStore,
  PendingIntentStore,
  PENDING_INTENT_TTL_SECONDS,
  DEFAULT_PENDING_INTENT,
} from './services/pending-intent.store';

export {
  loginSessionStore,
  LoginSessionStore,
  LOGIN_SESSION_TTL_SECONDS,
  LOGIN_SESSION_GRACE_SECONDS,
  LOGIN_MAX_ATTEMPTS,
} from './services/login-session.store';
export type {
  LoginSessionRecord,
  IssuedLoginSession,
  ConsumeLoginResult,
} from './services/login-session.store';

export {
  LOGIN_COMMAND,
  RESET_COMMAND,
  MAGIC_LINK_PATH,
  buildMagicLinkUrl,
} from './dto/messaging-login.dto';
export type { LoginCommandResult, LoginCommandReply } from './dto/messaging-login.dto';

export { LOGIN_CODE_LENGTH } from './domain/login-code';
export { LOGIN_TOKEN_BYTES } from './domain/login-token';

/**
 * ⚠ The ROUTER is deliberately NOT re-exported here, for the reason
 * `channel-connections/index.ts` gives about its own: every consumer of a barrel
 * is a service, and re-exporting a router drags the Express controller into all
 * of their import graphs.
 *
 * `api/index.ts` imports `./messaging-login.routes` directly. It is the one
 * caller that wants a router, and it is already an HTTP file.
 */
