/**
 * Escaping for Telegram's legacy Markdown (`parse_mode: 'Markdown'`).
 * ============================================================================
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Telegram's legacy Markdown treats `_ * ` [ ]` as formatting. Any DB- or
 * panel-authored string dropped into a Markdown message unescaped can therefore
 * carry a delimiter that never closes — and Telegram rejects the WHOLE message
 * with `400: can't parse entities`, not just the offending span. The handler
 * then throws, and to the merchandiser the button that triggered it simply
 * "does nothing".
 *
 * This is not hypothetical: a store code like `IPHONE_TEST` embeds a `_`, so
 * `📌 *Seçilmiş tapşırıq:* IPHONE_TEST — …` opened an italic entity that never
 * closed and made the entire task-open flow crash on `sendMessage`. The button
 * looked dead because the message it tried to send was rejected before the flow
 * could start.
 *
 * The rule this module exists to enforce: EVERY value that is not a literal in
 * the source — a store name, a task title, a description, a supervisor's
 * feedback — must be passed through `escapeMarkdown` before it is interpolated
 * into a `parse_mode: 'Markdown'` string. Numbers built in code are the only
 * safe exception.
 */

/** Escapes the characters Telegram's legacy Markdown treats as formatting. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*`[\]]/g, (char) => `\\${char}`);
}
