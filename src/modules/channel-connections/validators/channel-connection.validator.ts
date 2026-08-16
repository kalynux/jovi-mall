import { z } from 'zod';
import { CONNECTION_CHANNELS } from '../domain/channel';
import { CODE_LENGTH } from '../domain/connection-code';

/**
 * The redeem body.
 *
 * Deliberately loose on the code's *characters*: normalization (`O`→`0`, `I`→`1`,
 * lowercase, stripped spaces and hyphens) has not run yet at validation time, so
 * rejecting on the strict alphabet here would refuse `a7k9p-2` and `A7K9PO`
 * before the layer that exists to rescue exactly those. The service normalises,
 * then applies `isWellFormedConnectionCode`, and answers with the same
 * `CONNECTION_CODE_INVALID` a wrong-but-well-formed code gets — so a probe
 * cannot use the *error shape* to learn the alphabet.
 *
 * What this schema does enforce is a sane bound, so a megabyte of text never
 * reaches Redis.
 */
export const RedeemConnectionCodeSchema = z.object({
  code: z
    .string({ required_error: 'A connection code is required' })
    .trim()
    .min(CODE_LENGTH, 'A connection code is 6 characters')
    // Room for the separators and casing a user may paste in.
    .max(32, 'That is not a connection code'),
});

export type RedeemConnectionCodeInput = z.infer<typeof RedeemConnectionCodeSchema>;

/** The `:channel` path param. Derived from the union — never a second literal list. */
export const ChannelParamSchema = z.object({
  channel: z.enum(CONNECTION_CHANNELS),
});
