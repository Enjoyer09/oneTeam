/**
 * oneTeam Telegram Bot — reply keyboards
 * ============================================================================
 *
 * These lived inline in `handlers/start.ts` and `handlers/tasks.ts`. They are
 * here now because the guided field flow has to *restore* the main menu after it
 * has replaced it with the location prompt, and two definitions of "the main
 * menu" would drift the first time one of them changed.
 */

import { Keyboard } from 'grammy';

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

/** The everyday menu: the two things a merchandiser does most. */
export function mainMenuKeyboard(): Keyboard {
  return new Keyboard().text('📋 Tapşırıqlar').text('📊 Statusum').resized();
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
