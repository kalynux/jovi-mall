/**
 * Customer onboarding, as seen from a chat window — the whole of GAP-002's state, pure.
 *
 * ── WHY THE STATE HAS TO EXIST AT ALL ────────────────────────────────────────
 * The account is created on the sender's FIRST message and nobody is asked first, so it is
 * created knowing almost nothing about the person: a messaging identifier, and a profile
 * name the channel happened to attach. Everything else has to be collected one turn at a
 * time, inside a conversation the customer opened to ask about a product.
 *
 * That makes "what is still missing, and what did they already decline" a durable fact
 * rather than a derivation. Deriving it from field presence — the way every ROLE onboarding
 * in this service does (`core/constants/onboarding-steps.ts`) — cannot distinguish
 * **"no email yet"** from **"asked, and they said no"**, so a null email would make the bot
 * ask for one on every single message forever. The `skipped` state is the entire reason
 * this is stored rather than computed.
 *
 * ── IT IS A SEPARATE AXIS FROM `Customer.onboarding_step`, DELIBERATELY ──────
 * That field is `max: 0` and is the number `auth-me` reports so a DASHBOARD knows where to
 * route; its comment ("Always 0 for customers — no onboarding flow") stays true, because a
 * customer still has no dashboard onboarding. This is a chat-collection checklist, and
 * reusing the number would make a web session believe a customer was mid-onboarding and
 * route them to a screen that does not exist.
 *
 * ── THIS FILE IMPORTS NOTHING ────────────────────────────────────────────────
 * No Mongoose, no Express, no Zod. The Customer schema's `enum` is SPREAD from the
 * declarations below rather than typed beside them — the rule every notification stack
 * follows, and for the reason the agent stack learned the hard way: two hand-kept copies of
 * one vocabulary drift, and the drift here would be a `ValidationError` on a write nobody
 * is watching. `test:bot-surface` drives every function below with no database.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **ORDER IS THE ASK ORDER, and `phone` is first for a reason that is not politeness.**
 *
 * A Telegram `chat_id` bears no relation to any phone number, so a first-time Telegram
 * sender has NO ACCOUNT YET and there is nowhere to record anything about them. The only
 * step that can be actioned in that state is the one that establishes the account — so it
 * has to come first, or the anonymous case would need a special-cased `next` contradicting
 * this list.
 *
 * On WhatsApp the sender id IS the number, so the step is already satisfied the moment the
 * account exists and the customer never sees it. One ordered list, two channels, no branch.
 *
 * `name` is REQUIRED but pre-filled from the messaging profile, so the ask is a
 * confirmation rather than an interrogation. `email` and `address` are skippable: a person
 * who messaged a shop to ask a price is entitled to decline both, and checkout collects a
 * delivery address of its own accord when the time comes.
 */
export const BOT_ONBOARDING_STEPS = Object.freeze([
    Object.freeze({ step: 'phone', required: true }),
    Object.freeze({ step: 'name', required: true }),
    Object.freeze({ step: 'email', required: false }),
    Object.freeze({ step: 'address', required: false }),
] as const);

export type BotOnboardingStep = (typeof BOT_ONBOARDING_STEPS)[number]['step'];

/** The vocabulary the Mongoose `enum` is spread from. Never type the literals twice. */
export const BOT_ONBOARDING_STEP_VALUES: readonly BotOnboardingStep[] = Object.freeze(
    BOT_ONBOARDING_STEPS.map((s) => s.step),
) as readonly BotOnboardingStep[];

/**
 * `pending` has never been answered · `provided` carries a value · `skipped` was declined.
 *
 * The last two are both "done" and are NOT interchangeable anywhere a human reads them:
 * `provided` means the platform holds the fact, `skipped` means the customer said no and
 * must not be asked again. Collapsing them into a boolean is how "we have no email" and
 * "they refused an email" become the same sentence.
 */
export const BOT_ONBOARDING_STATES = Object.freeze(['pending', 'provided', 'skipped'] as const);
export type BotOnboardingStepState = (typeof BOT_ONBOARDING_STATES)[number];

/** One step's answer, as persisted. */
export interface BotOnboardingRecord {
    step: BotOnboardingStep;
    state: BotOnboardingStepState;
    /** When it left `pending`. Null while it never has. */
    at: Date | null;
}

/** What the caller must collect for a step, described rather than worded. */
export type BotOnboardingInputKind =
    /** Telegram `request_contact`. On WhatsApp this step is satisfied before it is asked. */
    | 'phone_contact'
    | 'text'
    | 'email'
    /** A `candidateRef` from `/geo/search` or `/geo/reverse` — never coordinates (GAP-005). */
    | 'geo_candidate';

export interface BotOnboardingNext {
    step: BotOnboardingStep;
    required: boolean;
    skippable: boolean;
    /** The field name to send back on `POST /identity/onboarding`. */
    field: string;
    kind: BotOnboardingInputKind;
}

/**
 * What each step accepts. **Descriptors, never copy.**
 *
 * The sentence the customer reads is the automation layer's to write, in the customer's own
 * language — and at first contact `preferences.language` has only just been guessed. What
 * this service owes the caller is the machine-readable half — which field, of what kind,
 * refusable or not — so a flow cannot ask for an email and post it as a name.
 */
