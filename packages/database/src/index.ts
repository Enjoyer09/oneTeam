/**
 * oneTeam Retail Execution Platform — Database Layer & Repository
 *
 * The repository keeps its working set in memory and, when a PostgreSQL
 * connection string is configured, treats the database as authoritative:
 * `init()` hydrates the arrays from real rows at start-up, and every mutation
 * is written through. See postgres.ts for why the driver is `pg` and not
 * Prisma, and for the single-instance caveat that comes with it.
 */

export * from './seed';
export * from './types';
import { SEED_DATA } from './seed';
import { TaskState, UserRole } from '@oneteam/types';
import type { InMemoryStoreTask, InMemoryEvidence, InMemoryAuditLog, InMemoryStore } from './types';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as pg from './postgres';
import {
  runMigrations,
  checkSchema,
  describeSchemaHealth,
  type MigrationReport,
  type SchemaReport,
} from './migrations';
import type { Pool } from 'pg';

/**
 * Enterprise In-Memory Database Repository
 * Provides guaranteed 0-latency execution, seed state, and audit logs.
 */
export class EnterpriseDatabase {
  public users = [...SEED_DATA.users];
  public region = { ...SEED_DATA.region };
  public stores: InMemoryStore[] = [...SEED_DATA.stores];
  public campaign = { ...SEED_DATA.campaign };
  public templates = [...SEED_DATA.templates];
  public storeTasks: InMemoryStoreTask[] = [
    {
      id: 'task-yasamal-cooler-01',
      templateId: 'tmpl-cooler-check',
      storeId: 'str-bravo-yasamal',
      assignedUserId: 'usr-merch-003',
      status: TaskState.PUBLISHED,
      deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'task-ganjlik-eyelevel-02',
      templateId: 'tmpl-eye-level',
      storeId: 'str-araz-ganjlik',
      assignedUserId: 'usr-merch-003',
      status: TaskState.DRAFT,
      deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'task-portbaku-cooler-03',
      templateId: 'tmpl-cooler-check',
      storeId: 'str-bazarstore-portbaku',
      assignedUserId: 'usr-merch-003',
      status: TaskState.SUBMITTED,
      deadline: new Date(Date.now() + 4 * 24 * 3600 * 1000),
      publishedAt: new Date(Date.now() - 3600000),
      deliveredAt: new Date(Date.now() - 3000000),
      acknowledgedAt: new Date(Date.now() - 2400000),
      submittedAt: new Date(Date.now() - 600000),
      createdAt: new Date(Date.now() - 3600000),
      updatedAt: new Date(Date.now() - 600000),
    },
  ];
  public evidences: InMemoryEvidence[] = [];
  public auditLogs: InMemoryAuditLog[] = [];

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private pool: Pool | null = null;

  /**
   * Where reads are actually coming from, reported through /api/health.
   *
   * This is deliberately public and explicit. The original bug was not that
   * the database was misconfigured — it was that nothing anywhere said the
   * database was unused, so the application looked healthy while losing every
   * write on restart.
   */
  public persistence: 'postgres' | 'memory' = 'memory';
  public persistenceDetail = 'DATABASE_URL is not set — running on seed data';

  /**
   * What the schema actually looks like, as opposed to what it should.
   *
   * Recorded once at start-up and reported through /api/health, so that
   * "the code needs a column that nobody added" is a sentence someone can read
   * rather than a log line nobody does. That failure has now happened twice in
   * this project; it is worth a field.
   */
  public migrations: MigrationReport | null = null;
  public schema: SchemaReport | null = null;
  public schemaOk = false;
  public schemaDetail = 'schema has not been checked yet';

  // -------------------------------------------------------------------------
  // Cross-replica refresh
  //
  // THE PROBLEM THIS SOLVES
  // -----------------------
  // Everything above is read from in-memory arrays. They are hydrated once at
  // start-up and updated in place by this process's own writes. That is correct
  // for one process and silently wrong for two: a second replica hydrates at
  // boot and never learns about anything the first one wrote afterwards. It does
  // not fail, it does not log, and it reports a healthy status — it just answers
  // with yesterday's data indefinitely.
  //
  // The mechanism is a counter in the database (`data_version`, bumped by
  // triggers on every table the snapshot reads) which is polled on an interval.
  // When it has moved, the snapshot is reloaded.
  //
  // THE STALENESS WINDOW, STATED PLAINLY
  // ------------------------------------
  // A replica's view is at most one interval out of date, plus the time the
  // reload itself takes. With the default of 1000 ms, a write on replica A is
  // visible on replica B within roughly a second. That is the trade: reads stay
  // in-memory and instant, and cross-replica visibility is bounded rather than
  // immediate.
  //
  // For a deployment that runs a single replica — which is the current one — the
  // polling finds nothing and costs one row read per second. Set
  // `ONETEAM_REFRESH_MS=0` to turn it off entirely.
  // -------------------------------------------------------------------------

  /** How often the change counter is polled. 0 disables the loop. */
  public refreshIntervalMs = 0;
  /** When the snapshot was last reloaded because the counter moved. */
  public lastRefreshAt: Date | null = null;
  /** How many reloads have happened since start-up. */
  public refreshCount = 0;
  /** A sentence for /api/health describing whether replicas converge. */
  public refreshDetail =
    "refresh is off — reads are this process's memory, and a second replica would not converge";

  private observedVersion: number | null = null;
  /**
   * Writes handed to the database but not yet acknowledged.
   *
   * A reload is skipped while any are outstanding. Without this, a replica could
   * reload from a snapshot taken before its own write committed and visibly
   * revert its own change for an interval — the kind of flicker that is
   * impossible to reproduce and easy to blame on something else.
   */
  private pendingWrites = 0;

