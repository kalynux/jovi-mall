import type { MessagingChannel } from '../../channel-connections';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { parseBotActionId } from './bot-action-id';
import { actionKeyOf } from './bot-action-dispatch';
import type { BotReplyIntent } from './channel-reply';

/**
 * ⭐ **THE QUESTION WAITING FOR AN ANSWER — and the rule that a typed "yes" is a tap.**
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * When this surface draws a Yes/No question — Place order · Not now under the chat checkout,
 * "did it arrive?", "cancel this order?", "close this request?", "disconnect this app?" — the
 * customer often TYPES "yes please" instead of tapping. The model answering that message usually
 * does not know what the question was: a tap never goes through the model at all, and a turn whose
 * message a tool drew was not saved to its memory. The owner's standing decision (2026-09-22):
 * **a typed yes/no must act EXACTLY like tapping the Yes/No button.**
 *
 * So the question is remembered HERE, where it was drawn, per conversation, for fifteen minutes —
 * the two tokens its buttons carry, and the words it asked. `chat_answer_question` then runs the
 * stored token through the SAME router over the SAME handler table the tap dispatcher uses
 * (`routeTap` in `bot-action.controller.ts`), so the outcome, the reply and every side effect are
 * the tap's own, byte for byte. There is no second implementation of placing an order or
 * cancelling one.
 *
 * ── ⛔ ACCOUNT CLOSURE IS BUTTON-ONLY, and that is checked twice ────────────
 * `yes:close` is never recorded (`pendingQuestionDecisionFor` answers `supersede`), and a stored
 * record whose token is not an answerable context is refused on the way out (`tokenForAnswer`). A
 * typed word must never close an account — so a closure question drawn AFTER a checkout question
 * also CLEARS the checkout one: otherwise the customer's "yes" to "close my account?" would place
 * the order still pending underneath it.
 *
 * ── WHAT COUNTS AS A QUESTION ───────────────────────────────────────────────
 * A drawn reply whose buttons hold **exactly one `yes:<ctx>` and exactly one `no:<ctx>`**, for one
 * context in `ANSWERABLE_QUESTION_CONTEXTS`. Anything else that carries a confirm token SUPERSEDES
 * (clears) the one waiting — a newer question now stands, and it is not one a word can answer:
 *
 *   - `yes:close` — button-only, by decision.
 *   - a context not on the list — a future confirm nobody has decided is safe to answer in words.
 *   - several `yes:` rows — the chat checkout with several deliverable addresses, where "yes"
 *     does not say WHICH address. The customer must tap the one they mean.
 *
 * A reply carrying no confirm token at all leaves the waiting question alone: `/identity/sync`
 * draws an onboarding prompt on many messages, and a product card drawn between the question and
 * the answer does not withdraw the question.
 *
 * ── WHY THIS FILE IS PURE ───────────────────────────────────────────────────
 * Every decision here — what is a question, what is stored, which token an answer runs, what the
 * model is shown — is a function of its arguments, so `test:chat-answer` drives all of it with no
 * Redis, no server and no clock. The store (`services/bot-pending-question.store.ts`) only persists.
 */

/**
 * The confirm contexts a typed answer may act on — the owner's list, 2026-09-22.
 *
 *     co   place the order (chat checkout)        yes:co:<ref>[:<addressId>]   no:co:<ref>
 *     cd   confirm a parcel was delivered         yes:cd:<orderId>:<shipmentId> no:cd:…
 *     cnc  cancel an order                        yes:cnc:<orderId>:<ref>      no:cnc:<orderId>
 *     tcl  close a support request                yes:tcl:<ticketId>:<ref>     no:tcl:<ticketId>
 *     unl  disconnect a messaging app             yes:unl:<channel>:<ref>      no:unl:<channel>
 *
 * ⚠ **Adding one is a product decision, not a refactor.** A context absent from this list is
 * treated exactly like `close`: never recorded, and it clears whatever was waiting.
 */
export const ANSWERABLE_QUESTION_CONTEXTS = Object.freeze(['co', 'cd', 'cnc', 'tcl', 'unl'] as const);
export type AnswerableQuestionContext = (typeof ANSWERABLE_QUESTION_CONTEXTS)[number];

/** ⛔ Never answerable in words, whatever the list above ever grows to. Checked on its own. */
export const BUTTON_ONLY_QUESTION_CONTEXTS = Object.freeze(['close'] as const);

export function isAnswerableContext(context: unknown): context is AnswerableQuestionContext {
    if (typeof context !== 'string') return false;
    if ((BUTTON_ONLY_QUESTION_CONTEXTS as readonly string[]).includes(context)) return false;
    return (ANSWERABLE_QUESTION_CONTEXTS as readonly string[]).includes(context);
}

