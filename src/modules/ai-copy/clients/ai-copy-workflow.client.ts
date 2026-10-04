import { aiCopyConfig } from '../../../config/ai-copy.config';
import { vectoriserConfig } from '../../../config/vectoriser.config';
import { AiCopyWorkflowRequest, AiCopyWorkflowResponse } from '../ai-copy.types';

/**
 * The one call to the n8n `UP-wi-mall-ai-listing-copy` workflow.
 *
 * Never throws: the caller has already charged the vendor and needs a verdict it can refund
 * against, not an exception to remember to catch. Two failure kinds, because the vendor is
 * told different things:
 *
 *   `unavailable` — never got an answer (connection refused, DNS, 404/401/5xx from n8n itself,
 *                   n8n crashing). 503 AI_COPY_UNAVAILABLE.
 *   `failed`      — the model produced nothing usable, or took longer than the timeout.
 *                   502 AI_COPY_FAILED.
 *
 * No retry. The vendor is watching a spinner with a 45 s budget, and the workflow already
 * falls back to a second model internally; a retry here would double the wait for the case
 * that is most likely to fail again.
 */
export type WorkflowVerdict =
  | { kind: 'ok'; body: AiCopyWorkflowResponse }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string; body?: AiCopyWorkflowResponse };

export async function callAiCopyWorkflow(payload: AiCopyWorkflowRequest): Promise<WorkflowVerdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), aiCopyConfig.timeoutMs);
  try {
    const res = await fetch(aiCopyConfig.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The vectoriser's n8n Header Auth credential guards this webhook too — see ai-copy.config.ts.
        ...(vectoriserConfig.apiKey ? { VECTORISER_API_KEY: vectoriserConfig.apiKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let body: AiCopyWorkflowResponse | undefined;
    try {
      body = (await res.json()) as AiCopyWorkflowResponse;
    } catch {
      body = undefined;
    }

    // The workflow answers 502 with `{ success:false }` when both models failed. Anything
    // else non-2xx is n8n itself (unpublished workflow, wrong key, crash) — not the model.
    if (res.status === 502 && body && body.success === false) {
      return { kind: 'failed', reason: body.error || 'model_failed', body };
    }
    if (!res.ok) return { kind: 'unavailable', reason: `workflow answered HTTP ${res.status}` };
    if (!body || body.success !== true || !body.output || typeof body.output !== 'object') {
      return { kind: 'failed', reason: body?.error || 'unparseable workflow answer', body };
    }
    return { kind: 'ok', body };
  } catch (err: any) {
    // A timeout is FAILED, not unavailable (the contract's rule): the workflow was reached and
    // the model was too slow, which a retry in a minute may well fix.
    if (err?.name === 'AbortError') return { kind: 'failed', reason: `timed out after ${aiCopyConfig.timeoutMs} ms` };
    return { kind: 'unavailable', reason: `request failed: ${err?.message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
