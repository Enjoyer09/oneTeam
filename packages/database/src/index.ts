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
import type {
  InMemoryStoreTask,
  InMemoryEvidence,
  InMemoryAuditLog,
} from './types';
import { createHash, randomBytes } from 'crypto';
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
  public stores = [...SEED_DATA.stores];
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
    'refresh is off — reads are this process\'s memory, and a second replica would not converge';

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
          'every task, evidence and audit entry will be lost on restart.'
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
              schemaHealth.detail
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
              'built-in seed data in memory. Run db/api-seed.sql against this database.'
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
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        if (attempt < attempts) {
          console.warn(
            `⏳ [oneTeam DB] Attempt ${attempt}/${attempts} failed (${reason}). ` +
              `Retrying in ${Math.round(delayMs / 1000)}s — the database is often still ` +
              'starting when the application container is already up.'
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
            'seed data; writes will NOT survive a restart. Reason: ' + reason
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
        'refresh is OFF (ONETEAM_REFRESH_MS=0) — a second replica would never see this one\'s writes';
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
        'replica becomes visible here within about that long.'
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
          (error instanceof Error ? error.message : String(error))
      );
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Fire-and-forget write-through.
   *
   * The callers are synchronous and stay that way — see the note in
   * postgres.ts. A failed write is logged loudly rather than thrown: an audit
   * row that cannot be written should not fail the business operation that
   * produced it, but it must be visible in the logs.
   */
  private persist(op: Promise<unknown>, label: string): void {
    if (!this.pool) return;

    this.pendingWrites += 1;
    op.catch((error) => {
      console.error(
        `⛔ [oneTeam DB] Failed to persist ${label}: ` +
          (error instanceof Error ? error.message : String(error))
      );
    }).finally(() => {
      this.pendingWrites -= 1;
    });
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
    if (this.pool) this.persist(pg.insertAuditLog(this.pool, entry), `audit ${entry.id}`);
    return entry;
  }

  /**
   * Adds a store task and persists it.
   *
   * Replaces a direct `db.storeTasks.push(...)` in the task service. The push
   * is still what makes the task visible to the running process; the insert is
   * what makes it survive.
   */
  public createStoreTask(task: InMemoryStoreTask): InMemoryStoreTask {
    this.storeTasks.push(task);
    if (this.pool) this.persist(pg.insertStoreTask(this.pool, task), `task ${task.id}`);
    return task;
  }

  /**
   * Adds an evidence record and persists it.
   *
   * Replaces a direct `db.evidences.push(...)` in the evidence service.
   */
  public createEvidence(evidence: InMemoryEvidence): InMemoryEvidence {
    this.evidences.push(evidence);
    if (this.pool) this.persist(pg.insertEvidence(this.pool, evidence), `evidence ${evidence.id}`);
    return evidence;
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
    if (this.pool) this.persist(pg.upsertTelegramUser(this.pool, record), `user ${record.id}`);

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
  public bindDeviceUser(params: {
    deviceId: string;
    fullName: string;
  }): { id: string; role: string } {
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
    if (this.pool) this.persist(pg.upsertDeviceUser(this.pool, record), `user ${record.id}`);

    return { id: record.id, role: record.role };
  }

  /**
   * Adds a task template authored from the web panel and persists it.
   *
   * The panel's "create task" form produces a briefing, not a store task: it
   * has no store in it. The domain model requires every store task to point at
   * a template, so the panel's payload becomes a template here and the existing
   * bulk dispatch then fans it out to the matching stores. That keeps one
   * code path for dispatch instead of giving the panel its own.
   */
  public createTemplate(template: {
    id: string;
    campaignId?: string | null;
    title: string;
    description: string;
    referenceImageUrl: string;
    priority: string;
    planogramRules?: unknown[];
    requiresBeforeAfterPhoto?: boolean;
    checklistSchema?: unknown[];
  }) {
    const record = {
      ...template,
      planogramRules: template.planogramRules ?? [],
      checklistSchema: template.checklistSchema ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.templates.push(record as (typeof this.templates)[number]);
    if (this.pool) this.persist(pg.insertTemplate(this.pool, record), `template ${record.id}`);
    return record;
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
    }
  ): InMemoryEvidence | null {
    const evidence = this.evidences.find((e) => e.id === evidenceId);
    if (!evidence) return null;

    if (patch.reviewerFeedback !== undefined) evidence.reviewerFeedback = patch.reviewerFeedback;
    if (patch.aiScore !== undefined) evidence.aiScore = patch.aiScore;
    if (patch.aiSummary !== undefined) evidence.aiSummary = patch.aiSummary;
    if (patch.aiDetections !== undefined) evidence.aiDetections = patch.aiDetections;
    evidence.updatedAt = new Date();

    if (this.pool) {
      this.persist(pg.updateEvidenceRow(this.pool, evidence), `evidence ${evidence.id} review`);
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
          'none was issued.'
      );
      return null;
    }

    const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const tokenHash = hashDeviceToken(token);

    await pg.insertDeviceToken(this.pool, {
      tokenHash,
      userId: params.userId,
      deviceId: params.deviceId,
      label: params.label ?? null,
    });

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
    token: string
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
      this.persist(pg.touchDeviceToken(this.pool, tokenHash), 'device token last-seen');
    }

    return { userId: found.userId, deviceId: found.deviceId };
  }

  /** Cuts a device off. Returns false when the token was unknown or already revoked. */
  public async revokeDeviceToken(token: string): Promise<boolean> {
    if (!this.pool) return false;
    return pg.revokeDeviceToken(this.pool, hashDeviceToken(token));
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
        this.storeTasks
          .filter((task) => task.assignedUserId === userId)
          .map((task) => task.id)
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

    if (this.pool) this.persist(pg.updateStoreTaskRow(this.pool, task), `task ${task.id} assignment`);
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

    if (this.pool) this.persist(pg.updateStoreTaskRow(this.pool, task), `task ${task.id} state`);

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

/** One-line description of a caught value, for a log message. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
