import crypto from 'crypto';

/**
 * The negotiation playbook as a DOCUMENT — parsing and fingerprinting, with no
 * database and no I/O.
 *
 * ── Why this is its own file ─────────────────────────────────────────────────
 *
 * The playbook is authored as a SKILL.md (YAML frontmatter + a markdown body) and
 * lives in git at `src/modules/negotiation/playbook/`. Mongo holds the LIVE copy —
 * that is what a future dashboard edits, and what the bargaining sub-agent is
 * served. Two representations of one thing, so exactly one place may translate
 * between them, or the seed and the reader will disagree about where the body
 * starts and the fingerprint will stop meaning anything.
 *
 * Everything here is pure, so `test:negotiation-playbook` can assert the parse
 * and the fingerprint without Mongo, without ts-node reading a file, and without
 * the frontmatter's own contents being a fixture somebody has to keep in step.
 *
 * ── The frontmatter parser is deliberately NOT a YAML parser ─────────────────
 *
 * No dependency is added for this. The frontmatter is a flat block of
 * `key: value` lines whose values are long single-line strings containing colons,
 * commas, quotes and parentheses — which is why the split is on the FIRST colon
 * only, and why nothing here tries to interpret a value. A real YAML parser would
 * additionally start *coercing*: `version: 3` becomes a number, an unquoted `yes`
 * becomes a boolean, and a description beginning with `[` becomes an array. Every
 * one of those is wrong for a field whose entire job is to be prose handed to a
 * model.
 *
 * Unknown keys are kept in `extra` rather than dropped, so a key added to the
 * authored file is preserved through a seed instead of silently disappearing on
 * the way into the database.
 */

/** The four keys this platform gives meaning to. Everything else lands in `extra`. */
export interface PlaybookFrontmatter {
    /** Stable identifier. Becomes the row's `key`, and is how the reader addresses it. */
    name: string;
    /** One-line summary. Carried for the dashboard's benefit; never sent to a model. */
    description: string;
    /** The tools the body assumes exist. Advisory prose — nothing validates against it. */
    compatibility?: string;
    /** Any other frontmatter key, preserved verbatim. */
    extra: Record<string, string>;
}

export interface ParsedPlaybook {
    frontmatter: PlaybookFrontmatter;
    /**
     * The markdown BODY, frontmatter removed and leading blank lines trimmed.
     *
     * This is the string that becomes the sub-agent's system prefix. The
     * frontmatter is deliberately not part of it: `name` and `description` exist
     * so a *loader* can decide whether to load a skill, and this one is always
     * loaded, so sending them would spend context on instructions to nobody.
     */
    content: string;
    /** `sha256(content)`, line-ending normalised. See `fingerprint`. */
    checksum: string;
}

export class PlaybookParseError extends Error {}

const DELIMITER = '---';

/**
 * Split a SKILL.md into its frontmatter and its body.
 *
 * Throws rather than returning a partial result: a playbook whose frontmatter did
 * not parse is a playbook whose `name` is unknown, and a row seeded under the
 * wrong key is served to nobody while appearing to have worked.
 */
export function parsePlaybook(raw: string): ParsedPlaybook {
    const normalised = normaliseLineEndings(raw).replace(/^\uFEFF/, '');
    const lines = normalised.split('\n');

    if (lines[0]?.trim() !== DELIMITER) {
        throw new PlaybookParseError(
            'Playbook must begin with a --- frontmatter delimiter on its first line',
        );
    }

    const closing = lines.findIndex((line, i) => i > 0 && line.trim() === DELIMITER);
    if (closing === -1) {
        throw new PlaybookParseError('Playbook frontmatter is not closed by a second ---');
    }

    const frontmatter = parseFrontmatterBlock(lines.slice(1, closing));
    // `trimStart` only: trailing whitespace is part of the authored file and
    // removing it would change the checksum for a reason nobody made.
    const content = lines.slice(closing + 1).join('\n').replace(/^\n+/, '');

    if (content.trim().length === 0) {
        throw new PlaybookParseError('Playbook body is empty');
    }

    return { frontmatter, content, checksum: fingerprint(content) };
}

/**
 * `sha256` of the content, over LF line endings.
 *
 * Normalising is not cosmetic. This is developed on Windows and deployed on
 * Linux, so a CRLF checkout would otherwise fingerprint differently from the same
 * file checked out on the build host — and the seed would write a "new version"
 * of an unchanged playbook on every run, in every environment that differs from
 * the last one. Exactly the reasoning `schema-migration.model.ts` applies to
 * migration checksums.
 */
export function fingerprint(content: string): string {
    return crypto.createHash('sha256').update(normaliseLineEndings(content), 'utf8').digest('hex');
}

function normaliseLineEndings(value: string): string {
    return value.replace(/\r\n/g, '\n');
}

function parseFrontmatterBlock(lines: string[]): PlaybookFrontmatter {
    const fields: Record<string, string> = {};

    for (const line of lines) {
        if (line.trim().length === 0) continue;
        // A continuation line (leading whitespace) belongs to the previous key.
        // Not currently produced by the authored file, but a wrapped description
        // is the obvious next edit and silently dropping half of it is worse than
        // joining it back on.
        const separator = line.indexOf(':');
        if (separator === -1) continue;

        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key.length === 0) continue;
        fields[key] = value;
    }

    const { name, description, compatibility, ...extra } = fields;

    if (!name) throw new PlaybookParseError('Playbook frontmatter is missing `name`');
    if (!description) throw new PlaybookParseError('Playbook frontmatter is missing `description`');

    return {
        name,
        description,
        ...(compatibility ? { compatibility } : {}),
        extra,
    };
}
