import mongoose from 'mongoose';
import { ChannelConnectionModel, IChannelConnection } from './channel-connection.model';
import { MessagingChannel } from './domain/channel';

export interface BindConnectionData {
  channel: MessagingChannel;
  externalId: string;
  displayName?: string | null;
  handle?: string | null;
}

const toObjectId = (id: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId =>
  typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id;

/**
 * Persistence for channel connections.
 *
 * Deliberately thin: every rule that decides *whether* a bind is allowed lives
 * in `ConnectionService`, so the two unique indexes on the model stay the only
 * enforcement and this class stays testable by inspection.
 */
export class ConnectionRepository {
  /** Every channel this account is connected on. */
  async findByUser(userId: string | mongoose.Types.ObjectId): Promise<IChannelConnection[]> {
    return ChannelConnectionModel.find({ user_id: toObjectId(userId) }).exec();
  }

  async findByUserAndChannel(
    userId: string | mongoose.Types.ObjectId,
    channel: MessagingChannel
  ): Promise<IChannelConnection | null> {
    return ChannelConnectionModel.findOne({ user_id: toObjectId(userId), channel }).exec();
  }

  /**
   * Who, if anyone, already holds this messaging identity.
   *
   * The service calls this before binding so an identity already claimed by
   * somebody else produces `MESSAGING_IDENTITY_ALREADY_LINKED` rather than a raw
   * duplicate-key error. The unique index still backs it — this read is for the
   * message, the index is for the race.
   */
  async findByIdentity(
    channel: MessagingChannel,
    externalId: string
  ): Promise<IChannelConnection | null> {
    return ChannelConnectionModel.findOne({ channel, external_id: externalId }).exec();
  }

  /**
   * Bind an identity to an account, replacing whatever that account had on this
   * channel.
   *
   * Upsert on `(user_id, channel)` — re-connecting a new number is a one-step
   * operation, not "disconnect, then connect". `connected_at` is re-stamped
   * because it describes *this* binding, not the first one the account ever had.
   */
  async bind(
    userId: string | mongoose.Types.ObjectId,
    data: BindConnectionData
  ): Promise<IChannelConnection> {
    const connection = await ChannelConnectionModel.findOneAndUpdate(
      { user_id: toObjectId(userId), channel: data.channel },
      {
        $set: {
          external_id: data.externalId,
          display_name: data.displayName ?? null,
          handle: data.handle ?? null,
          connected_at: new Date(),
          last_seen_at: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).exec();

    return connection;
  }

  /** @returns whether a connection was actually removed. */
  async unbind(
    userId: string | mongoose.Types.ObjectId,
    channel: MessagingChannel
  ): Promise<boolean> {
    const result = await ChannelConnectionModel.deleteOne({
      user_id: toObjectId(userId),
      channel,
    }).exec();
    return result.deletedCount > 0;
  }

  /**
   * Stamp inbound activity. Best-effort by design — a failed touch must never
   * fail the message that triggered it.
   */
  async touch(channel: MessagingChannel, externalId: string): Promise<void> {
    await ChannelConnectionModel.updateOne(
      { channel, external_id: externalId },
      { $set: { last_seen_at: new Date() } }
    ).exec();
  }
}

export const connectionRepository = new ConnectionRepository();
