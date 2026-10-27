import { z } from 'zod';
import { APPOINTMENT_LIMITS, APPOINTMENT_LOCATION_KINDS, isAcceptableMeetingUrl } from './appointment';

/**
 * Request schemas for the appointment place and access details.
 *
 * Shared by the service config writes (`variant.validator.ts`) and the vendor's per-booking edit
 * (`PATCH /api/vendor/bookings/:id/access`), so a link one door refuses cannot be written
 * through the other.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

/** `''` and `null` both clear a text field — the dashboard's empty input sends `''`. */
const clearableText = (max: number) =>
    z.union([z.string().trim().max(max), z.null()])
        .transform((v) => (v === null || v === '' ? null : v));

const meetingUrl = z.union([z.string(), z.null()])
    .transform((v) => (v === null ? null : v.trim()))
    .transform((v) => (v === '' ? null : v))
    .refine((v) => v === null || isAcceptableMeetingUrl(v), {
        message: `meetingUrl must be an https:// link of at most ${APPOINTMENT_LIMITS.meetingUrlMax} characters`,
    });

const revealMinutesBefore = z.number().int()
    .min(0, 'revealMinutesBefore cannot be negative')
    .max(APPOINTMENT_LIMITS.revealMinutesMax, `revealMinutesBefore is at most ${APPOINTMENT_LIMITS.revealMinutesMax} (one day)`);

/** Where the appointment happens. `vendorAddressId` is required for, and only for, `vendor_address`. */
export const AppointmentLocationSchema = z.object({
    kind: z.enum(APPOINTMENT_LOCATION_KINDS),
    vendorAddressId: objectId.nullable().optional(),
}).strict().superRefine((value, ctx) => {
    if (value.kind === 'vendor_address' && !value.vendorAddressId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendorAddressId'],
            message: "vendorAddressId is required when kind is 'vendor_address'",
        });
    }
    if (value.kind !== 'vendor_address' && value.vendorAddressId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendorAddressId'],
            message: "vendorAddressId only applies when kind is 'vendor_address'",
        });
    }
}).transform((value) => ({
    kind: value.kind,
    vendorAddressId: value.kind === 'vendor_address' ? value.vendorAddressId ?? null : null,
}));

/**
 * Access details, every field optional: on create the omitted ones take their defaults, on a
 * patch they are kept. `null` (or `''`) clears a text field.
 */
export const AppointmentAccessPatchSchema = z.object({
    instructions: clearableText(APPOINTMENT_LIMITS.instructionsMax).optional(),
    meetingUrl: meetingUrl.optional(),
    revealMinutesBefore: revealMinutesBefore.optional(),
}).strict();

export type AppointmentLocationInput = z.output<typeof AppointmentLocationSchema>;
export type AppointmentAccessPatchInput = z.output<typeof AppointmentAccessPatchSchema>;

/** The vendor's per-booking edit — at least one field (D-5). */
export const BookingAccessPatchSchema = AppointmentAccessPatchSchema.refine(
    (v) => Object.keys(v).length > 0,
    { message: 'Provide at least one of instructions, meetingUrl, revealMinutesBefore' },
);
