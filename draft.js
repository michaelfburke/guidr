/**
 * draft.js — Template step text, no AI needed.
 *
 * Every captured step gets a plain draft title and body built from what was
 * clicked, so a guide is usable straight after recording. Enrichment later
 * replaces both with model-written text.
 */

const FIELD_TYPES = ["text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "week", "time"];

// Where the element sits, phrased for an instruction. Only landmarks a reader
// can see on the screenshot; "main", "form" and "section" add nothing.
const PLACES = {
  nav: "in the navigation",
  header: "in the header",
  footer: "in the footer",
  aside: "in the sidebar",
  dialog: "in the dialog",
};

const clip = (s, n = 60) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

function kindOf(t) {
  const tag = t.tag;
  const type = (t.type || "").toLowerCase();
  const role = (t.role || "").toLowerCase();
  if (tag === "select" || role === "listbox" || role === "combobox") return "select";
  if (type === "checkbox" || role === "checkbox" || role === "switch") return "checkbox";
  if (type === "radio" || role === "radio") return "radio";
  if (tag === "textarea" || role === "textbox" || role === "searchbox"
      || (tag === "input" && FIELD_TYPES.includes(type || "text"))) return "field";
  if (tag === "a" || role === "link") return "link";
  if (role === "tab") return "tab";
  if (role === "menuitem" || role === "option") return "option";
  return "click";
}

/**
 * @param {object} target    – element description from content_script.js
 * @param {string} pageTitle – document.title where the click happened
 * @returns {{ title: string, body: string }}
 */
export function draftStep(target = {}, pageTitle = "") {
  const t = target || {};
  const label = clip(t.text || t.ariaLabel || t.placeholder || t.name);
  const place = PLACES[t.nearestLandmark?.tag] || "";
  const where = place ? ` ${place}` : "";

  if (!label) {
    const page = clip(pageTitle);
    return {
      title: page ? `Continue on ${page}` : "Continue",
      body: "Click the spot shown in the screenshot.",
    };
  }

  // Plain text, like enriched bodies: exports don't render Markdown.
  const b = `"${label}"`;
  switch (kindOf(t)) {
    case "field":
      return { title: `Fill in ${label}`, body: `Click the ${b} field${where} and enter the details.` };
    case "select":
      return { title: `Choose ${label}`, body: `Open the ${b} menu${where} and pick an option.` };
    case "checkbox":
      return { title: `Toggle ${label}`, body: `Select the ${b} checkbox${where}.` };
    case "radio":
      return { title: `Choose ${label}`, body: `Select ${b}${where}.` };
    case "link":
      return place === PLACES.nav
        ? { title: `Go to ${label}`, body: `Select ${b} in the navigation.` }
        : { title: `Open ${label}`, body: `Click the ${b} link${where}.` };
    case "tab":
      return { title: `Open the ${label} tab`, body: `Select the ${b} tab${where}.` };
    case "option":
      return { title: `Select ${label}`, body: `Select ${b}${where}.` };
    default:
      return { title: `Click ${label}`, body: `Click ${b}${where}.` };
  }
}
