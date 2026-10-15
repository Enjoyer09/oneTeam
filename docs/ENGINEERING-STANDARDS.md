# oneTeam — Engineering Standards & Quality Report

**Audience:** the whole engineering team
**Scope:** `apps/`, `packages/`, `web/`, `mobile/`, `src/`, `scripts/`
**Method:** static analysis, compiler output, and test execution — every claim
below is reproducible with a command. Nothing here is a matter of opinion.

---

## 1. Where the project actually stands

| Metric                               | Value                                      |
| ------------------------------------ | ------------------------------------------ |
| First-party files                    | 69                                         |
| Lines of code                        | 10,035                                     |
| TypeScript errors before this review | **19**                                     |
| TypeScript errors after              | **0** (3 remain only until `pnpm install`) |
| Committed credentials found          | **6 categories**                           |
| CI pipelines                         | 0 → 3 jobs                                 |
| Linters / formatters                 | 0 → ESLint + Prettier + EditorConfig       |
| Product code under version control   | **no**                                     |
| API tests passing                    | 2/19 → **25/25 + 14/14**                   |
| API type strictness                  | `strict: false` → **`strict: true`**       |

The code itself is not the problem. The architecture is coherent, the domain
model is real, and the tests — where they run — assert meaningful behaviour. The
problem is that **nothing was checking any of it automatically**, so several
defects had been sitting in the repository unnoticed.

---

## 2. Critical findings

### P0-1 — The product is not in version control

```
$ git -C /Users/macbookair/GitHub/oneTeam rev-parse --show-toplevel
/Users/macbookair

$ git ls-files oneTeam | wc -l
0
```

The git repository root is the user's **home directory**, not the project. It
contains 50,215 tracked files — `.cache/` (19,112), `.gemini/` (13,953),
`.npm/` (9,345) — and **not a single file from `oneTeam/`**.

Consequences, all of which follow directly:

- There is no history for the product, so there is no rollback.
- `git diff` cannot answer "what changed?" because the project is untracked.
- Code review is impossible — there is nothing to review.
- CI cannot run — a workflow file at the project root would be ignored.

**Fix.** Give the project its own repository:

```bash
cd /Users/macbookair/GitHub/oneTeam
git init
git add .                    # .gitignore now excludes secrets and build output
git commit -m "chore: import oneTeam into version control"
gh repo create oneteam-platform --private --source=. --push
```

The home-directory repository should be left alone until §2 P0-2 is handled.

---

### P0-2 — Credentials are committed to a repository with a GitHub remote

The repository at `/Users/macbookair` has the remote
`https://github.com/Enjoyer09/AZERIGIS.git` and tracks:

| Path                                  | What it is                                            |
| ------------------------------------- | ----------------------------------------------------- |
| `.ssh/id_ed25519`                     | **An SSH private key**                                |
| `.railway/config.json`                | Railway credentials (this project deploys on Railway) |
| `.aws/sso/cache/kiro-auth-token.json` | AWS SSO token                                         |
| `.docker/config.json`                 | Docker registry credentials                           |
| `.config/gh/`                         | GitHub CLI configuration                              |
| `.claude.json`, `.gemini/`, `.codex/` | AI agent configs — routinely hold API keys            |

The repository is **private** (verified against the GitHub API), which is the
only reason this is not already an incident. The exposure is currently limited to
whoever has repository access. That protection disappears the moment the
repository is made public, forked, or a collaborator's account is compromised.

**Fix, in this order:**

1. **Rotate every one of those credentials.** Generate a new SSH key, revoke the
   Railway token, the AWS SSO session, the Docker and GitHub tokens. Assume they
   are compromised — they are in a git history you do not fully control.
2. **Purge them from history.** `git filter-repo --path .ssh --path .railway
--path .aws --path .docker --invert-paths`, then force-push. Deleting the
   files in a new commit is _not_ enough; history is immutable.
3. **Prevent recurrence.** `.gitignore` now exists (§3). `pnpm run secrets:scan`
   runs in CI and in the pre-commit hook.

