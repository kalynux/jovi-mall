import { z } from 'zod';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const VehicleInfoSchema = z.object({
    vehicle_type: z.enum(['bike', 'car', 'van', 'truck']),
    plate_number: z.string().trim().nullable().optional(),
    color: z.string().min(1).max(50).trim(),
});

const LegalIdentitySchema = z.object({
    drivers_license_number: z.string().trim().nullable().optional(),
    national_id_number: z.string().trim().nullable().optional(),
});

const EmergencyContactSchema = z.object({
    name: z.string().min(1).max(100).trim(),
    phone: z.string().min(6).max(20).trim(),
});

// ─── Step 1: Vehicle Setup (REQUIRED) ─────────────────────────────────────────

export const AgentOnboardingStep1Schema = z.object({
    vehicle_info: VehicleInfoSchema,
});

export type AgentOnboardingStep1Input = z.infer<typeof AgentOnboardingStep1Schema>;

// ─── Step 2: Identity Setup (OPTIONAL / SKIPPABLE) ────────────────────────────

export const AgentOnboardingStep2Schema = z.object({
    /** Set to true to skip this step without providing identity data. */
    skip: z.boolean().optional().default(false),
    avatar_url: z.string().url('avatar_url must be a valid URL').nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
});

export type AgentOnboardingStep2Input = z.infer<typeof AgentOnboardingStep2Schema>;

// ─── General Profile Update ───────────────────────────────────────────────────

export const UpdateAgentProfileSchema = z.object({
    name: z.string().min(1).max(100).trim().optional(),
    avatar_url: z.string().url().nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
    vehicle_info: VehicleInfoSchema.optional(),
    legal_identity: LegalIdentitySchema.optional(),
    emergency_contact: EmergencyContactSchema.nullable().optional(),
});

export type UpdateAgentProfileInput = z.infer<typeof UpdateAgentProfileSchema>;
