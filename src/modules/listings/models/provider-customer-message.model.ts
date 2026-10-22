import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import {
  PROVIDER_MESSAGE_KINDS,
  PROVIDER_MESSAGE_CHANNELS,
  ProviderMessageKind,
  ProviderMessageChannel,
} from '../domain/listing.types';

/**
 * ProviderCustomerMessage — a message a provider sent a customer THROUGH Wi-Mall (L-14 … L-16).
 *
 * `call_me` is the template (charged as a billable WhatsApp template; plain text on
 * Telegram, counted the same); `free_text` is relayed by the bot, free, and only inside
 * WhatsApp's 24-hour window (always on Telegram). The caps — 3 per customer per 30 days,
 * at most 1 of them call-me (L-24) — are COUNTED from this collection, so a `failed` send
 * is recorded but does not count.
 *
 * The customer's reply never comes back here (L-16): the message carries a
 * "Chat with <business> on WhatsApp" button to the provider's own number.
 */
export interface IProviderCustomerMessage extends Document {
  vendor_id: Types.ObjectId;
  customer_id: Types.ObjectId;
  lead_id: Types.ObjectId;
  listing_id: Types.ObjectId;
  kind: ProviderMessageKind;
  channel: ProviderMessageChannel;
  body: string;
  credits: number;
  status: 'sent' | 'failed';
  provider_message_id: string | null;
  at: Date;
}

const ProviderCustomerMessageSchema = new Schema<IProviderCustomerMessage>({
  vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
  customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
  lead_id: { type: Schema.Types.ObjectId, ref: MODELS.LISTING_LEAD, required: true },
  listing_id: { type: Schema.Types.ObjectId, ref: MODELS.LISTING, required: true },
  kind: { type: String, enum: PROVIDER_MESSAGE_KINDS, required: true },
  channel: { type: String, enum: PROVIDER_MESSAGE_CHANNELS, required: true },
  body: { type: String, required: true, maxlength: 2000 },
  credits: { type: Number, required: true, default: 0, min: 0 },
  status: { type: String, enum: ['sent', 'failed'], required: true },
  provider_message_id: { type: String, default: null },
  at: { type: Date, required: true, default: Date.now },
});

// The caps count one provider's messages to one customer over the last 30 days.
ProviderCustomerMessageSchema.index({ vendor_id: 1, customer_id: 1, at: -1 }, { name: 'provider_message_pair_recent' });

export const ProviderCustomerMessageModel = mongoose.model<IProviderCustomerMessage>(
  MODELS.PROVIDER_CUSTOMER_MESSAGE,
  ProviderCustomerMessageSchema,
  COLLECTIONS.PROVIDER_CUSTOMER_MESSAGE,
);
