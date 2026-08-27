import { NextFunction, Request, Response } from 'express';
import { BotEnvelopeSchema } from '../validators/bot.validators';
import {
    botIdentityService,
    BotIdentityEnvelope,
    BotIdentityService,
    ResolvedBotCaller,
} from '../services/bot-identity.service';
import { digestForKey } from '../domain/bot-key-digest';
import { botRouteFor } from '../domain/bot-route-table';
import { CustomerModel } from '../../customers/customer.model';
import { BotReplyIntent } from '../domain/channel-reply';

/**
 * Resolve the messaging identity on the bot surface, once, before any handler runs.
 *
 * ── WHY THIS IS A MOUNT-LEVEL GUARD AND NOT A HELPER ─────────────────────────
 * A `resolveCaller(req)` helper each controller called would work exactly as long as
 * every controller remembered to call it, and the one that forgot would be a route
 * reachable with no identity at all — reading whatever `customerId` the code happened to
 * have. `router.use` makes "every route on this surface is identity-scoped" true by
 * construction, including routes added next year by somebody who never read this file.
 * Same argument `requireAuth`'s tail makes for Layer B of the rate limiter.
 *
 * ── IT RUNS BEFORE ARGUMENT PARSING, DELIBERATELY ────────────────────────────
 * A caller whose identity does not resolve is refused before a single operation argument
 * is looked at. That is not only tidiness: telling an unresolvable sender which of their
 * arguments were also malformed answers a question they had no standing to ask.
 *
 * ── IT REMOVES `identity` FROM THE BODY ──────────────────────────────────────
 * Every per-route schema is `.strict()`, so a leftover `identity` key would 400 every
 * call on the surface. Consuming it here is what lets each route declare only its own
 * arguments — and it also means no controller can read the envelope a second time and
 * reach a different conclusion about who is calling than this middleware did.
 *
 * ── ONE EXCEPTION, AND IT IS A COLUMN IN THE TABLE, NOT A BRANCH HERE ────────
 * A route flagged `anonymous` in `bot-route-table.ts` resolves SOFTLY: a sender who does
 * resolve still arrives with `req.bot.caller`, and one who does not arrives with
 * `caller: null` and the raw envelope, rather than the refusal. That is what makes GAP-002
 * reachable at all — this is a `router.use`, so a guard that refuses an unknown sender is
 * a guard that refuses the request whose whole job is to stop them being unknown.
 *
 * The exception is a data flag rather than a path check on purpose. A `if (req.path ===
 * '/identity/sync')` here would be a second, weaker copy of the route table, and the day
 * somebody adds a third registration route it silently would not cover it.
 */

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /**
             * The resolved bot caller. Present on every `/api/internal/bot/*` handler and
             * absent everywhere else.
             *
             * ⚠ Deliberately NOT `req.auth`. `requireAuth` and `requireAdminCaller` both
             * build that shape and both mean "a session or a service acting with full
             * privilege"; this is neither. Every `requireRole(['customer'])` route in the
             * service reads `req.auth`, so borrowing the field would make a bot request
             * indistinguishable from a signed-in customer to code that has never heard of
             * this surface — which is precisely the confusion the curated-surface design
             * exists to avoid.
             */
            bot?: {
                /**
                 * ⚠ **Null ONLY on a route the table flags `anonymous`.** Everywhere else
                 * the guard has already refused an unresolvable sender, which is why
                 * `botCallerOf` may throw rather than returning a union: forty handlers
                 * would otherwise each carry a null check for a state they cannot be in.
                 */
                caller: ResolvedBotCaller | null;
                /** The envelope as sent. The only identity an anonymous route has. */
                envelope: BotIdentityEnvelope;
                /** The catalogue tool name this path resolved to, for logs. */
                tool: string;
                /**
                 * The route's `anonymous` column, carried forward so the idempotency scope
                 * does not have to look the route up a second time — and, more to the
                 * point, so it cannot look it up differently. See `botIdempotencyScopeOf`.
                 */
                anonymous: boolean;
                /**
                 * The language `error.customerMessage` is written in when this request
                 * fails.
                 *
                 * ⚠ **Set here rather than resolved in the error handler, and that is
                 * deliberate.** The handler runs on a request that has already thrown —
                 * quite possibly because the database is unreachable — so a lookup there
                 * would be a query on the failure path, at the worst possible moment, to
                 * decide the wording of a sentence. Stamping it while the request is still
                 * healthy means the copy is right even when nothing else is answering.
                 *
                 * Seeded from the envelope's language hint (all the platform knows about a
                 * brand-new sender) and narrowed to the customer's own
                 * `preferences.language` by any handler that has loaded their profile.
                 */
                language: string | null;
                /**
                 * What to say to the customer when this request succeeds, described
                 * channel-neutrally. Rendered into `reply` by `attachBotReply`.
                 *
                 * ⚠ **Absent on most routes, and that is correct.** A cart, an order list
                 * or a product page is DATA for the model to narrate; only a turn whose
                 * wording is fixed — a prompt, a picker, a payment button — has a sentence
                 * this service is entitled to write. See `channel-reply.ts`.
                 *
                 * Set through `setBotReply`, never assigned directly, so the one place that
                 * knows a controller has no business naming a platform stays the one place.
                 */
                replyIntent?: BotReplyIntent | null;
            };
        }
    }
}

