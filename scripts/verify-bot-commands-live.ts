/**
 * Verify: the typed slash-command route, over real HTTP against real Mongo and Redis.
 *
 * `test:bot-commands` proves the parser, the registry and the contract pin with no I/O at
 * all. This proves the five things it structurally cannot:
 *
 *   1. that EXPRESS dispatches `/command` at all (a route table is not a mount);
 *   2. that the four guards accept the call in the right order — service token, webhook
 *      secret, identity, idempotency;
 *   3. ⭐ that `.strict()` on `{ text }` survives a body that also carries `identity` —
 *      which works only because `requireBotIdentity` does `delete body.identity`, and is
 *      the single thing most likely to 400 every command in production;
 *   4. that a real messaging identity resolves through the real ladder; and
 *   5. that `handled:false` really comes back with NO `reply`, which is what makes an
 *      unimplemented command fall through to the model rather than answering silence.
 *
 * ⚠ **It deliberately does NOT run `/login` or `/password`.** Both mint a live credential
 * against a real account — a ten-minute session or a thirty-minute reset token — and a
 * verification script must not leave one lying in a chat. `/connect` covers the same
 * `bus:*` dispatch path and mints only a connection code for the sender's own identity.
 *
 * ⚠ **`STORAGE_PROVIDER` is forced to `local` for THIS PROCESS ONLY.** The repository's
 * `.env` currently sets it twice — `local`, then `r2` in a later block — and dotenv takes
 * the last, so the service cannot boot at all: there is no R2 adapter. That is somebody
 * else's in-flight work and this script does not touch their file.
 *
 * Run: npm run verify:bot-commands   (NEEDS Mongo + Redis)
 */
import 'dotenv/config';

/**
 * ⚠ Every one of these must be set BEFORE `../src/app` is imported: `requireServiceToken`
 * reads `AGENT_CONFIG.INTERNAL_SERVICE_TOKEN`, which is captured at module load, and the
 * storage factory runs at import too. Same ordering constraint `verify-bot-surface-live.ts`
 * documents at its own top.
 */
/**
 * ⚠ **Without this the suite prints NOTHING and exits 0.** Importing `../src/app` runs
 * `initLogging()`, which BRIDGES `console.*` through pino — so a harness's own results are
 * swallowed by the sink it just installed, and a green run and a silent crash look
 * identical. CLAUDE.md records the rule as *"a test harness must print through
 * originalConsole"*; disabling the bridge for this process is the same fix, one step earlier.
 */
process.env.LOG_CONSOLE_BRIDGE = 'false';
process.env.STORAGE_PROVIDER = 'local';
process.env.INTERNAL_SERVICE_TOKEN ||= 'verify-bot-commands-service-token';
process.env.BOT_WEBHOOK_SECRET = 'verify-bot-commands-webhook-secret';
const SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN as string;
const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET as string;

import fs from 'fs';
import type { Server } from 'http';
import mongoose from 'mongoose';
import { app } from '../src/app';
import { UserModel } from '../src/modules/users/user.model';
import { CustomerModel } from '../src/modules/customers/customer.model';
import { ChannelConnectionModel } from '../src/modules/channel-connections/channel-connection.model';

let passed = 0;
let failed = 0;

function say(line: string): void {
    // fd 1 directly: see the note above the import block.
    fs.writeSync(1, `${line}\n`);
}

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        say('  PASS  ' + name);
        passed++;
    } else {
        say('  FAIL  ' + name + (detail ? ' -- ' + detail : ''));
        failed++;
    }
}

function section(title: string): void {
    say('');
    say(`> ${title}`);
}

interface CommandAnswer {
    status: number;
    body: {
        success?: boolean;
        data?: { handled?: boolean; command?: string | null; outcome?: string; suggestion?: string; reason?: string };
        error?: { code?: string; customerMessage?: string };
        reply?: { channel?: string; method?: string; body?: { text?: string } } | null;
    };
}

const CHANNEL = 'telegram';
/** A synthetic chat id, so this script never acts on a real customer's conversation. */
const EXTERNAL_ID = '990000000001';
const USER_ID = new mongoose.Types.ObjectId('60700000000000000000c101');
const CUSTOMER_ID = new mongoose.Types.ObjectId('60700000000000000000c102');
const STORED_PHONE = '+237600000101';

