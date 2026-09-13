# Contributing to oneTeam

This document is the short version. The long version — with the reasoning behind
each rule — is in [`docs/ENGINEERING-STANDARDS.md`](docs/ENGINEERING-STANDARDS.md).

---

## 1. Set up (10 minutes, once)

```bash
git clone <repository-url>
cd oneTeam
pnpm install          # NOT npm — see §2
pnpm run type-check   # should print nothing
pnpm run test:all     # should end with "ALL ... PASSED"
```

Node version is pinned in `.nvmrc`. If you use `nvm`, run `nvm use` first.

Copy `.env.example` to `.env` and fill in the values you need. **`.env` is
gitignored. Never commit it, and never paste its contents into a chat, an issue,
or a screenshot.**

---

## 2. Package manager

**This project uses pnpm.** Not npm, not yarn.

The workspace packages reference each other with the `workspace:*` protocol:

```json
"@oneteam/types": "workspace:*"
```

That syntax is **pnpm-only**. Running `npm install` fails outright with
`EUNSUPPORTEDPROTOCOL`, which is why a fresh clone must use pnpm.

> If you see a `package-lock.json` in the repository root, it is stale and
> should be deleted. Only `pnpm-lock.yaml` is authoritative.

---

## 3. The daily loop

```bash
pnpm run web:dev      # portal with hot reload on http://localhost:5173
pnpm run api:dev      # API on http://localhost:3001
```

Before you push:

```bash
pnpm run quality      # format check -> lint -> type-check -> tests
```

That one command runs everything CI runs. If it is green locally, CI will be
green. Do not push red and hope.

### Useful single commands

| Command | What it does |
| --- | --- |
| `pnpm run lint` | ESLint. Warnings are allowed; errors are not. |
| `pnpm run lint:fix` | ESLint with autofix. |
| `pnpm run format` | Prettier, rewriting files. |
| `pnpm run format:check` | Prettier in check-only mode (what CI runs). |
| `pnpm run type-check` | TypeScript across the whole workspace. |
| `pnpm run test:all` | Every test suite. |
| `pnpm run secrets:scan` | Scan staged files for credentials. |
| `pnpm run web:build` | Production build of the portal. |

---

## 4. What "done" means

A change is done when **all** of these are true. Not before.

1. It compiles, lints, and formats cleanly.
2. A test covers the behaviour — and the test fails if you revert the fix.
3. It is verified in the way a user will actually meet it. For UI work that
   means a narrow window, a keyboard, and dark mode.
4. Errors are surfaced, not swallowed. No empty `catch`.
5. Authorisation is enforced on the server, and identity comes from the
   authenticated principal — never from the request body.
6. You would be comfortable being woken up at 02:00 for it.

---

## 5. Rules that are not negotiable

These exist because each one has already caused a real defect in this codebase.

**Never commit a credential.** Not in source, not in a test fixture, not in a
comment, not "temporarily". A credential that reaches git history is compromised
forever — deleting the file does not remove it from history. If you do it by
accident, rotate the credential immediately and tell someone.

**Never take identity from the request body.** `dto.userId`, `body.actorId` and
friends are attacker-controlled. Use the authenticated principal.

**Never swallow an error.** `catch {}` turns a loud failure into a silent one.
If you truly must ignore an error, say why in a comment.

**Never disable a type check to make the build pass.** `any`, `as any`,
`@ts-ignore` and `!` all move a compile-time error to runtime, where it costs
far more. `@ts-expect-error` with a written reason is acceptable; `@ts-ignore`
is not.

**Never commit build output.** `dist/`, `*.tsbuildinfo` and compiled `.d.ts`
files next to their sources are generated. Committing them is how this project
ended up compiling its API against a stale declaration file.

---

## 6. Pull requests

- One logical change per PR. A 600-line diff does not get read carefully.
- Fill in the template. "What changes and why" is the most valuable part.
- Point the reviewer at the part you are least confident about.
- Expect review comments about the checklist above. That is the process working.

---

## 7. When you are stuck

Say so early, in writing, with what you have already tried. An unresolved
question posted at 10:00 costs the team minutes. The same question discovered at
17:00 on a Friday costs the weekend.

---

## 8. Known gaps

Honesty about what is missing is more useful than a confident README. Currently:

- The API persists to an **in-memory store** (`@oneteam/database`). Data does not
  survive a restart. The real PostgreSQL/Supabase schema exists in
  `supabase/migrations/` but is not wired up.
- `apps/api/tsconfig.json` sets `strict: false`, so the API is type-checked less
  strictly than the rest of the workspace.
- There is no webhook signature verification on the Telegram endpoint.
- The portal has no authentication.

See `docs/ENGINEERING-STANDARDS.md` for the plan and priority order.
