// ESLint flat config: recommended JS + typescript-eslint rules, Prettier owns formatting.
// typescript-eslint needs TypeScript's JS API, which TypeScript 7 does not ship, so the root
// `typescript` dependency is 6.0.x (for the linter) and `pnpm typecheck` runs TypeScript 7
// from the `typescript-7` alias.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'data/', 'evals/results/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      // Stream events, API bodies and test fakes are untyped JSON; `any` is used deliberately there.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
