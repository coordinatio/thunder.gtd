import assert from "node:assert/strict";
import test from "node:test";
import { parseClipboard } from "../parse-clipboard.js";

const MESSAGE_ID = "39070706a37245d09381099c4ac42ebb@contentai.ru";

test("blank clipboard is empty", () => {
  assert.deepEqual(parseClipboard(""), { type: "empty" });
  assert.deepEqual(parseClipboard(" \n\t "), { type: "empty" });
  assert.deepEqual(parseClipboard(null), { type: "empty" });
  assert.deepEqual(parseClipboard(undefined), { type: "empty" });
});

test("ordinary text is an exact subject", () => {
  assert.deepEqual(parseClipboard("Отчёт"), {
    type: "subject",
    subject: "Отчёт",
  });
  assert.deepEqual(parseClipboard("  Re: Отчёт  "), {
    type: "subject",
    subject: "Re: Отчёт",
  });
  assert.deepEqual(parseClipboard("see mid:inside the subject"), {
    type: "subject",
    subject: "see mid:inside the subject",
  });
  assert.deepEqual(parseClipboard("100% done"), {
    type: "subject",
    subject: "100% done",
  });
});

test("subject is normalized to NFC", () => {
  assert.deepEqual(parseClipboard("\u0438\u0306"), {
    type: "subject",
    subject: "\u0439",
  });
});

test("mid link without brackets", () => {
  assert.deepEqual(parseClipboard(`mid:${MESSAGE_ID}`), {
    type: "mid",
    id: MESSAGE_ID,
  });
  assert.deepEqual(parseClipboard(`  MID:${MESSAGE_ID}  `), {
    type: "mid",
    id: MESSAGE_ID,
  });
  assert.deepEqual(parseClipboard(`mid:   ${MESSAGE_ID}`), {
    type: "mid",
    id: MESSAGE_ID,
  });
});

test("mid link keeps message-id case", () => {
  assert.deepEqual(parseClipboard("mid:AbC@Example.COM"), {
    type: "mid",
    id: "AbC@Example.COM",
  });
});

test("mid link with angle brackets", () => {
  assert.deepEqual(parseClipboard(`mid:<${MESSAGE_ID}>`), {
    type: "mid",
    id: MESSAGE_ID,
  });
  assert.deepEqual(parseClipboard("mid:%3CAbC%40Example.COM%3E"), {
    type: "mid",
    id: "AbC@Example.COM",
  });
});

test("mid link drops the content-id tail", () => {
  assert.deepEqual(parseClipboard(`mid:${MESSAGE_ID}/part-1`), {
    type: "mid",
    id: MESSAGE_ID,
  });
  assert.deepEqual(parseClipboard(`mid:<${MESSAGE_ID}>/part-1`), {
    type: "mid",
    id: MESSAGE_ID,
  });
  assert.deepEqual(parseClipboard("mid:abc%2Fdef@host/part"), {
    type: "mid",
    id: "abc/def@host",
  });
  assert.deepEqual(parseClipboard("mid:<abc/def@host>"), {
    type: "mid",
    id: "abc/def@host",
  });
});

test("broken percent-encoding is kept as written", () => {
  assert.deepEqual(parseClipboard("mid:100%"), {
    type: "mid",
    id: "100%",
  });
});

test("empty mid link is not treated as a subject", () => {
  assert.deepEqual(parseClipboard("mid:"), { type: "mid", id: "" });
  assert.deepEqual(parseClipboard("mid:   "), { type: "mid", id: "" });
  assert.deepEqual(parseClipboard("mid:<>"), { type: "mid", id: "" });
});

test("only the first line of a mid link is used", () => {
  assert.deepEqual(parseClipboard(`mid:${MESSAGE_ID}\nsubject leftover`), {
    type: "mid",
    id: MESSAGE_ID,
  });
});
