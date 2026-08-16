import { z } from 'zod';
import { LOGIN_CODE_LENGTH } from '../domain/login-code';
import { LOGIN_TOKEN_BYTES } from '../domain/login-token';
import {
  isUsableLoginIdentifier,
  normalizeLoginIdentifier,
} from '../domain/login-identifier';
import { EMAIL_FORMAT_MESSAGE } from '../../../core/validation/email';
import { PHONE_FORMAT_MESSAGE } from '../../../core/validation/phone';

/**
 * The two redemption bodies.
 *
 * ── Loose on CHARACTERS, strict on SIZE ──────────────────────────────────────
 * Neither schema checks the code's or the token's alphabet. Normalisation
 * (`O`→`0`, `I`/`L`→`1`, lowercase, stripped spaces and hyphens) has not run at
 * validation time, so rejecting on the strict alphabet here would refuse
 * `4b2k-91qn` and `4B2K91QO` — precisely the inputs the normaliser exists to
 * rescue. The service normalises, applies the shape check, and answers with the
 * same `MAGIC_CODE_INVALID` a wrong-but-well-formed code gets, so a probe cannot
 * use the ERROR SHAPE to learn the alphabet.
 *
 * What they do enforce is a sane bound, so a megabyte of text never reaches
 * Redis.
 */

export const RedeemMagicLinkSchema = z.object({
  token: z
    .string({ required_error: 'A sign-in token is required' })
    .trim()
    .min(1, 'A sign-in token is required')
    // 32 bytes is 43 base64url characters; the ceiling leaves room for a stray
    // padding character or a URL-decoded artefact without admitting a payload.
    .max(LOGIN_TOKEN_BYTES * 4, 'That is not a sign-in token'),
});

export type RedeemMagicLinkInput = z.infer<typeof RedeemMagicLinkSchema>;

/**
 * ⚠ `identifier` is normalised and format-checked HERE, and that is deliberate
 * even though §5 forbids distinguishing an unknown identifier from a wrong code.
 *
 * The two are different statements. "This is not a well-formed phone number or
 * email address" is a fact about the caller's own input, visible to them without
 * asking us — it is not an oracle, and `POST /auth/login` answers the same way.
 * What must never be distinguishable is whether a WELL-FORMED identifier names
 * an account, and that verdict is made in the service, where every path answers
 * `MAGIC_CODE_INVALID`.
 *
 * Normalising here also means the service receives the value the attempt counter
 * will key on — see `login-identifier.ts`.
 */
export const RedeemMagicCodeSchema = z.object({
  identifier: z
    .string({ required_error: 'Phone or Email required' })
    .min(1, 'Phone or Email required')
    .max(254, 'That is not a phone number or an email address')
    .transform(normalizeLoginIdentifier)
    .refine(isUsableLoginIdentifier, {
      message:
        'Identifier must be a valid email address or phone number. '
        + `${EMAIL_FORMAT_MESSAGE}. ${PHONE_FORMAT_MESSAGE}`,
    }),
  code: z
    .string({ required_error: 'A sign-in code is required' })
    .trim()
    .min(LOGIN_CODE_LENGTH, 'A sign-in code is 8 characters')
    // Room for the separators and casing a user may paste in.
    .max(32, 'That is not a sign-in code'),
});

export type RedeemMagicCodeInput = z.infer<typeof RedeemMagicCodeSchema>;
