/**
 * Clipboard text for a later jump. A subject is wrapped in one pair of
 * ASCII quotes. parseClipboard strips that pair, so the quoted text and the
 * bare subject are the same search.
 */

/**
 * @param {unknown} subject
 * @returns {string}
 */
export function formatSubject(subject) {
  const text = String(subject ?? "").normalize("NFC").trim();
  return `"${text}"`;
}

/**
 * Percent-encode characters the mid: parser would trim, split on, or
 * decode. A slash stays literal: the id is wrapped in angle brackets, and
 * the parser keeps slashes inside that pair.
 *
 * @param {string} id
 * @returns {string}
 */
function encodeMessageId(id) {
  return id.replace(/[%<>\s]/g, (char) => encodeURIComponent(char));
}

/**
 * @param {unknown} id
 * @returns {string}
 */
export function formatMidLink(id) {
  const text = String(id ?? "").normalize("NFC");
  return `mid:<${encodeMessageId(text)}>`;
}

/**
 * @param {"subject" | "mid"} mode
 * @param {{subject?: string, headerMessageId?: string} | null | undefined} message
 * @returns {{ok: true, text: string} | {ok: false, reason: "no-message-id"}}
 */
export function clipboardText(mode, message) {
  if (mode === "mid") {
    const id = message?.headerMessageId ?? "";
    if (!id) {
      return { ok: false, reason: "no-message-id" };
    }
    return { ok: true, text: formatMidLink(id) };
  }
  return { ok: true, text: formatSubject(message?.subject ?? "") };
}