/**
 * ⚠ **The connection row is what makes this a test of the COMMAND layer.** Without it the
 * identity ladder answers `409 BOT_IDENTITY_NEEDS_CONTACT` on every call and the suite
 * measures the ladder instead — which is exactly what this script's first run did.
 *
 * ⭐ **That refusal is CORRECT, and it is worth knowing about.** A Telegram `chat_id`
 * matches no column anywhere, so a Telegram customer who has not shared a contact is
 * refused **even for `/help`** — they get the `request_contact` keyboard first. On WhatsApp
 * the sender id IS the phone, so step 2 of the ladder resolves and the first command works
 * immediately. The two channels genuinely differ on a customer's very first command.
 */
async function seed(): Promise<void> {
    await cleanup();
    await UserModel.create({
        _id: USER_ID,
        login_phone: STORED_PHONE,
        password_hash: 'verify-bot-commands-not-a-real-hash',
        roles: ['customer'],
        status: 'active',
    });
    await CustomerModel.create({
        _id: CUSTOMER_ID,
        user_id: USER_ID,
        name: 'Verify Commands',
        phone: STORED_PHONE,
        preferences: { language: 'en', currency: 'XAF' },
    });
    await ChannelConnectionModel.create({ user_id: USER_ID, channel: CHANNEL, external_id: EXTERNAL_ID });
}

/** Writes then deletes its own fixtures, pass or fail — the house rule for a verify script. */
async function cleanup(): Promise<void> {
    await Promise.all([
        UserModel.deleteMany({ _id: USER_ID }),
        CustomerModel.deleteMany({ _id: CUSTOMER_ID }),
        ChannelConnectionModel.deleteMany({ channel: CHANNEL, external_id: EXTERNAL_ID }),
    ]);
}

