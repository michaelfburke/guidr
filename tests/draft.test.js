import { describe, expect, it } from "vitest";
import { draftStep } from "../draft.js";

const t = (fields) => ({ tag: "button", ...fields });

describe("draftStep", () => {
  it("drafts a button click", () => {
    expect(draftStep(t({ text: "Save contact" }))).toEqual({
      title: "Click Save contact",
      body: 'Click "Save contact".',
    });
  });

  it("names where the element is when that is visible", () => {
    expect(draftStep(t({ text: "Save", nearestLandmark: { tag: "dialog" } })).body)
      .toBe('Click "Save" in the dialog.');
    expect(draftStep(t({ text: "Save", nearestLandmark: { tag: "form" } })).body)
      .toBe('Click "Save".');
  });

  it("treats navigation links as going somewhere", () => {
    expect(draftStep({ tag: "a", text: "Deals", nearestLandmark: { tag: "nav" } })).toEqual({
      title: "Go to Deals",
      body: 'Select "Deals" in the navigation.',
    });
    expect(draftStep({ tag: "a", text: "Docs" }).title).toBe("Open Docs");
  });

  it("drafts form fields by their label", () => {
    expect(draftStep({ tag: "input", type: "email", text: "Email" })).toEqual({
      title: "Fill in Email",
      body: 'Click the "Email" field and enter the details.',
    });
    expect(draftStep({ tag: "textarea", text: "Notes" }).title).toBe("Fill in Notes");
    expect(draftStep({ tag: "select", text: "Stage" }).title).toBe("Choose Stage");
    expect(draftStep({ tag: "input", type: "checkbox", text: "Remember me" }).title).toBe("Toggle Remember me");
    expect(draftStep({ tag: "div", role: "tab", text: "Billing" }).title).toBe("Open the Billing tab");
  });

  it("falls back to aria-label, placeholder, then name", () => {
    expect(draftStep(t({ ariaLabel: "Close" })).title).toBe("Click Close");
    expect(draftStep({ tag: "input", placeholder: "Search" }).title).toBe("Fill in Search");
    expect(draftStep({ tag: "input", name: "q" }).title).toBe("Fill in q");
  });

  it("shortens long labels", () => {
    const { title } = draftStep(t({ text: "x".repeat(200) }));
    expect(title.length).toBeLessThanOrEqual("Click ".length + 60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("uses the page title when nothing labels the element", () => {
    expect(draftStep({ tag: "div" }, "Acme CRM").title).toBe("Continue on Acme CRM");
    expect(draftStep(null).title).toBe("Continue");
  });
});
