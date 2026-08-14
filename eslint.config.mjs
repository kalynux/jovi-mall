import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ["src/scripts/**"]
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    "selector": "ThrowStatement > NewExpression[callee.name='Error']",
                    "message": "Use createAppError() or an AppError subclass instead of throw new Error()"
                },
                {
                    // Matches `error` ANYWHERE in the object literal, not only as its
                    // first property.
                    //
                    // The old selector was `[arguments.0.properties.0.key.name='error']`,
                    // which fired only when `error` was written first — so the idiomatic
                    // `{ success: false, error: {...} }` sailed straight through it. That
                    // is exactly how eighteen hand-rolled error responses accumulated,
                    // several carrying code strings that are in no registry
                    // ('NO_FILES_UPLOADED', 'FILE_TYPE_INVALID') and none carrying a
                    // requestId. A rule that only catches one spelling of the mistake is
                    // a rule that teaches the other spelling.
                    "selector": "CallExpression[callee.property.name='json'] > ObjectExpression > Property[key.name='error']",
                    "message": "Use next(error) instead of res.status().json({ error: ... }). Let the global handler respond."
                },
                {
                    // Every search path in this codebase is `$regex`-based, so a term the
                    // user typed reaches a regex engine verbatim unless something escapes
                    // it: `(a+)+$` pins a core, `.*` returns the whole collection.
                    //
                    // The helper was written to close exactly this, and was then omitted
                    // at seven call sites anyway — a convention nothing enforces is a
                    // convention that decays. The escaped form `new RegExp(escapeRegex(x))`
                    // is allowed because it IS the fix; `buildSearchRegex(x)` is the
                    // shorthand for the common `{ field: <regex> }` filter.
                    //
                    // A static pattern built from module constants (core/logging/scrub.ts,
                    // blog/validators/article-body.validator.ts) is a legitimate exception
                    // and disables this line-wise, with its reason written at the site —
                    // never file-wide, which would take the two bans above down with it.
                    "selector": "NewExpression[callee.name='RegExp']:not([arguments.0.callee.name='escapeRegex'])",
                    "message": "Build search regexes with buildSearchRegex()/escapeRegex() from core/utils/regex.util. Unescaped user input in a RegExp is regex injection + ReDoS."
                }
            ],
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": "off"
        }
    },
    {
        files: ["src/app.ts", "src/server.ts", "src/api/middlewares/error-handler.middleware.ts"],
        rules: {
            "no-restricted-syntax": "off"
        }
    },
    {
        files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
        rules: {
            "no-restricted-syntax": "off",
            "@typescript-eslint/no-var-requires": "off"
        }
    }
);