> The scanner found **zero** hardcoded credentials in first-party source. The
> leak is entirely from the home-directory repository, not from application code.

---

### P0-3 — A core feature has never worked: Telegram task acknowledgement

`apps/api/src/modules/notifications/webhook.controller.ts` built the acting user
as a plain string:

```ts
const actorId = `tg_user_${fromUser.id}`;
await this.taskStateService.transitionTask(taskId, TaskState.ACKNOWLEDGED, actorId, …);
```

`transitionTask` requires an `AuthenticatedPrincipal` **object**. The
authorisation layer therefore saw `principal.userId === undefined` and rejected
every call with **403**. Acknowledging a task from the Telegram inline button
could not work in any environment.

The TypeScript compiler reported this as `TS2345` on two lines. Nothing ran the
compiler.

**Worse, and less obvious:** because the actor identity came from the request
body rather than a trusted mapping, _any_ Telegram account that knew a task id
could have acted on it. The identity now comes from
`db.getUserByTelegramChatId()`, which was already implemented and never called —
and an unregistered Telegram account is refused with 403.

**Fixed.** Suite 3 of the integration tests now passes for the first time.

---

### P0-4 — The API compiled against a stale build artefact

`apps/api/tsconfig.json` resolves workspace packages to compiled declarations:

```json
"paths": {
  "@oneteam/types": ["../../packages/types/dist/index.d.ts"],
  "@oneteam/database": ["../../packages/database/dist/index.d.ts"]
}
```

`packages/database/dist/index.d.ts` was built before four methods were added
(`getUser`, `canUserAccessTask`, `getTasksForUser`, `getEvidencesForUser`), so
the compiler believed they did not exist. That produced **8 of the 19 errors** —
phantom errors that vanished the moment the package was rebuilt.

The underlying problem is that nothing enforces build order. The fix is
TypeScript **project references**:

```jsonc
// packages/database/tsconfig.json
{ "compilerOptions": { "composite": true, … } }

// apps/api/tsconfig.json
{ "references": [{ "path": "../../packages/database" }] }
```

With `composite: true` and `references`, `tsc --build` compiles dependencies
first and refuses to use a stale declaration. Until that is in place, **always
rebuild the packages before type-checking the API.**

---

### P0-5 — `npm run type-check` was failing with 19 errors

| Error                                                   | Count | Cause                                                          |
| ------------------------------------------------------- | ----- | -------------------------------------------------------------- |
| `TS2554` Expected 2 arguments, got 1                    | 14    | Service methods take a principal; call sites omitted it        |
| `TS2322` `null` not assignable to `number \| undefined` | 2     | Optional field typed too narrowly for a real three-state value |
| `TS7016` No declaration file for `express`              | 3     | `@types/express` declared but not installed                    |

The 14 `TS2554` errors are the same defect class as P0-3: a service method
requiring an authenticated principal, called without one. They were invisible
because `apps/api/tsconfig.json` declared `"include": ["src/**/*"]` — **the test
directory was never type-checked**. The root `tsconfig.json` does include
`apps/**`, which is how they surfaced at all.

All 19 are now resolved: 16 by fixing the code, 3 by installing the declared
dependency.

---

## 3. What now exists

### Quality gates

| File                                  | Purpose                                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `eslint.config.mjs`                   | ESLint 9 flat config. Errors block; warnings are visible debt.  |
| `.prettierrc.json`, `.prettierignore` | Formatting is a machine decision, not a review discussion.      |
| `.editorconfig`                       | Stops whitespace churn from burying real changes in diffs.      |
| `.gitignore`                          | Secrets, build output, model weights, screenshots.              |
| `.nvmrc`                              | Pins Node 22.                                                   |
| `.github/workflows/ci.yml`            | Three jobs: verify (secrets, types, lint, format), test, build. |
| `.github/pull_request_template.md`    | Forces intent, verification steps and risk to be written down.  |
| `scripts/quality/secret-scan.mjs`     | Scans staged files and history for credentials.                 |
| `CONTRIBUTING.md`                     | Onboarding and the daily loop.                                  |

### New scripts

