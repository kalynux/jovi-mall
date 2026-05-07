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
                    "selector": "CallExpression[callee.property.name='json'][arguments.0.properties.0.key.name='error']",
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
