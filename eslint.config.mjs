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
