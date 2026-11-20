/**
 * Clipboard text is either a mid: link or an exact subject.
 * Leading and trailing whitespace is ignored. A mid: link is recognized
 * only when the trimmed text starts with that prefix.
 *
 * One surrounding pair of ASCII quotes is a subject wrapper, not part of
 * the subject. "Тема" and Тема are the same search. The text inside the
 * quotes is not inspected for a mid: prefix, so a copied subject that
 * itself starts with mid: stays a subject.
 *
 * @param {unknown} text
 * @returns {{type: "empty"} | {type: "mid", id: string} | {type: "subject", subject: string}}
 */
export function parseClipboard(text) {
  if (typeof text !== "string") {
    return { type: "empty" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { type: "empty" };
  }

  if (isQuoted(trimmed)) {
    const subject = unwrapQuotes(trimmed).trim().normalize("NFC");
    if (!subject) {
      return { type: "empty" };
    }
    return { type: "subject", subject };
  }

  if (/^mid:/i.test(trimmed)) {
    const raw = trimmed.replace(/^mid:/i, "");
    return { type: "mid", id: messageIdFromMidUrl(raw).normalize("NFC") };
  }

  return { type: "subject", subject: trimmed.normalize("NFC") };
}

/**
 * @param {string} value
 */
function isQuoted(value) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"');
}

/**
 * @param {string} value
 */
function unwrapQuotes(value) {
  return value.slice(1, -1);
}

/**
 * RFC 2392 puts an optional content-id after the first unencoded slash.
 * Slashes that belong to the message-id are either percent-encoded or
 * wrapped inside <...>, so they are kept.
 */
function messageIdFromMidUrl(raw) {
  let value = firstLine(raw).trim();
  value = stripContentId(value);
  value = safeDecode(value).trim();
  return stripAngleBrackets(value);
}

function firstLine(value) {
  const lineBreak = value.search(/\r?\n/);
  if (lineBreak === -1) {
    return value;
  }
  return value.slice(0, lineBreak);
}

function stripContentId(value) {
  if (value.startsWith("<")) {
    const close = value.indexOf(">");
    if (close !== -1) {
      return value.slice(0, close + 1);
    }
  }

  const slash = value.indexOf("/");
  if (slash !== -1) {
    return value.slice(0, slash);
  }
  return value;
}

function stripAngleBrackets(value) {
  if (value.startsWith("<") && value.endsWith(">") && value.length >= 2) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
