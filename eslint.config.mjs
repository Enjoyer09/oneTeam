/**
 * ============================================================================
 *  oneTeam — ESLint configuration (flat config)
 *
 *  Written against ESLint 9 and now running on ESLint 10; the version that
 *  matters is whatever `package.json` pins, and this header previously claimed
 *  the wrong one because lint had never run to contradict it.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The repository had no linter at all. That means every quality rule lived in
 * reviewers' heads, which does not scale past one person and is impossible to
 * enforce consistently.
 *
 * PHILOSOPHY — "a gate that is switched off is not a gate"
 * --------------------------------------------------------
 * A rule set that fails on day one gets disabled on day one. So this config is
 * deliberately tiered:
 *
 *   ERROR  — genuine bugs, and cheap to fix. These must never enter `main`.
 *            Floating promises, misused promises, unused variables, `==`.
 *
 *   WARN   — real debt that already exists in the codebase and cannot be
 *            fixed in one afternoon. `any` is the main one: there are ~58
 *            usages today. These are visible in every editor and every CI run,
 *            and the ratchet plan (see docs/ENGINEERING-STANDARDS.md) moves
 *            each one to ERROR once its count reaches zero.
 *
 * If you need to silence a rule for a genuine reason, disable it for that
 * single line with a written justification — never for the whole file, and
 * never in this config without a note explaining why.
 *
 * TYPE-AWARE RULES
 * ----------------
 * The most valuable rules (no-floating-promises, no-misused-promises) need the
 * TypeScript type checker, which is why they are configured against the
 * project service rather than running on syntax alone.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // -------------------------------------------------------------------------
  // 1. What we never lint
  // -------------------------------------------------------------------------
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/*.min.js',
      '**/*.min.css',
      '**/*.map',
      '**/*.d.ts',
      // Generated prototype/report artefacts — not maintained source.
      'ui-audit/**',
      'ui-design/**',
      'ui-glass/**',
      // Local agent/tooling state.
      '.workbuddy-ai/**',
      '.claude/**',
      '.gemini/**',
      '.codex/**',
      // Model weights and binary assets.
      '**/*.pt',
      '**/*.png',
      '**/*.jpg',
      '**/*.jpeg',
    ],
  },

  // -------------------------------------------------------------------------
  // 2. Baseline for every JavaScript file
  // -------------------------------------------------------------------------
  js.configs.recommended,

  // -------------------------------------------------------------------------
  // 3. TypeScript — syntactic rules (fast, no type checker required)
  // -------------------------------------------------------------------------
  ...tseslint.configs.recommended,

  // -------------------------------------------------------------------------
  // 4. TypeScript — type-aware rules (the ones that catch production bugs)
  // -------------------------------------------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parserOptions: {
        // Uses the nearest tsconfig.json for each file, so linting stays
        // correct across the workspace without hand-maintaining project lists.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // --- ERRORS: real defects, cheap to fix -----------------------------

      // A promise that is created and never awaited is the single most common
      // source of "it worked in dev" bugs: the error is swallowed, and the
      // caller proceeds before the work is done.
      '@typescript-eslint/no-floating-promises': 'error',

      // Passing an async function where a sync one is expected (an event
      // handler, a `.forEach`, a `sort` comparator) means errors are dropped
      // and ordering is not what it looks like.
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // `@ts-ignore` hides an error and also hides any NEW error that appears
      // on the same line later. `@ts-expect-error` fails loudly once the
      // underlying problem is fixed, so the suppression cannot rot.
      //
      // WHY THIS IS SHAPED LIKE THIS — the first time lint ever ran, it failed
      // on THIS line, with `Value "Use @ts-expect-error with a written reason,
      // or fix the type." should be boolean.` The values were written as custom
      // MESSAGES, which was valid in typescript-eslint v7 and was removed in v8:
      // every key now takes `boolean | 'allow-with-description'`. Because lint
      // had never executed — CI died at the secret scan on every single push —
      // nobody had ever seen the error. A config that cannot load is not a
      // strict config, it is an absent one.
      //
      // The policy below is the one CONTRIBUTING.md and
      // docs/ENGINEERING-STANDARDS.md already state: `@ts-expect-error` is
      // acceptable WITH a written reason, `@ts-ignore` is not.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          // `@ts-check` turns checking ON, so there is nothing to ban.
          'ts-check': false,
          // "A written reason" is not three characters.
          minimumDescriptionLength: 10,
        },
      ],

      // Throwing a string loses the stack trace, so production errors become
      // impossible to locate.
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-param-reassign': ['warn', { props: false }],
      'no-return-await': 'error',
      'require-await': 'off', // superseded by the type-aware variant below
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',

      // --- WARNINGS: existing debt, with a documented ratchet --------------

      // ~58 usages today. `any` disables the type checker for everything
      // downstream of it, which is how a typed codebase quietly becomes
      // untyped. Ratchet target: 0, then this becomes 'error'.
      '@typescript-eslint/no-explicit-any': 'warn',

      // 3 usages. A non-null assertion is a promise to the compiler that the
      // value is present; when it is wrong, you get a runtime crash instead of
      // a compile error.
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // 98 usages. Structured logging should replace these.
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      'no-restricted-syntax': [
        'warn',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'new Date() with no argument is not testable. Inject a clock, or pass an explicit timestamp.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // 5. React — the web portal
  // -------------------------------------------------------------------------
  {
    files: ['web/**/*.tsx', 'web/**/*.ts'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // The rules-of-hooks rule catches conditional hook calls, which are a
      // crash, not a style issue.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // -------------------------------------------------------------------------
  // 6. Node-side entry points, scripts and migrations
  // -------------------------------------------------------------------------
  {
    files: [
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      '**/*.config.js',
      '**/*.config.mjs',
      'postcss.config.js',
      'tailwind.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // CLI tools legitimately print to stdout; that is their interface.
      'no-console': 'off',
    },
  },

  // -------------------------------------------------------------------------
  // 7. Tests and harnesses
  // -------------------------------------------------------------------------
  {
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/test/**/*.ts',
      '**/tests/**/*.ts',
      '**/*test-runner*.ts',
      '**/smoke-test.ts',
    ],
    rules: {
      // Test output is the interface of a test runner.
      'no-console': 'off',
      // Fixtures and mocks are full of deliberately loose types.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // An intentionally non-awaited rejection check is normal in tests.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // -------------------------------------------------------------------------
  // 8. Declaration files and type-only packages
  // -------------------------------------------------------------------------
  {
    files: ['**/*.d.ts', 'types/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // -------------------------------------------------------------------------
  // 9. Turn off every stylistic rule that would fight Prettier.
  //    Formatting is Prettier's job; ESLint's job is correctness.
  //    Must stay last so it wins.
  // -------------------------------------------------------------------------
  prettierConfig,
);
