import mongoose, { Document, Schema } from 'mongoose';

export interface ISession extends Document {
    sessionId: string; // Cryptographically strong token
    userId: mongoose.Types.ObjectId;
    expiresAt: Date; // Absolute expiration
    createdAt: Date;
    updatedAt: Date;
}

const SessionSchema = new Schema<ISession>(
    {
        sessionId: {
            type: String,
            required: true,
            unique: true,
            index: true, // Fast lookup by sessionId
        },
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        expiresAt: {
            type: Date,
            required: true,
            // index: true, // For TTL cleanup and efficient expiry checks // decommenting will create duplicate index
        },
    },
    {
        timestamps: true,
    }
);

// Compound index for cleanup queries
SessionSchema.index({ expiresAt: 1, userId: 1 });

// TTL index - MongoDB will automatically delete expired sessions
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model<ISession>('Session', SessionSchema);
