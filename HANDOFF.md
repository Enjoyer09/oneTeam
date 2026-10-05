# HANDOFF — oneTeam, for the next coding agent

# =============================================================================

#

# Read this first. It maps the state of the work and — more importantly — the

# things that are easy to get wrong here. Much of it is not derivable from the

# code: several entries describe bugs that were FIXED and why the fix was shaped

# the way it was, so they are not repeated.

#

# Written 2026-10-03. Verify anything load-bearing before relying on it; this

# document is a starting point, not an authority.

#

# =============================================================================

# 1. WHAT THIS IS

# =============================================================================

#

# oneTeam: retail shelf monitoring for FMCG distribution. Supervisors dispatch

# merchandising tasks and planograms; field merchandisers submit shelf photos

# and telemetry from a Telegram bot or an iOS app; supervisors review and

# approve from a web portal.

#

# web/ React + Vite admin & supervisor portal (private key login)

# mobile/ Expo / React Native iOS app (offline-first queue)

# src/ Telegram bot (grammY) + vision services

# apps/api/ NestJS API — the ONLY thing that touches the database

# packages/ @oneteam/types, @oneteam/database

#

# There is no Supabase. The database is plain PostgreSQL 16 and the API is an

# in-memory replica with write-through persistence. All three clients are API

# clients; none opens a database connection.

#

# Production: 4 Railway services (api, bot, web, Postgres)

# api https://api-production-c17b.up.railway.app

# web https://web-production-1392e.up.railway.app

# Railway deploys from GitHub on push to main. There is no railway.json; the

# project is configured in the Railway dashboard.

#

# =============================================================================

# 2. RUNNING IT

# =============================================================================

#

# npm run gate # the full local gate — RUN THIS BEFORE YOU PUSH

# npm run gate:fast # everything except the test suite (~25s)

#

# Individual suites worth knowing:

# npm run test:all # all hermetic suites (~60s), no database needed

# npm run test:live # DB-backed suites; needs a running PostgreSQL

# npm run type-check # root tsconfig

# npm run web:check # web/ — NOT covered by the root tsconfig (§9)

#

# =============================================================================

# 3. ⭐ THE PUSH GATE — WHY YOU MUST USE IT

# =============================================================================

#

# GITHUB ACTIONS DOES NOT RUN FOR THIS REPOSITORY. It has failed on every push

# since 2026-09-20 with:

#

# "The job was not started because recent account payments have failed or

# your spending limit needs to be increased."

#

# The repo is private, so Actions minutes are metered, and the account is out of

# credit. The owner has decided not to pay. So the checks were moved LOCALLY:

#

# =============================================================================

# 4. TEST PHILOSOPHY — READ BEFORE WRITING A TEST

# =============================================================================

#

# Every new guard in this repo was BROKEN ON PURPOSE after being written, to

# confirm it turns red. Three stayed green the first time, and those were the

# instructive failures:

#

# - The portal silent-success guard passed while `runAction` still returned

# `void` — it checked the handlers but not the contract they depend on.

# - The ROI guard passed with `padRatio: 0`. "The crop contains every box" is

# also true of a crop taken exactly to the union edge, which is precisely

# what clips product. Fixed by asserting the margin against the CONFIGURED

# pad, not just `> 0`.

# - An ROI case asserted a lone edge detection would crop. The code refused and

# the code was RIGHT. The test was wrong, and now says so in a comment.

#

# So: after writing a test, deliberately break the code it guards and confirm the

# test goes red. If it does not, the test is not testing the thing.

#

# Also: when a test fails and the CODE is right, fix the test and say so in a

# comment. That happened twice above and both comments are load-bearing.

#

# =============================================================================

# 5. WHAT IS DONE

# =============================================================================

#

# Plan phase 1 (security, panel CRUD, roles) — done, deployed.

# Plan phase 2 (bot inline keyboard, session store, notifications) — done.

# Plan 3.1-3.5 (Expo app) — partial; blocked by the environment, not the code

# (see §7). 4.1, 4.2, 4.3 — done (this session).

# Plan 4.4 (BullMQ worker), 4.5 (fallback), 4.6 (DPA doc) — NOT started.

# Plan 5 (E2E, load test, operator guide, demo) — NOT started.

#

# Recent commits worth reading in full, in this order:

#

# 58c2dab Portal reported success when a write had FAILED. `runAction`