/**
 * How long a question waits. Fifteen minutes — the owner's figure.
 *
 * ⚠ **Longer than the ten-minute refs some of these buttons carry, deliberately.** A stale ref is
 * not refused silently: the tap it came from re-asks with fresh buttons (a checkout draws a fresh
 * confirmation, a cancel asks again), and a typed answer runs that same tap — so a late "yes"
 * reaches the re-ask rather than "there is no question", which would be untrue.
 */
export const PENDING_QUESTION_TTL_SECONDS = 15 * 60;

/** How much of the question the model is shown. See `clipQuestionText`. */
export const PENDING_QUESTION_TEXT_MAX = 300;

/**
 * Whose conversation a question belongs to — the resolved account and the channel it is talking
 * on. `ResolvedBotCaller` satisfies it.
 *
 * ⚠ **The account + channel, not the raw messaging identity, and the two name the same chat.**
 * `channel_connections` is unique on `(user_id, channel)` AND on `(channel, external_id)`, and the
 * resolver binds on success, so a resolved caller has exactly one chat per channel. Keying on the
 * account is what lets an administrator's memory reset clear every chat's question with no lookup
 * (and no chance of missing an unbound one), and it keeps a phone number out of a Redis key name.
 * It is also the scope the confirm refs are bound to (`bot-confirmation-ref.ts`), so a question
 * and the ref inside its button can never disagree about whose they are.
 */
export interface PendingQuestionOwner {
    userId: string;
    channel: MessagingChannel;
}

/** What is stored. ⛔ The two tokens never leave this service — see `pendingQuestionView`. */
export interface BotPendingQuestion {
    context: AnswerableQuestionContext;
    /** The Yes button's token, verbatim — what a typed yes runs. */
    yesToken: string;
    /** The No button's token, verbatim — what a typed no runs. */
    noToken: string;
    /** The words of the question, clipped — so the model can judge whether a message answers it. */
    questionText: string;
    /** ISO. Also the authority on expiry, over and above the Redis TTL. */
    askedAt: string;
}

export type PendingQuestionDecision =
    | { kind: 'record'; question: BotPendingQuestion }
    /** A newer confirm question stands that a word must not answer: clear the waiting one. */
    | { kind: 'supersede'; reason: 'button_only' | 'not_a_pair' }
    /** No confirm button on this reply: leave the waiting question as it is. */
    | { kind: 'none' };

const NONE: PendingQuestionDecision = Object.freeze({ kind: 'none' });

/** Every token a reply's buttons carry. Only `text` actions and `choice` rows carry any. */
function buttonTokensOf(intent: BotReplyIntent): string[] {
    if (intent.kind === 'text') return (intent.actions ?? []).map((option) => option.id);
    if (intent.kind === 'choice') return intent.options.map((option) => option.id);
    return [];
}

/**
 * Keep the END of a long question, not the start.
 *
 * ⚠ **Every question on this surface ends with the question.** The chat checkout's body is the
 * basket lines, then the total, the address, the wallet, and "Place this order?" last; a head-clip
 * would hand the model a list of products and no question at all. Short questions are unchanged.
 * Clipped by code point, so an emoji or an Arabic letter is never cut in half.
 */
export function clipQuestionText(text: string, max: number = PENDING_QUESTION_TEXT_MAX): string {
    const chars = Array.from(text.trim());
    if (chars.length <= max) return chars.join('');
    return `…${chars.slice(chars.length - (max - 1)).join('').trimStart()}`;
}

/**
 * Is this drawn reply a Yes/No question a word may answer — and if not, does it withdraw one?
 *
 * The token grammar is the dispatcher's own (`parseBotActionId` + `actionKeyOf`), so "the context
 * of this button" means exactly what it means when the button is tapped.
 */
export function pendingQuestionDecisionFor(
    intent: BotReplyIntent | null | undefined,
    now: Date,
): PendingQuestionDecision {
    if (!intent) return NONE;

    const confirms: Array<{ verb: 'yes' | 'no'; context: string; token: string }> = [];
    for (const token of buttonTokensOf(intent)) {
        const parsed = parseBotActionId(token);
        if (!parsed || (parsed.verb !== 'yes' && parsed.verb !== 'no')) continue;
        confirms.push({ verb: parsed.verb, context: actionKeyOf(parsed).action.subKey ?? '', token });
    }
    if (confirms.length === 0) return NONE;

    if (confirms.some((confirm) => !isAnswerableContext(confirm.context))) {
        return { kind: 'supersede', reason: 'button_only' };
    }

    const contexts = new Set(confirms.map((confirm) => confirm.context));
    const yes = confirms.filter((confirm) => confirm.verb === 'yes');
    const no = confirms.filter((confirm) => confirm.verb === 'no');
    if (contexts.size !== 1 || yes.length !== 1 || no.length !== 1) {
        return { kind: 'supersede', reason: 'not_a_pair' };
    }

    // Only `text` and `choice` carry buttons, and both carry `text`.
    const text = 'text' in intent && typeof intent.text === 'string' ? intent.text : '';

    return {
        kind: 'record',
        question: {
            context: yes[0].context as AnswerableQuestionContext,
            yesToken: yes[0].token,
            noToken: no[0].token,
            questionText: clipQuestionText(text),
            askedAt: now.toISOString(),
        },
    };
}

