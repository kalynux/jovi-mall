import { CommandBus } from '../command-bus/command-bus';
import * as ConnectCommand from '../channel-connections/commands/connect.command';
import * as LoginCommand from '../messaging-login/commands/login.command';
import * as LoginContactCommand from '../messaging-login/commands/login-contact.command';
import * as ResetPasswordCommand from '../messaging-login/commands/reset-password.command';

/**
 * Bot commands, registered at boot and dispatched by both webhooks.
 *
 * **One command, both channels.** `/connect` replaced `link` (WhatsApp) and `link_telegram`
 * (Telegram), which were two commands doing one job in two shapes. The handler resolves the
 * sender from the context each webhook controller builds — `wa_phone_id` or `chat_id` — and
 * everything after that is channel-agnostic. `/login` follows the same shape.
 *
 * Each command lives in its own domain's `commands/` folder rather than here: this file is
 * only the registry. Their predecessors lived here and that is how `link.command.ts` ended up
 * importing a service across three module boundaries.
 *
 * ── The two families are NOT the same blast radius ───────────────────────────
 * `connect` mints a credential for a messaging identity nobody owns yet — a leaked one
 * discloses a phone number. `login` and `login_contact` mint a credential that GRANTS A
 * CUSTOMER SESSION on an existing account. They share a webhook, an alphabet and a
 * command bus, and nothing else; that is why they are separate modules and why folding
 * `messaging-login` into `channel-connections` would put a passwordless login path inside
 * the module every notification service imports.
 *
 * ⚠ `login_contact` is dispatched when the automation layer sees a `contact` on an inbound
 * Telegram message — NOT by a slash command anybody types. It completes **either** `/login`
 * or `/reset-password` for a Telegram chat we have never seen before, selected by the
 * pending intent the prompt recorded.
 *
 * ── `login` and `reset_password` are NOT the same audience ───────────────────
 * `/login` mints a customer SESSION and is customer-only. `/reset-password` mints a
 * password-reset link, and a password belongs to the account — so vendors, agencies and
 * agents reach it too. They share the identity ladder and diverge only at the gate.
 */
export function register_all_commands(bus: CommandBus): void {
  bus.register(ConnectCommand.command_name, ConnectCommand.schema, ConnectCommand.handler);
  console.log('✅ Registered Command:', ConnectCommand.command_name);

  bus.register(LoginCommand.command_name, LoginCommand.schema, LoginCommand.handler);
  console.log('✅ Registered Command:', LoginCommand.command_name);

  bus.register(
    LoginContactCommand.command_name,
    LoginContactCommand.schema,
    LoginContactCommand.handler
  );
  console.log('✅ Registered Command:', LoginContactCommand.command_name);

  bus.register(
    ResetPasswordCommand.command_name,
    ResetPasswordCommand.schema,
    ResetPasswordCommand.handler
  );
  console.log('✅ Registered Command:', ResetPasswordCommand.command_name);
}
