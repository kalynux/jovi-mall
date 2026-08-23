function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Self-service contact change — the two windows, as configuration rather than literals
 * (Phase 6 · 6.D.1).
 *
 * Both are deliberately SHORTER than the registration email-verification window
 * (`EMAIL_VERIFY_EXPIRE`, 24 hours), and the asymmetry is the point rather than an
 * oversight. That token proves an address somebody has just typed into a signup form and
 * costs nothing if it lapses — they ask again. These bound a change to an identifier that
 * an account **already signs in with**, so the window is the period during which a
 * confirmation landing in the wrong mailbox, or a number connected for an unrelated
 * reason, would still move somebody's login. An hour is enough for a person to switch to
 * their mail client; a day is not enough more to be worth it.
 */
export const CONTACT_CHANGE_CONFIG = Object.freeze({
  /**
   * How long an emailed confirmation link stays spendable.
   *
   * The plaintext token exists only inside that message, so this is the exposure window of
   * a credential the platform has already handed to a third party (a mail provider, a
   * corporate relay, whatever scans attachments on the way).
   */
  EMAIL_TOKEN_TTL_SECONDS: intEnv('CONTACT_CHANGE_EMAIL_TTL_SECONDS', 60 * 60),

  /**
   * How long a requested phone change waits for its proof.
   *
   * Longer than the email window because the proof is not delivered — the person has to
   * go and message the bot from the new number, possibly on a handset that is not in the
   * room. Still bounded, because an unbounded pending request would be completed by the
   * next WhatsApp connection made for any reason at all, months later.
   */
  PHONE_PENDING_TTL_SECONDS: intEnv('CONTACT_CHANGE_PHONE_TTL_SECONDS', 24 * 60 * 60),
});
