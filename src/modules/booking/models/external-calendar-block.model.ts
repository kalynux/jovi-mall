import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * ExternalCalendarBlock - Persisted busy times from external calendars
 * 
 * PURPOSE:
 * - Stores busy time ranges fetched from vendor Google Calendars
 * - Enables availability blocking without real-time API calls
 * - Provides audit trail via soft-delete
 * 
 * IMPORTANT:
 * - This is DERIVED DATA, not user-editable
 * - Synced by InboundCalendarSyncWorker
 * - Soft-deleted (isActive: false) when external event removed
 */
export interface IExternalCalendarBlock extends IBaseDocument {
    vendorId: Types.ObjectId;
    provider: 'google';
    externalEventId: string; // Google Calendar event ID
    startTime: Date;
    endTime: Date;
    timezone: string; // IANA timezone (e.g., 'America/New_York')
    sourceCalendarId: string; // Which calendar this came from (usually 'primary')
    externalUpdatedAt: Date; // Google event's 'updated' timestamp for skip-if-unchanged optimization
    lastSyncedAt: Date; // When we last synced this block
    isActive: boolean; // false = soft-deleted (event no longer exists in Google)
}

const ExternalCalendarBlockSchema = new Schema<IExternalCalendarBlock>(
    {
        vendorId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.VENDOR,
            required: true,
            index: true,
        },
        provider: {
            type: String,
            enum: ['google'],
            required: true,
            default: 'google',
        },
        externalEventId: {
            type: String,
            required: true,
            index: true,
        },
        startTime: {
            type: Date,
            required: true,
            index: true,
        },
        endTime: {
            type: Date,
            required: true,
            index: true,
        },
        timezone: {
            type: String,
            required: true,
            default: 'UTC',
        },
        sourceCalendarId: {
            type: String,
            required: true,
            default: 'primary',
        },
        externalUpdatedAt: {
            type: Date,
            required: true,
        },
        lastSyncedAt: {
            type: Date,
            required: true,
            default: Date.now,
        },
        isActive: {
            type: Boolean,
            required: true,
            default: true,
            index: true,
        },
        ...BaseSchemaFields,
    },
    BaseSchemaOptions
);

// Compound unique index for idempotency (one block per external event)
ExternalCalendarBlockSchema.index(
    { vendorId: 1, provider: 1, externalEventId: 1 },
    { unique: true }
);

// Query index for availability lookups (find active blocks in time range)
ExternalCalendarBlockSchema.index({
    vendorId: 1,
    isActive: 1,
    startTime: 1,
    endTime: 1,
});

export const ExternalCalendarBlock = model<IExternalCalendarBlock>(MODELS.EXTERNAL_CALENDAR_BLOCK, ExternalCalendarBlockSchema, COLLECTIONS.EXTERNAL_CALENDAR_BLOCK);
