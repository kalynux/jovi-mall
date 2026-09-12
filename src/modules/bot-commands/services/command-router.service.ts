import { commandBus } from '../../command-bus/instance';
import { commandReplyIntent } from '../../command-bus/command-reply';
import { BotReplyIntent } from '../../bot-surface/domain/channel-reply';
import { MessagingChannel } from '../../channel-connections';
import { commandDescription, commandSentence } from '../domain/command-copy';
import { COMMANDS, CommandSpec, CANONICAL_COMMAND_NAMES, LIVE_COMMANDS } from '../domain/command-registry';
import { parseCommand } from '../domain/command-parser';
import { suggestCommand } from '../domain/command-suggest';

/**
 * One typed message in, one decision out.
 *
 * ── THREE OUTCOMES, AND THE MIDDLE ONE IS THE INTERESTING ONE ───────────────
 *   `answered`   — the platform said something. The controller sets it as the reply intent.
 *   `to_model`   — hand this turn to the AI agent, exactly as today.
 *   (there is no third; an unknown command is `answered`, with a suggestion.)
 *
 * ⚠ **A KNOWN command with no handler yet is `to_model`, and an UNKNOWN one never is.**
 * That distinction is the whole safety property. `commands.json` states it in one line —
 * *"a typo'd /cancel must not become a cancellation"* — and it is about a word that names
 * NOTHING. `/cart` names something real that this phase has not built; sending it to the
 * model is what already happens today, so treating it as unknown would be a regression on
 * behaviour customers currently have.
 */

export type CommandOutcome =
    | { kind: 'answered'; command: string | null; intent: BotReplyIntent; data: CommandAnswerData }
    | { kind: 'to_model'; reason: 'not_a_command' | 'not_implemented'; command: string | null };

export interface CommandAnswerData {
    /** The canonical name, or null when nothing matched. */
    command: string | null;
    /** What the platform did. `unknown` and `suggested` never ran anything. */
    outcome: 'executed' | 'suggested' | 'unknown' | 'help' | 'welcome';
    /** Present only on `suggested`. */
    suggestion?: string;
}

/**
 * Who sent it. The channel and id come from the RESOLVED caller; the two cosmetic fields
 * come from the envelope and are trusted for nothing — see the controller.
 */
export interface CommandSender {
    channel: MessagingChannel;
    externalId: string;
    displayName: string | null;
    handle: string | null;
}

export interface CommandRouterInput {
    text: string;
    sender: CommandSender;
    /** The resolved caller's language. */
    language: string | null;
}

export class CommandRouterService {
    async route(input: CommandRouterInput): Promise<CommandOutcome> {
        const parsed = parseCommand(input.text, COMMANDS);

        if (parsed.kind === 'not_a_command') {
            return { kind: 'to_model', reason: 'not_a_command', command: null };
        }

        if (parsed.kind === 'unknown') {
            return this.refuseUnknown(parsed.typed, input.language);
        }

        const spec = COMMANDS.find((command) => command.name === parsed.name);
        if (!spec || spec.handler === null) {
            return { kind: 'to_model', reason: 'not_implemented', command: parsed.name };
        }

        return this.dispatch(spec, input);
    }

    /**
     * ⚠ **The suggestion is offered, never executed.** Answering `/cancle ORD-…` by running
     * `/cancel` on the customer's behalf is exactly the failure the rule exists to prevent —
     * an edit distance is a guess, and a guess must not cancel an order.
     */
    private refuseUnknown(typed: string, language: string | null): CommandOutcome {
        const suggestion = suggestCommand(typed, CANONICAL_COMMAND_NAMES);

        if (suggestion) {
            return {
                kind: 'answered',
                command: null,
                intent: {
                    kind: 'text',
                    text: commandSentence('didYouMean', language).replace('{{suggestion}}', `/${suggestion}`),
                },
                data: { command: null, outcome: 'suggested', suggestion },
            };
        }

        return {
            kind: 'answered',
            command: null,
            intent: { kind: 'text', text: commandSentence('unknownCommand', language) },
            data: { command: null, outcome: 'unknown' },
        };
    }

    private async dispatch(spec: CommandSpec, input: CommandRouterInput): Promise<CommandOutcome> {
        if (spec.handler === 'help') {
            return {
                kind: 'answered',
                command: spec.name,
                intent: { kind: 'text', text: this.renderHelp(input.language) },
                data: { command: spec.name, outcome: 'help' },
            };
        }

        if (spec.handler === 'start') {
            return {
                kind: 'answered',
                command: spec.name,
                intent: { kind: 'text', text: commandSentence('welcome', input.language) },
                data: { command: spec.name, outcome: 'welcome' },
            };
        }

        return this.dispatchToBus(spec, input);
    }

    /**
     * Run one of the four handlers that have been on the `CommandBus` since 2026-08-16 and
     * that nothing typed could reach until now.
     *
     * ⚠ **The context is built the way `telegram.controller.ts` builds it, from the ENVELOPE
     * and never from anything a caller chose.** `resolveSender` reads `chat_id` /
     * `wa_phone_id` off it, and on `/login` a caller-supplied identity is outright account
     * takeover — the mistake the deleted `link` command made one layer down. The envelope
     * here comes from the sealed identity the bot surface already resolved, so the handler
     * cannot tell which door it came through and the rule holds on both.
     */
    private async dispatchToBus(spec: CommandSpec, input: CommandRouterInput): Promise<CommandOutcome> {
        const busName = spec.handler!.slice('bus:'.length);
        const { channel, externalId, displayName, handle } = input.sender;

        const context =
            channel === 'telegram'
                ? { source: 'telegram', chat_id: externalId, user_id: externalId }
                : { source: 'whatsapp', wa_phone_id: externalId };

        const payload = {
            ...(displayName ? { name: displayName } : {}),
            ...(handle ? { username: handle } : {}),
        };

        const result = await commandBus.execute<Record<string, unknown>>(busName, payload, context);

        /**
         * ⚠ **A refusal is an ANSWER here, not an error.** Every one of these handlers returns
         * `{ success: false, message }` for the ordinary outcomes — no account, not a
         * customer, suspended — because the person has to be told, and a thrown error would
         * reach the automation layer's failure branch and reach them as silence. Only the
         * contact-share guard throws, and that one is meant to.
         */
        const intent = commandReplyIntent(result, input.language);

        if (!intent) {
            // A handler that answered with no message has nothing to say; let the model speak
            // rather than sending an empty bubble.
            return { kind: 'to_model', reason: 'not_implemented', command: spec.name };
        }

        return {
            kind: 'answered',
            command: spec.name,
            intent,
            data: { command: spec.name, outcome: 'executed' },
        };
    }

    /**
     * `/help`, built FROM THE REGISTRY.
     *
     * ⚠ **This is the one command whose content is the registry itself**, which is what stops
     * it drifting: a help text maintained by hand is a list that is wrong the first time
     * somebody adds a command and forgets it, and a customer reading a stale list concludes
     * the missing one does not exist. Only commands with a handler appear — advertising a
     * command that falls through to the model would be advertising a coincidence.
     */
    private renderHelp(language: string | null): string {
        const lines = LIVE_COMMANDS.map((command) => {
            const description = commandDescription(command.name, language);
            return description ? `/${command.name} — ${description}` : `/${command.name}`;
        });

        return [
            commandSentence('helpIntro', language),
            '',
            ...lines,
            '',
            commandSentence('helpOutro', language),
        ].join('\n');
    }
}

export const commandRouterService = new CommandRouterService();
