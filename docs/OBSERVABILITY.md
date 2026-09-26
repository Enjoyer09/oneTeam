# Observability

Status: **recommendations + TODO.** This document describes the target state and
the smallest useful first steps. The application code that would implement it
(`apps/api/src/**`, `src/**`) is out of scope for the current DevOps hardening
pass, so nothing here is wired yet unless a section says otherwise.

The three pillars — logs, metrics, traces — plus a request ID that ties them
together. Do them in that order; each is useful on its own.

## 1. Structured logging

Today the API and bot log through NestJS's `Logger` / `console`, which emits
human-readable lines. That is fine for a terminal and poor for a log platform:
you cannot filter by field, and multi-line stack traces fragment.

Target:

- Emit **one JSON object per line** (`{ "level", "time", "msg", "context", "requestId", ... }`).
  A drop-in is [`pino`](https://getpino.io) (`nestjs-pino` for the API); it is
  fast and defaults to line-delimited JSON.
- Keep logs on **stdout/stderr only**. The containers are stateless and the
  platform (Railway / `docker logs`) collects the stream; writing log files
  inside a container just fills the layer.
- **Never log secrets or full photo payloads.** The API already treats the bot
  token and DATABASE_URL as sensitive; a structured logger makes redaction a
  config list (`redact: ['req.headers.authorization', ...]`) rather than a habit.
- Levels: `error` for a failed request the caller could not fix, `warn` for a
  degraded-but-serving state (e.g. persistence fell back to memory), `info` for
  lifecycle and request summaries, `debug` off in production.

## 2. Request ID (correlation ID)

The single highest-value, lowest-cost step, so it is called out on its own.

- On every inbound HTTP request, read `X-Request-Id` if the caller sent one,
  otherwise generate a UUID. Echo it back on the response as `X-Request-Id`.
- Put it on a per-request context (NestJS: a middleware + `AsyncLocalStorage`, or
  `nestjs-pino`'s `genReqId`) so **every log line for that request carries the
  same `requestId`** without threading it through function signatures.
- **Propagate it across process hops.** The bot calls the API, and the API calls
  itself across replicas; forward the same `X-Request-Id` on those outbound calls
  so one field follows a shelf photo from Telegram through the API to the
  database write. Without this, correlating the bot's view with the API's is
  guesswork.

## 3. Metrics

- Expose Prometheus-style metrics at `/metrics` (`prom-client`, or
  `@willsoto/nestjs-prometheus`). Scrape from the platform's metrics agent.
- Start with the RED signals per route: **R**ate (requests/sec), **E**rrors
  (non-2xx/5xx count), **D**uration (latency histogram). These answer "is it up,
  is it fast, is it erroring" without any custom instrumentation.
- Add a few domain gauges that map to real incidents this project has had:
  - persistence driver in use (`memory` vs `postgres`) — a silent fallback to
    memory has bitten this system before (see `apps/api/src/main.ts`);
  - replica staleness / last successful refresh, since reads come from an
    in-memory snapshot;
  - offline-queue drain outcomes reported by the mobile client, if it reports.
- `/metrics` is unauthenticated by convention but should **not** be exposed to
  the public internet — scrape it over the private network, or guard it.

## 4. Tracing (later)

Once logs carry a request ID and metrics show where the time goes, distributed
tracing is the follow-up, not the starting point.

- Instrument with **OpenTelemetry** (`@opentelemetry/sdk-node`, auto-instrument
  HTTP and `pg`). Export OTLP to whatever the platform offers (Grafana Tempo,
  Honeycomb, Datadog, etc.).
- Reuse the request ID as (or alongside) the trace ID so a log line links to its
  span. The bot → API → Postgres path is the first trace worth having; it is the
  path a field submission actually travels.

## Health endpoint (already implemented)

`GET /api/health` exists and is unauthenticated by design. It reports liveness
plus the persistence driver and schema/migration status. The container
`HEALTHCHECK` and Compose healthchecks already use it. It is the readiness
signal a platform gates a release on — keep it cheap and dependency-light.

## Suggested rollout order

1. Request ID middleware + echo header. (small, immediate payoff)
2. Structured JSON logging with the request ID on every line.
3. `/metrics` with RED + the persistence/replica gauges.
4. OpenTelemetry tracing across bot → API → Postgres.