  /**
   * The tail of the write queue. See `persist()` for why writes are ordered.
   *
   * Typed `unknown` rather than `void` because the value is never read — it
   * exists only so the next write can be appended to it.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  /**
   * Connects to PostgreSQL and replaces the seeded arrays with real rows.
   *
   * RETRIES, BECAUSE THE DEPLOY RACE IS REAL
   * ----------------------------------------
   * A platform starts every service in a release at once. The database takes
   * noticeably longer to become ready than an application container does, so
   * the API regularly reaches its first query before Postgres is accepting
   * connections. Observed on Railway: API started 15:36:38, Postgres ready
   * 15:36:40 — a two-second gap that, with a single attempt, left the API
   * permanently on in-memory seed data while reporting a healthy status.
   *
   * That is the exact failure this whole change exists to remove, so the first
   * connection is retried for a bounded window rather than attempted once.
   *
   * Failure is still logged and survived rather than fatal: a database that is
   * genuinely unavailable should not take the API down with it, and the API is
   * still useful on seed data. What must not happen is failing silently, so the
   * mode is logged at error level and surfaced by /api/health.
   */
  public async init(options?: { attempts?: number; delayMs?: number }): Promise<void> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      this.schemaDetail = 'schema was not verified: DATABASE_URL is not set';
      console.warn(
        '⚠️  [oneTeam DB] DATABASE_URL is not set. Running entirely in memory — ' +
          'every task, evidence and audit entry will be lost on restart.',
      );
      return;
    }

    const attempts = options?.attempts ?? 12;
    const delayMs = options?.delayMs ?? 3_000;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // A fresh pool per attempt: a pool that failed to connect is not
        // necessarily reusable, and leaking one per retry would hold sockets.
        if (this.pool) await this.pool.end().catch(() => undefined);
        this.pool = pg.createPool(connectionString);

        await pg.ping(this.pool);

        // ------------------------------------------------------------------
        // Bring the schema up to date BEFORE reading anything.
        // ------------------------------------------------------------------
        // Order matters. A database that predates a column loads perfectly well
        // — `SELECT *` simply does not return the missing column — and then
        // fails every write that touches it. That is precisely how a bound
        // device came to exist in memory and nowhere else: the bind reported
        // success, and the insert failed into a log line. Migrating first means
        // the read that follows sees the schema the code expects.
        //
        // Set ONETEAM_AUTO_MIGRATE=0 to turn this off, for a deployment where
        // the schema is managed by something else.
        if (process.env.ONETEAM_AUTO_MIGRATE !== '0') {
          this.migrations = await runMigrations(this.pool);
          for (const applied of this.migrations.applied) {
            console.log(`🔧 [oneTeam DB] Applied migration ${applied}`);
          }
          for (const problem of this.migrations.problems) {
            console.error('⛔ [oneTeam DB] Migration problem: ' + problem);
          }
        }

        // Caught separately from the connection handling below, so that a
        // failed check cannot discard a working connection.
        try {
          this.schema = await checkSchema(this.pool);
        } catch (error) {
          this.schema = null;
          console.warn('⚠️  [oneTeam DB] Schema check could not run: ' + describeError(error));
        }

        const schemaHealth = describeSchemaHealth(this.migrations, this.schema);
        this.schemaOk = schemaHealth.ok;
        this.schemaDetail = schemaHealth.detail;

        if (schemaHealth.ok) {
          console.log('✅ [oneTeam DB] Schema verified — ' + schemaHealth.detail);
        } else {
          console.error(
            '⛔ [oneTeam DB] The database schema is not what this build expects. ' +
              schemaHealth.detail,
          );
        }

        const state = await pg.loadAll(this.pool);

        if (state.users.length > 0) {
          this.users = state.users as typeof this.users;
          if (state.region) this.region = state.region as typeof this.region;
          this.stores = state.stores as typeof this.stores;
          if (state.campaign) this.campaign = state.campaign as typeof this.campaign;
          this.templates = state.templates as typeof this.templates;
          this.storeTasks = state.storeTasks;
          this.evidences = state.evidences;
          this.auditLogs = state.auditLogs;
        } else {
          console.warn(
            '⚠️  [oneTeam DB] Connected, but the users table is empty. Keeping the ' +
              'built-in seed data in memory. Run db/api-seed.sql against this database.',
          );
        }

        this.persistence = 'postgres';
        this.persistenceDetail =
          `postgres — ${this.users.length} users, ${this.stores.length} stores, ` +
          `${this.storeTasks.length} tasks, ${this.evidences.length} evidences, ` +
          `${this.auditLogs.length} audit entries`;
        console.log('✅ [oneTeam DB] ' + this.persistenceDetail);

        // Started only now: the snapshot is loaded, so there is a baseline to
        // compare against. Starting it earlier would poll a counter with nothing
        // to reload.
        this.startRefreshLoop();

        // Said out loud at start-up, because both situations are invisible from
        // the outside and both are the operator's to fix. A configured bootstrap
        // key that is being refused is the more urgent of the two: the panel
        // will be asking for a key that nothing satisfies until it is replaced.
        const bootstrapProblem = panelBootstrapProblem();
        if (bootstrapProblem) {
          console.error('⛔ [oneTeam DB] ' + bootstrapProblem);
        } else if (panelBootstrapKey()) {
          console.warn(
            '🔑 [oneTeam DB] ONETEAM_PANEL_BOOTSTRAP_KEY is active. Sign in with it, ' +
              'mint a personal key for yourself, then remove the variable — it is a ' +
              'master key and does not need to stay.',
          );
        }
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        if (attempt < attempts) {
          console.warn(
            `⏳ [oneTeam DB] Attempt ${attempt}/${attempts} failed (${reason}). ` +
              `Retrying in ${Math.round(delayMs / 1000)}s — the database is often still ` +
              'starting when the application container is already up.',
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        if (this.pool) {
          await this.pool.end().catch(() => undefined);
        }
        this.pool = null;
        this.persistence = 'memory';
        this.persistenceDetail = 'postgres unavailable: ' + reason;
        this.schemaOk = false;
        this.schemaDetail = 'schema was not verified: the database was unreachable';
        console.error(
          `⛔ [oneTeam DB] Gave up after ${attempts} attempts. Falling back to in-memory ` +
            'seed data; writes will NOT survive a restart. Reason: ' +
            reason,
        );
      }
    }
  }

  /**
   * Starts polling the shared change counter.
   *
   * Called at the end of a successful `init()`. Never started when there is no
   * database: with nothing to poll there is nothing to converge to, and a timer
   * that cannot do its job is worse than no timer.
   */
  public startRefreshLoop(): void {
    const configured = Number(process.env.ONETEAM_REFRESH_MS);
    // Default 1000 ms. `0` is an explicit opt-out; anything unparseable falls
    // back to the default rather than to 0, because a typo in an environment
    // variable should not silently disable cross-replica consistency.
    const interval = Number.isFinite(configured) && configured >= 0 ? configured : 1000;

    this.stopRefreshLoop();
    this.refreshIntervalMs = interval;

    if (!this.pool) {
      this.refreshDetail = 'refresh is off — no database connection';
      return;
    }

    if (interval === 0) {
      this.refreshDetail =
        "refresh is OFF (ONETEAM_REFRESH_MS=0) — a second replica would never see this one's writes";
      console.warn('⚠️  [oneTeam DB] ' + this.refreshDetail);
      return;
    }

    this.refreshDetail = `polling the change counter every ${interval}ms`;
    this.refreshTimer = setInterval(() => {
      void this.refreshIfChanged();
    }, interval);
    // Node would otherwise hold the process open for the sake of a poll that
    // only matters while the process is serving.
    this.refreshTimer.unref?.();

    console.log(
      `🔄 [oneTeam DB] Cross-replica refresh every ${interval}ms — a write on another ` +
        'replica becomes visible here within about that long.',
    );
  }

  /** Stops the loop. Used by shutdown and by tests that need a quiet process. */
  public stopRefreshLoop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Reloads the snapshot if the counter has moved.
   *
   * Public so it can be driven directly by a test, which is the only way to
   * check convergence without waiting on a timer and hoping.
   */
  public async refreshIfChanged(): Promise<boolean> {
    if (!this.pool || this.refreshing) return false;

    // See `pendingWrites`. Deferring rather than reloading is the safe
    // direction: the next tick will pick the change up.
    if (this.pendingWrites > 0) return false;

    this.refreshing = true;
    try {
      const version = await pg.readDataVersion(this.pool);

      // `null` means "could not tell" — a database that predates the migration,
      // or a momentary error. Treating that as "unchanged" is right; treating it
      // as "changed" would reload on every tick forever.
      if (version === null) return false;

      if (this.observedVersion === null) {
        // First poll after start-up. The snapshot was just loaded, so adopt the
        // current counter as the baseline rather than reloading immediately.
        this.observedVersion = version;
        return false;
      }

      if (version === this.observedVersion) return false;

      const state = await pg.loadAll(this.pool);

      // Only replace the arrays if the reload produced something usable. A
      // database that momentarily returns no users must not blank the working
      // set — the same guard `init()` applies, for the same reason.
      if (state.users.length === 0) return false;

      this.users = state.users as typeof this.users;
      if (state.region) this.region = state.region as typeof this.region;
      this.stores = state.stores as typeof this.stores;
      if (state.campaign) this.campaign = state.campaign as typeof this.campaign;
      this.templates = state.templates as typeof this.templates;
      this.storeTasks = state.storeTasks;
      this.evidences = state.evidences;
      this.auditLogs = state.auditLogs;

      this.observedVersion = version;
      this.refreshCount += 1;
      this.lastRefreshAt = new Date();
      this.persistenceDetail =
        `postgres — ${this.users.length} users, ${this.stores.length} stores, ` +
        `${this.storeTasks.length} tasks, ${this.evidences.length} evidences, ` +
        `${this.auditLogs.length} audit entries`;
      return true;
    } catch (error) {
      // A failed poll leaves the previous snapshot in place, which is stale but
      // usable, and the next tick retries. Throwing here would take down a timer
      // nobody is awaiting.
      console.warn(
        '⚠️  [oneTeam DB] Refresh failed, keeping the previous snapshot: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Fire-and-forget write-through, in submission order.
   *
   * The callers are synchronous and stay that way — see the note in
   * postgres.ts. A failed write is logged loudly rather than thrown: an audit
   * row that cannot be written should not fail the business operation that
   * produced it, but it must be visible in the logs.
   *
   * WHY THIS IS A QUEUE AND NOT A BARE PROMISE
   * ------------------------------------------
   * It used to accept an already-started promise, so every write ran
   * concurrently on its own pool connection and the order in which they reached
   * PostgreSQL was whatever the scheduler decided. That is harmless until one
   * row is the parent of another, and then it is silent data loss. Observed on
   * a device's first enrolment, which queues four writes at once:
   *
   *   - `users`         — the row this installation is about to become
   *   - `store_tasks`   — the claim on the store's open work
   *   - `audit_logs`    — the record that the enrolment happened
   *   - `device_tokens` — the credential, the only one of the four awaited
   *
   * The first three lost the race. The response said
   * `claimedTaskIds: ["task-yasamal-cooler-01"]` and the log said
   * `claimed 1 task(s)`, while the database held neither the claim nor the
   * audit entry. `device_tokens` failed with a foreign-key violation that
   * escaped as a bare HTTP 500, so the phone was told the sign-in had failed
   * for no stated reason. Intermittent, and only under load — the kind of fault
   * that gets blamed on the network and never reproduced.
   *
   * Taking a thunk instead of a promise is the fix. The query is not created
   * until its turn comes, so a child row cannot be written before the parent it
   * references. One rule, applied once, for every table.
   *
   * The cost is throughput: writes no longer overlap. This repository is the
   * single writer for a single-replica pilot, and a lost claim or a missing
   * audit record is worse than a slower write, so the trade is made
   * deliberately. If a hot path ever genuinely needs concurrency, give it its
   * own pool and keep this guarantee for anything with a foreign key.
   *
   * A failed write does not stall the queue: the error is caught here, so the
   * next thunk still runs. Without that, one failing parent write would leave
   * every dependent write rejected for the life of the process.
   */
  private persist(op: (pool: Pool) => Promise<unknown>, label: string): void {
    void this.enqueue(op, label).catch((error) => {
      console.error(
        `⛔ [oneTeam DB] Failed to persist ${label}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    });
  }

  /**
   * Appends a write to the queue and hands back the promise for that link.
   *
   * The queue exists so a child row is never written before its parent; see
   * `persist()` for the failure that made that necessary. `persist()` is the
   * fire-and-forget wrapper over this. This method exists separately because a
   * few writes have a result the caller must act on — issuing a credential is
   * the one that matters, since a token that could not be stored must not be
   * handed out.
   *
   * The returned promise rejects if the write failed, so an awaiting caller can
   * fail closed. The queue's own tail never rejects, so one bad write does not
   * poison every write behind it.
   *
   * WHAT IS DELIBERATELY NOT QUEUED
   * -------------------------------
   * Inserts and updates to a row that must already exist are left as direct
   * awaits — the four revocation methods, and the two "last seen" touches, which
   * do go through `persist()` but only ever update an existing row. They are
   * idempotent, they report a result the caller acts on, and they have no
   * ordering dependency on anything submitted in the same tick, so putting them
   * behind the queue would buy nothing and make their return types awkward.
   *
   * The rule is about *dependencies*, not about writes in general: if a write
   * can only succeed once another write has landed, it goes through here.
   */
  private enqueue(op: (pool: Pool) => Promise<unknown>, label: string): Promise<unknown> {
    // Captured rather than read inside the thunk: `close()` sets `this.pool` to
    // null, and a write already queued should still go to the pool it was
    // queued against rather than throw a TypeError.
    const pool = this.pool;
    if (!pool) return Promise.resolve();

    this.pendingWrites += 1;
    const attempt = this.writeQueue.then(() => op(pool));

    this.writeQueue = attempt
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.pendingWrites -= 1;
      });

    return attempt;
  }

  /** Closes the pool. Used by tests and by graceful shutdown. */
  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Records immutable audit trail event
   */
  public logAuditEvent(params: {
    entityType: string;
    entityId: string;
    action: string;
    fromState?: string;
    toState?: string;
    actorId?: string;
    payload?: any;
  }): InMemoryAuditLog {
    const entry: InMemoryAuditLog = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      fromState: params.fromState,
      toState: params.toState,
      actorId: params.actorId,
      payload: params.payload,
      createdAt: new Date(),
    };
    this.auditLogs.push(entry);
    if (this.pool) this.persist((pool) => pg.insertAuditLog(pool, entry), `audit ${entry.id}`);
    return entry;
  }

  /**
   * Adds a store task and waits for it to reach the database.
   *
   * WHY THIS AWAITS, ALTHOUGH IT USED NOT TO
   * ----------------------------------------
   * Store tasks are only ever created by a supervisor dispatching a briefing
   * from the panel — there is no field-worker path that creates one. So the
   * caller is always someone who just pressed a button and expects to see the
   * result. Firing the insert and returning meant a failed write was reported
   * as "12 tasks created" while the database held nothing.
   *
   * The foreign key makes that worse than it sounds: `store_tasks.template_id`
   * references `task_templates`, so if the template's own insert did not land,
   * every store task insert fails too — twelve failures, twelve reported
   * successes. Awaiting is what lets the caller tell the difference.
   *
   * On failure the in-memory push is undone, so the process's task list matches
   * what actually persisted.
   */
  public async createStoreTask(
    task: InMemoryStoreTask,
  ): Promise<{ task?: InMemoryStoreTask; error?: 'NOT_STORED' }> {
    this.storeTasks.push(task);

    if (this.pool) {
      try {
        await this.enqueue((pool) => pg.insertStoreTask(pool, task), `task ${task.id}`);
      } catch (error) {
        this.storeTasks = this.storeTasks.filter((candidate) => candidate.id !== task.id);
        console.error(`⛔ [oneTeam DB] Could not store task ${task.id}: ` + describeError(error));
        return { error: 'NOT_STORED' };
      }
    }

    return { task };
  }

  /**
   * Adds an evidence record and persists it.
   *
   * Replaces a direct `db.evidences.push(...)` in the evidence service.
   */
  public createEvidence(evidence: InMemoryEvidence): InMemoryEvidence {
    this.evidences.push(evidence);
    if (this.pool)
      this.persist((pool) => pg.insertEvidence(pool, evidence), `evidence ${evidence.id}`);
    return evidence;
  }

  // -------------------------------------------------------------------------
  // Stores
  //
  // These three are the only way the process's store list changes. Nothing
  // pushes to `this.stores` directly any more, for the same reason the task and
  // evidence helpers exist: an in-memory push that never reaches the database
  // survives until the next restart and then quietly disappears.
  //
  // WHY THESE AWAIT, UNLIKE THE TASK AND EVIDENCE HELPERS
  // -----------------------------------------------------
  // `createStoreTask` and `createEvidence` fire the write and return, because a
  // field worker's photo must not be refused for a database hiccup — it is
  // already captured, and the audit trail is worth more than the round trip.
  // A store is different in kind: a supervisor types a code, an address and
  // coordinates, and expects to see the store in the list afterwards. Reporting
  // "created" for a row that failed to insert produces a store that exists
  // until the next deploy and then vanishes — the exact failure this project
  // has paid for more than once. So these go through `enqueue()` and wait, and
  // a failure is reported as a failure.
  // -------------------------------------------------------------------------

  /** PostgreSQL's unique-violation code. */
  private static readonly PG_UNIQUE_VIOLATION = '23505';

  /**
   * Creates a store.
   *
   * The caller supplies the editable fields; the id and the two timestamps are
   * minted here rather than accepted, so no caller can invent a colliding id or
   * backdate a store's creation.
   *
   * Returns null when the store could not be persisted. The in-memory push is
   * undone in that case: leaving the store visible in a list it will not
   * survive is worse than not creating it, because the operator has no way to
   * tell the difference until the data is gone.
   */
  public async createStore(params: {
    storeCode: string;
    name: string;
    regionId?: string;
    chainName?: string;
    storeFormat?: InMemoryStore['storeFormat'];
    address: string;
    city?: string;
    latitude: number;
    longitude: number;
    isActive?: boolean;
  }): Promise<{ store?: InMemoryStore; error?: 'DUPLICATE_CODE' | 'NOT_STORED' }> {
    const now = new Date();
    const store: InMemoryStore = {
      id: `str-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      storeCode: params.storeCode,
      name: params.name,
      regionId: params.regionId ?? this.region.id,
      chainName: params.chainName ?? 'Bravo',
      storeFormat: params.storeFormat ?? 'supermarket',
      address: params.address,
      city: params.city ?? 'Bakı',
      latitude: params.latitude,
      longitude: params.longitude,
      isActive: params.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.stores.push(store);

    if (this.pool) {
      try {
        await this.enqueue((pool) => pg.insertStore(pool, store), `store ${store.id}`);
      } catch (error) {
        this.stores = this.stores.filter((candidate) => candidate.id !== store.id);
        const code = (error as { code?: string } | null)?.code;
        if (code === EnterpriseDatabase.PG_UNIQUE_VIOLATION) {
          return { error: 'DUPLICATE_CODE' };
        }
        console.error(
          `⛔ [oneTeam DB] Could not store the new store ${store.storeCode}: ` +
            describeError(error),
        );
        return { error: 'NOT_STORED' };
      }
    }

    return { store };
  }

  /**
   * Applies an edit to an existing store.
   *
   * Returns the updated row, or null when no store has that id — the caller
   * turns that into a 404 rather than reporting a successful no-op. Only the
   * fields present in `changes` are touched, so "deactivate" and "rename" are
   * the same call.
   *
   * The previous values are captured before the edit and restored if the write
   * fails, so an edit that did not reach the database does not leave the
   * process showing a change it will lose on restart.
   */
  public async updateStore(
    storeId: string,
    changes: Partial<
      Pick<
        InMemoryStore,
        | 'storeCode'
        | 'name'
        | 'chainName'
        | 'storeFormat'
        | 'address'
        | 'city'
        | 'latitude'
        | 'longitude'
        | 'isActive'
      >
    >,
  ): Promise<{ store?: InMemoryStore; error?: 'NOT_FOUND' | 'DUPLICATE_CODE' | 'NOT_STORED' }> {
    const store = this.getStore(storeId);
    if (!store) return { error: 'NOT_FOUND' };

    const before: InMemoryStore = { ...store };

    // Undefined means "not mentioned", which is not the same as "set to
    // undefined". Spreading the changes directly would let a field the caller
    // omitted overwrite a real value with nothing.
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) (store as any)[key] = value;
    }
    store.updatedAt = new Date();

    if (this.pool) {
      try {
        await this.enqueue((pool) => pg.updateStoreRow(pool, store), `store ${store.id} edit`);
      } catch (error) {
        Object.assign(store, before);
        const code = (error as { code?: string } | null)?.code;
        if (code === EnterpriseDatabase.PG_UNIQUE_VIOLATION) {
          return { error: 'DUPLICATE_CODE' };
        }
        console.error(
          `⛔ [oneTeam DB] Could not save the edit to store ${store.storeCode}: ` +
            describeError(error),
        );
        return { error: 'NOT_STORED' };
      }
    }

    return { store };
  }

  /**
   * Removes a store.
   *
   * Refuses when the store still has tasks, because `store_tasks.store_id` is
   * `ON DELETE RESTRICT`. The count is returned so the caller can say how many,
   * and offer deactivation instead of deletion — deleting a store is the wrong
   * answer for one that has field work against it, and a bare foreign-key error
   * does not explain that.
   */
  public async deleteStore(storeId: string): Promise<{
    deleted: boolean;
    reason?: 'NOT_FOUND' | 'HAS_TASKS' | 'NOT_DELETED';
    tasks?: number;
  }> {
    const store = this.getStore(storeId);
    if (!store) return { deleted: false, reason: 'NOT_FOUND' };

    const taskCount = this.storeTasks.filter((task) => task.storeId === storeId).length;
    if (taskCount > 0) return { deleted: false, reason: 'HAS_TASKS', tasks: taskCount };

    if (this.pool) {
      try {
        await this.enqueue((pool) => pg.deleteStoreRow(pool, storeId), `store ${storeId} delete`);
      } catch (error) {
        // The count above is a pre-check and can go stale: a task dispatched
        // between the two statements trips the RESTRICT here. Reporting that as
        // "could not delete" rather than "deleted" is the whole point of
        // awaiting, and the store is left in place to match the database.
        console.error(
          `⛔ [oneTeam DB] Could not delete store ${store.storeCode}: ` + describeError(error),
        );
        return { deleted: false, reason: 'NOT_DELETED' };
      }
    }

    this.stores = this.stores.filter((candidate) => candidate.id !== storeId);
    return { deleted: true };
  }

  /**
   * Binds a Telegram chat to a user, creating the user on first contact.
   *
   * Returns the existing row when the chat is already known, so the bot does not
   * mint a new identity every time someone presses /start.
   */
  public bindTelegramUser(params: {
    telegramChatId: string | number;
    fullName: string;
    username?: string;
  }): { id: string; role: string } {
    const chatId = String(params.telegramChatId);
    const existing = this.getUserByTelegramChatId(chatId);

    if (existing) {
      existing.fullName = params.fullName;
      return { id: existing.id, role: existing.role };
    }

    const record = {
      id: `usr-tg-${chatId}`,
      email: `tg-${chatId}@oneteam.local`,
      fullName: params.fullName,
      role: UserRole.MERCHANDISER as string,
      telegramChatId: chatId,
      phone: undefined as string | undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.users.push(record as (typeof this.users)[number]);
    if (this.pool) this.persist((pool) => pg.upsertTelegramUser(pool, record), `user ${record.id}`);

    return { id: record.id, role: record.role };
  }

  /**
   * Binds a mobile device to a user, creating the user on first contact.
   *
   * The mirror image of `bindTelegramUser`, and deliberately so: a channel's
   * external identifier is how that channel names the acting person, and both
   * resolve to one user row. That is what keeps the anti-fraud rules — which are
   * written against the user, not against the channel — from needing a copy per
   * client.
   *
   * A device id is NOT an authentication factor. Anyone who can read it can
   * claim it, so it must only ever be accepted from a client the operator
   * controls, exactly as the bot only accepts a chat id it derived from the
   * update it is handling.
   */
  public bindDeviceUser(params: { deviceId: string; fullName: string }): {
    id: string;
    role: string;
  } {
    const deviceId = String(params.deviceId).trim();
    const existing = this.getUserByMobileDeviceId(deviceId);

    if (existing) {
      existing.fullName = params.fullName;
      return { id: existing.id, role: existing.role };
    }

    const record = {
      id: `usr-dev-${deviceId}`,
      email: `device-${deviceId}@oneteam.local`,
      fullName: params.fullName,
      role: UserRole.MERCHANDISER as string,
      mobileDeviceId: deviceId,
      phone: undefined as string | undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.users.push(record as (typeof this.users)[number]);
    if (this.pool) this.persist((pool) => pg.upsertDeviceUser(pool, record), `user ${record.id}`);

    return { id: record.id, role: record.role };
  }

  /**
   * Adds a task template authored from the web panel and waits for it to land.
   *
   * The panel's "create task" form produces a briefing, not a store task: it
   * has no store in it. The domain model requires every store task to point at
   * a template, so the panel's payload becomes a template here and the existing
   * bulk dispatch then fans it out to the matching stores. That keeps one
   * code path for dispatch instead of giving the panel its own.
   *
   * Awaited for the same reason the store writes are: a supervisor typed a
   * title and a deadline. It is also what stops the fan-out below from
   * reporting twelve created tasks whose rows all failed their foreign key.
   */
  public async createTemplate(template: {
    id: string;
    campaignId?: string | null;
    title: string;
    description: string;
    referenceImageUrl: string;
    priority: string;
    planogramRules?: unknown[];
    requiresBeforeAfterPhoto?: boolean;
    checklistSchema?: unknown[];
  }): Promise<{ template?: any; error?: 'NOT_STORED' }> {
    const record = {
      ...template,
      planogramRules: template.planogramRules ?? [],
      checklistSchema: template.checklistSchema ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.templates.push(record as (typeof this.templates)[number]);

    if (this.pool) {
      try {
        await this.enqueue((pool) => pg.insertTemplate(pool, record), `template ${record.id}`);
      } catch (error) {
        this.templates = this.templates.filter((candidate) => candidate.id !== record.id);
        console.error(
          `⛔ [oneTeam DB] Could not store template ${record.id}: ` + describeError(error),
        );
        return { error: 'NOT_STORED' };
      }
    }

    return { template: record };
  }

  /**
   * Applies an edit to a task template.
   *
   * This is what "edit a task" means for everything except its deadline and its
   * assignee: the title, the description, the priority and the checklist live on
   * the template, and every store task dispatched from it reads them from there.
   * Editing one therefore changes what all of them say — which is the truthful
   * behaviour for the panel's "one task, many stores" shape, and the reason the
   * service reports how many rows were reached.
   */
  public async updateTemplate(
    templateId: string,
    changes: Partial<{
      title: string;
      description: string;
      referenceImageUrl: string;
      priority: string;
      planogramRules: unknown[];
      requiresBeforeAfterPhoto: boolean;
      checklistSchema: unknown[];
    }>,
  ): Promise<{ template?: any; error?: 'NOT_FOUND' | 'NOT_STORED' }> {
    const template: any = this.getTemplate(templateId);
    if (!template) return { error: 'NOT_FOUND' };

    const before = { ...template };

    // Undefined means "not mentioned", which is not the same as "set to
    // undefined" — the same distinction `updateStore` makes.
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) template[key] = value;
    }
    template.updatedAt = new Date();

    if (this.pool) {
      try {
        await this.enqueue(
          (pool) => pg.updateTemplateRow(pool, template),
          `template ${templateId} edit`,
        );
      } catch (error) {
        Object.assign(template, before);
        console.error(
          `⛔ [oneTeam DB] Could not save the edit to template ${templateId}: ` +
            describeError(error),
        );
        return { error: 'NOT_STORED' };
      }
    }

    return { template };
  }

  /**
   * Applies an edit to one store task.
   *
   * Only the two fields that genuinely belong to a single (template, store)
   * pair: its deadline and who it is assigned to. Status is deliberately not
   * writable here — it moves through the state machine, and a direct write
   * would let the panel skip a transition the audit log is built to record.
   *
   * `assignedUserId: null` is a real instruction meaning "unassign, let whoever
   * is at the store claim it", which is different from omitting the key.
   */
  public async updateTask(
    taskId: string,
    changes: Partial<{ deadline: Date; assignedUserId: string | null }>,
  ): Promise<{ task?: InMemoryStoreTask; error?: 'NOT_FOUND' | 'NOT_STORED' }> {
    const task = this.getTask(taskId);
    if (!task) return { error: 'NOT_FOUND' };

    const before: InMemoryStoreTask = { ...task };

    if (changes.deadline !== undefined) task.deadline = changes.deadline;
    if (changes.assignedUserId !== undefined) {
      task.assignedUserId = changes.assignedUserId ?? undefined;
    }
    task.updatedAt = new Date();

    if (this.pool) {
      try {
        await this.enqueue((pool) => pg.updateStoreTaskRow(pool, task), `task ${taskId} edit`);
      } catch (error) {
        Object.assign(task, before);
        console.error(
          `⛔ [oneTeam DB] Could not save the edit to task ${taskId}: ` + describeError(error),
        );
        return { error: 'NOT_STORED' };
      }
    }

    return { task };
  }

  /**
   * Removes one store task.
   *
   * REFUSES WHEN THE TASK HAS EVIDENCE, AND THAT IS THE POINT
   * --------------------------------------------------------
   * `task_evidences.store_task_id` is `ON DELETE CASCADE`. Deleting a task
   * therefore deletes the photos, the coordinates and the checklist answers
   * submitted against it, silently and in one statement. A supervisor
   * tidying up a task list would be destroying field work they cannot see.
   *
   * So the count is taken first and the delete is refused while any evidence
   * exists. Unlike a store — where deactivation is the sensible alternative —
   * there is no "archive" for a task, so the refusal simply says how much would
   * be lost and leaves the decision with the operator.
   */
  public async deleteTask(taskId: string): Promise<{
    deleted: boolean;
    reason?: 'NOT_FOUND' | 'HAS_EVIDENCE' | 'NOT_DELETED';
    evidences?: number;
  }> {
    const task = this.getTask(taskId);
    if (!task) return { deleted: false, reason: 'NOT_FOUND' };

    // The count is taken from the database when there is one. The in-memory
    // list is a poll behind (see ONETEAM_REFRESH_MS), so a submission that
    // landed in the last second would not be in it — and because the foreign
    // key is ON DELETE CASCADE, a stale count does not fail loudly, it destroys
    // the evidence quietly. The database cannot be a poll behind.
    let evidenceCount: number;
    if (this.pool) {
      try {
        evidenceCount = await pg.countEvidencesForTask(this.pool, taskId);
      } catch (error) {
        console.error(
          `⛔ [oneTeam DB] Could not count evidence for task ${taskId}: ` + describeError(error),
        );
        return { deleted: false, reason: 'NOT_DELETED' };
      }
    } else {
      evidenceCount = this.evidences.filter((e) => e.storeTaskId === taskId).length;
    }

    if (evidenceCount > 0) {
      return { deleted: false, reason: 'HAS_EVIDENCE', evidences: evidenceCount };
    }

    if (this.pool) {
      try {
        await this.enqueue((pool) => pg.deleteStoreTaskRow(pool, taskId), `task ${taskId} delete`);
      } catch (error) {
        // The count above is a pre-check and can go stale: an evidence row
        // submitted between the two statements would be cascaded away by the
        // delete. Reporting "could not delete" leaves the task in place to
        // match the database, which is the safe side to fail on.
        console.error(`⛔ [oneTeam DB] Could not delete task ${taskId}: ` + describeError(error));
        return { deleted: false, reason: 'NOT_DELETED' };
      }
    }

    this.storeTasks = this.storeTasks.filter((candidate) => candidate.id !== taskId);
    return { deleted: true };
  }

  /**
   * Removes a task template that was never dispatched to anything.
   *
   * Used to undo the template half of a dispatch that then failed — a deadline
   * that would not parse, a store id that does not exist, a segmentation that
   * matched nothing. A briefing nobody was sent is harmless in itself, but
   * leaving one behind on every failed request turns a mistyped field into
   * permanent litter that no screen lists and no endpoint can remove.
   *
   * Returns false, without attempting anything, when any store task points at
   * the template: `store_tasks.template_id` is `ON DELETE RESTRICT`, and a
   * template with dispatched work against it is not an orphan. That is also
   * what makes this safe to call from a `catch` that does not know how far the
   * dispatch got.
   */
  public async discardTemplate(templateId: string): Promise<boolean> {
    if (this.storeTasks.some((task) => task.templateId === templateId)) return false;

    if (this.pool) {
      try {
        await this.enqueue(
          (pool) => pg.deleteTemplateRow(pool, templateId),
          `template ${templateId} discard`,
        );
      } catch (error) {
        console.error(
          `⛔ [oneTeam DB] Could not discard template ${templateId}: ` + describeError(error),
        );
        return false;
      }
    }

    this.templates = this.templates.filter((candidate) => candidate.id !== templateId);
    return true;
  }

  /**
   * Records a reviewer's decision on an evidence record and persists it.
   *
   * Only review fields are writable. The photo, coordinates and checklist
   * answers belong to the field worker who submitted them; letting a reviewer
   * overwrite those would make the audit trail editable by the auditor.
   */
  public updateEvidence(
    evidenceId: string,
    patch: {
      reviewerFeedback?: string;
      aiScore?: number | null;
      aiSummary?: string | null;
      aiDetections?: any[];
    },
  ): InMemoryEvidence | null {
    const evidence = this.evidences.find((e) => e.id === evidenceId);
    if (!evidence) return null;

    if (patch.reviewerFeedback !== undefined) evidence.reviewerFeedback = patch.reviewerFeedback;
    if (patch.aiScore !== undefined) evidence.aiScore = patch.aiScore;
    if (patch.aiSummary !== undefined) evidence.aiSummary = patch.aiSummary;
    if (patch.aiDetections !== undefined) evidence.aiDetections = patch.aiDetections;
    evidence.updatedAt = new Date();

    if (this.pool) {
      this.persist(
        (pool) => pg.updateEvidenceRow(pool, evidence),
        `evidence ${evidence.id} review`,
      );
    }
    return evidence;
  }

  public getUser(userId: string) {
    return this.users.find((user) => user.id === userId) || null;
  }

  // -------------------------------------------------------------------------
  // Device credentials
  // -------------------------------------------------------------------------

  /**
   * Issues a credential for one mobile installation.
   *
   * The token is returned to the caller exactly once and never stored — only
   * its hash is. There is no way to recover a token from this database, which is
   * the point: a leaked backup yields nothing usable.
   *
   * Returns null rather than throwing when there is no database. A credential
   * that lives only in memory would be lost on the next restart, and a device
   * that has been told it is enrolled and then is not is worse than one that was
   * never enrolled at all.
   */
  public async issueDeviceToken(params: {
    userId: string;
    deviceId: string;
    label?: string;
  }): Promise<{ token: string; tokenHash: string } | null> {
    if (!this.pool) {
      console.error(
        '⛔ [oneTeam DB] Cannot issue a device token: no database connection. ' +
          'A credential stored only in memory would not survive a restart, so ' +
          'none was issued.',
      );
      return null;
    }

    const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const tokenHash = hashDeviceToken(token);

    // Through the queue, not straight to the pool. On a device's first
    // enrolment the `users` row this token references is itself still queued, so
    // writing directly raced it and lost — a foreign-key violation that reached
    // the phone as a bare HTTP 500 on its very first sign-in.
    try {
      await this.enqueue(
        (pool) =>
          pg.insertDeviceToken(pool, {
            tokenHash,
            userId: params.userId,
            deviceId: params.deviceId,
            label: params.label ?? null,
          }),
        `device token for ${params.userId}`,
      );
    } catch (error) {
      // Fail closed, exactly as the no-pool branch above does: a device that is
      // told it is enrolled and then is not is worse than one that was never
      // enrolled. The caller answers 503 and the phone asks a human.
      console.error(
        '⛔ [oneTeam DB] Could not store a device token: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }

    return { token, tokenHash };
  }

  /**
   * Resolves a presented token to the user it belongs to, or null.
   *
   * This reads the database rather than the in-memory working set, on every
   * call. That is deliberate: a credential must be authoritative, and a token
   * that is valid on one replica and not another — or that outlives its
   * revocation until the next restart — is not one. It is a single indexed
   * lookup on a small table.
   */
  public async verifyDeviceToken(
    token: string,
  ): Promise<{ userId: string; deviceId: string } | null> {
    if (!this.pool) return null;

    const tokenHash = hashDeviceToken(token);
    const found = await pg.findDeviceToken(this.pool, tokenHash);
    if (!found) return null;

    // "Last seen" is written at most once every five minutes per token. It is
    // operationally useful — it answers "is this device still in use" — and
    // writing it on every request would turn each authenticated call into a
    // write for a field nobody reads in a hurry.
    const FIVE_MINUTES = 5 * 60 * 1000;
    if (!found.lastSeenAt || Date.now() - found.lastSeenAt.getTime() > FIVE_MINUTES) {
      this.persist((pool) => pg.touchDeviceToken(pool, tokenHash), 'device token last-seen');
    }

    return { userId: found.userId, deviceId: found.deviceId };
  }

  /** Cuts a device off. Returns false when the token was unknown or already revoked. */
  public async revokeDeviceToken(token: string): Promise<boolean> {
    if (!this.pool) return false;
    return pg.revokeDeviceToken(this.pool, hashDeviceToken(token));
  }

  // -------------------------------------------------------------------------
  // Panel credentials
  // -------------------------------------------------------------------------

  /**
   * Mints a login key for one person.
   *
   * Returned exactly once and never stored — only the SHA-256 is. There is no
   * recovery path on purpose: a key that can be looked up again is a key that
   * leaks with a database read.
   *
   * Returns null rather than throwing when there is no database, for the same
   * reason the device path does: a credential that exists only in memory is
   * lost on the next restart, and telling someone their key works when it will
   * not survive the night is worse than refusing to issue one.
   */
  public async issuePanelToken(params: {
    userId: string;
    label?: string;
    createdBy?: string;
  }): Promise<{ token: string; tokenHash: string } | null> {
    if (!this.pool) {
      console.error(
        '⛔ [oneTeam DB] Cannot issue a panel key: no database connection. ' +
          'A key stored only in memory would not survive a restart, so none was issued.',
      );
      return null;
    }

    const user = this.getUser(params.userId);
    if (!user) {
      console.error(
        `⛔ [oneTeam DB] Cannot issue a panel key: no user ${params.userId}. ` +
          'A key that resolves to nobody would be refused at every request.',
      );
      return null;
    }

    const token = PANEL_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const tokenHash = hashPanelToken(token);

    // Through the queue for the same reason as the device path: `panel_tokens`
    // references `users`, and the two writes are not otherwise ordered.
    try {
      await this.enqueue(
        (pool) =>
          pg.insertPanelToken(pool, {
            tokenHash,
            userId: params.userId,
            label: params.label ?? null,
            createdBy: params.createdBy ?? null,
          }),
        `panel key for ${params.userId}`,
      );
    } catch (error) {
      console.error(
        '⛔ [oneTeam DB] Could not store a panel key: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }

    return { token, tokenHash };
  }

  /**
   * Resolves a presented key to the user it belongs to, or null.
   *
   * Reads the database on every call rather than the in-memory set, because a
   * revoked key must stop working immediately — waiting for the next restart,
   * or for a replica to catch up, would mean "revoked" was a suggestion.
   */
  public async verifyPanelToken(token: string): Promise<{ userId: string } | null> {
    if (!this.pool) return null;

    const tokenHash = hashPanelToken(token);
    const found = await pg.findPanelToken(this.pool, tokenHash);
    if (!found) return null;

    // Same five-minute throttle as the device path: useful for "is this key
    // still in use", and writing it on every request would turn each panel read
    // into a write.
    const FIVE_MINUTES = 5 * 60 * 1000;
    if (!found.lastSeenAt || Date.now() - found.lastSeenAt.getTime() > FIVE_MINUTES) {
      this.persist((pool) => pg.touchPanelToken(pool, tokenHash), 'panel token last-seen');
    }

    return { userId: found.userId };
  }

  /** Cuts one key off. Returns false when it was unknown or already revoked. */
  public async revokePanelToken(token: string): Promise<boolean> {
    if (!this.pool) return false;
    return pg.revokePanelToken(this.pool, hashPanelToken(token));
  }

  /**
   * Cuts a key off by its hash rather than its value.
   *
   * The panel never holds anyone else's key — only its hash — so revoking
   * somebody's access from the key list has to work from the hash. Both paths
   * end in the same `UPDATE`, which is the point: there is one definition of
   * "revoked", not one per caller.
   */
  public async revokePanelTokenByHash(tokenHash: string): Promise<boolean> {
    if (!this.pool) return false;
    return pg.revokePanelToken(this.pool, tokenHash);
  }

  /** Cuts every key belonging to one person off. What "they left" means. */
  public async revokePanelTokensForUser(userId: string): Promise<number> {
    if (!this.pool) return 0;
    return pg.revokePanelTokensForUser(this.pool, userId);
  }

  public async listPanelTokens(includeRevoked = false): Promise<pg.PanelTokenRow[]> {
    if (!this.pool) return [];
    return pg.listPanelTokens(this.pool, { includeRevoked });
  }

  /**
   * Whether the panel should ask for a key at all.
   *
   * The answer is "yes" as soon as either a live key exists or a usable
   * bootstrap key is configured. That makes switching the login on a deliberate
   * act — set the environment variable, or mint a key — rather than something
   * that happens by deploying. Until then the panel keeps working as it did,
   * and the shell says out loud that it is open.
   *
   * `bootstrapProblem` is reported separately from `bootstrapConfigured` on
   * purpose. A key that was set but refused is not the same as no key at all,
   * and the difference is the whole reason someone is looking at a login screen
   * that nothing satisfies.
   */
  public async panelAuthStatus(): Promise<{
    required: boolean;
    liveKeys: number;
    bootstrapConfigured: boolean;
    bootstrapProblem: string | null;
  }> {
    const bootstrapConfigured = Boolean(usablePanelBootstrapKey());
    const bootstrapProblem = panelBootstrapProblem();

    if (!this.pool) {
      return { required: bootstrapConfigured, liveKeys: 0, bootstrapConfigured, bootstrapProblem };
    }

    let liveKeys = 0;
    try {
      liveKeys = await pg.countLivePanelTokens(this.pool);
    } catch (error) {
      // A count that cannot be read must not be reported as zero, because zero
      // means "no login needed". Failing toward `required: true` would lock the
      // operator out of a panel whose keys cannot be read either, so the honest
      // answer is "unknown", and unknown is surfaced rather than swallowed.
      console.error('⛔ [oneTeam DB] Could not count panel keys: ' + describeError(error));
      return { required: true, liveKeys: -1, bootstrapConfigured, bootstrapProblem };
    }

    return {
      required: liveKeys > 0 || bootstrapConfigured,
      liveKeys,
      bootstrapConfigured,
      bootstrapProblem,
    };
  }

  public getUserByTelegramChatId(telegramChatId: string | number) {
    const chatId = String(telegramChatId);
    return this.users.find((user) => user.telegramChatId === chatId) || null;
  }

  /** The mobile client's equivalent of `getUserByTelegramChatId`. */
  public getUserByMobileDeviceId(deviceId: string) {
    const id = String(deviceId).trim();
    if (!id) return null;
    return this.users.find((user) => user.mobileDeviceId === id) || null;
  }

  public getStore(storeId: string) {
    return this.stores.find((s) => s.id === storeId) || null;
  }

  public getStoreByCode(code: string) {
    return this.stores.find((s) => s.storeCode.toUpperCase() === code.toUpperCase()) || null;
  }

  public getTemplate(templateId: string) {
    return this.templates.find((t) => t.id === templateId) || null;
  }

  public getStoresFiltered(filter: {
    regionId?: string;
    chainName?: string;
    storeFormat?: string;
  }) {
    return this.stores.filter((store) => {
      if (!store.isActive) return false;
      if (filter.regionId && filter.regionId !== 'all' && store.regionId !== filter.regionId) {
        return false;
      }
      if (
        filter.chainName &&
        filter.chainName !== 'all' &&
        store.chainName.toLowerCase() !== filter.chainName.toLowerCase()
      ) {
        return false;
      }
      if (
        filter.storeFormat &&
        filter.storeFormat !== 'all' &&
        store.storeFormat.toLowerCase() !== filter.storeFormat.toLowerCase()
      ) {
        return false;
      }
      return true;
    });
  }

  public getTask(taskId: string) {
    return this.storeTasks.find((t) => t.id === taskId) || null;
  }

  public canUserAccessTask(userId: string, role: UserRole, taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    if (role === UserRole.ADMIN || role === UserRole.SUPERVISOR) return true;
    if (role === UserRole.MERCHANDISER) return task.assignedUserId === userId;
    return false;
  }

  public getTasksForUser(userId: string, role: UserRole): InMemoryStoreTask[] {
    if (role === UserRole.ADMIN || role === UserRole.SUPERVISOR) {
      return [...this.storeTasks];
    }
    if (role === UserRole.MERCHANDISER) {
      return this.storeTasks.filter((task) => task.assignedUserId === userId);
    }
    return [];
  }

  public getEvidencesForUser(userId: string, role: UserRole): InMemoryEvidence[] {
    if (role === UserRole.ADMIN || role === UserRole.SUPERVISOR) {
      return [...this.evidences];
    }
    if (role === UserRole.MERCHANDISER) {
      const taskIds = new Set(
        this.storeTasks.filter((task) => task.assignedUserId === userId).map((task) => task.id),
      );
      return this.evidences.filter((evidence) => taskIds.has(evidence.storeTaskId));
    }
    return [];
  }

  /**
   * Points a store task at the person who will do it.
   *
   * WHY THE TELEGRAM CHANNEL NEEDS THIS
   * -----------------------------------
   * `canUserAccessTask` lets a MERCHANDISER submit only for a task assigned to
   * them, which is what stops one field worker filing an audit for another's
   * store. The panel and mobile flows satisfy that because a supervisor picks
   * the assignee when dispatching.
   *
   * The chat flow has no supervisor in it: a merchandiser proves which store
   * they are at by sending its code. So the claim *is* the assignment, and
   * without recording it here every submission from a chat would be refused
   * with a 403 — the bot would look broken for exactly the people it exists for.
   *
   * An existing assignee is never overwritten: a task already given to someone
   * else stays theirs, and the caller decides what to do about that.
   */
  public assignStoreTask(taskId: string, userId: string): InMemoryStoreTask | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (task.assignedUserId === userId) return task;

    task.assignedUserId = userId;
    task.updatedAt = new Date();

    if (this.pool)
      this.persist((pool) => pg.updateStoreTaskRow(pool, task), `task ${task.id} assignment`);
    return task;
  }

  public updateTaskState(taskId: string, newState: TaskState): InMemoryStoreTask | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    task.status = newState;
    task.updatedAt = new Date();

    if (newState === TaskState.PUBLISHED) task.publishedAt = new Date();
    if (newState === TaskState.DELIVERED) task.deliveredAt = new Date();
    if (newState === TaskState.ACKNOWLEDGED) task.acknowledgedAt = new Date();
    if (newState === TaskState.SUBMITTED) task.submittedAt = new Date();
    if (newState === TaskState.APPROVED || newState === TaskState.REJECTED) {
      task.reviewedAt = new Date();
    }

    if (this.pool)
      this.persist((pool) => pg.updateStoreTaskRow(pool, task), `task ${task.id} state`);

    return task;
  }
}

export const db = new EnterpriseDatabase();

/**
 * Prefix on every device credential.
 *
 * A recognisable prefix lets the auth layer route a bearer token without a
 * database call, and lets a leaked token be identified as one in a log or a
 * secret scanner. It is not a security measure — the hash is.
 */
export const DEVICE_TOKEN_PREFIX = 'otd_';

/** SHA-256 of a token, hex. The only form that is ever stored. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether a bearer value is a device credential rather than a service one. */
export function isDeviceToken(value: string): boolean {
  return typeof value === 'string' && value.startsWith(DEVICE_TOKEN_PREFIX);
}

/**
 * Prefix on every panel login key.
 *
 * Chosen to differ from `otd_` at the third character, so a value can be routed
 * by shape without a database call and without any risk of the two being
 * confused — a device credential must never be looked up in `panel_tokens`, and
 * a panel key must never resolve to a device's user.
 */
export const PANEL_TOKEN_PREFIX = 'otp_';

/** SHA-256 of a panel key, hex. The only form that is ever stored. */
export function hashPanelToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether a bearer value is a panel key rather than a device or service one. */
export function isPanelToken(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PANEL_TOKEN_PREFIX);
}

/**
 * The bootstrap key, if the operator configured one.
 *
 * This is the way in before any personal key exists. It is read from the
 * environment rather than stored, so removing the variable is all it takes to
 * switch it off — there is no row to remember to revoke, and nothing in a
 * database dump that grants access.
 *
 * It is deliberately NOT a fallback that applies when the panel is otherwise
 * open: setting it is what turns the login on. See `panelAuthStatus`.
 */
export function panelBootstrapKey(): string | null {
  const value = (process.env.ONETEAM_PANEL_BOOTSTRAP_KEY || '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Minimum length of the bootstrap key.
 *
 * Minted keys are 32 random bytes and cannot be guessed. The bootstrap key is
 * typed by a person, so its strength is whatever they chose — and unlike a
 * personal key, guessing it once grants full administrative access. A short one
 * is not a weaker version of this system, it is a broken one.
 *
 * 24 characters is the floor rather than a target. `openssl rand -base64 24`
 * produces 32 characters, which is the recommended way to generate it.
 */
export const PANEL_BOOTSTRAP_MIN_LENGTH = 24;

/**
 * Why the configured bootstrap key cannot be used, or null if there is no
 * problem (including "no key configured", which is a normal state).
 *
 * Kept next to the key itself so that the guard, the status endpoint and the
 * startup log cannot disagree about whether the key is acceptable.
 */
export function panelBootstrapProblem(): string | null {
  const value = panelBootstrapKey();
  if (!value) return null;
  if (value.length < PANEL_BOOTSTRAP_MIN_LENGTH) {
    return (
      `ONETEAM_PANEL_BOOTSTRAP_KEY is only ${value.length} characters. ` +
      `It must be at least ${PANEL_BOOTSTRAP_MIN_LENGTH}, because guessing this ` +
      `one value grants full administrative access. It is being refused rather ` +
      `than accepted, so the panel will ask for a key that nothing satisfies ` +
      `until it is replaced. Generate one with: openssl rand -base64 24`
    );
  }

  // A value shaped like another credential would be routed as that credential by
  // every reader except the one comparison that checks it here. The result would
  // be a bootstrap key that works in some code paths and not others — the worst
  // kind of failure to debug, and one an operator could easily create by pasting
  // the wrong string from a dashboard.
  const reserved: Array<[string, string]> = [
    [DEVICE_TOKEN_PREFIX, 'a device token'],
    [PANEL_TOKEN_PREFIX, 'a panel key'],
    ['oneteam-user:', 'the service credential'],
  ];
  for (const [prefix, what] of reserved) {
    if (value.startsWith(prefix)) {
      return (
        `ONETEAM_PANEL_BOOTSTRAP_KEY begins with "${prefix}", which is how ${what} ` +
        `is recognised. It would be read as ${what} and never as a bootstrap key. ` +
        `Use a value with no prefix — openssl rand -base64 24 produces one.`
      );
    }
  }

  return null;
}

/** The bootstrap key when it is configured AND strong enough to honour. */
export function usablePanelBootstrapKey(): string | null {
  if (panelBootstrapProblem()) return null;
  return panelBootstrapKey();
}

/**
 * Whether a presented key is the bootstrap key.
 *
 * Compared as fixed-length SHA-256 digests through `timingSafeEqual`, so the
 * comparison takes the same time whatever was presented. A plain `===` on a
 * secret leaks its length and, in principle, its prefix — and this is the one
 * credential that can be brute-forced at leisure if it is guessable.
 *
 * A key that fails the length check is never matched, so a weak value cannot be
 * used even by someone who knows it.
 */
export function matchesPanelBootstrapKey(candidate: string): boolean {
  const expected = usablePanelBootstrapKey();
  if (!expected || !candidate) return false;

  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** One-line description of a caught value, for a log message. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
