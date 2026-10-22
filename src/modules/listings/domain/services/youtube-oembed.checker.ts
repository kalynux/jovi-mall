/**
 * "Can this YouTube video be watched?" — YouTube's oEmbed endpoint, which answers 401/403/404
 * for a private, deleted or embed-disabled video (SERVICE-LISTINGS-PLAN stated defaults, L-17).
 *
 * Three verdicts, because the caller treats a NETWORK failure differently from a refusal:
 *
 *   watchable    200 — store `checked_at = now`.
 *   gone         401 / 403 / 404 — a definite answer: refuse at submit
 *                (`LISTING_VIDEO_NOT_WATCHABLE`), refuse and charge nothing at reveal.
 *   unknown      timeout, network error, any other status — FAIL OPEN: accept with
 *                `checked_at: null` and let the reviewing administrator watch it. A YouTube
 *                outage must never block every provider's submission (§ C-8a says the same
 *                for the reveal).
 *
 * Google Drive has no equivalent check and is never sent here.
 *
 * `fetchImpl` is injectable so the suites never touch the network.
 */
export type OembedVerdict = 'watchable' | 'gone' | 'unknown';

export const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';
/** Short on purpose: this runs inside a provider's submit request. */
export const OEMBED_TIMEOUT_MS = 5000;

type FetchLike = (url: string, init: { signal: AbortSignal; method: string }) => Promise<{ status: number }>;

export function oembedUrlFor(videoUrl: string): string {
  return `${OEMBED_ENDPOINT}?url=${encodeURIComponent(videoUrl)}&format=json`;
}

export function verdictForStatus(status: number): OembedVerdict {
  if (status >= 200 && status < 300) return 'watchable';
  if (status === 401 || status === 403 || status === 404) return 'gone';
  return 'unknown';
}

export class YoutubeOembedChecker {
  constructor(
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = OEMBED_TIMEOUT_MS,
  ) {}

  async check(videoUrl: string): Promise<OembedVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(oembedUrlFor(videoUrl), { method: 'GET', signal: controller.signal });
      return verdictForStatus(res.status);
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }
}

export const youtubeOembedChecker = new YoutubeOembedChecker();
