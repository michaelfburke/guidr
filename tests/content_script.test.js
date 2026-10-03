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
    <textarea></textarea>`;
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

  it("swallows the implicit-submit click after Enter in a text input", () => {
    key(document.querySelector("input[type=text]"), "Enter");
    click(document.querySelector("button"), 0);
    expect(markers()).toHaveLength(1);
    expect(markers()[0][0].payload.target.tag).toBe("input");
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

  it("records a later synthetic click once the echo window has passed", () => {
    vi.useFakeTimers();
    key(document.querySelector("button"), "Enter");
    vi.advanceTimersByTime(1500);
    click(document.querySelector("a"), 0);
    expect(markers()).toHaveLength(2);
  });

  it("emits nothing after recording stops", () => {
    message("GUIDR_STOP_RECORDING");
    click(document.querySelector("button"), 1);
    key(document.querySelector("button"), "Enter");
    expect(markers()).toHaveLength(0);
  });
});