const INPUT: Readonly<Record<BotOnboardingStep, { field: string; kind: BotOnboardingInputKind }>> =
    Object.freeze({
        phone: { field: 'contact', kind: 'phone_contact' },
        name: { field: 'name', kind: 'text' },
        email: { field: 'email', kind: 'email' },
        address: { field: 'address', kind: 'geo_candidate' },
    });

// ─────────────────────────────────────────────────────────────────────────────
// Derivations
// ─────────────────────────────────────────────────────────────────────────────

export function isOnboardingStep(value: unknown): value is BotOnboardingStep {
    return typeof value === 'string'
        && BOT_ONBOARDING_STEP_VALUES.includes(value as BotOnboardingStep);
}

export function isRequiredStep(step: BotOnboardingStep): boolean {
    return BOT_ONBOARDING_STEPS.find((s) => s.step === step)?.required ?? false;
}

/**
 * The stored answers, completed into the full ordered checklist.
 *
 * A step with no row reads `pending`, which is what makes ADDING a step to the list above a
 * one-line change rather than a migration: every existing customer reads as not-yet-asked
 * for it, which is exactly true. An unrecognised stored step — one REMOVED from the list
 * later — is dropped rather than surfaced, so retiring a step cannot strand a customer on a
 * question nobody can answer any more.
 */
export function normalizeOnboarding(
    stored: readonly BotOnboardingRecord[] | null | undefined,
): BotOnboardingRecord[] {
    const byStep = new Map<BotOnboardingStep, BotOnboardingRecord>();
    for (const row of stored ?? []) {
        if (row && isOnboardingStep(row.step)) byStep.set(row.step, row);
    }

    return BOT_ONBOARDING_STEPS.map(({ step }) => {
        const row = byStep.get(step);
        const state = row && BOT_ONBOARDING_STATES.includes(row.state) ? row.state : 'pending';
        return { step, state, at: row?.at ?? null };
    });
}

/** The first unanswered step, in list order, or null when nothing is outstanding. */
export function nextOnboardingStep(
    records: readonly BotOnboardingRecord[],
): BotOnboardingNext | null {
    const pending = records.find((r) => r.state === 'pending');
    if (!pending) return null;

    const required = isRequiredStep(pending.step);
    return {
        step: pending.step,
        required,
        skippable: !required,
        ...INPUT[pending.step],
    };
}

/**
 * Complete ⟺ nothing is pending AND every required step was actually PROVIDED.
 *
 * The second clause is not redundant with the first. A required step can only leave
 * `pending` by being provided — `applyOnboardingStep`'s caller refuses to skip one — but
 * stating the invariant here means a row written by anything else (a fixture, a future
 * admin repair, a migration) cannot make an account look finished while its phone number is
 * missing. The cheap check goes on the side that cannot be wrong.
 */
export function isOnboardingComplete(records: readonly BotOnboardingRecord[]): boolean {
    return records.every((r) => r.state !== 'pending')
        && records.every((r) => !isRequiredStep(r.step) || r.state === 'provided');
}

/** Required steps still unprovided — what stands between this account and `complete`. */
export function outstandingRequired(
    records: readonly BotOnboardingRecord[],
): BotOnboardingStep[] {
    return records
        .filter((r) => isRequiredStep(r.step) && r.state !== 'provided')
        .map((r) => r.step);
}

/**
 * Apply one answer, returning a NEW list.
 *
 * Pure, and it takes the clock as a parameter rather than calling `new Date()` — the same
 * discipline `availability-windows.util.ts` follows, so the whole state machine is
 * assertable without freezing time.
 *
 * **Providing is allowed on any step in any state.** A customer who skipped their email in
 * January and offers it in March must be able to; refusing would make `skipped` a one-way
 * door on a field the person owns. **Skipping a REQUIRED step is refused by the caller**
 * (`BOT_ONBOARDING_STEP_NOT_SKIPPABLE`) rather than silently ignored here — a flow that
 * believes it skipped the phone number will never ask for it again.
 */
export function applyOnboardingStep(
    records: readonly BotOnboardingRecord[],
    step: BotOnboardingStep,
    state: Exclude<BotOnboardingStepState, 'pending'>,
    now: Date,
): BotOnboardingRecord[] {
    return normalizeOnboarding(records).map((row) =>
        row.step === step ? { step, state, at: now } : row,
    );
}

/**
 * The checklist an account starts life with.
 *
 * `satisfied` names the steps already true at creation — on WhatsApp that is `phone`,
 * because the sender id IS the number and the inbound message is the proof. Passing it here
 * rather than patching afterwards means a freshly created account is never briefly
 * described as needing something it does not.
 */
export function seedOnboarding(
    satisfied: readonly BotOnboardingStep[],
    now: Date,
): BotOnboardingRecord[] {
    return BOT_ONBOARDING_STEPS.map(({ step }) =>
        satisfied.includes(step)
            ? { step, state: 'provided' as const, at: now }
            : { step, state: 'pending' as const, at: null },
    );
}
