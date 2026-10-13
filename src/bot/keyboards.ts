/**
 * oneTeam Telegram Bot — keyboards
 * ============================================================================
 *
 * These lived inline in `handlers/start.ts` and `handlers/tasks.ts`. They are
 * here now because the guided field flow has to *restore* the main menu after it
 * has replaced it with the location prompt, and two definitions of "the main
 * menu" would drift the first time one of them changed.
 *
 * TWO KINDS, AND WHY BOTH ARE KEPT
 * --------------------------------
 * The reply keyboard (`mainMenuKeyboard`) sits under the message box and is the
 * one a merchandiser can find without scrolling. It is also the only kind that
 * can ask for a location, which is why `locationRequestKeyboard` has to be a
 * reply keyboard.
 *
 * The inline keyboard (`mainMenuInline`) travels with a specific message, which
 * is what a menu needs once the flow has several steps: the buttons belong to
 * the step they were offered at, and an old menu scrolled past cannot be
 * mistaken for the current one.
 *
 * Both are kept because Phase 2.4 requires the text commands to keep working
 * when inline is unavailable. Removing the reply keyboard would remove the
 * location button with it.
 *
 * ONE `reply_markup` PER MESSAGE, SO EVERY MESSAGE MAKES A CHOICE
 * --------------------------------------------------------------
 * Telegram carries exactly one `reply_markup`, and it is either a reply
 * keyboard or an inline keyboard — never both. So "attach the menu" is not a
 * thing a message can do twice, and each message has to pick.
 *
 * The rule this file exists to keep:
 *
 *   - A message that answers a TYPED command, or ends the flow, carries the
 *     REPLY keyboard. It is the durable one, it is the one that survives being
 *     scrolled past, and — the reason Phase 2.4 needs it — it is the only one
 *     that can be brought back by typing. `locationRequestKeyboard()` is
 *     `oneTime()`, so the location step dismisses the reply keyboard and
 *     nothing else ever puts it back; before 2.4 a merchandiser who had shared
 *     a location and scrolled away had no buttons at all.
 *   - A message that IS a step carries an INLINE keyboard, because its buttons
 *     belong to that step: the checklist answer buttons for that question, the
 *     confirm/retake buttons for that photo. A reply keyboard cannot express
 *     "answer to this message".
 */

import { InlineKeyboard, Keyboard } from 'grammy';
import { encodeCallback } from './callbacks';

/**
 * The label on the button that lets a merchandiser continue without sharing a
 * location.
 *
 * It is a plain text button rather than an inline one because it has to sit
 * beside Telegram's own "share my location" button, which can only be requested
 * from a reply keyboard. The bot recognises it by this exact string, so the
 * constant is exported rather than typed twice.
 */
export const LOCATION_SKIP_LABEL = '⏭️ Lokasiya olmadan davam et';

/** The label on the reply-keyboard button that opens the day-at-a-glance view. */
export const MENU_TODAY_LABEL = '🗓 Bu gün';

/** The label on the reply-keyboard button that lists the store's tasks. */
export const MENU_TASKS_LABEL = '📋 Tapşırıqlar';

/** The label on the reply-keyboard button that shows recent audits. */
export const MENU_STATUS_LABEL = '📊 Auditlərim';

/**
 * The everyday menu.
 *
 * "🗓 Bu gün" sits on its own row at the top because it is the screen a
 * merchandiser opens first each shift — the day's active tasks and what they
 * have already sent today, in one message. The two originals stay on the row
 * below: the task list, and the status of past submissions. All three are
 * durable reply-keyboard buttons for the reason the file header gives — they are
 * the only kind that survives a scroll and can be brought back by typing.
 */
export function mainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text(MENU_TODAY_LABEL)
    .row()
    .text(MENU_TASKS_LABEL)
    .text(MENU_STATUS_LABEL)
    .resized();
}

/**
 * The same actions as inline buttons.
 *
 * Sent with the messages the flow produces, so that a merchandiser who has
 * scrolled away from the reply keyboard — which happens as soon as a checklist
 * has more than a couple of questions — still has the way back in front of them.
 */
export function mainMenuInline(): InlineKeyboard {
  return new InlineKeyboard()
    .text(MENU_TODAY_LABEL, encodeCallback('today', 'me'))
    .row()
    .text('📋 Tapşırıqlar', encodeCallback('tasks', 'list'))
    .text(MENU_STATUS_LABEL, encodeCallback('status', 'me'))
    .row()
    .text('❓ Kömək', encodeCallback('help', 'show'));
}

/**
 * The label on the "back to the menu" button.
 *
 * It exists because `menu:home` used to be a dead action: the router handled it
 * and `handleMenuHome` was written for it, but no button anywhere produced
 * `menu:home`, so the action could not be reached. That is the same defect
 * Phase 2.1 found one level up (four handlers imported into `index.ts` and
 * called by nothing), and it is invisible to a test that drives the bot —
 * driving can only reach actions that are already reachable.
 *
 * The label is exported and the button is built at each site rather than
 * returned as a keyboard, because the two sites want it in different rows: the
 * flow puts it beside "🔄 Yenidən başla", the photo step puts it beside
 * "🔄 Yenidən çək". What must not drift is what the merchandiser reads, and
 * that is this string. The `callback_data` format is already centralised in
 * `callbacks.ts`, which is where 2.1 put it.
 */
export const MENU_HOME_LABEL = '🏠 Menyu';

/**
 * Asks for the device's location.
 *
 * `oneTime()` matters: a reply keyboard persists until it is replaced, and a
 * sticky location button under every later message invites a stray tap that
 * would attach coordinates to the wrong task. `resized()` keeps it from
 * swallowing half the screen on a small phone.
 */
export function locationRequestKeyboard(): Keyboard {
  return new Keyboard()
    .requestLocation('📍 Lokasiyamı göndər')
    .text(LOCATION_SKIP_LABEL)
    .resized()
    .oneTime();
}