/** Does this stored token still say what the record says it is? */
function tokenMatches(token: unknown, verb: 'yes' | 'no', context: string): token is string {
    if (typeof token !== 'string') return false;
    const parsed = parseBotActionId(token);
    return parsed !== null && parsed.verb === verb && actionKeyOf(parsed).action.subKey === context;
}

/**
 * Read a stored record back, refusing anything this service would not have written.
 *
 * Null for a malformed record, a record for another account, an unanswerable context, a token
 * that no longer parses to its own context, and a question older than the TTL — one bucket, whose
 * answer is always "there is no question waiting". The expiry is re-checked here for the reason
 * `product-display.store.ts` gives: a key that outlives its `EX` must not resurrect a question.
 */
export function readPendingQuestion(
    raw: string | null,
    owner: PendingQuestionOwner,
    now: Date,
): BotPendingQuestion | null {
    if (!raw) return null;

    let record: Record<string, unknown>;
    try {
        record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!record || typeof record !== 'object') return null;
    if (record.owner !== owner.userId) return null;

    const context = record.context;
    if (!isAnswerableContext(context)) return null;
    if (!tokenMatches(record.yesToken, 'yes', context) || !tokenMatches(record.noToken, 'no', context)) return null;

    const askedAt = typeof record.askedAt === 'string' ? Date.parse(record.askedAt) : NaN;
    if (!Number.isFinite(askedAt)) return null;
    if (now.getTime() - askedAt > PENDING_QUESTION_TTL_SECONDS * 1000) return null;

    return {
        context,
        yesToken: record.yesToken as string,
        noToken: record.noToken as string,
        questionText: typeof record.questionText === 'string' ? record.questionText : '',
        askedAt: new Date(askedAt).toISOString(),
    };
}

/** The stored form: the question plus the account it was drawn for. */
export function serializePendingQuestion(owner: PendingQuestionOwner, question: BotPendingQuestion): string {
    return JSON.stringify({ ...question, owner: owner.userId });
}

/**
 * The token a typed answer runs — or null, which the caller turns into the no-question refusal.
 *
 * ⛔ **Re-checks the context on the way OUT**, although nothing unanswerable is ever recorded. The
 * record is JSON in a cache an operator can reach; this is the line that makes "a typed word never
 * closes an account" true of what RUNS, not only of what was written.
 */
export function tokenForAnswer(question: BotPendingQuestion, answer: 'yes' | 'no'): string | null {
    if (!isAnswerableContext(question.context)) return null;
    const token = answer === 'yes' ? question.yesToken : question.noToken;
    return tokenMatches(token, answer, question.context) ? token : null;
}

/**
 * What the model is shown on `/identity/sync` — the context, the words and when. ⛔ Never a token.
 *
 * A token carries a confirm ref or a checkout credential; in a model's context it is a string the
 * model could echo into a tool argument. The model does not need it: `chat_answer_question` takes
 * only `yes` or `no`.
 */
export interface BotPendingQuestionView {
    context: AnswerableQuestionContext;
    text: string;
    askedAt: string;
}

export function pendingQuestionView(question: BotPendingQuestion | null): BotPendingQuestionView | null {
    if (!question) return null;
    return { context: question.context, text: question.questionText, askedAt: question.askedAt };
}

/**
 * THE refusal for an answer with no question to answer — none drawn, the fifteen minutes passed,
 * a tap already answered it, or the one waiting is a question a word may not answer.
 *
 * ⚠ **409, so it derives `conflict`** — the conversation's state is not what the call assumed —
 * and `bot-recovery-actions.ts` offers no button for that category, which is right here: the honest
 * remedy is to tap the question's own button if there is one, and the sentence says so.
 */
export function noPendingQuestion() {
    return createAppError(
        ERROR_CODES.BOT_NO_PENDING_QUESTION,
        409,
        'There is no yes/no question waiting for an answer in this conversation',
    );
}

/** What `answerTokenFor` needs from the store: take the question, atomically, or nothing. */
export interface PendingQuestionTaker {
    take(owner: PendingQuestionOwner): Promise<BotPendingQuestion | null>;
}

/**
 * Take the waiting question and return the token the answer runs — or throw the refusal.
 *
 * ⚠ **TAKEN, not read.** An answered question is gone before its handler runs, exactly as a tap
 * clears it, so a second "yes" a moment later cannot run the same token twice. Whatever the handler
 * draws next — a fresh confirmation for a stale checkout, say — is recorded as a new question.
 */
export async function answerTokenFor(
    store: PendingQuestionTaker,
    owner: PendingQuestionOwner,
    answer: 'yes' | 'no',
): Promise<string> {
    const question = await store.take(owner);
    const token = question ? tokenForAnswer(question, answer) : null;
    if (!token) throw noPendingQuestion();
    return token;
}
