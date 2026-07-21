import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { AGENT_CONFIG, internalApiEnabled } from '../config/agent.config';

/**
 * requireServiceToken — authenticates geo-tracker (not a human) on the internal
 * agent API.
 *
 * The user-facing `requireAuth` is wrong for this caller: geo-tracker has no
 * user, no role entity, and no refresh cookie, and forcing it to impersonate
 * one would blur the audit trail. It presents a shared secret instead —
 * mirroring how the tracking webhook already authenticates in the opposite
 * direction with HMAC.
 *
 * Two properties worth keeping:
 *
 *  - An unset secret DENIES rather than allows. A misconfigured deploy must
 *    not silently expose agent policy to anyone who finds the URL; the fail
 *    direction of an auth check is never "open".
 *  - Comparison is timing-safe. A naive `===` leaks the secret a byte at a
 *    time to anyone who can measure response latency.
 */
export const requireServiceToken = (req: Request, res: Response, next: NextFunction) => {
  if (!internalApiEnabled()) {
    return next(
      createAppError(
        ERROR_CODES.AGENT_SERVICE_TOKEN_NOT_CONFIGURED,
        503,
        'Internal agent API is disabled — INTERNAL_SERVICE_TOKEN is not set'
      )
    );
  }

  const presented = extractServiceToken(req);
  if (!presented || !timingSafeEqual(presented, AGENT_CONFIG.INTERNAL_SERVICE_TOKEN)) {
    return next(createAppError(ERROR_CODES.AGENT_SERVICE_TOKEN_INVALID, 401));
  }

  next();
};

function extractServiceToken(req: Request): string | null {
  const header = req.headers['x-service-token'];
  if (typeof header === 'string' && header.length > 0) return header;

  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();

  return null;
}

/**
 * Constant-time compare. Lengths are hashed first so that differing lengths
 * don't short-circuit (timingSafeEqual throws on length mismatch, which is
 * itself a leak).
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
