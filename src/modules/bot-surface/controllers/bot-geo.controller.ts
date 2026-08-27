import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { getGeocodingProvider } from '../../../core/geocoding';
import { geoCandidateStore } from '../services/geo-candidate.store';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { BotReplyIntent } from '../domain/channel-reply';
import { BotGeoCandidateDto, toBotGeoCandidateDto } from '../dto/bot-projections';
import { BotGeoReverseSchema, BotGeoSearchSchema } from '../validators/bot.validators';

/**
 * Address search for the bot's address flow (GAP-005).
 *
 * ── WHAT DIFFERS FROM `GET /api/geo/search` ─────────────────────────────────
 * The candidates are the same and the provider is the same — this branches on neither,
 * exactly as the geo module does not. The difference is that **coordinates do not come
 * back**. Each candidate is stored server-side behind an opaque single-use handle, and
 * `POST /addresses` takes the handle.
 *
 * Two reasons, and the second is the one that has already cost this platform something.
 * A machine that can construct a `geo` object can construct a wrong one, and an address
 * that looks right and points somewhere else is a delivery to the wrong street. And a
 * `null` inside the 2dsphere-indexed saved-address array makes the WHOLE customer document
 * unwritable — measured, not fixed by a sparse or partial index, and it presents days
 * later as "this customer cannot be edited at all". A caller assembling `geo` objects
 * sends a null eventually. Withholding the coordinates removes the possibility rather
 * than warning against it.
 *
 * ── THE PROVIDER'S OWN ERRORS PASS THROUGH ──────────────────────────────────
 * `GEO_PROVIDER_UNAVAILABLE` and `GEO_SEARCH_FAILED` are raised by the adapter and
 * forwarded untouched. This surface adds no retry and no fallback of its own: the chain
 * (`GEO_PROVIDER=chain`) already fails over on a 429 or an empty result, and a second
 * retry layer here would multiply calls against a rate-limited provider without being
 * able to tell a real outage from a throttle.
 */
export class BotGeoController {
    /**
     * `POST /geo/search` — free-form text the customer typed, to ranked candidates.
     *
     * ⚠ **A POST for a read, and the reason is the identity envelope.** Putting a
     * messaging identifier in a query string writes it into every access log on the path.
     * That rule holds across the whole surface; here it also means the search text — which
     * is somebody's home address — stays out of those logs too.
     *
     * `limit` is capped at 10 rather than the geo module's 20. A chat can render a handful
     * of options as a numbered list; twenty is a wall, and the customer picks badly from it.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const { q, limit } = BotGeoSearchSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const candidates = await getGeocodingProvider().search(q, { limit });
        const refs = await geoCandidateStore.mint(caller.userId, candidates, q);

        const dtos = candidates.map((candidate, i) => toBotGeoCandidateDto(refs[i], candidate));
        setBotReply(req, pickerFor(dtos, req));
        sendSuccess(res, dtos);
    });

    /**
     * `POST /geo/reverse` — a coordinate to its best-matching address.
     *
     * The customer sends a location pin from WhatsApp or Telegram and the platform turns it
     * into something saveable. Note the asymmetry with `/search`: coordinates may come IN
     * — the customer's own device produced them — and never go back out.
     *
     * `null` is a legitimate answer: a provider with no address for a point says so, and a
     * pin in the middle of a field is a real thing for a person to send.
     */
    static reverse = asyncHandler(async (req: Request, res: Response) => {
        const { lat, lng } = BotGeoReverseSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const candidate = await getGeocodingProvider().reverse(lat, lng);
        if (!candidate) {
            sendSuccess(res, null);
            return;
        }

        // `rawInput` is null: the customer typed nothing, they dropped a pin. That null
        // reaches `GeoAddress.raw_input`, where it correctly says "not typed" rather than
        // inventing a coordinate string nobody entered.
        const [ref] = await geoCandidateStore.mint(caller.userId, [candidate], null);
        const dto = toBotGeoCandidateDto(ref, candidate);
        // A one-option picker rather than a bare sentence, deliberately. The pin resolved to
        // ONE address and the customer still has to say it is the right one — a confirmation
        // is the same widget with one row, and reusing it means the answer comes back through
        // exactly the path a multi-candidate answer does.
        setBotReply(req, pickerFor([dto], req));
        sendSuccess(res, dto);
    });
}

/**
 * The "which of these?" message for a set of candidates.
 *
 * ⚠ **The `candidateRef` IS the option id, and that is what makes the automation layer
 * stateless across this turn.** The walkthrough used to tell it to put a row *index* in
 * `callback_data` and keep the refs in the n8n execution's own memory, on the stated grounds
 * that *"a ref plus any prefix you add will silently truncate"*. Measured: a handle is `gc_`
 * plus 43 base64url characters — **46 bytes against Telegram's 64** — so it fits with room to
 * spare, and `renderBotReply` drops the keyboard rather than truncating if a future id ever
 * does not. Sending the ref means the tap comes back carrying the thing that must be posted
 * to `/identity/onboarding`, with nothing to remember in between.
 *
 * The label split is channel-shaped rather than cosmetic: `label` is the whole address (what
 * a Telegram button row shows), `shortLabel` the most specific component (a WhatsApp list
 * row's 24-character title), `description` the whole address again (that row's 72-character
 * subtitle). See `BotReplyOption`.
 */
function pickerFor(candidates: readonly BotGeoCandidateDto[], req: Request): BotReplyIntent | null {
    if (candidates.length === 0) return null;

    const language = botResponseLanguageOf(req);
    return {
        kind: 'choice',
        text: botChrome('choosePrompt', language),
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
        options: candidates.map((c) => ({
            id: c.candidateRef,
            label: c.formattedAddress,
            shortLabel:
                c.components.street
                ?? c.components.neighbourhood
                ?? c.components.city
                ?? c.formattedAddress,
            description: c.formattedAddress,
        })),
    };
}
