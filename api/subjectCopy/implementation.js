var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs",
);
var { ExtensionParent } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionParent.sys.mjs",
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs",
);

var subjectCopy = class extends ExtensionCommon.ExtensionAPIPersistent {
  PERSISTENT_EVENTS = {
    onCopyRequested({ fire }) {
      return this.registerCopyRequests(fire);
    },
  };

  getAPI(context) {
    context.callOnClose({
      close() {
        dismissAllToasts();
      },
    });

    return {
      subjectCopy: {
        onCopyRequested: new ExtensionCommon.EventManager({
          context,
          module: "subjectCopy",
          event: "onCopyRequested",
          extensionApi: this,
        }).api(),

        async getCurrentMessage(windowId) {
          return describeWindow(windowFromId(windowId));
        },

        async showToast(windowId, text, timeoutMs) {
          const window = windowFromId(windowId);
          if (!window) {
            return;
          }
          presentToast(window, text, timeoutMs);
          await paintSoon(window);
        },

        async hideToast(windowId) {
          const window = windowFromId(windowId);
          if (!window) {
            return;
          }
          dismissToast(window);
        },
      },
    };

    function windowFromId(windowId) {
      try {
        return ExtensionParent.apiManager.global.windowTracker.getWindow(
          windowId,
          context,
        );
      } catch (error) {
        console.error(error);
        return null;
      }
    }
  }

  registerCopyRequests(fire) {
    const extension = this.extension;
    const listenerId = `${extension.id}#subject-copy`;
    const documentListeners = new Map();
    const watchedBrowsers = new WeakSet();
    const watched3Pane = new WeakSet();
    const observedPanes = new WeakSet();
    const disconnectors = [];
    let installed = ExtensionSupport.registerWindowListener(listenerId, {
      chromeURLs: [
        "chrome://messenger/content/messenger.xhtml",
        "chrome://messenger/content/messageWindow.xhtml",
      ],
      onLoadWindow: watchChromeWindow,
    });

    return {
      unregister: uninstall,
      convert(newFire) {
        fire = newFire;
      },
    };

    function uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      ExtensionSupport.unregisterWindowListener(listenerId);
      for (const disconnect of disconnectors.splice(0)) {
        try {
          disconnect();
        } catch (error) {
          console.error(error);
        }
      }
      for (const listener of documentListeners.values()) {
        detachButtons(listener);
      }
      documentListeners.clear();
    }

    function watchChromeWindow(window) {
      const type = window.document.documentElement.getAttribute("windowtype");
      if (type === "mail:messageWindow") {
        watchBrowser(window.document.getElementById("messageBrowser"));
        return;
      }

      const tabmail = window.document.getElementById("tabmail");
      if (!tabmail) {
        return;
      }
      for (const tab of tabmail.tabInfo || []) {
        watchTab(tab);
      }
      const monitor = {
        onTabOpened: watchTab,
        onTabRestored: watchTab,
        onTabSwitched: watchTab,
        // Tabmail calls this on every registered monitor.
        onTabTitleChanged() {},
      };
      tabmail.registerTabMonitor(monitor);
      disconnectors.push(() => tabmail.unregisterTabMonitor(monitor));
    }

    function watchTab(tab) {
      const name = tab?.mode?.name;
      if (name === "mailMessageTab") {
        watchBrowser(tab.chromeBrowser);
        return;
      }
      if (name === "mail3PaneTab") {
        watch3Pane(tab.chromeBrowser);
      }
    }

    function watch3Pane(browser) {
      if (!browser || watched3Pane.has(browser)) {
        return;
      }
      watched3Pane.add(browser);
      const update = () => {
        let win = null;
        try {
          win = browser.contentWindow;
        } catch (error) {
          console.error(error);
          return;
        }
        if (!win || win.location?.href !== "about:3pane") {
          return;
        }
        const pane = win.document.getElementById("messagePane");
        const found = () =>
          win.messageBrowser || pane?.querySelector("#messageBrowser");
        const messageBrowser = found();
        if (messageBrowser) {
          watchBrowser(messageBrowser);
          return;
        }
        if (!pane || observedPanes.has(pane)) {
          return;
        }
        observedPanes.add(pane);
        const observer = new win.MutationObserver(() => {
          const messageBrowser = found();
          if (!messageBrowser) {
            return;
          }
          observer.disconnect();
          watchBrowser(messageBrowser);
        });
        observer.observe(pane, { childList: true, subtree: true });
        disconnectors.push(() => observer.disconnect());
      };
      browser.addEventListener("load", update, true);
      disconnectors.push(() => browser.removeEventListener("load", update, true));
      update();
    }

    function watchBrowser(browser) {
      if (!browser || watchedBrowsers.has(browser)) {
        return;
      }
      watchedBrowsers.add(browser);
      const update = () => {
        let doc = null;
        try {
          doc = browser.contentDocument;
        } catch (error) {
          console.error(error);
          return;
        }
        attachButtons(doc);
      };
      browser.addEventListener("load", update, true);
      disconnectors.push(() => browser.removeEventListener("load", update, true));
      update();
    }

    function attachButtons(doc) {
      if (!doc || documentListeners.has(doc) || !isAboutMessage(doc)) {
        return;
      }
      const toolbar = doc.getElementById("header-view-toolbar");
      if (!toolbar) {
        return;
      }
      const buttons = HEADER_BUTTONS.map((spec) =>
        ensureHeaderButton(doc, toolbar, spec),
      );
      const onPageHide = (event) => {
        // Switching messages hides the nested body document, but reuses this header.
        if (event.target !== doc) {
          return;
        }
        const listener = documentListeners.get(doc);
        if (!listener) {
          return;
        }
        detachButtons(listener);
        documentListeners.delete(doc);
      };
      doc.defaultView?.addEventListener("pagehide", onPageHide);
      documentListeners.set(doc, { doc, onPageHide, buttons });
    }

    function ensureHeaderButton(doc, toolbar, spec) {
      let button = doc.getElementById(spec.id);
      if (!button) {
        button = createHeaderButton(doc, spec);
        const more = toolbar.querySelector("#otherActionsButton");
        if (more) {
          toolbar.insertBefore(button, more);
        } else {
          toolbar.appendChild(button);
        }
      }
      const onCommand = () => {
        requestCopy(doc, spec.mode, fire);
      };
      // Match the built-in header buttons: a click must not leave focus here.
      const onMouseDown = (event) => {
        event.preventDefault();
      };
      button.addEventListener("command", onCommand);
      button.addEventListener("mousedown", onMouseDown);
      return { button, onCommand, onMouseDown };
    }

    function createHeaderButton(doc, spec) {
      const button = doc.createXULElement
        ? doc.createXULElement("toolbarbutton")
        : doc.createElementNS(XUL_NS, "toolbarbutton");
      button.id = spec.id;
      button.className = "toolbarbutton-1 message-header-view-button";
      button.setAttribute("label", message(spec.labelKey));
      button.setAttribute("tooltiptext", message(spec.tooltipKey));
      button.style.setProperty("-moz-context-properties", "fill, stroke");
      button.style.setProperty("fill", "currentColor");
      button.style.setProperty("stroke", "currentColor");
      button.style.setProperty(
        "list-style-image",
        `url("${extension.getURL(spec.icon)}")`,
      );
      return button;
    }

    function message(key) {
      try {
        return extension.localeData.localizeMessage(key) || key;
      } catch (error) {
        console.error(error);
        return key;
      }
    }
  }
};

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

