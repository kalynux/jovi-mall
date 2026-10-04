import { z } from 'zod';
import { Types } from 'mongoose';
import { CLOSABLE_ROLES } from './role-closure.types';

/**
 * The phrase a confirm must carry. The same one ADR-A02 self-closure asks for: an
 * irreversible write should not be reachable by a stray empty POST, and one phrase across
 * both doors is one thing for a client to get right.
 */
export const ROLE_CLOSURE_CONFIRMATION_PHRASE = 'CLOSE MY ACCOUNT';

export const RoleClosureParamsSchema = z.object({
  userId: z.string().refine((v) => Types.ObjectId.isValid(v), 'userId must be an ObjectId'),
  role: z.enum(CLOSABLE_ROLES),
});

export const RoleClosureUserParamsSchema = z.object({
  userId: z.string().refine((v) => Types.ObjectId.isValid(v), 'userId must be an ObjectId'),
});

/** The administrator's reason is shown to the user in the notice, so it is required. */
export const RequestRoleClosureSchema = z
  .object({
    reason: z.string().trim().min(3, 'A reason is required — the user is shown it').max(500),
  })
  .strict();

export const ConfirmRoleClosureSchema = z
  .object({
    confirm: z.literal(ROLE_CLOSURE_CONFIRMATION_PHRASE),
  })
  .strict();

export const DeclineRoleClosureSchema = z
  .object({
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
