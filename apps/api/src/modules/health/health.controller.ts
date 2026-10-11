import { Controller, Get } from '@nestjs/common';
import { db } from '@oneteam/database';
import { StorageService } from '../storage/storage.service';

/**
 * Liveness probe — deliberately unauthenticated.
 *
 * WHY THIS EXISTS
 * ---------------
 * The container healthcheck used to request `/api/tasks`. That route sits
 * behind AuthGuard and therefore answers 401 to every unauthenticated caller.
 * `wget --spider` treats any non-2xx response as a failure, so the healthcheck
 * reported the container as unhealthy while it was serving traffic correctly.
 *
 * That is not cosmetic. A platform that gates a release on its healthcheck will
 * roll back a working deployment, and a compose file using
 * `depends_on: condition: service_healthy` will refuse to start anything that
 * depends on this service. Both failure modes look like "the app is broken"
 * when the app is fine.
 *
 * A healthcheck answers exactly one question: is this process alive and able to
 * serve? It must not require credentials, and it must not query the database —
 * a database hiccup should not be reported as a dead process.
 *
 * WHY IT STILL REPORTS THE DATABASE
 * ---------------------------------
 * Everything below is a value *recorded once* by `db.init()` at start-up, not a
 * live query, so the rule above still holds: a database that goes down after
 * start-up cannot make this endpoint fail.
 *
 * That distinction is the whole point of the fields. The worst failure this
 * project has had was not a crash — it was a fully healthy-looking API running
 * on in-memory seed data while every write was silently discarded, and a
 * second one where the code needed a column the database did not have. Both
 * were invisible from outside. `persistence` and `schema` exist so that the
 * first question an operator asks — "is it actually saving anything, and does
 * the database look like what this build expects?" — has an answer that can be
 * read from a URL.
 *
 * The response is always HTTP 200, even when `schema.ok` is false. A schema
 * mismatch is a real problem, but it is not a dead process, and reporting it as
 * one would take the API out of service and roll back the deploy that could
 * have told you about it.
 */
@Controller('api/health')
export class HealthController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  check() {
    return {
      status: 'ok',
      service: 'oneteam-api',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: Date.now(),

      // Which storage the repository decided to use at start-up.
      //
      // Only the MODE is public. `persistenceDetail` ("postgres — N users, N
      // stores …") carries live row counts, and the storage `detail` carries
      // the S3 bucket name and endpoint — infrastructure facts an anonymous
      // caller has no need for. This endpoint is unauthenticated and, through
      // the nginx proxy, reachable from the internet, so it answers "alive,
      // saving, schema OK" without naming the bucket or counting the rows.
      persistence: db.persistence,

      // Whether the database actually has the tables and columns this build
      // queries, and whether the migrations needed to get it there were applied.
      // Kept (the production smoke test asserts these are clean); table and
      // migration names are far less sensitive than a bucket address.
      schema: {
        ok: db.schemaOk,
        detail: db.schemaDetail,
        migrationsApplied: db.migrations?.applied ?? [],
        migrationsAlreadyApplied: db.migrations?.alreadyApplied ?? [],
        missingTables: db.schema?.missingTables ?? [],
        missingColumns: db.schema?.missingColumns ?? [],
        columnsChecked: db.schema?.checked ?? 0,
      },

      // Only the driver is public — not the bucket name or endpoint. `inline`
      // vs `s3` is what the smoke test checks; the address behind an `s3` driver
      // is infrastructure disclosure and is no longer returned here.
      photoStorage: { driver: this.storage.description.driver },

      // Whether this process would notice another replica's writes.
      //
      // Reads come from an in-memory snapshot, so a second replica is only
      // correct if it polls the shared change counter. An operator running more
      // than one replica needs to be able to see that this is on, and what the
      // worst-case staleness is, without reading the source.
      replicaSync: {
        enabled: db.refreshIntervalMs > 0,
        intervalMs: db.refreshIntervalMs,
        detail: db.refreshDetail,
        reloadsSinceStart: db.refreshCount,
        lastReloadAt: db.lastRefreshAt?.toISOString() ?? null,
        // The honest number: a replica is at most one interval behind, plus
        // however long a reload takes.
        worstCaseStalenessMs: db.refreshIntervalMs > 0 ? db.refreshIntervalMs : null,
      },
    };
  }
}
