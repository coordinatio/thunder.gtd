/**
 * Clipboard text is either a mid: link or an exact subject.
 * Leading and trailing whitespace is ignored. A mid: link is recognized
 * only when the trimmed text starts with that prefix.
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

  if (/^mid:/i.test(trimmed)) {
    const raw = trimmed.replace(/^mid:/i, "");
    return { type: "mid", id: messageIdFromMidUrl(raw).normalize("NFC") };
  }

  return { type: "subject", subject: trimmed.normalize("NFC") };
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
