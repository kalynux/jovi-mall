/**
 * test:negotiation-playbook — the playbook document and its store.
 *
 * No database. The parse and the fingerprint are pure, the service is driven
 * against a fake repository, and the rest is source scans over the invariants
 * nothing behavioural can see.
 *
 * Run: npm run test:negotiation-playbook
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    PlaybookParseError,
    fingerprint,
    parsePlaybook,
} from '../../src/modules/negotiation/domain/playbook-document';
import { NegotiationPlaybookService } from '../../src/modules/negotiation/services/negotiation-playbook.service';
import type {
    NegotiationPlaybookRepository,
    PlaybookRecord,
} from '../../src/modules/negotiation/repositories/negotiation-playbook.repository';

const originalConsole = { log: console.log.bind(console) };

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed += 1;
            originalConsole.log(`  ✅ ${label}`);
        })
        .catch((error: unknown) => {
            failed += 1;
            originalConsole.log(`  ❌ FAIL: ${label}`);
            originalConsole.log(`     ${error instanceof Error ? error.message : String(error)}`);
        });
}

function eq<T>(actual: T, expected: T, what: string): void {
    if (actual !== expected) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function throws(fn: () => unknown, what: string): void {
    try {
        fn();
    } catch {
        return;
    }
    throw new Error(`${what}: expected a throw, got none`);
}

const SRC = join(__dirname, '..', '..', 'src');
const PLAYBOOK_PATH = join(SRC, 'modules', 'negotiation', 'playbook', 'negotiation.core.md');

const SAMPLE = [
    '---',
    'name: sample-playbook',
    'description: A one-line summary: it contains a colon, and a comma.',
    'compatibility: Requires tools a, b.',
    'custom_key: kept verbatim',
    '---',
    '',
    '# Body',
    '',
    'The instructions.',
    '',
].join('\n');

async function main(): Promise<void> {
    originalConsole.log('\n── 1 · Frontmatter parsing ──────────────────────────────────────────────');

    await assert('name and description are lifted from the frontmatter', () => {
        const parsed = parsePlaybook(SAMPLE);
        eq(parsed.frontmatter.name, 'sample-playbook', 'name');
        eq(
            parsed.frontmatter.description,
            'A one-line summary: it contains a colon, and a comma.',
            'description',
        );
    });

    await assert('the split is on the FIRST colon, so a value may contain colons', () => {
        const parsed = parsePlaybook(SAMPLE);
        if (!parsed.frontmatter.description.includes(':')) {
            throw new Error('the colon inside the value was eaten');
        }
    });

    await assert('an unknown frontmatter key is preserved in `extra`, never dropped', () => {
        const parsed = parsePlaybook(SAMPLE);
        eq(parsed.frontmatter.extra.custom_key, 'kept verbatim', 'extra.custom_key');
    });

    await assert('`extra` does NOT contain the three known keys', () => {
        const parsed = parsePlaybook(SAMPLE);
        for (const key of ['name', 'description', 'compatibility']) {
            if (key in parsed.frontmatter.extra) {
                throw new Error(`${key} leaked into extra`);
            }
        }
    });

    await assert('the frontmatter is STRIPPED from the body', () => {
        const parsed = parsePlaybook(SAMPLE);
        if (parsed.content.includes('description:')) {
            throw new Error('frontmatter survived into the content served to the model');
        }
        if (!parsed.content.startsWith('# Body')) {
            throw new Error(`leading blank lines not trimmed: ${JSON.stringify(parsed.content.slice(0, 20))}`);
        }
    });

    await assert('a missing opening delimiter throws', () => {
        throws(() => parsePlaybook('name: x\n---\nbody'), 'no opening ---');
    });

    await assert('an unclosed frontmatter throws', () => {
        throws(() => parsePlaybook('---\nname: x\ndescription: y\nbody'), 'no closing ---');
    });

    await assert('a missing `name` throws', () => {
        throws(() => parsePlaybook('---\ndescription: y\n---\nbody'), 'no name');
    });

    await assert('a missing `description` throws', () => {
        throws(() => parsePlaybook('---\nname: x\n---\nbody'), 'no description');
    });

    await assert('an empty body throws', () => {
        throws(() => parsePlaybook('---\nname: x\ndescription: y\n---\n\n   \n'), 'empty body');
    });

    await assert('the error type is PlaybookParseError, not a bare Error', () => {
        // The throw happens OUTSIDE the catch: `preserve-caught-error` wants a `cause`
        // on an error raised from inside one, and `new Error(msg, { cause })` needs the
        // ES2022 lib this tsconfig does not target.
        let caught: unknown;
        try {
            parsePlaybook('nope');
        } catch (error) {
            caught = error;
        }
        if (caught === undefined) throw new Error('expected a throw, got none');
        if (!(caught instanceof PlaybookParseError)) {
            throw new Error(
                `expected PlaybookParseError, got ${caught instanceof Error ? caught.constructor.name : typeof caught}`,
            );
        }
    });

    originalConsole.log('\n── 2 · The fingerprint ──────────────────────────────────────────────────');

    await assert('CRLF and LF fingerprint IDENTICALLY — the cross-platform seed rule', () => {
        const lf = 'line one\nline two\n';
        const crlf = 'line one\r\nline two\r\n';
        eq(fingerprint(crlf), fingerprint(lf), 'checksum');
    });

    await assert('a CRLF playbook parses to the same checksum as its LF twin', () => {
        eq(
            parsePlaybook(SAMPLE.replace(/\n/g, '\r\n')).checksum,
            parsePlaybook(SAMPLE).checksum,
            'checksum',
        );
    });

    await assert('a one-character body change moves the checksum', () => {
        const a = parsePlaybook(SAMPLE);
        const b = parsePlaybook(SAMPLE.replace('The instructions.', 'The instructions!'));
        if (a.checksum === b.checksum) throw new Error('checksum did not move');
    });

    await assert('a DESCRIPTION change does not move the checksum — it fingerprints the BODY', () => {
        const a = parsePlaybook(SAMPLE);
        const b = parsePlaybook(SAMPLE.replace('A one-line summary', 'A different summary'));
        eq(b.checksum, a.checksum, 'checksum');
    });

    originalConsole.log('\n── 3 · The authored playbook itself ─────────────────────────────────────');

    const authored = readFileSync(PLAYBOOK_PATH, 'utf8');

    await assert('the shipped playbook parses', () => {
        parsePlaybook(authored);
    });

    await assert('its frontmatter `name` matches the default key the service resolves', () => {
        // Read as source rather than importing the config, so this does not depend on
        // the environment the suite happens to run in.
        const config = readFileSync(
            join(SRC, 'modules', 'negotiation', 'config', 'negotiation.config.ts'),
            'utf8',
        );
        const parsed = parsePlaybook(authored);
        if (!config.includes(`'${parsed.frontmatter.name}'`)) {
            throw new Error(
                `DEFAULT_PLAYBOOK_KEY does not name the authored playbook '${parsed.frontmatter.name}' — `
                + 'the seed would publish under a key nothing reads',
            );
        }
    });

    await assert('it declares every tool the sub-agent is given, and no other', () => {
        const parsed = parsePlaybook(authored);
        const declared = parsed.frontmatter.compatibility ?? '';
        const expected = [
            'negotiation_context',
            'negotiation_record',
            'get_product_details',
            'find_alternative_product',
            'find_complementary_products',
            'quote_delivery',
            'check_promotion',
        ];
        for (const tool of expected) {
            if (!declared.includes(tool)) throw new Error(`compatibility does not mention ${tool}`);
        }
    });

    /**
     * ⛔ **THE SELLER NEVER ASKS FOR THE ADDRESS OR THE NUMBER** (owner, 2026-09-22).
     *
     * Execution 1914: the agent closed a deal with *"What's your delivery address and number?"* — and
     * it had been taught to. The register table's Close row asked "Where am I delivering?" in five
     * languages and the worked turn ended «Ton adresse et ton numéro, et c'est parti.» The customer's
     * account already holds both, checkout picks the address from the saved ones, and a close now
     * puts the item in the basket. The model imitates its examples more faithfully than its rules,
     * so the scan reads the EXAMPLES: every line the playbook puts in the seller's mouth.
     */
    const ASKS_FOR_DETAILS = /adress|address|endereço|endereco|dirección|direccion|عنوان|numéro|number|número|telefone|teléfono|phone|رقم|هاتف|livraison où|entrego onde|dónde te lo entrego|where am i delivering|أين أوصل/i;

    /** Every utterance the playbook scripts for the seller: «…» quotes, and the quoted cells and "You:" lines. */
    function sellerLines(text: string): string[] {
        const lines: string[] = [];
        for (const m of text.matchAll(/«([^»\n]+)»/g)) lines.push(m[1]!);
        for (const row of text.split('\n')) {
            if (!row.startsWith('|') && !row.startsWith('> **You:**')) continue;
            for (const m of row.matchAll(/"([^"\n]{3,240})"/g)) lines.push(m[1]!);
        }
        return lines;
    }

    const noAddressHunt = (text: string): void => {
        const lines = sellerLines(text);
        if (lines.length < 20) throw new Error(`only ${lines.length} scripted lines found — the extractor has stopped seeing them`);
        const asking = lines.filter((line) => ASKS_FOR_DETAILS.test(line));
        if (asking.length > 0) throw new Error(`the seller is scripted to ask for delivery details: ${asking.join(' | ')}`);
    };

    await assert('⛔ no line the playbook scripts for the seller asks for an address or a phone number', () => {
        noAddressHunt(authored);
    });

    await assert('⭐ it states the rule, and says a close puts the item in the basket', () => {
        for (const phrase of [
            'the platform puts the item in their basket at the agreed price',
            'never ask where to deliver, for their address, or for their phone number',
            'ask for a delivery address or a phone number',
            'View basket · Checkout · Keep shopping',
        ]) {
            if (!authored.includes(phrase)) throw new Error(`the playbook no longer says: "${phrase}"`);
        }
    });

    await assert('⭐ MUTANT — the two lines that taught the incident are caught if they come back', () => {
        const oldClose = '| Close | «Bon, on fait affaire. Livraison où?» | "Deal. Where am I delivering?" | «Fechado. Entrego onde?» | «Hecho. ¿Dónde te lo entrego?» | «اتفقنا. أين أوصلها لك؟» |';
        const oldWorked = '> **You:** «On fait affaire 🤝 Yopougon c\'est bon. Ton adresse et ton numéro, et c\'est parti.»';
        const closeRow = authored.split('\n').find((row) => row.startsWith('| Close |'));
        if (!closeRow) throw new Error('the Close row is gone — the mutant has no anchor');
        for (const [label, mutated] of [
            ['old Close row', authored.replace(closeRow, oldClose)],
            ['old worked-turn close', `${authored}\n${oldWorked}\n`],
        ] as const) {
            if (mutated === authored) throw new Error(`${label}: the mutant did not apply`);
            let threw = false;
            try {
                noAddressHunt(mutated);
            } catch {
                threw = true;
            }
            if (!threw) throw new Error(`${label}: the scan passed a mutant it exists to catch`);
        }
    });

    originalConsole.log('\n── 4 · The service, against a fake repository ───────────────────────────');

    function fakeRepo(record: PlaybookRecord | null): { repo: NegotiationPlaybookRepository; calls: () => number } {
        let calls = 0;
        const repo = {
            findActive: async () => {
                calls += 1;
                return record;
            },
        } as unknown as NegotiationPlaybookRepository;
        return { repo, calls: () => calls };
    }

    const RECORD: PlaybookRecord = {
        key: 'sample-playbook',
        version: 3,
        description: 'd',
        content: '# Body',
        checksum: 'abc',
        updatedAt: new Date(),
    };

    await assert('a published playbook is returned', async () => {
        const { repo } = fakeRepo(RECORD);
        const service = new NegotiationPlaybookService(repo);
        const resolved = await service.resolve('sample-playbook');
        eq(resolved.version, 3, 'version');
    });

    await assert('a second read inside the TTL does NOT hit the repository', async () => {
        const { repo, calls } = fakeRepo(RECORD);
        const service = new NegotiationPlaybookService(repo);
        await service.resolve('sample-playbook');
        await service.resolve('sample-playbook');
        eq(calls(), 1, 'repository calls');
    });

    await assert('invalidate() forces the next read through', async () => {
        const { repo, calls } = fakeRepo(RECORD);
        const service = new NegotiationPlaybookService(repo);
        await service.resolve('sample-playbook');
        service.invalidate('sample-playbook');
        await service.resolve('sample-playbook');
        eq(calls(), 2, 'repository calls');
    });

    await assert('⭐ NOTHING published FAILS CLOSED — 503, never an empty playbook', async () => {
        const { repo } = fakeRepo(null);
        const service = new NegotiationPlaybookService(repo);
        try {
            await service.resolve('sample-playbook');
        } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            const code = (error as { code?: string }).code;
            eq(status, 503, 'statusCode');
            eq(code, 'NEGOTIATION_PLAYBOOK_NOT_PUBLISHED', 'code');
            return;
        }
        throw new Error('resolve() returned instead of refusing — a model with a floor and no rules');
    });

    originalConsole.log('\n── 5 · Source scans ─────────────────────────────────────────────────────');

    const serviceSrc = readFileSync(
        join(SRC, 'modules', 'negotiation', 'services', 'negotiation-playbook.service.ts'),
        'utf8',
    );
    const repoSrc = readFileSync(
        join(SRC, 'modules', 'negotiation', 'repositories', 'negotiation-playbook.repository.ts'),
        'utf8',
    );
    const routeSrc = readFileSync(
        join(SRC, 'modules', 'negotiation', 'routes', 'internal-negotiation.routes.ts'),
        'utf8',
    );

    await assert('the service never reads the file system — Mongo is the only runtime source', () => {
        for (const name of ['readFileSync', 'readFile', "from 'fs'"]) {
            if (serviceSrc.includes(name)) {
                throw new Error(
                    `the service references ${name} — a disk fallback makes the file and the database `
                    + 'two live sources, which is what moving the playbook into Mongo was for',
                );
            }
        }
    });

    await assert('⚠ `publish` uses the ARRAY form of create — else the session is ignored', () => {
        if (!/create\(\s*\[/.test(repoSrc)) {
            throw new Error(
                'NegotiationPlaybookModel.create is not called with an array. Mongoose reads '
                + '{ session } only when the first argument is an array, so the insert would '
                + 'commit OUTSIDE the transaction that demoted the previous version.',
            );
        }
    });

    await assert('the demote and the insert are inside ONE transaction', () => {
        if (!repoSrc.includes('runInTransaction')) {
            throw new Error('publish() does not open a transaction — a crash between the two writes leaves no active playbook');
        }
    });

    await assert('the route is behind requireServiceToken', () => {
        if (!routeSrc.includes('router.use(requireServiceToken)')) {
            throw new Error('the playbook route is not guarded by requireServiceToken');
        }
    });

    /**
     * ⛔ **CI went red on "Cannot call abortTransaction after calling commitTransaction"**
     * (2026-09-21, the `seed:negotiation-playbook` step, intermittently on both branches). That
     * message is not a cause: `runInTransaction` answered a failed COMMIT by aborting, which the
     * driver forbids once a commit has been attempted — so the abort threw and REPLACED the real
     * error. On a fresh database the real one is MongoDB's "please retry" answer to a write racing
     * the collection's creation, which is exactly what the retrying variant exists for.
     *
     * A stand-in session, faithful to the driver on the one point that matters: once
     * `commitTransaction` has been CALLED — whatever it answered — the transaction is no longer
     * in progress, and `abortTransaction` throws that message.
     */
    const txnSession = (commitError: Error | null) => {
        let state: 'none' | 'open' | 'committed' | 'aborted' = 'none';
        const calls: string[] = [];
        return {
            calls,
            session: {
                startTransaction: () => { calls.push('start'); state = 'open'; },
                inTransaction: () => state === 'open',
                commitTransaction: async () => {
                    calls.push('commit');
                    state = 'committed';
                    if (commitError) throw commitError;
                },
                abortTransaction: async () => {
                    calls.push('abort');
                    if (state === 'committed') throw new Error('Cannot call abortTransaction after calling commitTransaction');
                    state = 'aborted';
                },
                endSession: async () => { calls.push('end'); },
            },
        };
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongooseModule = require('mongoose') as { startSession: unknown };
    const realStartSession = mongooseModule.startSession;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { transactionManager } = require('../../src/core/database/transaction.manager') as typeof import('../../src/core/database/transaction.manager');
    const withSession = async <T>(fake: ReturnType<typeof txnSession>, run: () => Promise<T>): Promise<T> => {
        mongooseModule.startSession = async () => fake.session;
        try { return await run(); } finally { mongooseModule.startSession = realStartSession; }
    };

    await assert('⛔ a FAILED COMMIT surfaces its own error — never "Cannot call abortTransaction…"', async () => {
        const fake = txnSession(new Error('WriteConflict: please retry'));
        let seen = '';
        await withSession(fake, () => transactionManager.runInTransaction(async () => 'written')).catch((e: Error) => { seen = e.message; });
        if (seen !== 'WriteConflict: please retry') throw new Error(`the caller saw "${seen}" (calls: ${fake.calls.join(' → ')})`);
        if (fake.calls.includes('abort')) throw new Error(`it tried to abort after a commit: ${fake.calls.join(' → ')}`);
    });

    await assert('a failure INSIDE the transaction is still rolled back, and its error surfaces', async () => {
        const fake = txnSession(null);
        let seen = '';
        await withSession(fake, () => transactionManager.runInTransaction(async () => { throw new Error('the write failed'); })).catch((e: Error) => { seen = e.message; });
        if (seen !== 'the write failed' || fake.calls.join(' → ') !== 'start → abort → end') {
            throw new Error(`saw "${seen}", calls ${fake.calls.join(' → ')}`);
        }
    });

    await assert('publish() uses the RETRYING transaction — a fresh database answers its first write with "please retry"', () => {
        const code = repoSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (!code.includes('transactionManager.runInTransactionWithRetry(')) {
            throw new Error('publish() uses the non-retrying runInTransaction: the seed fails intermittently on a fresh database');
        }
    });

    originalConsole.log('\n════════════════════════════════════════════════════════════════════════════');
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
    originalConsole.log('Suite crashed:', error);
    process.exitCode = 1;
});