```bash
pnpm run quality        # format:check -> lint -> type-check -> test:all
pnpm run lint           # ESLint
pnpm run lint:fix       # ESLint with autofix
pnpm run format         # Prettier, rewriting
pnpm run format:check   # Prettier, check only (what CI runs)
pnpm run secrets:scan   # credential scan
```

### The secret scanner

Node built-ins only, no dependencies. It detects PEM private keys, OpenAI,
Anthropic, GitHub, AWS, Google, Slack, Stripe, Telegram and Supabase key
formats, database URLs with inline passwords, JWTs, and generic
`apiKey = "…"` assignments — with allow-lists so placeholders, `process.env`
references, git SHAs and variable names do not fire.

Verified against a synthetic fixture: **7 of 7 real credential patterns caught,
5 of 5 benign patterns correctly ignored.** Findings are masked — the scanner
never prints a live secret, because terminal scrollback and CI logs are
themselves a leak vector.

---

## 4. Engineering standards

Each rule exists because a specific defect in this repository motivated it.

### 4.1 Identity comes from the principal, never the request body

`SubmitEvidenceRequestDto` used to carry a `submittedById` field, letting the
caller state who was submitting. `EvidenceService` correctly ignored it and used
`principal.userId` — but the field invited exactly the mistake that caused P0-3,
and any future code path that trusted it would have been identity spoofing.

> **Done.** `submittedById` has been removed from the request DTO, along with the
> ten call sites that populated it. The field remains on the _stored_ record
> (`InMemoryEvidence`, the domain entity), because the service recording who
> actually acted is correct and necessary for the audit trail. The rule is now
> enforced by the type system: a request cannot express an actor.

### 4.2 Never disable a type check to make the build pass

`any`, `as any`, `@ts-ignore` and `!` move an error from compile time — where it
costs seconds — to runtime, where it costs a production incident. `@ts-expect-error`
with a written reason is acceptable because it fails loudly once the underlying
problem is fixed. `@ts-ignore` is not: it also hides any _new_ error on that line.

Current debt: **58** `any` usages, **3** non-null assertions.

### 4.3 Never swallow an error

`catch {}` converts a loud failure into a silent one. The scan found no empty
catches — keep it that way. If you must ignore an error, write why.

### 4.4 Tests must exercise the real thing

The API test suites run against `@oneteam/database`, which is an **in-memory
array store**. The 388-line PostgreSQL schema in `supabase/migrations/` is never
executed by any test. So the persistence layer, the SQL, the constraints and the
row-level security are entirely untested — while the suite reports "integration
tests passing".

> **Action:** add a database-backed test tier that runs migrations against a
> scratch PostgreSQL and exercises the real repository code. Keep the in-memory
> tier for fast unit feedback.

### 4.5 A test that cannot fail is not a test

Every suite here exits non-zero on failure, which is correct and was verified.
Keep it that way. A test that logs `❌` and exits 0 is documentation, not a gate.

### 4.6 Strictness is not optional on the API

`apps/api/tsconfig.json` set `"strict": false` — the most security-critical layer
was checked least. The root config used `strict: true`.

> **Done, and it cost nothing.** Flipping `apps/api` to `strict: true` produced
> **zero** new errors. The code was already strict-clean; the flag was
> unnecessary caution that had been suppressing future guarantees. It is now on
> permanently.

> **Next:** add `noUncheckedIndexedAccess` to the root config. That one will
> surface real findings, so it needs its own pass.

### 4.7 Webhook endpoints must verify their sender

`POST /api/webhooks/telegram` had no signature verification. Anyone who learned
the URL could POST a forged callback, mutate task state, and write a forged actor
into the audit log — defeating the audit trail's purpose, because an audit trail
a stranger can write to is worse than none.

