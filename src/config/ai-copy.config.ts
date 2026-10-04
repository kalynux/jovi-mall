/**
 * AI listing-copy configuration — `POST /api/vendor/ai/listing-copy`.
 *
 * The model runs in n8n (the `UP-wi-mall-ai-listing-copy` workflow), not here: that
 * workflow owns the system prompt and the model slugs, so wording and model can be
 * tuned without a backend deploy. jovi-mall owns everything around it — the vendor,
 * the photos, the credits, the category list, and the check of what comes back.
 *
 * Env vars (all optional):
 *   AI_COPY_ENABLED     — `false` answers 503 AI_COPY_UNAVAILABLE without charging. Default on.
 *   AI_COPY_BASE_URL    — the workflow's production webhook. Production sets the Docker-network
 *                         address (`http://n8n:5678/webhook/ai-listing-copy`), like the vectoriser.
 *   AI_COPY_TIMEOUT_MS  — how long to wait for the model. Default 45 s, the dashboard's budget.
 *
 * ⚠ There is no key of its own. The webhook sits behind the SAME n8n Header Auth credential
 * as the vectoriser ("Vectoriser Api Key"), so jovi-mall sends `VECTORISER_API_KEY` from
 * `vectoriser.config.ts`. One secret, one n8n credential, one place to rotate it. If the two
 * ever need separating, give this its own credential in n8n and its own variable here.
 */
export const aiCopyConfig = {
  enabled: !['false', '0'].includes((process.env.AI_COPY_ENABLED ?? 'true').trim().toLowerCase()),

  baseUrl: process.env.AI_COPY_BASE_URL ?? 'https://the8n.wi-mall.com/webhook/ai-listing-copy',

  timeoutMs: parseInt(process.env.AI_COPY_TIMEOUT_MS ?? '45000', 10),

  /** Long side, in pixels, a photo is shrunk to before the model sees it. */
  imageMaxSide: 1024,

  /** A source photo larger than this is refused rather than decoded. */
  imageMaxSourceBytes: 15 * 1024 * 1024,
} as const;