export function buildBotIdentityMiddleware(service: BotIdentityService = botIdentityService) {
    return async function requireBotIdentity(
        req: Request,
        _res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const { identity } = BotEnvelopeSchema.parse(body);

            // `req.originalUrl` carries the query string; `req.baseUrl + req.path` does not,
            // and inside a `use`-mounted router `req.path` alone has had the prefix stripped.
            // The route table matches ABSOLUTE paths, so both halves are needed — the same
            // trap `rate-limit/auth-paths.ts` documents.
            const route = botRouteFor(req.method, `${req.baseUrl}${req.path}`);

            /**
             * ⚠ **STAMPED BEFORE THE RESOLUTION, and that ordering is a fix rather than a
             * tidy-up.** `service.resolve` THROWS for a sender it cannot resolve, so while
             * this assignment sat below it `req.bot` was never set on exactly the refusals
             * a chat window most needs worded — `BOT_IDENTITY_UNRESOLVED`,
             * `BOT_IDENTITY_NEEDS_CONTACT`, `BOT_IDENTITY_NOT_CUSTOMER`. The error handler
             * keys `error.customerMessage` on `req.bot`, so those three answered with the
             * operator's English sentence and nothing a customer could read, while the
             * copy table sat there with an entry for each of them. The reply body inherits
             * the same fix: `BOT_IDENTITY_NEEDS_CONTACT` can now render the very keyboard
             * its own copy tells the customer to tap.
             *
             * Nothing downstream can observe the intermediate `caller: null`, because a
             * refusal goes straight to `next(error)` and no handler runs.
             */
            req.bot = {
                caller: null,
                envelope: identity,
                tool: route?.tool ?? 'unknown',
                anonymous: route?.anonymous === true,
                /**
                 * The envelope's hint is the seed — it is all we know about a sender whose
                 * account does not exist yet, and it is exactly the case where a refusal is
                 * most likely. Handlers that load a profile narrow it to the customer's own
                 * setting through `setBotResponseLanguage`.
                 */
                language: identity.language ?? null,
            };

            /**
             * An unrecognised path resolves to no row and is treated as NOT anonymous.
             *
             * It is on its way to a 404 either way, and failing to the strict branch is the
             * safe direction — the same reasoning `isBotReadRequest` gives for failing
             * closed on an unnamed path.
             */
            const caller = route?.anonymous
                ? await service.resolveSoftly(identity)
                : await service.resolve(identity);

            req.bot.caller = caller;

            /**
             * A resolved caller is a customer whose stored preference we should be using
             * rather than a device locale, so read it once here. Best-effort and
             * self-catching: a language lookup must never be the thing that fails a request
             * on a surface where every route has real work to do.
             */
            if (caller) {
                try {
                    const customer = await CustomerModel.findById(caller.customerId)
                        .select('preferences.language')
                        .lean();
                    if (customer?.preferences?.language) {
                        req.bot.language = customer.preferences.language;
                    }
                } catch (error) {
                    console.warn('[BotSurface] could not resolve the response language', error);
                }
            }

            // See the header: every per-route schema is `.strict()`.
            delete body.identity;

            next();
        } catch (error) {
            next(error);
        }
    };
}

export const requireBotIdentity = buildBotIdentityMiddleware();

/**
 * The resolved caller, or a throw.
 *
 * Controllers call this instead of reading `req.bot!.caller`, so the non-null assertion
 * exists once rather than in forty handlers. If it ever fires, the middleware above was
 * not mounted — a wiring bug, not a request the caller can fix.
 */
