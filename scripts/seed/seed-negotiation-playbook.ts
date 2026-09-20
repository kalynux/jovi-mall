/**
 * Seed: the bargaining agent's playbook.
 *
 * Reads the authored SKILL.md at
 * `src/modules/negotiation/playbook/negotiation.core.md`, parses its frontmatter,
 * and publishes the body as the active `negotiation_playbooks` row.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 *
 * The playbook is authored in git — that is what makes it reviewable, diffable
 * and revertible. The running service reads it from MONGO, so a future dashboard
 * can change the wording without a deploy. This script is the one bridge between
 * the two, and it runs in ONE DIRECTION only: nothing ever writes back to the
 * file. A dashboard edit and a git edit therefore cannot drift into two live
 * copies — re-running this is an explicit act that supersedes whatever is live,
 * and the superseded version is kept.
 *
 * ── Idempotent by CHECKSUM, not by upsert ────────────────────────────────────
 *
 * A run whose content fingerprint matches the live row writes nothing and says
 * so. That is what makes it safe to wire into a deploy: publishing a new version
 * on every boot would fill the history with rows nobody authored and would defeat
 * the reason the history exists.
 *
 * ⚠ The fingerprint is taken over LF line endings, so a CRLF checkout on Windows
 * and an LF one on a Linux build host agree. Without that this script would
 * publish a "new version" of an unchanged file every time it moved between them.
 *
 * Run:
 *   npm run seed:negotiation-playbook
 *   npm run seed:negotiation-playbook -- --dry-run
 *   npm run verify:negotiation-playbook        (--check: read-only, exits 1 on drift)
 */
import 'dotenv/config'; // load .env (MONGO_URI etc.) before anything reads it
import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { join } from 'path';

import { parsePlaybook } from '../../src/modules/negotiation/domain/playbook-document';
import { negotiationPlaybookRepository } from '../../src/modules/negotiation/repositories/negotiation-playbook.repository';
import {
    describePlaybookDrift,
    isPlaybookDrift,
    playbookDrift,
} from '../../src/modules/negotiation/domain/playbook-drift';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

/**
 * Resolved from `src/`, never `dist/`. This script is only ever run through
 * ts-node from the repository root (the runtime image has no ts-node and no
 * devDependencies, so it structurally cannot run this at all — the same reason
 * migrations are a `toolbox` operation).
 */
const PLAYBOOK_PATH = join(
    __dirname,
    '..',
    '..',
    'src',
    'modules',
    'negotiation',
    'playbook',
    'negotiation.core.md',
);

const DRY_RUN = process.argv.includes('--dry-run');

/** Read-only, and the only mode that FAILS: the deployment-day check. */
const CHECK = process.argv.includes('--check');

async function main(): Promise<void> {
    const raw = readFileSync(PLAYBOOK_PATH, 'utf8');
    const parsed = parsePlaybook(raw);

    console.log('Playbook:', PLAYBOOK_PATH);
    console.log('  key        :', parsed.frontmatter.name);
    console.log('  description:', truncate(parsed.frontmatter.description, 90));
    console.log('  body       :', parsed.content.length, 'characters');
    console.log('  checksum   :', parsed.checksum);

    await mongoose.connect(MONGO_URI);

    const live = await negotiationPlaybookRepository.findActive(parsed.frontmatter.name);
    if (live) {
        console.log(`  live       : v${live.version} (${live.checksum})`);
    } else {
        console.log('  live       : none published');
    }

    /**
     * ⭐ **One rule for "is the live playbook this build's?", shared with `--check`.** If the check
     * decided drift differently from the seed, it would pass things the seed would republish and
     * fail things it would leave alone — so the comparison lives in `playbookDrift` and both call it.
     */
    const verdict = playbookDrift(parsed.checksum, live ? { version: live.version, checksum: live.checksum } : null);

    /**
     * `--check` — READ ONLY, and it EXITS NON-ZERO on drift.
     *
     * ⛔ **This exists because the model reads its instructions from Mongo, not from this file.** A
     * deployment that ships new instructions and skips the seed leaves the bargaining agent running
     * the old ones, behaving subtly differently, with nothing anywhere going red. `--dry-run`
     * already prints the comparison, but it exits 0 whatever it finds, so nothing can gate on it.
     * This is the same shape as a price stated in copy beside a number in a service: two records of
     * one fact, with nothing to notice them disagreeing.
     */
    if (CHECK) {
        console.log(`\n${describePlaybookDrift(verdict)}`);
        if (isPlaybookDrift(verdict)) process.exitCode = 1;
        return;
    }

    if (verdict.status === 'current') {
        console.log('\nUnchanged — nothing to publish.');
        return;
    }

    if (DRY_RUN) {
        console.log(
            `\n[dry-run] Would publish v${(live?.version ?? 0) + 1}. Nothing written.`,
        );
        return;
    }

    const published = await negotiationPlaybookRepository.publish(parsed, 'seed');
    if (!published) {
        // Only reachable if another writer published the same content between the
        // read above and the write. Reported rather than treated as an error.
        console.log('\nAlready current — nothing to publish.');
        return;
    }

    console.log(`\nPublished v${published.version} as the active playbook.`);
    if (live) console.log(`v${live.version} is now superseded and kept as history.`);
}

function truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

main()
    .catch((error) => {
        console.error('\nSeed failed:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
