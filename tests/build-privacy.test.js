import { describe, it, expect } from "vitest";
import { markdownToHtml, inline } from "../scripts/build-privacy.js";

describe("privacy page renderer", () => {
  it("renders headings, paragraphs and wrapped list items", () => {
    const html = markdownToHtml("# Title\n\nOne\nparagraph.\n\n## What we keep\n\n- **Video.** Stays\n  local.\n- Key\n");
    expect(html).toBe([
      '<h1 id="title">Title</h1>',
      "<p>One paragraph.</p>",
      '<h2 id="what-we-keep">What we keep</h2>',
      "<ul>\n  <li><strong>Video.</strong> Stays local.</li>\n  <li>Key</li>\n</ul>",
    ].join("\n"));
  });

  it("escapes HTML and leaves code spans literal", () => {
    expect(inline("`<all_urls>` and **bold** & _note_")).toBe("<code>&lt;all_urls&gt;</code> and <strong>bold</strong> &amp; <em>note</em>");
    expect(inline("`chrome.storage.local` keeps snake_case_names")).toBe("<code>chrome.storage.local</code> keeps snake_case_names");
  });
});
