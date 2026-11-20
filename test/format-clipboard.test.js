import assert from "node:assert/strict";
import test from "node:test";
import { clipboardText, formatMidLink, formatSubject } from "../format-clipboard.js";
import { parseClipboard } from "../parse-clipboard.js";

const MESSAGE_ID = "39070706a37245d09381099c4ac42ebb@contentai.ru";

test("a copied subject is the same search as the bare subject", () => {
  const subjects = ["Отчёт", "Re: Отчёт", "100% done", "  spaced  "];
  for (const subject of subjects) {
    const copied = clipboardText("subject", { subject });
    assert.equal(copied.ok, true);
    const expected = subject.normalize("NFC").trim();
    assert.deepEqual(parseClipboard(copied.text), {
      type: "subject",
      subject: expected,
    });
    assert.deepEqual(parseClipboard(copied.text), parseClipboard(expected));
  }
});

test("a subject that already has quotes keeps them after one unwrap", () => {
  const copied = clipboardText("subject", { subject: '"тема"' });
  assert.deepEqual(copied, { ok: true, text: '""тема""' });
  assert.deepEqual(parseClipboard(copied.text), {
    type: "subject",
    subject: '"тема"',
  });
});

test("a copied subject that starts with mid: stays a subject", () => {
  const copied = clipboardText("subject", { subject: "mid:not-a-link" });
  assert.equal(copied.ok, true);
  assert.deepEqual(parseClipboard(copied.text), {
    type: "subject",
    subject: "mid:not-a-link",
  });
});

test("an empty subject copies quotes that the jump treats as empty", () => {
  const copied = clipboardText("subject", { subject: "   " });
  assert.deepEqual(copied, { ok: true, text: '""' });
  assert.deepEqual(parseClipboard(copied.text), { type: "empty" });
});

test("copied subject text is wrapped in one pair of quotes", () => {
  assert.equal(formatSubject("Отчёт"), '"Отчёт"');
  assert.equal(formatSubject("  Re: Отчёт  "), '"Re: Отчёт"');
  assert.equal(formatSubject("\u0438\u0306"), '"\u0439"');
});

test("a copied mid link parses back to the same id", () => {
  const ids = [
    MESSAGE_ID,
    "AbC@Example.COM",
    "abc/def@host",
    "100%",
    "100%20",
    "a b@host",
    "a>b@host",
    "a<b@host",
    "line\nbreak@host",
  ];
  for (const id of ids) {
    const copied = clipboardText("mid", { headerMessageId: id });
    assert.equal(copied.ok, true);
    assert.equal(copied.text, formatMidLink(id));
    assert.deepEqual(parseClipboard(copied.text), {
      type: "mid",
      id: id.normalize("NFC"),
    });
  }
});

test("a message without an id is not copied as a mid link", () => {
  assert.deepEqual(clipboardText("mid", { headerMessageId: "" }), {
    ok: false,
    reason: "no-message-id",
  });
  assert.deepEqual(clipboardText("mid", {}), {
    ok: false,
    reason: "no-message-id",
  });
});