const HEADER_BUTTONS = [
  {
    id: "jump-to-clipboard-copy-subject",
    mode: "subject",
    labelKey: "buttonCopySubject",
    tooltipKey: "commandCopySubject",
    icon: "icons/subject.svg",
  },
  {
    id: "jump-to-clipboard-copy-mid",
    mode: "mid",
    labelKey: "buttonCopyMid",
    tooltipKey: "commandCopyMid",
    icon: "icons/mid.svg",
  },
];

/**
 * @param {{doc: Document, onPageHide: EventListener, buttons: Array<{button: Element, onCommand: EventListener, onMouseDown: EventListener}>}} listener
 */
function detachButtons(listener) {
  try {
    listener.doc.defaultView?.removeEventListener("pagehide", listener.onPageHide);
  } catch (error) {
    console.error(error);
  }
  for (const item of listener.buttons || []) {
    try {
      item.button.removeEventListener("command", item.onCommand);
      item.button.removeEventListener("mousedown", item.onMouseDown);
      item.button.remove();
    } catch (error) {
      console.error(error);
    }
  }
}

/**
 * @param {Document} doc
 * @param {"subject" | "mid"} mode
 * @param {{async: Function}} fire
 */
function requestCopy(doc, mode, fire) {
  const described = describeAboutMessage(doc.defaultView);
  const info = {
    mode,
    kind: described.kind === "message" ? "message" : "none",
  };
  if (described.kind === "message") {
    info.subject = described.subject;
    info.headerMessageId = described.headerMessageId;
  }
  const windowId = chromeWindowId(doc);
  if (windowId != null) {
    info.windowId = windowId;
  }
  fire.async(info).catch(console.error);
}