export function botCallerOf(req: Request): ResolvedBotCaller {
    const caller = req.bot?.caller;
    if (!caller) {
        // A WIRING bug, not a request the caller can fix, and structurally unreachable
        // while the router mounts this guard with `router.use`. A bare throw is exactly
        // right: the global handler turns it into the generic 500 an unexpected fault
        // deserves, and an AppError with a domain code would dress a broken mount up as a
        // business outcome somebody might try to handle.
        // eslint-disable-next-line no-restricted-syntax -- wiring fault, not a domain error
        throw new Error(
            '[BotSurface] req.bot is absent — requireBotIdentity is not mounted on this route',
        );
    }
    return caller;
}

/**
 * The envelope this request carried, resolved or not.
 *
 * Only the `anonymous` routes have any use for it: on every other row the caller has
 * already been resolved and the envelope is the strictly weaker fact. Reading it elsewhere
 * to make a decision would reintroduce exactly the rule this surface exists to hold — the
 * identity is never a parameter — so it is deliberately not returned by `botCallerOf`.
 */
export function botEnvelopeOf(req: Request): BotIdentityEnvelope {
    const envelope = req.bot?.envelope;
    if (!envelope) {
        // eslint-disable-next-line no-restricted-syntax -- wiring fault; see botCallerOf.
        throw new Error(
            '[BotSurface] req.bot is absent — requireBotIdentity is not mounted on this route',
        );
    }
    return envelope;
}

/**
 * The scope an idempotency record is filed under.
 *
 * Ordinary routes are keyed on the ACCOUNT, so one person reaching it from two channels
 * shares one record — the reasoning is in `bot-idempotency.middleware.ts`.
 *
 * ⚠ **The `anonymous` routes are keyed on the MESSAGING IDENTITY instead, and that is not
 * merely a fallback for "there is no account yet".** Keying them on the resolved caller
 * would make the scope CHANGE ACROSS THE VERY TRANSITION THEY PERFORM: the first call has
 * no account and files under `anon:…`, and the retry a second later finds the account the
 * first one created and looks under `user:…`. The record is there and is never consulted,
 * so a retried registration re-executes — which is exactly the case idempotency exists for.
 *
 * That was measured rather than reasoned about: `verify:bot-registration` § 8 failed on it,
 * and the failure was in the code rather than the test. The blast radius was small — the
 * upsert is idempotent by the messaging identity anyway, so no duplicate account was ever
 * created — but the retry answered `isNew: false`, which is the signal a caller uses to
 * decide whether to greet somebody for the first time.
 *
 * The account-scoped rule's own justification does not apply to these two routes either:
 * "one person, two channels, one record" is right for a cart, and wrong for a
 * registration, where a WhatsApp turn and a Telegram turn are genuinely different requests.
 *
 * The identity is **hashed**: a scope string becomes part of a Redis key name, key names
 * are listable on the operations surface, and a raw phone number must never be. Same rule,
 * same argument, as `digestForKey`'s own header. The two spaces are prefixed so they cannot
 * collide.
 */
export function botIdempotencyScopeOf(req: Request): string {
    const caller = req.bot?.caller;
    if (caller && !req.bot?.anonymous) return `user:${caller.userId}:${caller.channel}`;

    const envelope = botEnvelopeOf(req);
    return `identity:${envelope.channel}:${digestForKey(envelope.externalId)}`;
}

/**
 * Narrow the language a failure will be worded in, once a handler knows the customer's own.
 *
 * Called by the registration routes, which create or load a profile mid-request and
 * therefore learn a better answer than the envelope's device-locale hint. A null is
 * ignored rather than clearing what is already there — "I did not find a preference" must
 * not undo "the transport told us `fr`".
 *
 * ⚠ **Only ever narrows toward the customer's stored preference.** Nothing else may write
 * this: a request-scoped language set from anything the customer did not choose would make
 * the wording of an error depend on which handler happened to run first.
 */
export function setBotResponseLanguage(req: Request, language: string | null): void {
    if (req.bot && language) req.bot.language = language;
}

/**
 * The language this request's `error.customerMessage` is written in.
 *
 * Returns null off the bot surface, which is what keeps the field off every other response
 * in the service — see `error-handler.middleware.ts`.
 */
export function botResponseLanguageOf(req: Request): string | null {
    return req.bot?.language ?? null;
}
