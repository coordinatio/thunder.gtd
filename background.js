import { clipboardText } from "./format-clipboard.js";
import { parseClipboard } from "./parse-clipboard.js";

const COMMAND = "jump-to-clipboard-message";
const COPY_SUBJECT = "copy-subject";
const COPY_MID = "copy-mid";
const NOTIFICATION_ID = "jump-to-clipboard";
const COPY_TOAST_MS = 2000;

/** @type {SearchSession | null} */
let session = null;

/** @type {Promise<void>} */
let queue = Promise.resolve();

browser.action.onClicked.addListener(() => {
  enqueue(jumpToClipboardMessage);
});

browser.subjectCopy.onDoubleClick.addListener((info) => {
  enqueue(() =>
    writeCopy(info.shiftKey ? "mid" : "subject", info, info.windowId),
  );
});

browser.commands.onCommand.addListener((command, tab) => {
  if (command === COMMAND) {
    enqueue(jumpToClipboardMessage);
  } else if (command === COPY_SUBJECT) {
    enqueue(() => copyCurrent("subject", tab));
  } else if (command === COPY_MID) {
    enqueue(() => copyCurrent("mid", tab));
  }
});

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Copy and jump share one queue, so a jump started after a copy reads the
 * clipboard only once that copy has finished writing it.
 *
 * @param {"subject" | "mid"} mode
 * @param {browser.tabs.Tab | undefined} tab
 */
async function copyCurrent(mode, tab) {
  const windowId = await windowIdFor(tab);
  if (windowId == null) {
    await notify("notifyNoMessage");
    return;
  }

  let current;
  try {
    current = await browser.subjectCopy.getCurrentMessage(windowId);
  } catch (error) {
    console.error(error);
    await notify("notifyCopyFailed");
    return;
  }
  await writeCopy(mode, current, windowId);
}

/**
 * @param {browser.tabs.Tab | undefined} tab
 * @returns {Promise<number | null>}
 */
