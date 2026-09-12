/**
 * Publish the slash-command menu to Telegram.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * **Nothing in this codebase had ever called `setMyCommands`.** Measured live on
 * 2026-09-08, `getMyCommands` on the production bot returned three commands from an
 * unrelated project — `/talk`, `/run`, `/loop`, typo included — and not one wi-mall
 * command. So a customer typing `/` was offered three entries that do nothing, and none of
 * the ones that work.
 *
 * The menu is also what makes a ONE-WORD command safe: Telegram prints the description
 * beside the name everywhere the command appears, so `/password` reads as *"Get a link to
 * set a new password"* rather than as an offer to show one. That pairing is why the
 * owner's short-name decision costs no clarity — and why a command registered without a
 * description would be worse than one not registered at all.
 *
 * ── ⚠ ONE BATCH, ALL OR NOTHING ─────────────────────────────────────────────
 * `setMyCommands` replaces the whole list for a scope. It does not merge, so this script
 * publishes the complete live set every time and a command dropped from the registry
 * disappears from the menu on the next run. An over-long description makes the Bot API
 * reject the **entire** batch — which is why `assertCommandCopyComplete()` caps them at
 * boot rather than leaving it to be discovered here.
 *
 *   npx ts-node scripts/register-telegram-commands.ts            # publish
 *   npx ts-node scripts/register-telegram-commands.ts --dry-run  # print, send nothing
 *   npx ts-node scripts/register-telegram-commands.ts --show     # read back what is live
 */
import 'dotenv/config';
import { BOT_COPY_LANGUAGES } from '../src/modules/bot-surface/domain/bot-error-copy';
import { commandDescription } from '../src/modules/bot-commands/domain/command-copy';
import { LIVE_COMMANDS } from '../src/modules/bot-commands/domain/command-registry';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const API = 'https://api.telegram.org';

interface TelegramCommand {
    command: string;
    description: string;
}

/**
 * ⚠ **The DEFAULT scope carries English and is not the same as the `en` scope.** Telegram
 * serves the default to every client whose language has no explicit list, so publishing
 * only the five named languages would leave a German-speaking customer with an empty menu.
 * English is therefore published twice, deliberately.
 */
function menuFor(language: string | null): TelegramCommand[] {
    return LIVE_COMMANDS.map((command) => {
        const description = commandDescription(command.name, language);
        if (!description) {
            // Unreachable while `assertCommandCopyComplete` runs at boot; loud rather than
            // silently publishing a command with no explanation beside it.
            throw new Error(`[register-telegram-commands] /${command.name} has no description`);
        }
        return { command: command.name, description };
    });
}

async function callBotApi(method: string, body: unknown): Promise<{ ok: boolean; description?: string; result?: unknown }> {
    const response = await fetch(`${API}/bot${TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return (await response.json()) as { ok: boolean; description?: string; result?: unknown };
}

async function main(): Promise<void> {
    const dryRun = process.argv.includes('--dry-run');
    const show = process.argv.includes('--show');

    if (!TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN is not set — nothing to publish to.');
        process.exit(1);
    }

    if (show) {
        for (const language of [null, ...BOT_COPY_LANGUAGES]) {
            const body = language ? { language_code: language } : {};
            const answer = await callBotApi('getMyCommands', body);
            const rows = (answer.result as TelegramCommand[] | undefined) ?? [];
            console.log(`\n${language ?? 'default'}: ${rows.length} command(s)`);
            for (const row of rows) console.log(`  /${row.command} — ${row.description}`);
        }
        return;
    }

    const scopes: { language: string | null; commands: TelegramCommand[] }[] = [
        { language: null, commands: menuFor('en') },
        ...BOT_COPY_LANGUAGES.map((language) => ({ language, commands: menuFor(language) })),
    ];

    for (const scope of scopes) {
        const label = scope.language ?? 'default (en)';

        if (dryRun) {
            console.log(`\n${label}: would publish ${scope.commands.length} command(s)`);
            for (const row of scope.commands) console.log(`  /${row.command} — ${row.description}`);
            continue;
        }

        const answer = await callBotApi('setMyCommands', {
            commands: scope.commands,
            ...(scope.language ? { language_code: scope.language } : {}),
        });

        if (!answer.ok) {
            console.error(`✖ ${label}: ${answer.description ?? 'refused'}`);
            process.exitCode = 1;
            continue;
        }
        console.log(`✔ ${label}: ${scope.commands.length} command(s) published`);
    }

    if (!dryRun) {
        console.log('\nVerify with: npx ts-node scripts/register-telegram-commands.ts --show');
    }
}

/**
 * ⚠ Guarded, for the reason `scripts/migrate.ts` and `admin/scripts/ensure-indexes.ts` are:
 * a suite importing this module for its pure half must not publish a command menu.
 */
if (require.main === module) {
    main().catch((error) => {
        console.error('[register-telegram-commands]', error);
        process.exit(1);
    });
}

export { menuFor };
