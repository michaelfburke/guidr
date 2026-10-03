import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(resolve(__dirname, "../content_script.js"), "utf8");

let onMessage;
let sendMessage;

function message(type) {
  onMessage({ type }, {}, () => {});
}

function key(el, k) {
  el.focus();
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
}

function click(el, detail) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
}

const markers = () => sendMessage.mock.calls.filter(([m]) => m.type === "GUIDR_CHAPTER_MARKER");

beforeEach(() => {
  document.body.innerHTML = `
    <button>Save</button>
    <a href="#x">Docs</a>
    <input type="text" name="q"/>
    <input type="checkbox"/>
    <textarea></textarea>
    <select><option>One</option></select>
    <form><input type="text" name="email"/><button type="button">Go</button></form>`;
  sendMessage = vi.fn(() => Promise.resolve());
  chrome.runtime.sendMessage = sendMessage;
  chrome.runtime.onMessage.addListener = (fn) => { onMessage = fn; };
  delete window.__guidrInjected;
  new Function(SOURCE)();
  message("GUIDR_START_RECORDING");
});

afterEach(() => {
  message("GUIDR_STOP_RECORDING");
  vi.useRealTimers();
});

describe("content_script chapter markers", () => {
  it("emits one marker per mouse click", () => {
    click(document.querySelector("button"), 1);
    expect(markers()).toHaveLength(1);
    expect(markers()[0][0].payload.target.text).toBe("Save");
  });

  it("does not double-count Enter on a button (keydown + synthetic click)", () => {
    const btn = document.querySelector("button");
    key(btn, "Enter");
    click(btn, 0);
    expect(markers()).toHaveLength(1);
  });

  it("does not double-count Space on a checkbox", () => {
    const cb = document.querySelector("input[type=checkbox]");
    key(cb, " ");
    click(cb, 0);
    expect(markers()).toHaveLength(1);
  });

  it("ignores typing spaces in a text input and newlines in a textarea", () => {
    key(document.querySelector("input[type=text]"), " ");
    key(document.querySelector("textarea"), "Enter");
    key(document.querySelector("textarea"), " ");
    expect(markers()).toHaveLength(0);
  });

  it("still records a real mouse click right after a keyboard step", () => {
    key(document.querySelector("button"), "Enter");
    click(document.querySelector("a"), 1);
    expect(markers()).toHaveLength(2);
  });

  it("records a synthetic click on an unrelated element after a keyboard step", () => {
    key(document.querySelector("button"), "Enter");
    click(document.querySelector("button"), 0); // the echo
    click(document.querySelector("a"), 0);      // e.g. the app calling .click()
    expect(markers()).toHaveLength(2);
  });

  it("still swallows the echo when Space is held for a while", () => {
    vi.useFakeTimers();
    const btn = document.querySelector("button");
    key(btn, " ");
    vi.advanceTimersByTime(2000);
    click(btn, 0);
    expect(markers()).toHaveLength(1);
  });

  it("swallows the submit-button echo after Enter in a form field", () => {
    key(document.querySelector("form input"), "Enter");
    click(document.querySelector("form button"), 0);
    expect(markers()).toHaveLength(1);
  });

  it("ignores keys that don't activate the focused element", () => {
    key(document.querySelector("a"), " ");                     // Space scrolls
    key(document.querySelector("input[type=checkbox]"), "Enter"); // Enter doesn't toggle
    key(document.querySelector("select"), "Enter");
    expect(markers()).toHaveLength(0);
  });

  it("emits nothing after recording stops", () => {
    message("GUIDR_STOP_RECORDING");
    click(document.querySelector("button"), 1);
    key(document.querySelector("button"), "Enter");
    expect(markers()).toHaveLength(0);
  });
});
