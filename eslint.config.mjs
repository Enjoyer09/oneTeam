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
        // The type-aware rules above need the TypeScript type checker. This
        // asks for the nearest tsconfig.json per file, so linting stays correct
        // across the workspace without hand-maintaining project lists.
        //
        // WHY `allowDefaultProject` EXISTS — a file that is in no tsconfig is
        // not linted at all. typescript-eslint does not skip it quietly; it
        // reports `Parsing error: <file> was not found by the project service`,
        // which is an ERROR. The first run that got this far found five:
        //
        //   mobile/Root.tsx, mobile/index.ts        — outside `include`, which
        //                                             is `src/**/*`
        //   mobile/src/services/keychain.ts         — deliberately EXCLUDED from
        //   mobile/src/services/queueStorage.ts       mobile/tsconfig.json
        //   web/vite.config.ts                      — outside `include`, which
        //                                             is `src`
        //
        // The two mobile services are excluded on purpose and the reason is
        // written down in mobile/tsconfig.json: they import `expo-secure-store`
        // and `@react-native-async-storage/async-storage`, neither of which is
        // installed, so they cannot be type-checked. `mobile:config` guards that
        // exclusion list. They still have to be LINTED, though, and this is the
        // documented way to lint a file that belongs to no project.
        //
        // WHAT THIS COSTS, STATED PLAINLY: a file listed here is parsed and
        // checked with the SYNTACTIC rules only. The type-aware rules — the
        // floating-promise and misused-promise ones — are skipped, because there
        // is no type information to run them on. So `Root.tsx` is linted, but
        // less thoroughly than `src/App.tsx`. That is strictly better than the
        // alternative it replaces, which was not being linted at all, and it is
        // why the list is kept to five files and commented rather than left to
        // grow. Delete the two mobile entries the moment `cd mobile && npm
        // install` succeeds and the exclusions in mobile/tsconfig.json go away.
        projectService: {
          allowDefaultProject: [
            'mobile/index.ts',
            'mobile/Root.tsx',
            'mobile/src/services/keychain.ts',
            'mobile/src/services/queueStorage.ts',
            'web/vite.config.ts',
          ],
        },
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

      // WHY THIS IS THE TYPESCRIPT-ESLINT RULE AND NOT THE ESLINT ONE
      // ------------------------------------------------------------
      // This was `'no-return-await': 'error'` — the ESLint core rule. ESLint
      // deprecated it in 8.46 and says so on its own page: "Without type
      // information, the only situations that could be flagged by
      // `no-return-await` were of neutral-to-negative value, which eventually
      // led to its deprecation." The deprecation is not cosmetic. The core rule
      // flags `return await promise` EVERYWHERE, including inside a `try` block
      // — where the `await` is not redundant but REQUIRED, because without it a
      // rejection escapes the `catch` that was written to handle it. So the old
      // rule's advice was, in the one case that matters, actively wrong.
      //
      // `in-try-catch` is the option typescript-eslint documents as "the
      // closest behavior to the `no-return-await` rule", with that one case
      // corrected: `return await` is required in an error-handling context and
      // banned outside one. It needs the type checker, which is already
      // configured above.
      //
      // Switching the rule is not a way of making the findings disappear. All
      // 18 sites it reported were in ordinary contexts, so all 18 were still
      // reported after the switch and all 18 were fixed in the code.
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

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
      // WHY `.cjs` IS LISTED HERE — the second time lint ran, it reported 120
      // `no-undef` errors, every one of them in the four `scripts/live-*.cjs`
      // probes, for `process`, `console`, `fetch`, `setTimeout` and `module`.
      // None of those was a bug: the files were simply never given an
      // environment, so every Node global in them looked undefined. The same
      // run reported `require()` as a forbidden import in all four — in a
      // CommonJS file, where `require` is not a workaround but the module
      // system itself.
      //
      // One glob was missing. `.mjs` and `.js` were covered, `.cjs` was not.
      'scripts/**/*.cjs',
      // WHY THIS GLOB IS HERE — `mobile/plugins/withUITests.js` is an Expo
      // config plugin. Expo loads config plugins with `require()`, and
      // `mobile/package.json` declares no `"type"`, so the file is CommonJS by
      // definition. Without this entry it is linted under the bare JS baseline,
      // where every Node global is undefined and `require()` counts as a
      // forbidden import — the same false positives the four `scripts/live-*.cjs`
      // probes produced before this section existed. `require` is not a
      // workaround in a CommonJS file; it is the module system.
      'mobile/plugins/**/*.js',
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
      // A `.cjs` file is CommonJS by extension. `require()` is the correct way
      // to import in it, so the rule that bans `require` in favour of ESM has
      // nothing to say here — it was flagging four files for being the kind of
      // file they are.
      '@typescript-eslint/no-require-imports': 'off',
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