# returned void, so callers could not tell success from failure and

# destroyed the user's work assuming it had succeeded.

# deb9cf6 Auto-approve could fire on a submission with NO LOCATION. The gate

# checked `locationMocked` (the device says this is a lie) but not

# `locationUnverified` (there was no fix at all). The Telegram bot has

# a skip button; the API then substitutes the store's own coordinates,

# so the geofence passes by construction. The one channel that cannot

# prove location was the one that never had to.

# 53ba3ad Moved CI locally (§3). Found while building it: `web/` is not in

# the root tsconfig, so the portal's types were NEVER checked by any

# gate, including the GitHub one.

# 8d87e64 Verdict schema + ROI pre-filter (§6).

#

# =============================================================================

# 6. THE VISION LAYER — WHAT 4.1-4.3 SET UP, AND WHAT IS STILL MISSING

# =============================================================================

#

# src/services/vision/ is the seam. Read types.ts first: it explains why the

# layer exists and what a `VisionProvider` must be.

#

# index.ts the edge: reads env, returns a provider or null

# types.ts the interface — read this one

# hybridProvider.ts YOLO-then-LLM escalation. combineHybrid is pure

# llmProvider.ts judges a VisionLLMClient's answer

# openrouterClient.ts 4.1 — transport, 20/min token bucket, retries only 429

# verdict.ts 4.2 — zod schema + triage (NEW)

# roi.ts 4.3 — crop decision + refusal reasons (NEW)

#

# WHAT IS DELIBERATELY OFF. `ONETEAM_VISION_PROVIDER` defaults to `off`, so

# nothing judges shelf photos in production today. That is the intended state,

# not an oversight. Do not flip it on without the operator deciding, and read

# the external-call warning in index.ts first.

#

# 4.1's retry policy is worth internalising: 429 is the ONLY retried status. A

# 401 or a 402 must throw on the first attempt — retrying a wrong key or a spent

# balance turns a config error into minutes of silence before the same verdict.

#

# =============================================================================

# 7. ENVIRONMENT LIMITS — MEASURED, NOT ASSUMED

# =============================================================================

#

# `npm install` in mobile/ FAILS in the agent sandbox: `reify:createSparse`

# → mkdir denied. It is not a package-count problem — 400 sequential and 50

# parallel mkdirs succeed; 200+ parallel ones are refused, and the budget does

# not recover. npm and pnpm both build their tree with one Promise.all. The

# measurements are in docs/PRODUCT-PLAN-AZ.md §3.1.

#

# Consequence: `npm run mobile:ios` and the Xcode UI tests cannot run here. That

# is why those two checks are SKIPPED rather than failing.

#

# =============================================================================

# 8. PRODUCTION STATE — WHAT IS SET, AND THE TWO TRAPS

# =============================================================================

#

# Set on Railway (api AND bot unless noted):

# DATABASE_URL, CORS_ALLOWED_ORIGINS, TELEGRAM_BOT_TOKEN,

# TELEGRAM_WEBHOOK_SECRET, ONETEAM_ENROLLMENT_SECRET

# STORAGE_DRIVER=s3, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID,

# S3_SECRET_ACCESS_KEY, S3_REGION, S3_FORCE_PATH_STYLE, S3_PUBLIC_BASE_URL

# ONETEAM_SERVICE_SIGNING_SECRET (32 bytes of randomness)

# ONETEAM_ALLOW_LEGACY_SERVICE_TOKEN=false

# ONETEAM_SERVICE_USER_ID (bot only)

#

# NOT SET — both are known, both are open:

#

# OPENROUTER_API_KEY + OPENROUTER_MODEL

# 4.1-4.3 are shipped but unreachable until the operator supplies a key.

# Without it `resolveVisionProvider` returns null for vision-llm/hybrid,

# which is correct behaviour, not a bug.

#

# DATABASE_URL for GitHub Actions

# `db-backup.yml` fails daily because the secret is absent AND because

# Railway's Postgres is on a private network a hosted runner cannot reach.

# Fixing it means either a public endpoint or a Railway cron service. Do not

# put the production DB password into GitHub without the owner's explicit

# agreement.

#

# TRAP 1 — the signing secret must be set on BOTH api and bot. The bot mints a

# 5-minute token per request, and the API refuses unsigned credentials the

# moment the secret is non-empty. Set on the API alone and the bot is locked out,

