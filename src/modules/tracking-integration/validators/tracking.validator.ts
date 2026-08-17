import { z } from 'zod';

/**
 * The tracking-state notification geo-tracker POSTs to `/api/tracking/agent-state`.
 *
 * Published as `geo-tracker/api-doc/tracking-notifications.md`, and this schema is the
 * jovi-mall half of that contract. Keep the two in step: a field added on one side and
 * not the other is silently dropped, and the delivery is best-effort so nobody is told.
 *
 * ── Lenient where it can be, strict where it must ────────────────────────────
 * `previousState` and `trigger` are free strings rather than enums. geo-tracker owns
 * that vocabulary — nine lifecycle states and a longer list of triggers — and pinning
 * them here would make a state added there a 400 here, which is a rejected notification
 * rather than the harmless "unknown" the mapping already handles. `state` is likewise
 * free and mapped, never matched exhaustively.
 *
 * The coordinates ARE bounded, because they are the one field that can be wrong in a way
 * nothing downstream would notice: a latitude of 200 stores fine, indexes fine, and puts
 * a pin nowhere.
 */
export const AgentStateNotificationSchema = z
    .object({
        eventId: z.string().min(1).max(200),
        agentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'agentId must be a 24-character hex string'),
        previousState: z.string().min(1).max(64),
        state: z.string().min(1).max(64),
        trigger: z.string().min(1).max(64),
        reason: z.string().max(500).optional(),
        occurredAt: z.coerce.date(),

        /**
         * Named fields, NOT a GeoJSON pair — the `[lng, lat]` inversion happens exactly
         * once, in `AgentStateReceiverService`, next to the field it writes.
         *
         * Absent means "no fix", which is the ordinary case on the transitions that get
         * sent: an agent going offline has usually stopped producing one. Absent is
         * never read as "clear the stored position".
         */
        position: z
            .object({
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
                recordedAt: z.coerce.date(),
            })
            .nullable()
            .optional(),
    })
    /**
     * Not `.strict()`, deliberately, and this is the one place on the inbound surface
     * where that is the right call. geo-tracker is a separately-deployed service on its
     * own release cadence; a field it adds before jovi-mall knows about it must be
     * ignored, not answered with a 400 that turns every notification into a dropped
     * delivery until both sides ship. The fields that matter are all required above.
     */
    .passthrough();

export type AgentStateNotificationInput = z.infer<typeof AgentStateNotificationSchema>;
