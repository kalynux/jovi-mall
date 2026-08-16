/**
 * The connections module's public surface.
 *
 * Other modules import from HERE, never from a file inside. The notification
 * stacks need `connectionService` and the channel type; Phase 4's `/connect`
 * command needs `connectionCodeStore.issue`. Nothing else should reach in — in
 * particular the repository and the model stay private, so `external_id` has one
 * way out of this module and it goes through `ConnectionMapper`.
 */
export { CONNECTION_CHANNELS, isMessagingChannel } from './domain/channel';
export type { MessagingChannel } from './domain/channel';

/**
 * The masker, so a caller that must render a hint cannot invent its own.
 *
 * `modules/messaging-login` stamps one onto a sign-in session ("signed in from
 * WhatsApp ••••3456"). Exporting the function rather than letting it re-derive
 * the rule is what keeps "the raw identifier never leaves this module" a single
 * decision instead of a convention.
 */
export { maskIdentity } from './domain/identity-mask';

export { connectionService, ConnectionService } from './services/channel-connection.service';
export type { ChannelConnectionState } from './services/channel-connection.service';

export {
  connectionCodeStore,
  ConnectionCodeStore,
  CONNECTION_CODE_TTL_SECONDS,
  CONNECTION_CODE_MAX_ATTEMPTS,
} from './services/connection-code.store';
export type {
  ConnectionCodeRecord,
  IssuedConnectionCode,
  IssueConnectionCodeInput,
} from './services/connection-code.store';

export { ConnectionMapper, CONNECT_COMMAND, buildConnectInstructions } from './dto/channel-connection.dto';
export type { ChannelConnectionDto } from './dto/channel-connection.dto';

export type { IChannelConnection } from './channel-connection.model';

/**
 * The bind payload — a TYPE only, so `bindVerifiedIdentity` can be called from
 * outside without the repository itself becoming reachable.
 */
export type { BindConnectionData } from './channel-connection.repository';

/**
 * ⚠ Two things stay unexported on purpose and the reason is the same one:
 * `ConnectionRepository` and `ChannelConnectionModel`. `external_id` has exactly
 * one way out of this module — `ConnectionMapper`, which masks it — and a
 * repository in the barrel is a second way that nobody would notice being used.
 *
 * The one file outside this module that reaches past the barrel is
 * `messaging-login/domain/login-code.ts`, which imports the pure code primitives
 * from `domain/connection-code.ts` directly. That is deliberate and is argued in
 * that file's header: the alternative is putting Mongoose and the Redis factory
 * into the import graph of a function that draws random bytes.
 */

/**
 * ⚠ The ROUTER is deliberately NOT re-exported here, and this is layering rather
 * than taste. Every consumer of this barrel is a service — the four notification
 * stacks, the Telegram sender, Phase 4's command handler. Re-exporting the router
 * puts the Express controller in all of their import graphs, so a background
 * worker transitively loads an HTTP layer it will never use, and a DB-free test
 * that touches a notification service ends up compiling request types.
 *
 * `user.routes.ts` imports `./channel-connection.routes` directly. It is the one
 * caller that wants a router, and it is already an HTTP file.
 */