async function windowIdFor(tab) {
  if (tab?.windowId != null) {
    return tab.windowId;
  }
  try {
    const current = await browser.windows.getCurrent();
    return current?.id ?? null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

/**
 * @param {"subject" | "mid"} mode
 * @param {{kind?: string, subject?: string, headerMessageId?: string, shiftKey?: boolean} | null | undefined} info
 * @param {number | null | undefined} windowId
 */
async function writeCopy(mode, info, windowId) {
  const message = asMessage(info);
  if (message.kind === "none") {
    await notify("notifyNoMessage");
    return;
  }
  if (message.kind === "multiple") {
    await notify("notifyManyMessages");
    return;
  }

  const result = clipboardText(mode, message);
  if (!result.ok) {
    await notify("notifyNoMessageId");
    return;
  }

  try {
    await navigator.clipboard.writeText(result.text);
  } catch (error) {
    console.error(error);
    await notify("notifyCopyFailed");
    return;
  }
  await showCopyToast(windowId, result.text);
}

/**
 * A double-click has no kind. It is one displayed message.
 *
 * @param {{kind?: string, subject?: string, headerMessageId?: string} | null | undefined} info
 */
function asMessage(info) {
  if (!info) {
    return { kind: "none" };
  }
  if (
    info.kind === "none" ||
    info.kind === "multiple" ||
    info.kind === "message"
  ) {
    return info;
  }
  return {
    kind: "message",
    subject: info.subject ?? "",
    headerMessageId: info.headerMessageId ?? "",
  };
}

async function jumpToClipboardMessage() {
  try {
    await jump();
  } catch (error) {
    console.error(error);
    await notify("notifyError");
  }
}

async function jump() {
  const text = await navigator.clipboard.readText();
  const parsed = parseClipboard(text);
  if (parsed.type === "empty") {
    await notify("notifyEmpty");
    return;
  }

  const tab = await findMailTab();
  if (!tab) {
    await notify("notifyNoMailTab");
    return;
  }

  const folderId = tab.displayedFolder?.id ?? null;
  if (parsed.type === "subject" && folderId == null) {
    await notify("notifyNoFolder");
    return;
  }

  const signature = signatureFor(parsed, folderId);
  const fresh = !session || session.abandoned || session.signature !== signature;
  if (fresh) {
    abandon(session);
    session = createSession(parsed, signature, folderId);
  }

  // The toast has to be on screen before messages.query. That call keeps
  // the parent thread busy, so a notice queued after it only appears,
  // then vanishes, when the search finally returns.
  const announce = needsWait(session);
  if (announce) {
    await showSearchToast(tab.windowId, searchToastText(parsed));
  }
  if (fresh) {
    search(session);
  }

  let result;
  try {
    result = await nextMatch(session);
    if (result.type === "found") {
      await reveal(result.message, tab);
    }
  } finally {
    if (announce) {
      await hideSearchToast(tab.windowId);
    }
  }
  if (result.type === "cancelled") {
    return;
  }
  if (result.type === "error") {
    await notify("notifyError");
    return;
  }
  if (result.type === "none") {
    await notify("notifyNotFound");
  }
}

/**
 * A repeat jump already has its match. Only a search that has not produced
 * one yet is slow enough to announce.
 *
 * @param {SearchSession} current
 */
function needsWait(current) {
  if (!current || current.abandoned || current.complete) {
    return false;
  }
  return current.served >= current.messages.length;
}

/**
 * @param {{type: "mid", id: string} | {type: "subject", subject: string}} parsed
 */
function searchToastText(parsed) {
  const query = parsed.type === "mid" ? `mid:${parsed.id}` : parsed.subject;
  return browser.i18n.getMessage("toastSearching", query);
}

/**
 * @param {number | null | undefined} windowId
 * @param {string} text
 */
async function showSearchToast(windowId, text) {
  if (windowId == null) {
    return;
  }
  try {
    await browser.subjectCopy.showToast(windowId, text, 0);
  } catch (error) {
    console.error(error);
  }
}

/**
 * @param {number | null | undefined} windowId
 */
async function hideSearchToast(windowId) {
  if (windowId == null) {
    return;
  }
  try {
    await browser.subjectCopy.hideToast(windowId);
  } catch (error) {
    console.error(error);
  }
}

/**
 * @param {number | null | undefined} windowId
 * @param {string} text
 */
async function showCopyToast(windowId, text) {
  const id = windowId != null ? windowId : await windowIdFor();
  if (id == null) {
    return;
  }
  try {
    await browser.subjectCopy.showToast(
      id,
      browser.i18n.getMessage("toastCopied", text),
      COPY_TOAST_MS,
    );
  } catch (error) {
    console.error(error);
  }
}

/**
 * @param {ReturnType<typeof parseClipboard>} parsed
 * @param {string | null} folderId
 */
function signatureFor(parsed, folderId) {
  if (parsed.type === "mid") {
    return JSON.stringify({ type: "mid", id: parsed.id });
  }
  return JSON.stringify({
    type: "subject",
    folderId,
    subject: parsed.subject,
  });
}

async function findMailTab() {
  const current = await browser.windows.getCurrent();
  const attempts = [
    { windowId: current.id, active: true },
    { windowId: current.id },
    { lastFocusedWindow: true },
    {},
  ];

  for (const queryInfo of attempts) {
    const tabs = await browser.mailTabs.query(queryInfo);
    if (tabs.length > 0) {
      return tabs[0];
    }
  }
  return null;
}

/**
 * @param {browser.messages.MessageHeader} message
 * @param {browser.mailTabs.MailTab} tab
 */
async function reveal(message, tab) {
  await focusMailTab(tab);
  let result = await trySelect(tab.tabId, message.id);
  if (result === "selected") {
    return;
  }

  // A quick filter can hide the row. Clearing it rebuilds the view, so the
  // selection is retried until the row appears.
  await clearQuickFilter(tab.tabId);
  const deadline = Date.now() + (result === "hidden" ? 2000 : 0);
  do {
    result = await trySelect(tab.tabId, message.id);
    if (result === "selected") {
      return;
    }
    if (result !== "hidden" || Date.now() >= deadline) {
      break;
    }
    await delay(100);
  } while (Date.now() < deadline);

  throw new Error("Message could not be selected");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {browser.mailTabs.MailTab} tab
 */
async function focusMailTab(tab) {
  try {
    await browser.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    console.error(error);
  }
  try {
    await browser.tabs.update(tab.tabId, { active: true });
  } catch (error) {
    console.error(error);
  }
}

/**
 * @param {number} tabId
 * @param {number} messageId
 * @returns {Promise<"selected" | "hidden" | "error">}
 */
async function trySelect(tabId, messageId) {
  try {
    await browser.mailTabs.setSelectedMessages(tabId, [messageId]);
  } catch (error) {
    console.error(error);
    return "error";
  }

  const listed = await browser.mailTabs.getSelectedMessages(tabId);
  const selected = (listed.messages || []).some((item) => item.id === messageId);
  return selected ? "selected" : "hidden";
}

/**
 * setQuickFilter drops every constraint before it applies the new state.
 * Hiding the bar leaves that cleared state in place. unread:false and
 * starred:false are real constraints, so those keys stay unset.
 *
 * @param {number} tabId
 */
async function clearQuickFilter(tabId) {
  await browser.mailTabs.setQuickFilter(tabId, { show: false });
}

/**
 * @param {string} messageKey
 */
async function notify(messageKey) {
  const options = {
    type: "basic",
    title: browser.i18n.getMessage("extensionName"),
    message: browser.i18n.getMessage(messageKey),
  };
  try {
    await browser.notifications.create(NOTIFICATION_ID, {
      ...options,
      iconUrl: browser.runtime.getURL("icons/jump.svg"),
    });
  } catch (error) {
    console.error(error);
    try {
      await browser.notifications.create(NOTIFICATION_ID, options);
    } catch (fallbackError) {
      console.error(fallbackError);
    }
  }
}

/**
 * @param {ReturnType<typeof parseClipboard> & {type: "mid" | "subject"}} parsed
 * @param {string} signature
 * @param {string | null} folderId
 * @returns {SearchSession}
 */
function createSession(parsed, signature, folderId) {
  return {
    signature,
    parsed,
    folderId,
    messages: [],
    seen: new Set(),
    served: 0,
    waiters: [],
    complete: false,
    abandoned: false,
    error: null,
    listId: null,
  };
}

/**
 * @param {SearchSession | null} current
 */
function abandon(current) {
  if (!current || current.abandoned) {
    return;
  }
  current.abandoned = true;
  const listId = current.listId;
  current.listId = null;
  if (listId != null) {
    browser.messages.abortList(listId).catch(() => {});
  }
  const waiters = current.waiters.splice(0);
  for (const resolve of waiters) {
    resolve({ type: "cancelled" });
  }
}

/**
 * @param {SearchSession} current
 * @returns {Promise<SearchResult>}
 */
function nextMatch(current) {
  return new Promise((resolve) => {
    current.waiters.push(resolve);
    flushWaiters(current);
  });
}

/**
 * @param {SearchSession} current
 */
function flushWaiters(current) {
  while (current.waiters.length > 0 && current.served < current.messages.length) {
    const message = current.messages[current.served];
    current.served += 1;
    current.waiters.shift()({ type: "found", message });
  }

  if (!current.complete || current.waiters.length === 0) {
    return;
  }

  if (current.messages.length === 0) {
    const type = current.error ? "error" : "none";
    while (current.waiters.length > 0) {
      current.waiters.shift()({ type });
    }
    return;
  }

  while (current.waiters.length > 0) {
    const message = current.messages[current.served % current.messages.length];
    current.served += 1;
    current.waiters.shift()({ type: "found", message });
  }
}

/**
 * @param {SearchSession} current
 */
function search(current) {
  scan(current).catch((error) => {
    if (current.abandoned) {
      return;
    }
    console.error(error);
    current.error = error;
    complete(current);
  });
}

/**
 * @param {SearchSession} current
 */
async function scan(current) {
  if (current.parsed.type === "mid") {
    if (!current.parsed.id) {
      complete(current);
      return;
    }
    // nsIMsgDBHdr.messageId has no angle brackets, and messages.query
    // compares it exactly. Try that spelling first, then the bracketed one.
    await runQuery(current, { headerMessageId: current.parsed.id });
    if (current.abandoned) {
      return;
    }
    if (current.messages.length === 0) {
      const bracketedFailed = await runQuery(current, {
        headerMessageId: `<${current.parsed.id}>`,
      });
      if (current.abandoned) {
        return;
      }
      if (bracketedFailed && current.messages.length === 0) {
        current.error = bracketedFailed;
      }
    }
  } else {
    const failed = await runQuery(current, {
      folderId: current.folderId,
      subject: current.parsed.subject,
      includeSubFolders: false,
    });
    if (current.abandoned) {
      return;
    }
    if (failed && current.messages.length === 0) {
      current.error = failed;
    }
  }

  complete(current);
}

/**
 * Runs one query. A failure is returned so a mid: lookup can try the
 * other Message-ID spelling before the search is finished.
 *
 * @param {SearchSession} current
 * @param {object} criteria
 * @returns {Promise<Error | null>}
 */
async function runQuery(current, criteria) {
  try {
    await consume(current, criteria);
    return null;
  } catch (error) {
    if (current.abandoned) {
      return null;
    }
    console.error(error);
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * @param {SearchSession} current
 * @param {object} criteria
 */
async function consume(current, criteria) {
  let page = await browser.messages.query({
    ...criteria,
    messagesPerPage: 100,
    autoPaginationTimeout: 250,
  });

  while (page && (page.messages || []).length) {
    if (current.abandoned) {
      abortPage(page);
      return;
    }

    if (page.id != null) {
      current.listId = page.id;
    }
    absorb(current, page.messages);

    if (current.abandoned) {
      abortPage(page);
      return;
    }
    if (page.id == null) {
      break;
    }

    page = await browser.messages.continueList(page.id);
  }

  if (!current.abandoned) {
    current.listId = null;
  }
}

/**
 * @param {SearchSession} current
 * @param {browser.messages.MessageHeader[] | undefined} messages
 */
function absorb(current, messages) {
  for (const message of messages || []) {
    if (current.seen.has(message.id) || !matches(current, message)) {
      continue;
    }
    current.seen.add(message.id);
    current.messages.push(message);
    flushWaiters(current);
  }
}

/**
 * messages.query({ subject }) returns every subject that contains the text.
 * Keep only messages whose subject is exactly the clipboard text.
 *
 * @param {SearchSession} current
 * @param {browser.messages.MessageHeader} message
 */
function matches(current, message) {
  if (current.parsed.type === "mid") {
    return true;
  }
  const subject = (message.subject ?? "").trim().normalize("NFC");
  return subject === current.parsed.subject;
}

/**
 * @param {{ id?: string | number | null }} page
 */
function abortPage(page) {
  if (page?.id != null) {
    browser.messages.abortList(page.id).catch(() => {});
  }
}

/**
 * @param {SearchSession} current
 */
function complete(current) {
  if (current.abandoned || current.complete) {
    return;
  }
  current.complete = true;
  current.listId = null;
  flushWaiters(current);
}

/**
 * @typedef {object} SearchSession
 * @property {string} signature
 * @property {{type: "mid", id: string} | {type: "subject", subject: string}} parsed
 * @property {string | null} folderId
 * @property {browser.messages.MessageHeader[]} messages
 * @property {Set<number>} seen
 * @property {number} served
 * @property {Array<(result: SearchResult) => void>} waiters
 * @property {boolean} complete
 * @property {boolean} abandoned
 * @property {Error | null} error
 * @property {string | number | null} listId
 */

/**
 * @typedef {{type: "found", message: browser.messages.MessageHeader}
 *   | {type: "none"}
 *   | {type: "error"}
 *   | {type: "cancelled"}} SearchResult
 */
