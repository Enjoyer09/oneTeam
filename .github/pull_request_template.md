<!--
  oneTeam pull request template.

  WHY: a PR is a request for someone else to take responsibility for your
  change. The reviewer should not have to reverse-engineer intent from a diff.
  Fill this in — delete the prompts you do not need, keep the headings.
-->

## What changes, and why

<!--
  One or two sentences. Lead with the problem, not the implementation.
  Good:  "Telegram task acknowledgement returned 403 for every user, so the
          feature never worked. Identity is now resolved from the chat-id
          mapping instead of the request body."
  Bad:   "Fix webhook.controller.ts"
-->

## How to verify

<!--
  Exact steps a reviewer can follow. If it cannot be verified, say so and
  explain why.
-->

1.
2.

## Risk

<!--
  What could this break? What did you deliberately NOT change? If the change
  touches authentication, money, personal data, or the database schema, say so
  explicitly — that changes who needs to review it.
-->

- Blast radius:
- Rollback plan:

## Checklist

- [ ] `npm run quality` passes locally (format, lint, type-check, tests)
- [ ] Tests added or updated for the behaviour that changed
- [ ] No new `any`, `@ts-ignore`, or non-null assertions without a written reason
- [ ] No credentials, tokens, or `.env` contents in the diff
- [ ] If the database schema changed, a migration is included and was applied to a scratch database
- [ ] If a public API or DTO changed, consumers were checked
- [ ] `docs/ENGINEERING-STANDARDS.md` updated if a convention changed

## Review focus

<!--
  Point the reviewer at the part you are least sure about. That is where the
  value of a review is. "LGTM" on a 600-line diff is not a review.
-->

- Please look closely at:

---

<!--
  REVIEWER NOTES (for whoever reviews)

  Approve only when you would be comfortable being paged at 02:00 for this
  change. Specifically check:

  1. Can this be abused? Is authorisation enforced server-side, and is identity
     taken from a trusted source rather than the request body?
  2. Does it fail loudly? Silent `catch {}`, swallowed promise rejections, and
     default fallbacks hide production failures.
  3. Is the test testing the real thing, or a mock of the real thing?
  4. Does it work on a phone, and with a keyboard only?
  5. Will the next person understand it in six months without asking you?
-->
