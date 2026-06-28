/**
 * Message Renderer
 *
 * Fills `{{placeholder}}` tokens in a preformatted catalog string with real
 * values from a flat context object. Missing/nullish values render as empty
 * strings so a partial payload never produces a literal `{{key}}` in output.
 */
export type RenderContext = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export function renderTemplate(template: string, ctx: RenderContext): string {
    return template.replace(PLACEHOLDER, (_match, key: string) => {
        const value = ctx[key];
        return value === undefined || value === null ? '' : String(value);
    });
}