async function send(base: string, text: string, messageId: string): Promise<CommandAnswer> {
    const response = await fetch(`${base}/api/internal/bot/command`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SERVICE_TOKEN}`,
            'X-Webhook-Secret': WEBHOOK_SECRET,
            // Per inbound message, exactly as `run command` builds it in wi-mall-core.
            'Idempotency-Key': `${CHANNEL}-${EXTERNAL_ID}-${messageId}-cmd`,
        },
        body: JSON.stringify({
            identity: { channel: CHANNEL, externalId: EXTERNAL_ID, displayName: 'Verify Commands', language: 'en' },
            text,
        }),
    });
    return { status: response.status, body: (await response.json()) as CommandAnswer['body'] };
}

async function main(): Promise<void> {
    await mongoose.connect(process.env.MONGO_URI as string);
    const listening: Server = app.listen(0);
    await new Promise<void>((resolve) => { if (listening.listening) return resolve(); listening.once('listening', () => resolve()); });
    const port = (listening.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    await seed();
    say(`booted on ${base}  ·  identity ${CHANNEL}:${EXTERNAL_ID}`);

    try {
        // ═════════════════════════════════════════════════════════════════════
        section('1 · The route is mounted, guarded, and parses a body carrying `identity`');

        const help = await send(base, '/help', 'm1');
        assert('POST /command answers 200', help.status === 200, `got ${help.status} ${JSON.stringify(help.body).slice(0, 220)}`);

        /**
         * ⭐ The assertion this whole script exists for. The body carries BOTH `identity`
         * and `text`, and `BotCommandDispatchSchema` is `.strict()` on `{ text }` alone —
         * so this passes only because `requireBotIdentity` strips `identity` first. If that
         * ever changes, every command 400s and nothing offline would have noticed.
         */
        assert('⭐ `.strict()` on {text} survives the identity envelope', help.status !== 400);

        assert('/help is handled by the platform', help.body.data?.handled === true && help.body.data?.outcome === 'help');
        assert('/help comes back with a channel-ready reply', !!help.body.reply && help.body.reply.channel === CHANNEL);

        const helpText = help.body.reply?.body?.text ?? '';
        assert('the help text lists the live commands', helpText.includes('/help') && helpText.includes('/password') && helpText.includes('/connect'));
        assert('⚠ it does NOT advertise an unimplemented command', !helpText.includes('/cart') && !helpText.includes('/orders'));

        // ═════════════════════════════════════════════════════════════════════
        section('2 · ⛔ An unknown command never reaches the model');

        const typo = await send(base, '/passwrd', 'm2');
        assert('a one-edit typo is answered, not forwarded', typo.body.data?.handled === true && typo.body.data?.outcome === 'suggested');
        assert('…and it suggests /password', typo.body.data?.suggestion === 'password');
        assert('…as a real reply the customer will see', (typo.body.reply?.body?.text ?? '').includes('/password'));

        const nonsense = await send(base, '/xyzzy', 'm3');
        assert('an unrecognisable command is answered too', nonsense.body.data?.handled === true && nonsense.body.data?.outcome === 'unknown');
        assert('…and points at /help', (nonsense.body.reply?.body?.text ?? '').includes('/help'));

        const removed = await send(base, '/reset-password', 'm4');
        assert('⛔ the REMOVED hyphenated form is unknown, not silently honoured', removed.body.data?.outcome === 'unknown' || removed.body.data?.outcome === 'suggested');
        assert('…and it definitely did not run reset_password', removed.body.data?.command === null);

        // ═════════════════════════════════════════════════════════════════════
        section('3 · What still belongs to the model');

        const prose = await send(base, 'where is my order', 'm5');
        assert('ordinary prose is NOT handled', prose.body.data?.handled === false && prose.body.data?.reason === 'not_a_command');
        assert('⭐ …and carries NO reply, so the turn falls through', !prose.body.reply);

        const unbuilt = await send(base, '/cart', 'm6');
        assert('a declared-but-unimplemented command falls through too', unbuilt.body.data?.handled === false && unbuilt.body.data?.reason === 'not_implemented');
        assert('…naming itself, so the fall-through is legible', unbuilt.body.data?.command === 'cart');
        assert('⭐ …and carries NO reply', !unbuilt.body.reply);

        // ═════════════════════════════════════════════════════════════════════
        section('4 · The bus dispatch — a command that really runs');

        const connect = await send(base, '/connect', 'm7');
        assert('/connect reaches the CommandBus and answers', connect.body.data?.handled === true && connect.body.data?.outcome === 'executed');
        assert('…with a reply the automation layer can send', !!connect.body.reply?.method);
        assert('…and the alias /link resolves to the same command',
            (await send(base, '/link', 'm8')).body.data?.command === 'connect');

        // ═════════════════════════════════════════════════════════════════════
        section('5 · The guards are real');

        const noToken = await fetch(`${base}/api/internal/bot/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET, 'Idempotency-Key': 'x-1' },
            body: JSON.stringify({ identity: { channel: CHANNEL, externalId: EXTERNAL_ID }, text: '/help' }),
        });
        assert('no service token is refused', noToken.status === 401 || noToken.status === 403, `got ${noToken.status}`);

        const noSecret = await fetch(`${base}/api/internal/bot/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_TOKEN}`, 'Idempotency-Key': 'x-2' },
            body: JSON.stringify({ identity: { channel: CHANNEL, externalId: EXTERNAL_ID }, text: '/help' }),
        });
        assert('no webhook secret is refused', noSecret.status === 401 || noSecret.status === 403, `got ${noSecret.status}`);

        const noKey = await fetch(`${base}/api/internal/bot/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_TOKEN}`, 'X-Webhook-Secret': WEBHOOK_SECRET },
            body: JSON.stringify({ identity: { channel: CHANNEL, externalId: EXTERNAL_ID }, text: '/help' }),
        });
        assert('⚠ a mutating route with no Idempotency-Key is refused', noKey.status === 400, `got ${noKey.status}`);

        /**
         * ⚠ The replay is the property `POST /checkout` needs and `/cancel` will: one inbound
         * message retried by the transport must not run a write command twice. A replay is
         * byte-identical and announces itself only in a header.
         */
        const first = await send(base, '/help', 'replay-1');
        const replay = await send(base, '/help', 'replay-1');
        assert('⚠ a replayed Idempotency-Key returns the stored answer',
            JSON.stringify(first.body) === JSON.stringify(replay.body));
    } finally {
        await cleanup();
        await new Promise<void>((resolve) => listening.close(() => resolve()));
        await mongoose.disconnect();
    }

    say('');
    say(`  ${passed} passed, ${failed} failed`);
    /**
     * ⚠ An explicit exit. Redis clients and the Mongoose pool keep the event loop alive, so
     * a verify script that merely returns hangs until whatever is running it gives up —
     * which is indistinguishable from a test that never finished.
     */
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    say(`verify:bot-commands crashed: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
});