/**
 * The subject lives in about:message. The toast belongs on the outer mail
 * window, which is the top chrome window or a browser a few levels up.
 *
 * @param {Document} doc
 * @returns {number | null}
 */
function chromeWindowId(doc) {
  const win = chromeWindowFor(doc);
  if (!win) {
    return null;
  }
  try {
    const id = ExtensionParent.apiManager.global.windowTracker.getId(win);
    return Number.isInteger(id) ? id : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

/**
 * @param {Document | null | undefined} doc
 * @returns {Window | null}
 */
function chromeWindowFor(doc) {
  try {
    const direct = doc?.defaultView?.browsingContext?.topChromeWindow;
    if (isMailChrome(direct)) {
      return direct;
    }
  } catch (error) {
    console.error(error);
  }
  try {
    let node = doc?.defaultView?.docShell?.chromeEventHandler;
    for (let i = 0; node && i < 6; i += 1) {
      const win = node.ownerGlobal;
      if (isMailChrome(win)) {
        return win;
      }
      node = win?.docShell?.chromeEventHandler;
    }
  } catch (error) {
    console.error(error);
  }
  return null;
}

/**
 * @param {Window | null | undefined} win
 */
function isMailChrome(win) {
  if (!win || win.closed) {
    return false;
  }
  try {
    const type = win.document?.documentElement?.getAttribute("windowtype") || "";
    return type === "mail:3pane" || type === "mail:messageWindow";
  } catch (error) {
    console.error(error);
    return false;
  }
}

/**
 * @param {Document | null | undefined} doc
 */
function isAboutMessage(doc) {
  let href = "";
  try {
    href = doc.documentURI || "";
  } catch {
    return false;
  }
  return href === "about:message" || href.startsWith("about:message?");
}

/**
 * @param {Window | null} window
 * @returns {{kind: "message", subject: string, headerMessageId: string}
 *   | {kind: "none"}
 *   | {kind: "multiple"}}
 */
function describeWindow(window) {
  if (!window || window.closed) {
    return { kind: "none" };
  }
  let type = "";
  try {
    type = window.document.documentElement.getAttribute("windowtype") || "";
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
  if (type === "mail:messageWindow") {
    try {
      const browser = window.document.getElementById("messageBrowser");
      if (!browser || browser.hidden) {
        return { kind: "none" };
      }
      return describeAboutMessage(browser.contentWindow);
    } catch (error) {
      console.error(error);
      return { kind: "none" };
    }
  }

  const tabmail = window.document.getElementById("tabmail");
  const tab = tabmail?.currentTabInfo;
  const name = tab?.mode?.name;
  if (name === "mailMessageTab") {
    try {
      return describeAboutMessage(tab.chromeBrowser?.contentWindow);
    } catch (error) {
      console.error(error);
      return { kind: "none" };
    }
  }
  if (name === "mail3PaneTab") {
    try {
      return describe3Pane(tab.chromeBrowser?.contentWindow);
    } catch (error) {
      console.error(error);
      return { kind: "none" };
    }
  }
  return { kind: "none" };
}

/**
 * The open message pane shows that message. A hidden pane uses the selected
 * list row, so a collapsed thread contributes its row header rather than
 * every message in the thread.
 *
 * @param {Window | null | undefined} win
 */
function describe3Pane(win) {
  if (!win) {
    return { kind: "none" };
  }
  let paneVisible = false;
  try {
    paneVisible = !!win.paneLayout?.messagePaneVisible;
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
  if (!paneVisible) {
    return describeSelection(win);
  }
  try {
    if (win.messagePane?.isMultiMessageBrowserVisible?.()) {
      return { kind: "multiple" };
    }
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
  try {
    const browser = win.messageBrowser;
    if (!browser || browser.hidden) {
      return { kind: "none" };
    }
    return describeAboutMessage(browser.contentWindow);
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
}

/**
 * @param {Window | null | undefined} win
 */
function describeSelection(win) {
  let indices = [];
  try {
    indices = [...(win.threadTree?.selectedIndices || [])];
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
  if (indices.length === 0) {
    return { kind: "none" };
  }
  if (indices.length > 1) {
    return { kind: "multiple" };
  }
  let header = null;
  try {
    header = win.gDBView?.getMsgHdrAt(indices[0]);
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
  return describeHeader(header);
}

/**
 * @param {Window | null | undefined} win
 */
function describeAboutMessage(win) {
  let header = null;
  try {
    header = win?.gMessage;
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
  return describeHeader(header);
}

/**
 * @param {nsIMsgDBHdr | null | undefined} header
 */
function describeHeader(header) {
  if (!header) {
    return { kind: "none" };
  }
  try {
    return {
      kind: "message",
      subject: header.mime2DecodedSubject || "",
      headerMessageId: header.messageId || "",
    };
  } catch (error) {
    console.error(error);
    return { kind: "none" };
  }
}

var TOAST_ID = "jump-to-clipboard-toast";
var HTML_NS = "http://www.w3.org/1999/xhtml";
var TOAST_STYLE = [
  "position: fixed",
  "left: 50%",
  "top: 50%",
  "transform: translate(-50%, -50%)",
  "z-index: 100000",
  "width: max-content",
  "max-width: min(36rem, 70vw)",
  "box-sizing: border-box",
  "padding: 10px 16px",
  "border-radius: 6px",
  "border: 1px solid light-dark(transparent, var(--color-gray-30))",
  "box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25)",
  "background: light-dark(var(--color-gray-90), var(--color-gray-05))",
  "color: light-dark(var(--color-gray-05), var(--color-gray-90))",
  "font: message-box",
  "font-size: 1rem",
  "text-align: start",
  "pointer-events: none",
  "overflow: hidden",
  "text-overflow: ellipsis",
  "white-space: nowrap",
].join("; ");

/** @type {Set<Window>} */
var toastWindows = new Set();

/** @type {WeakMap<Window, number>} */
var toastTimers = new WeakMap();

/** @type {WeakSet<Window>} */
var watchedToastWindows = new WeakSet();

/**
 * @param {Window} window
 * @param {unknown} text
 * @param {number} timeoutMs
 */
function presentToast(window, text, timeoutMs) {
  if (!window || window.closed) {
    return;
  }
  const doc = window.document;
  let host = doc.getElementById(TOAST_ID);
  if (!host) {
    host = doc.createElementNS(HTML_NS, "div");
    host.id = TOAST_ID;
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    host.style.cssText = TOAST_STYLE;
    doc.documentElement.appendChild(host);
  }
  host.textContent = String(text ?? "").replace(/\s+/g, " ").trim();
  armToastTimer(window, timeoutMs);
  trackToastWindow(window);
}

/**
 * A timeout of 0 leaves the toast up until dismissToast. A later show
 * replaces both the text and any pending timer.
 *
 * @param {Window} window
 * @param {number} timeoutMs
 */
function armToastTimer(window, timeoutMs) {
  const previous = toastTimers.get(window);
  if (previous) {
    window.clearTimeout(previous);
    toastTimers.delete(window);
  }
  if (!(timeoutMs > 0)) {
    return;
  }
  const timer = window.setTimeout(() => {
    toastTimers.delete(window);
    dismissToast(window);
  }, timeoutMs);
  toastTimers.set(window, timer);
}

/**
 * @param {Window} window
 */
function trackToastWindow(window) {
  toastWindows.add(window);
  if (watchedToastWindows.has(window)) {
    return;
  }
  watchedToastWindows.add(window);
  window.addEventListener(
    "unload",
    () => {
      toastWindows.delete(window);
      const timer = toastTimers.get(window);
      if (!timer) {
        return;
      }
      toastTimers.delete(window);
      try {
        window.clearTimeout(timer);
      } catch (error) {
        console.error(error);
      }
    },
    { once: true },
  );
}

/**
 * @param {Window | null | undefined} window
 */
function dismissToast(window) {
  if (!window) {
    return;
  }
  const timer = toastTimers.get(window);
  if (timer) {
    toastTimers.delete(window);
    try {
      window.clearTimeout(timer);
    } catch (error) {
      console.error(error);
    }
  }
  toastWindows.delete(window);
  if (window.closed) {
    return;
  }
  try {
    window.document.getElementById(TOAST_ID)?.remove();
  } catch (error) {
    console.error(error);
  }
}

function dismissAllToasts() {
  for (const window of [...toastWindows]) {
    dismissToast(window);
  }
}

/**
 * Resolves after the window has a chance to paint the toast. A search
 * started in the same turn would block that paint.
 *
 * @param {Window} window
 */
function paintSoon(window) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    if (!window || window.closed) {
      finish();
      return;
    }
    try {
      window.requestAnimationFrame(() => {
        window.setTimeout(finish, 0);
      });
    } catch (error) {
      console.error(error);
      finish();
      return;
    }
    window.setTimeout(finish, 100);
  });
}
