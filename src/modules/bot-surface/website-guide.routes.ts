import { Request, Response, Router } from 'express';
import { renderWebsiteGuide } from './domain/website-guide';

/**
 * `GET /api/public/website-guide/:topic?lang=fr` — one topic of the website guide, as plain text.
 *
 * Read by the customer assistant's `Read-Website-Guide` tool (`wi-mall-core`) when a customer
 * wants something the chat cannot do: the answer tells it where on wi-mall.com to send them and
 * what to tap. See `domain/website-guide.ts`.
 *
 * ── WHY PUBLIC, AND WHY PLAIN TEXT ───────────────────────────────────────────
 * Nothing in it is about anyone: it is a how-to for the whole website, the same text for every
 * customer, so it carries no identity and needs none — the n8n tool calls it like the existing
 * website reader, with a fixed host and only the topic chosen by the model. Plain text because
 * the reader is a model, and JSON would only cost it tokens to unwrap.
 *
 * ⚠ **No `:topic` (or an unknown one) answers the topic LIST with a 200**, not a 404 — see
 * `renderWebsiteGuide`. `lang` is a hint: French gets French, everything else English, and the
 * link carries the customer's own locale either way.
 */
const router = Router();

function send(req: Request, res: Response): void {
    const lang = typeof req.query.lang === 'string' ? req.query.lang.slice(0, 8) : null;
    const topic = typeof req.params.topic === 'string' ? req.params.topic.slice(0, 40) : null;

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('text/plain; charset=utf-8');
    res.send(renderWebsiteGuide(topic, lang));
}

router.get('/website-guide', send);
router.get('/website-guide/:topic', send);

export default router;