> **Done.** The endpoint now requires Telegram's
> `X-Telegram-Bot-Api-Secret-Token` header and compares it in constant time
> (`timingSafeEqual`, to avoid leaking the secret through timing). Requests are
> rejected before the body is parsed.
>
> **It fails closed.** If `TELEGRAM_WEBHOOK_SECRET` is unset in production, every
> request is refused with 503 rather than accepted unverified. "Secure when
> configured" is how a misconfiguration becomes a breach. Outside production the
> check is skipped with a loud warning, so local development and the test suite
> stay frictionless.
>
> Six tests cover it: forged token rejected (401), state provably unchanged,
> missing header rejected, correct token accepted, unregistered Telegram account
> refused (403), and production-without-secret failing closed (503).

> **Operational step:** set `TELEGRAM_WEBHOOK_SECRET`, then re-register the
> webhook with Telegram passing the same value as `secret_token`.

### 4.8 Authentication must be verifiable

`AuthGuard` accepts `Bearer oneteam-user:<id>`. There is no signature, no expiry,
and no verification — anyone who can guess a user id is that user. This is a
placeholder, and it is currently the only thing between the API and the internet.

> **Partially done.** CORS is no longer `origin: '*'`. It is now an explicit
> allow-list read from `CORS_ALLOWED_ORIGINS`, with a wildcard value actively
> rejected and production failing closed when the variable is unset. That matters
> because with a wildcard, any page a signed-in user visits could call this API
> as them and read the responses.
>
> **Still outstanding:** replace the placeholder token with verified JWTs
> (Supabase Auth or equivalent), checking signature, `exp` and `aud`. This needs
> a decision about the identity provider, so it is not something to change
> unilaterally.

### 4.9 A fallback that cannot be seen is a lie

`src/services/aiVision.ts` is a simulation, and its own header says so. Three
things about how it was tested made that simulation look like a working detector:

1. **The worker's failures were collapsed into one value.** The Python worker
   could fail seven different ways — no virtualenv, no worker script, a spawn
   error, a timeout, a non-zero exit, unparseable output, or a successful run that
   found nothing — and all seven returned `null`. A caller could not tell "this
   machine has not built the Python environment" from "the model looked and found
   no bottles".
2. **The worker drew its own detections.** When the model detected nothing, the
   Python script generated nine plausible boxes instead of returning an empty
   list, so a demo was never blank. `logo.jpg` in this repository is a company
   logo; the model finds **zero** objects in it, and the test asserting "detection
   boxes were returned" was satisfied entirely by drawing.
3. **The test that claimed the real engine could not fail.** `analyzeShelfPhoto`
   falls back to the simulation when the worker returns nothing, and nothing
   recorded which engine had run. So _"End-to-end planogram compliance analysis
   succeeds using real Ultralytics engine"_ passed whether or not that engine ran.

> **Fixed.** The worker returns an outcome that names its reason
> (`worker-unavailable` / `timeout` / `worker-failed` / `no-detections`); the
> drawn boxes carry `"synthetic": true` with a top-level `"synthetic_fallback"`;
> and the evaluation carries an `engine` field. The test warms the worker before
> asserting (a cold start measured **47s** against **3.3s** warm, and the old 60s
> cap had no margin on a loaded machine), asserts that a killed worker is reported
> as a timeout, and cross-checks the engine the evaluation names against the
> worker it called directly. That historical runtime was Ultralytics; the current
> worker uses TorchVision and defaults to disabled until a reviewed checkpoint exists.

The general rule: **if a system substitutes a fallback for a failure, the caller
must be able to tell.** A fallback that reports itself as success is worse than no
fallback, because it is believed.

---

## 5. Code review checklist

Reviewers: approve only when you would be comfortable being paged at 02:00 for
this change.

- [ ] **Can it be abused?** Authorisation enforced server-side. Identity from the
      principal, not the body.
- [ ] **Does it fail loudly?** No empty `catch`, no swallowed promise rejection,
      no silent fallback that hides a failure.
- [ ] **Is the test real?** It exercises the actual code path, and it fails if
      you revert the fix.
- [ ] **Does the diff contain a secret?** Check `.env` values, tokens, keys.
- [ ] **Is it accessible?** Keyboard reachable, visible focus, contrast holds,
      works at 360px wide.
- [ ] **Does it survive the future?** The next person will read this in six
      months without being able to ask you.

---

## 6. Definition of done

