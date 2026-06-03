/**
 * Vectoriser Service Configuration
 *
 * All settings are driven by environment variables.
 * Values here document the shape and defaults — never hard-code secrets.
 *
 * Required env vars (production):
 *   VECTORISER_API_KEY  — secret sent as T8N-API-KEY header
 *
 * Optional env vars (with defaults):
 *   VECTORISER_BASE_URL            — base URL (default: https://the8n.fante.cloud/vectoriser)
 *   VECTORISER_TIMEOUT_SINGLE_MS   — single product HTTP timeout in ms (default: 30000)
 *   VECTORISER_TIMEOUT_BULK_MS     — bulk HTTP timeout in ms (default: 120000)
 *   VECTORISER_MAX_RETRIES         — max retry attempts on transient failures (default: 3)
 *   VECTORISER_RETRY_BASE_DELAY_MS — base delay in ms for exponential backoff (default: 1000)
 */
export const vectoriserConfig = {
  /**
   * Base URL for the vectoriser service.
   * Single-product endpoint: POST <baseUrl>
   * Status-update endpoint:  POST <baseUrl>/status
   * Bulk endpoint:           POST <baseUrl> (array payload)
   */
  baseUrl: process.env.VECTORISER_BASE_URL ?? 'https://the8n.fante.cloud/vectoriser',

  /**
   * API key sent as the custom header: T8N-API-KEY: <apiKey>
   * Must be set in production. Absent in dev → requests go unauthenticated (OK for local mocks).
   */
  apiKey: process.env.VECTORISER_API_KEY ?? '',

  /** HTTP timeout for single-product requests (ms). Default: 30 s */
  timeoutSingleMs: parseInt(process.env.VECTORISER_TIMEOUT_SINGLE_MS ?? '30000', 10),

  /** HTTP timeout for bulk requests (ms). Default: 120 s */
  timeoutBulkMs: parseInt(process.env.VECTORISER_TIMEOUT_BULK_MS ?? '120000', 10),

  /** Maximum retry attempts on transient failures (network / 5xx). Default: 3 */
  maxRetries: parseInt(process.env.VECTORISER_MAX_RETRIES ?? '3', 10),

  /**
   * Base delay between retries for exponential backoff (ms).
   * Attempt 1 → <baseDelay>ms, attempt 2 → <baseDelay * 2>ms, …
   * Default: 1000 ms
   */
  retryBaseDelayMs: parseInt(process.env.VECTORISER_RETRY_BASE_DELAY_MS ?? '1000', 10),
} as const;

export type VectoriserConfig = typeof vectoriserConfig;
