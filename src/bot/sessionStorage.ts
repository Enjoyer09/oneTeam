/**
 * oneTeam — where a chat's place in the guided field flow is kept
 * ============================================================================
 *
 * WHAT WAS WRONG WITH THE DEFAULT
 * ------------------------------
 * grammy's session middleware keeps sessions in a `Map` inside the process.
 * That is fine for a toy and wrong for this bot, because the process is replaced
 * on every deploy.
 *
 * The failure it produces is the worst kind: not an error. A merchandiser
 * answers two of three checklist questions, the container is swapped while they
 * are reading the third, and the next message they send gets "hansı mağazadasınız?"
 * — the store code prompt — because the bot has no idea who they are. They are
 * standing in a shop holding a phone and cannot tell whether they did something
 * wrong, whether the bot is broken, or whether their work was saved. Nothing
 * anywhere says what happened.
 *
 * So the flow is stored in Postgres, reached through the Core API. See
 * `db/migrations/20260918000007_add_bot_sessions.sql` for why Postgres rather
 * than Redis, and why the bot still goes through the API instead of opening its
 * own connection.
 *
 * WHY THE STORAGE ADAPTER IS THE RIGHT PLACE FOR THIS
 * --------------------------------------------------
 * The alternative was to keep grammy's memory sessions and have every handler
 * call the API itself. That means six handlers each remembering to save, each
 * getting the ordering right, and each being a place where a missed save is
 * invisible. A storage adapter is the one seam grammy already calls on every
 * update, before and after the handlers run, so the flow is saved exactly once
 * and no handler can forget.
 *
 * WHY THE ERRORS ARE NOT SWALLOWED
 * --------------------------------
 * `read` throwing means the update is not handled and the person gets a warning
 * instead of a silent restart. That is deliberate. Returning `undefined` when
 * the API is unreachable would be indistinguishable from "this chat has no
 * session", and the bot would answer by starting the flow over — throwing away
 * answers that are still sitting safely in the database.
 *
 * `write` throwing is noisier and still correct: by then the handler has already
 * replied, so the person sees a normal answer and then a warning that their
 * progress was not saved. Telling them is the only honest option. A merchandiser
 * who believes three checklist answers were recorded when they were not is worse
 * off than one who knows to redo them.
 *
 * The API answers 503 with `FLOW_UNAVAILABLE` / `FLOW_NOT_STORED` for exactly
 * these two cases, so a real refusal and a dead network arrive here the same way
 * — as a failure — which is what they have in common.
 */

import type { StorageAdapter } from 'grammy';
import type { FieldFlowPayload } from '@oneteam/types';
import { portalApi } from '../services/portalApi';
import type { SessionData } from './types';

/**
 * A failure to read or write the flow, tagged with which operation failed.
 *
 * Wrapped rather than let through as a `PortalApiError` so the bot's error
 * handler can tell "the chat's progress could not be saved" — worth interrupting
 * the person for — from every other API error, which the handlers already deal
 * with in their own words.
 */
export class FlowStorageError extends Error {
  readonly operation: 'read' | 'write' | 'delete';
  readonly detail: unknown;

  constructor(operation: 'read' | 'write' | 'delete', cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`The guided flow could not be ${PAST_TENSE[operation]}: ${detail}`);
    this.name = 'FlowStorageError';
    this.operation = operation;
    this.detail = cause;
  }
}

const PAST_TENSE: Record<FlowStorageError['operation'], string> = {
  read: 'loaded',
  write: 'saved',
  delete: 'cleared',
};

/**
 * Is there anything here worth a row?
 *
 * A chat that has never been bound — someone who said "salam", or a person the
 * bot has never seen — produces an empty session. Writing that row would mean a
 * table that grows with every stray message and a DELETE that is cheaper and
 * says the same thing.
 *
 * `storeId` counts as content on purpose. "Bound to a store, no task open" is
 * the state a merchandiser spends most of their time in, and it is precisely the
 * one that must survive a restart — losing it is what makes the bot ask for the
 * store code again.
 */
function isBlank(session: SessionData): boolean {
  return (
    (session.step ?? 'idle') === 'idle' &&
    !session.storeId &&
    !session.activeTaskId &&
    !session.pendingPhoto
  );
}

/**
 * The stored flow → the session the handlers read.
 *
 * `null` from the API becomes `undefined` here because `SessionData`'s fields are
 * optional, and the two mean the same thing to a handler that checks
 * `if (ctx.session.storeId)`.
 */
function fromFlow(flow: FieldFlowPayload): SessionData {
  return {
    step: flow.step,
    storeId: flow.storeId ?? undefined,
    storeCode: flow.storeCode ?? undefined,
    storeName: flow.storeName ?? undefined,
    // The API derives the person from the chat rather than trusting the caller,
    // so this is the stored answer, not the bot's opinion of one.
    profileId: flow.userId ?? undefined,
    activeTaskId: flow.activeTaskId ?? undefined,
    activeTaskTitle: flow.activeTaskTitle ?? undefined,
    location: flow.location ?? undefined,
    checklistQuestions: flow.checklistQuestions ?? [],
    checklistAnswers: flow.checklistAnswers ?? [],
    checklistIndex: flow.checklistIndex ?? undefined,
    pendingPhoto: flow.pendingPhoto ?? undefined,
  };
}

/**
 * The session the handlers wrote → the stored flow.
 *
 * Every field is sent on every write, including the empty ones. The API stores
 * the whole row for the same reason: a patch would let a step change
 * `checklistIndex` without the matching answers and leave a session that cannot
 * be resumed, and the failure would show up later, somewhere else.
 */
function toFlow(session: SessionData): FieldFlowPayload {
  return {
    step: session.step ?? 'idle',
    storeId: session.storeId ?? null,
    storeCode: session.storeCode ?? null,
    storeName: session.storeName ?? null,
    activeTaskId: session.activeTaskId ?? null,
    activeTaskTitle: session.activeTaskTitle ?? null,
    location: session.location ?? null,
    checklistQuestions: session.checklistQuestions ?? [],
    checklistAnswers: session.checklistAnswers ?? [],
    checklistIndex: session.checklistIndex ?? null,
    pendingPhoto: session.pendingPhoto ?? null,
  };
}

/**
 * grammy's storage contract, answered by the Core API.
 *
 * `has` and the `readAll*` methods are deliberately not implemented: grammy only
 * uses them when you ask it to, and every one of them would be a query this
 * system never makes. A session is only ever fetched by the chat that owns it.
 */
export class ApiSessionStorage implements StorageAdapter<SessionData> {
  async read(key: string): Promise<SessionData | undefined> {
    try {
      const flow = await portalApi.getFlow(key);
      return flow ? fromFlow(flow) : undefined;
    } catch (error) {
      throw new FlowStorageError('read', error);
    }
  }

  async write(key: string, value: SessionData): Promise<void> {
    try {
      if (isBlank(value)) {
        await portalApi.clearFlow(key);
        return;
      }
      await portalApi.saveFlow(key, toFlow(value));
    } catch (error) {
      throw new FlowStorageError('write', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await portalApi.clearFlow(key);
    } catch (error) {
      throw new FlowStorageError('delete', error);
    }
  }
}
