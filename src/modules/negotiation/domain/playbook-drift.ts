/**
 * Is the playbook the service SERVES the one this build AUTHORED?
 *
 * ── ⛔ WHY THIS QUESTION NEEDS AN ANSWER ON DEPLOYMENT DAY ───────────────────
 * The bargaining agent reads its instructions from **Mongo**, not from the file in git. The file is
 * the authored source and `seed:negotiation-playbook` is the one bridge between them. So a deploy
 * that ships new instructions and skips the seed leaves the model running the OLD ones, behaving
 * subtly differently, with nothing anywhere going red — the customer simply gets a bot that has not
 * learned what this release taught it.
 *
 * That is the same shape as the download expiry stated in five sentences beside a TTL in a service:
 * **two records of one fact, with nothing to notice them disagreeing.** This is the noticing.
 *
 * ── THE COMPARISON IS THE SEED'S OWN, DELIBERATELY ──────────────────────────
 * "Current" has to mean exactly what the seed means by it, or the check passes things the seed
 * would republish and fails things it would leave alone. So the rule lives here, once, and both the
 * seed and the check call it — rather than a verification script re-deciding what counts as drift.
 *
 * ⚠ The checksum fingerprints the BODY over LF line endings (`parsePlaybook`), so a CRLF checkout
 * on Windows and an LF one on a Linux build host agree, and a description-only edit does not read
 * as drift.
 *
 * Pure: no database, no file system, no clock. The I/O belongs to the script.
 */

/** The live row, as far as this decision cares. Null when nothing is published under that key. */
export interface LivePlaybook {
    version: number;
    checksum: string;
}

export type PlaybookDrift =
    /** What is served is what this build authored. Nothing to do. */
    | { status: 'current'; version: number }
    /** Something is published, but not this. The seed would publish a new version over it. */
    | { status: 'drifted'; liveVersion: number; liveChecksum: string; authoredChecksum: string }
    /** Nothing is published under this key at all — the agent has no instructions to read. */
    | { status: 'absent'; authoredChecksum: string };

export function playbookDrift(authoredChecksum: string, live: LivePlaybook | null): PlaybookDrift {
    if (!live) return { status: 'absent', authoredChecksum };

    if (live.checksum === authoredChecksum) return { status: 'current', version: live.version };

    return {
        status: 'drifted',
        liveVersion: live.version,
        liveChecksum: live.checksum,
        authoredChecksum,
    };
}

/**
 * Whether this verdict should FAIL a deployment check.
 *
 * ⚠ **`absent` fails too, and that is not pedantry.** A key with nothing published is the state in
 * which the bargaining agent is served no playbook at all — the service refuses the read rather
 * than falling back (`NEGOTIATION_PLAYBOOK_NOT_PUBLISHED`), so haggling simply stops working. It is
 * a louder failure than drift, not a quieter one.
 */
export function isPlaybookDrift(verdict: PlaybookDrift): boolean {
    return verdict.status !== 'current';
}

/**
 * One line a human reads on deployment day, and the reason each says what to do.
 *
 * ⚠ **Never localised and never shown to a customer** — the audience is whoever is running the
 * release, the same audience as a migration's output.
 */
export function describePlaybookDrift(verdict: PlaybookDrift): string {
    switch (verdict.status) {
        case 'current':
            return `The live playbook is v${verdict.version} and matches this build. Nothing to do.`;
        case 'drifted':
            return (
                `DRIFT: the model is being served v${verdict.liveVersion} (${verdict.liveChecksum}), `
                + `not what this build authored (${verdict.authoredChecksum}). `
                + 'Run `npm run seed:negotiation-playbook` — the agent is following older instructions.'
            );
        case 'absent':
            return (
                `NOTHING PUBLISHED: no active playbook for this key (authored ${verdict.authoredChecksum}). `
                + 'Bargaining is refused outright until `npm run seed:negotiation-playbook` runs.'
            );
    }
}