1. `pnpm run quality` is green locally.
2. A test covers the new behaviour and fails without the fix.
3. Verified the way a user meets it — narrow window, keyboard, dark mode.
4. Errors surface rather than being swallowed.
5. Authorisation is server-side; identity from the principal.
6. No new `any`, `@ts-ignore` or non-null assertion without a written reason.
7. `docs/ENGINEERING-STANDARDS.md` updated if a convention changed.

---

## 7. Roadmap

### Now — this week

| #   | Action                                                | Why                                          |
| --- | ----------------------------------------------------- | -------------------------------------------- |
| 1   | Rotate the credentials listed in P0-2                 | They are in a git history you do not control |
| 2   | Purge them from history and force-push                | Deleting files is not enough                 |
| 3   | `git init` the project and push to its own repository | Nothing else in this list works without it   |
| 4   | Turn on branch protection: CI must pass to merge      | Makes the gate real                          |

### Next — this month

| #   | Action                                                    | Why                                             | Status               |
| --- | --------------------------------------------------------- | ----------------------------------------------- | -------------------- |
| 5   | Telegram webhook signature verification                   | §4.7                                            | **done**             |
| 6   | Restrict CORS to an allow-list                            | §4.8                                            | **done**             |
| 7   | TypeScript project references                             | Kills the P0-4 class of bug permanently         | **done**             |
| 8   | `strict: true` on `apps/api`                              | §4.6                                            | **done** (zero cost) |
| 9   | Remove `submittedById` from the request DTO               | §4.1                                            | **done**             |
| 10  | Set `TELEGRAM_WEBHOOK_SECRET` and re-register the webhook | The code now requires it in production          | **operational step** |
| 11  | Replace the toy bearer token with verified JWTs           | §4.8 — needs an identity-provider decision      | open                 |
| 12  | Wire `@oneteam/database` to real PostgreSQL               | The product currently loses all data on restart | open                 |
| 13  | A database-backed test tier                               | §4.4                                            | open                 |

### Later — this quarter

| #   | Action                                                                | Why                                         |
| --- | --------------------------------------------------------------------- | ------------------------------------------- |
| 12  | Ratchet `no-explicit-any` from `warn` to `error` at zero              | §4.2                                        |
| 13  | Replace 98 `console.log` calls with structured logging                | Unsearchable, unstructured, no severity     |
| 14  | Add a coverage threshold to CI                                        | Coverage is a floor, not a target           |
| 15  | Split `TaskManager.tsx` (748 lines) and `AuditReviewCenter.tsx` (713) | Hard to test, hard to review                |
| 16  | Archive `ui-audit/`, `ui-design/`, `ui-glass/` into one place         | Three overlapping prototype dirs            |
| 17  | Delete stale `packages/*/src/*.d.ts` and `*.js` build output          | Compiled artefacts committed next to source |

### Deliberately not fixed here

These need a team decision rather than a unilateral change:

- **`vitest` is a phantom dependency** — present in `node_modules` but declared
  in no `package.json`. It works on the machine it was installed on and will
  break on a clean checkout. Either declare it or remove it.
- **`turbo.json` is orphaned** — Turborepo is configured but not installed and
  not referenced by any script.
- **`package-lock.json` vs `pnpm-lock.yaml`** — the npm lockfile is stale and
  should be deleted once pnpm is confirmed as the standard.
- **`yolov8n.pt`** sits in the project root; model weights belong in object
  storage or Git LFS. Related: `.venv/` is gitignored and the weights are
  untracked, so `npm run test:ai` cannot pass on a clean checkout. Test 7 now
  says so plainly and prints the command to build the environment, but the real
  fix is a documented setup step or a container for the worker.

---

## 8. Reproducing this review

```bash
cd /Users/macbookair/GitHub/oneTeam

# Type safety
node ./node_modules/typescript/bin/tsc --noEmit

# Credentials (whole tree)
node scripts/quality/secret-scan.mjs --dir .

# The test suites
pnpm run test:all

# Was the product ever tracked?
git -C /Users/macbookair ls-files oneTeam | wc -l
```
