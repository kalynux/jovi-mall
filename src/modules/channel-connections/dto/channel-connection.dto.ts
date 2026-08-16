import { IChannelConnection } from '../channel-connection.model';
import { MessagingChannel } from '../domain/channel';
import { maskIdentity } from '../domain/identity-mask';
import { ChannelConnectionState } from '../services/channel-connection.service';

/**
 * The client-facing shape of a connection.
 *
 * ── THIS MAPPER IS THE ACCESS CONTROL ────────────────────────────────────────
 * `external_id` is a durable identifier for a real person's messaging account.
 * It is never a field on this DTO, and there is deliberately no "expanded" or
 * "admin" variant that includes it — the settings screen needs to answer "is
 * this the right account?", which `displayName` and `identityHint` do.
 *
 * `test:connections` carries a LEAK assertion in the style of
 * `test:public-catalog`: a DTO is built from a document holding a full identity,
 * serialised, and the identity asserted absent from the string. Same reasoning —
 * where a projection IS the boundary, the test has to check the output, not the
 * intent.
 */
export interface ChannelConnectionDto {
  channel: MessagingChannel;
  connected: boolean;
  /** WhatsApp profile name or Telegram display name. Null when unknown. */
  displayName: string | null;
  /** `••••1234` / `@handle`. Null when there is nothing safe to show. */
  identityHint: string | null;
  connectedAt: Date | null;
  /** Rendered only when the channel is NOT connected — see `howToConnect`. */
  howToConnect?: ChannelConnectInstructionsDto;
}

/**
 * Where to go and what to send. Built from configuration, never from the
 * account, so it is identical for every caller and safe to cache client-side.
 */
export interface ChannelConnectInstructionsDto {
  command: string;
  /** `@BotName` for Telegram, the E.164-ish bot number for WhatsApp. */
  botHandle: string | null;
  /** A tap-through that opens the chat, pre-filled where the channel allows it. */
  deepLink: string | null;
}

/** The command a user sends to either bot. One word, both channels. */
export const CONNECT_COMMAND = '/connect';

/**
 * How to reach each bot.
 *
 * Read from the SAME two variables the deleted issuers used — `WA_BOT_NUMBER`
 * and `TELEGRAM_BOT_NAME` — which is what keeps `test:env` green: that census
 * fails in both directions, so a variable documented in `.env.example` and read
 * by nothing is as much a failure as an undocumented one.
 *
 * A missing variable disables the *instruction*, never the flow: a user who
 * already knows the bot can still send /connect and redeem the code.
 */
export function buildConnectInstructions(
  channel: MessagingChannel
): ChannelConnectInstructionsDto {
  switch (channel) {
    case 'whatsapp': {
      const botNumber = process.env.WA_BOT_NUMBER || null;
      return {
        command: CONNECT_COMMAND,
        botHandle: botNumber,
        deepLink: botNumber
          ? `https://wa.me/${botNumber}?text=${encodeURIComponent(CONNECT_COMMAND)}`
          : null,
      };
    }
    case 'telegram': {
      const botName = process.env.TELEGRAM_BOT_NAME || null;
      return {
        command: CONNECT_COMMAND,
        botHandle: botName ? `@${botName}` : null,
        // Telegram's deep link cannot pre-fill a message the way wa.me can;
        // `?start=` would send /start, not /connect. The user types it.
        deepLink: botName ? `https://t.me/${botName}` : null,
      };
    }
    default: {
      const unreachable: never = channel;
      return unreachable;
    }
  }
}

export class ConnectionMapper {
  static toDto(state: ChannelConnectionState): ChannelConnectionDto {
    const { channel, connection } = state;

    if (!connection) {
      return {
        channel,
        connected: false,
        displayName: null,
        identityHint: null,
        connectedAt: null,
        howToConnect: buildConnectInstructions(channel),
      };
    }

    return {
      channel,
      connected: true,
      displayName: connection.display_name ?? null,
      identityHint: maskIdentity(channel, connection.external_id, connection.handle),
      connectedAt: connection.connected_at,
    };
  }

  static toDtoList(states: ChannelConnectionState[]): ChannelConnectionDto[] {
    return states.map((state) => ConnectionMapper.toDto(state));
  }

  /** The single connection returned after a successful redeem. */
  static toConnectedDto(connection: IChannelConnection): ChannelConnectionDto {
    return ConnectionMapper.toDto({ channel: connection.channel, connection });
  }
}
