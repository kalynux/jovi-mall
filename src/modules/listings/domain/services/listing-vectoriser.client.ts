import { vectoriserConfig } from '../../../../config/vectoriser.config';

/**
 * The HTTP leg to the n8n `wi-mall-vectoriser` workflow, for listings.
 *
 * Same base URL, same `VECTORISER_API_KEY` header, same timeouts and retry budget as the
 * product path — all read from `vectoriserConfig`, never re-derived — and the same rule the
 * product path follows: retry transient failures (network, 5xx), never a 4xx. Never throws:
 * the caller is a fire-and-forget indexing step and needs a verdict it can refund against.
 *
 * ⚠ It is a sibling of `VectorisationService`'s private `vectoriserFetch`/`withRetry`, not a
 * reuse of them — those two are module-private there. The header handling is the one the
 * AI-copy client already uses (`ai-copy-workflow.client.ts`). Exporting the product helpers and
 * deleting this body is a two-line follow-up if the catalog owner prefers one copy.
 *
 * `transport` is injectable so the suites never touch the network.
 */
export type VectoriserVerdict<T> = { ok: true; body: T } | { ok: false; status: number | null; error: string };

export interface ListingVectoriserTransport {
  /** `path` is appended to the base URL: `''` (submit, 202) or `/delete`. */
  post<T>(path: '' | '/delete', body: unknown, opts?: { retry?: boolean }): Promise<VectoriserVerdict<T>>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpListingVectoriserTransport implements ListingVectoriserTransport {
  async post<T>(path: '' | '/delete', body: unknown, opts: { retry?: boolean } = {}): Promise<VectoriserVerdict<T>> {
    const attempts = opts.retry ? Math.max(1, vectoriserConfig.maxRetries) : 1;
    let last: VectoriserVerdict<T> = { ok: false, status: null, error: 'not attempted' };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      last = await this.once<T>(`${vectoriserConfig.baseUrl}${path}`, body);
      if (last.ok) return last;
      // A 4xx is a payload problem — retrying cannot help (the product path's rule).
      if (last.status !== null && last.status >= 400 && last.status < 500) return last;
      if (attempt < attempts) await delay(vectoriserConfig.retryBaseDelayMs * attempt);
    }
    return last;
  }

  private async once<T>(url: string, body: unknown): Promise<VectoriserVerdict<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), vectoriserConfig.timeoutSingleMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(vectoriserConfig.apiKey ? { VECTORISER_API_KEY: vectoriserConfig.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }
      return { ok: true, body: (await res.json()) as T };
    } catch (err: any) {
      return { ok: false, status: null, error: err?.name === 'AbortError' ? 'timed out' : String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
