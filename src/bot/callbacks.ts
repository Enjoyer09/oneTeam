/**
 * oneTeam Telegram Bot — the callback vocabulary
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every inline button carries a `callback_data` string, and until Phase 2.1
 * those strings were written by hand at each site:
 *
 *     new InlineKeyboard().text('📸 Rəf Şəklini Göndər', `submit_${task.id}`)
 *     keyboard.text('✅ Bəli', `${CHECKLIST_CALLBACK_PREFIX}_${index}_bool_true`)
 *
 * Two shapes, two parsers, and no way to answer "which buttons does this bot
 * have?" without grepping for string prefixes. Worse, the single
 * `callback_query:data` handler in `index.ts` understood only `submit_`, so
 * every checklist button was swallowed without even an acknowledgement — the
 * merchandiser tapped ✅ and the button span for thirty seconds and stopped.
 * A format that has to be remembered at every call site is a format that gets
 * forgotten at one of them.
 *
 * So the format is now one thing, and it is written in one place:
 *
 *     <action>:<id>
 *
 * The router splits on the FIRST colon and looks the action up in a table. The
 * `id` is opaque to the router and is parsed by the action's own handler, which
 * is what lets the checklist carry two values (`chk:2:true`) inside a
 * one-separator format rather than needing a second one.
 *
 * WHAT IS DELIBERATELY NOT AN ACTION
 * ----------------------------------
 * There is no `photo:<id>` action, even though the plan's state machine lists a
 * `photo` step. The step exists; it is just not button-initiated, because
 * Telegram has no button that attaches a photo. Offering one would create a
 * button whose only possible effect is a second prompt, and a dead button
 * teaches a merchandiser that buttons here do not work.
 *
 * WHY `open` AND `restart` ARE TWO ACTIONS AND NOT ONE
 * ---------------------------------------------------
 * "Open this task" arrives twice for two unrelated reasons: a deliberate second
 * tap on the task card, and a duplicate delivery of the first tap. From the
 * data they are identical, so a single action has to guess — and the destructive
 * reading of the guess throws away the answers the merchandiser has already
 * given.
 *
 * Splitting them removes the guess. `open` never destroys anything: opening a
 * task whose flow is already running re-sends that step's prompt. `restart`
 * always destroys, and says so in its button label. Each action then has one
 * meaning, which is what makes "a duplicate tap changes nothing" a property
 * rather than a hope.
 *
 * THE 64-BYTE LIMIT
 * -----------------
 * Telegram caps `callback_data` at 64 bytes and answers a longer one with a
 * 400 — which arrives as a button that does nothing. It is checked here, at
 * encode time, where the mistake is cheap to find, rather than at tap time.
 */

export const CALLBACK_ACTIONS = [
  /** `menu:home` — the main menu, as an inline keyboard. */
  'menu',
  /** `today:me` — the day at a glance: active tasks and today's submissions. */
  'today',
  /** `tasks:list` — the store's active tasks. */
  'tasks',
  /** `open:<taskId>` — open a task and start the guided flow. */
  'open',
  /** `restart:<taskId>` — throw the answers away and start this task over. */
  'restart',
  /** `chk:<questionIndex>:<value>` — answer a checklist question. */
  'chk',
  /** `confirm:<taskId>` — file the photo that is waiting. */
  'confirm',
  /** `retake:<taskId>` — discard the waiting photo and ask for another. */
  'retake',
  /** `status:me` — the chat's recent audits. */
  'status',
  /** `help:show` — what this bot can do. */
  'help',
] as const;

export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

const TELEGRAM_CALLBACK_LIMIT = 64;

function isCallbackAction(value: string): value is CallbackAction {
  return (CALLBACK_ACTIONS as readonly string[]).includes(value);
}

/**
 * Builds a `callback_data` string, refusing one Telegram would reject.
 *
 * Throwing here rather than returning a bad string is deliberate: a button that
 * silently does nothing is the failure this whole file exists to remove, and a
 * loud failure while the keyboard is being built is caught by the test suite.
 */
export function encodeCallback(action: CallbackAction, id: string): string {
  if (!id) {
    throw new Error(`Callback action "${action}" needs an id.`);
  }
  const data = `${action}:${id}`;
  if (data.length > TELEGRAM_CALLBACK_LIMIT) {
    throw new Error(
      `callback_data "${data}" is ${data.length} bytes; Telegram allows ${TELEGRAM_CALLBACK_LIMIT}.`,
    );
  }
  return data;
}

export interface ParsedCallback {
  action: CallbackAction;
  /** Everything after the first colon, verbatim — the action parses this. */
  id: string;
}

/** Returns null for anything this bot did not build, including `undefined`. */
export function parseCallback(data: string | undefined | null): ParsedCallback | null {
  if (!data) return null;
  const separator = data.indexOf(':');
  if (separator <= 0) return null;

  const action = data.slice(0, separator);
  const id = data.slice(separator + 1);
  if (!isCallbackAction(action) || id.length === 0) return null;

  return { action, id };
}

// ---------------------------------------------------------------------------
// The checklist's id
// ---------------------------------------------------------------------------

/**
 * Encodes a checklist answer.
 *
 * `true`/`false` for a boolean question, `opt<n>` for a choice. A number
 * question has no buttons — the answer is typed — so it has no encoding here,
 * and that absence is the honest one: there is no button to encode.
 */
export function encodeChecklistAnswer(index: number, value: boolean | number): string {
  return `${index}:${typeof value === 'boolean' ? String(value) : `opt${value}`}`;
}

/**
 * Reads a checklist id back.
 *
 * Returns null rather than a partial answer when anything is off. A malformed
 * id means a button this bot did not build, or one built by an older version,
 * and the caller's job is then to say so — not to guess an index.
 */
export function decodeChecklistAnswer(
  id: string,
): { index: number; value: boolean | number } | null {
  const separator = id.indexOf(':');
  if (separator <= 0) return null;

  const rawIndex = id.slice(0, separator);
  const raw = id.slice(separator + 1);

  // `Number.isInteger` rejects '', 'x' and '1.5' in one go, which is what makes
  // this safe to use as an array index.
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) return null;

  if (raw === 'true') return { index, value: true };
  if (raw === 'false') return { index, value: false };
  if (/^opt\d+$/.test(raw)) return { index, value: Number(raw.slice(3)) };

  return null;
}
