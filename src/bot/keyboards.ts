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

/** The label on the reply-keyboard button that lists the store's tasks. */
export const MENU_TASKS_LABEL = '📋 Tapşırıqlar';

/** The label on the reply-keyboard button that shows recent audits. */
export const MENU_STATUS_LABEL = '📊 Statusum';

/** The everyday menu: the two things a merchandiser does most. */
export function mainMenuKeyboard(): Keyboard {
  return new Keyboard().text(MENU_TASKS_LABEL).text(MENU_STATUS_LABEL).resized();
}

/**
 * The same two things as inline buttons.
 *
 * Sent with the messages the flow produces, so that a merchandiser who has
 * scrolled away from the reply keyboard — which happens as soon as a checklist
 * has more than a couple of questions — still has the way back in front of them.
 */
export function mainMenuInline(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Tapşırıqlar', encodeCallback('tasks', 'list'))
    .text('📊 Statusum', encodeCallback('status', 'me'))
    .row()
    .text('❓ Kömək', encodeCallback('help', 'show'));
}

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
