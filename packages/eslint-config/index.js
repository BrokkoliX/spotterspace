/**
 * Shared ESLint flat config for the non-Next workspaces
 * (apps/api, packages/db, packages/shared).
 *
 * Exported as a CommonJS array so each workspace's `eslint.config.mjs` can
 * `import` it directly. apps/web has its own config (eslint-config-next).
 */
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettier = require('eslint-config-prettier');
const importPlugin = require('eslint-plugin-import');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', '.next/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': tsPlugin, import: importPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Must stay after the recommended sets: switches off the stylistic
      // rules that would fight prettier.
      ...prettier.rules,
      // TypeScript already errors on undefined identifiers, and `no-undef`
      // does not understand type-only names or ambient declarations — it
      // reported 188 false positives across apps/api.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' },
        },
      ],
    },
  },
];
