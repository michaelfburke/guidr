/**
 * icons.js
 * Inline SVG icon set. Each entry is the SVG markup with a placeholder
 * viewBox so callers can drop them into innerHTML / template strings
 * without bundling external assets. CSS sizes them via the `.ico` class
 * (width + height + stroke), so authors don't need to size each instance.
 *
 * Style is Lucide-inspired: 24x24 viewBox, stroke="currentColor",
 * stroke-width 2, round caps/joins. The same SVG strings are also
 * inlined directly into sidepanel/index.html for static markup —
 * keep both in sync if you change one.
 */

const wrap = (body) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  chevronLeft:    wrap(`<polyline points="15 18 9 12 15 6"/>`),
  chevronDown:    wrap(`<polyline points="6 9 12 15 18 9"/>`),
  eye:            wrap(`<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`),
  eyeOff:         wrap(`<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>`),
  trash:          wrap(`<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`),
  moreHorizontal: wrap(`<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`),
  pencil:         wrap(`<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>`),
  link:           wrap(`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`),
  videoOff:       wrap(`<path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z"/><line x1="2" x2="22" y1="2" y2="22"/>`),
  circle:         wrap(`<circle cx="12" cy="12" r="9"/>`),
  arrow:          wrap(`<line x1="6" y1="18" x2="18" y2="6"/><polyline points="9 6 18 6 18 15"/>`),
  square:         wrap(`<rect width="16" height="16" x="4" y="4" rx="1"/>`),
  mask:           `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 2" aria-hidden="true"><rect width="16" height="16" x="4" y="4" rx="1"/></svg>`,
  undo:           wrap(`<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>`),
  x:              wrap(`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`),
  rotateCcw:      wrap(`<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>`),
  check:          wrap(`<polyline points="20 6 9 17 4 12"/>`),
  plus:           wrap(`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`),
};