# holding a static token that is already refused. The symptom is a silently

# broken bot, which is worse than the original hole.

#

# TRAP 2 — `ONETEAM_PANEL_BOOTSTRAP_KEY` is a way in before any personal panel

# key exists. Sign in, mint a real key, then UNSET it. Leaving it set means

# anyone holding it is an administrator.

#

# =============================================================================

# 9. KNOWN GAPS, IN THE ORDER THEY MATTER

# =============================================================================

#

# 1. No React test runner. There is no jsdom or testing-library, and `web/` has

# its own lockfile. The portal's guard is a source-level contract check

# (scripts/quality/portal-silent-success.test.mjs) and says so in its header:

# it cannot prove a modal stays open, only that nobody restored the broken

# shape. Adding a real runner is a decision for the owner.

#

# 2. `test:live` needs a database. Locally that means starting one. Until then

# the DB-backed paths have no automated coverage on this machine.

#

# 3. 298 lint warnings, 0 errors — mostly `no-explicit-any` and `no-console`.

# Not a correctness problem; it is noise that will hide a real one.

#

# 4. Dark mode is half-implemented: the theme toggle and the CSS variables

# exist, but several components still use hard-coded light Tailwind classes.

#

# 5. 20+ `<label>` elements have no `htmlFor`. Invisible in review; shows up in

# screen readers.

#

# 6. `yolov8n.pt` is a generic COCO model. It detects bottles, not SKUs, which

# is why the ROI pre-filter is a pre-filter and not an answer.

#

# =============================================================================

# 10. HOUSE RULES

# =============================================================================

#

# - Run `npm run gate` before you finish. If you cannot, say so explicitly

# rather than implying it passed.

# - Never make a failure look like a success. Not in a return value, not in a

# toast, not in a default field value, not in a test. Most of the bugs fixed

# this session were one of those wearing a costume.

# - Comments should explain WHY and name what was measured. "For readability"

# is worth deleting. A measured number in a comment outlives the person who

# wrote it — that is how the 47s cold start, the 0.12s mint TTL and the ~70%

# crop saving stay honest.

# - If you break something deliberately to prove a test works, say so in the

# commit message. Several commits here do exactly that, and it is the reason

# their test counts can be trusted.

#

# =============================================================================

# THE THREE THINGS 4.4 MUST WIRE TOGETHER (nothing calls 4.2/4.3 yet):

#

# 1. Run YOLO → DetectionItem[] with .box (0-100 frame fractions).

# 2. computeRoi(detections.map(d => d.box)) → either an ROI or a refusal.

# On 'none', send the FULL photo. On 'roi', crop, and pass roiNoteFor(...)

# into buildVerdictPrompt's `roiNote` option so the model knows it is

# looking at a crop.

# 3. Send image + buildVerdictPrompt(...) → OpenRouter → parseVerdict(raw)

# → assessVerdict(result).

#

# Then: `assessVerdict` returning 'human-review' must NEVER become a score. Feed

# it into the existing `needsHumanReview` on VisionAnalysis and let the existing

# hybrid logic do its job. The invariant the whole layer rests on: a model that

# could not be reached, or could not be read, has said NOTHING about the shelf,

# and must never be recorded as a low score.

#

# Worker choice for 4.4 is still OPEN and needs a decision: BullMQ + Redis

# (neither is in node_modules) or a DB-backed in-memory queue. Pick deliberately

# — the plan says BullMQ, but adding Redis to Railway is a new billable service.

#

# .githooks/pre-push refuses the push if any check fails

# scripts/quality/local-gate.mjs the 11 steps, same commands ci.yml ran

#

# `git push` runs gate:fast automatically (about 25s). To run everything:

#

# ONETEAM_GATE=full git push

#

# You can bypass with `git push --no-verify`, and that bypass is intentional —

# a gate that cannot be bypassed gets bypassed destructively. Use it when you

# have already run `npm run gate` yourself. (This file was itself pushed with

# --no-verify because the tool session timed out mid-gate; the gate had been run

# separately and was green.)

#

# Two checks CANNOT run locally and are reported as SKIPPED, never as passing:

# - `test:live` — needs a running PostgreSQL

# - iOS UI tests — need macOS + Xcode + a simulator (`npm run mobile:ios`)

#

# Do not "fix" a SKIP by reporting it as a pass. A gate that lies is worse than

# no gate.

#
