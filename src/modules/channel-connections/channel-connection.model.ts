import mongoose, { Document, Schema } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';
import { CONNECTION_CHANNELS, MessagingChannel } from './domain/channel';

/**
 * ChannelConnection — one messaging identity bound to one platform account.
 *
 * ── USER-SCOPED, and that is the whole point ─────────────────────────────────
 * This replaces two mechanisms that disagreed about what an identity attaches
 * to. Telegram bound to the User (`telegram_links`); WhatsApp bound to each
 * ROLE ENTITY, as a `wa` sub-document duplicated across Vendor, Customer,
 * DeliveryAgency and DeliveryAgent, kept in step by an `update_other_roles`
 * flag that fanned a write across four collections best-effort.
 *
 * A person has one WhatsApp number. They do not have a vendor WhatsApp number
 * and a separate customer one, and the fan-out flag existed only to paper over
 * a model that said they did. Binding to `user_id` deletes the fan-out, the
 * eight duplicated repository methods, and the class of bug where a person is
 * connected in one role and mysteriously not in another.
 */
export interface IChannelConnection extends Document {
  user_id: mongoose.Types.ObjectId;
  channel: MessagingChannel;
  external_id: string;
  display_name: string | null;
  handle: string | null;
  connected_at: Date;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const ChannelConnectionSchema = new Schema<IChannelConnection>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.USER,
      required: true,
    },
    channel: {
      type: String,
      // Spread from the single declaration in `domain/channel.ts`. Never type
      // the literals here — see that file's header for the drift this prevents.
      enum: [...CONNECTION_CHANNELS],
      required: true,
    },
    /**
     * How the channel addresses this account: the WhatsApp phone id, or the
     * Telegram **chat** id (what `TelegramBotService.sendMessage` needs — the
     * old model stored both a chat id and a numeric user id, which are the same
     * value for a private bot chat and only ever gave two things to keep in
     * step).
     *
     * NEVER serialised to a client. See `domain/identity-mask.ts`.
     */
    external_id: {
      type: String,
      required: true,
      trim: true,
    },
    /** WhatsApp profile name, or the Telegram first+last name. Display only. */
    display_name: { type: String, default: null, trim: true },
    /** Telegram `@username`. Always null for WhatsApp, which has no handle. */
    handle: { type: String, default: null, trim: true },
    connected_at: { type: Date, required: true, default: () => new Date() },
    /**
     * Last inbound message seen on this channel.
     *
     * Its predecessor — `wa.last_seen_at` — was declared on all four role models
     * and written by absolutely nothing, for the whole life of the feature. This
     * one is written by the webhook path, or it should not be here.
     */
    last_seen_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * One connection per channel per account. A person re-connecting a new number
 * replaces their old one (the service upserts on this key) rather than
 * accumulating rows that disagree about where to send their notifications.
 */
ChannelConnectionSchema.index({ user_id: 1, channel: 1 }, { unique: true });

/**
 * One account per messaging identity — the constraint WhatsApp has NEVER had.
 *
 * Nothing stopped two accounts claiming the same WhatsApp number: the `wa`
 * sub-document had no index of any kind, so a person could bind a number that
 * already belonged to somebody else and both accounts would then send
 * notifications to one phone. This index is what makes
 * `MESSAGING_IDENTITY_ALREADY_LINKED` enforceable rather than advisory — the service
 * checks first for a clean error, and this catches the race that check cannot.
 *
 * ⚠ `autoIndex` is on and a failed build fails SILENTLY at boot. Boot the server
 * after changing this file; a unit test structurally cannot see it.
 */
ChannelConnectionSchema.index({ channel: 1, external_id: 1 }, { unique: true });

export const ChannelConnectionModel = mongoose.model<IChannelConnection>(
  MODELS.CHANNEL_CONNECTION,
  ChannelConnectionSchema,
  COLLECTIONS.CHANNEL_CONNECTION
);
