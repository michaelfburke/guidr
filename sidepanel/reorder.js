/**
 * reorder.js
 * Pointer-event drag-to-reorder for a scrolling chip rail.
 *
 * Usage:
 *   makeReorderable(railEl, { getSteps, onReorder })
 *   - getSteps()           → current array of step objects
 *   - onReorder(newOrder)  → called with reordered steps when user drops
 *
 * Uses pointer events (not HTML5 draggable) so that:
 *  - The rail can scroll horizontally without the native ghost fighting us.
 *  - We get a clean insertion indicator rather than the OS drag image.
 *
 * Keyboard reorder: focus a chip then press Ctrl+Left / Ctrl+Right.
 */

const DRAG_THRESHOLD_PX = 6; // minimum pointer travel before drag mode

export function makeReorderable(railEl, { getSteps, onReorder }) {
  let _dragState = null; // null | { chipEl, originIdx, indicator }

  railEl.addEventListener("pointerdown", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || !railEl.contains(chip)) return;
    // Ignore right-click / touch-outside / already dragging
    if (e.button !== 0) return;

    const originIdx = Number(chip.dataset.idx);
    if (isNaN(originIdx)) return;

    let moved = false;
    const startX = e.clientX;
    const startY = e.clientY;

    const indicator = document.createElement("div");
    indicator.className = "reorder-indicator";
    indicator.style.display = "none";
    railEl.appendChild(indicator);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (!moved) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return;
        moved = true;
        chip.classList.add("dragging");
        _dragState = { chipEl: chip, originIdx, indicator };
        chip.setPointerCapture(e.pointerId);
      }

      // Find insertion point by scanning chip centres in the rail.
      const chips = [...railEl.querySelectorAll(".chip:not(.dragging)")];
      let insertBefore = null;
      for (const c of chips) {
        const r = c.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) { insertBefore = c; break; }
      }

      // Move the indicator line.
      indicator.style.display = "";
      if (insertBefore) {
        const r = insertBefore.getBoundingClientRect();
        const railR = railEl.getBoundingClientRect();
        indicator.style.left = `${r.left - railR.left + railEl.scrollLeft}px`;
      } else {
        // Append to end
        const last = chips[chips.length - 1];
        if (last) {
          const r = last.getBoundingClientRect();
          const railR = railEl.getBoundingClientRect();
          indicator.style.left = `${r.right - railR.left + railEl.scrollLeft}px`;
        }
      }
    }

    function onUp(ev) {
      chip.removeEventListener("pointermove", onMove);
      chip.removeEventListener("pointerup", onUp);
      chip.removeEventListener("pointercancel", onUp);
      indicator.remove();

      if (!moved) { _dragState = null; return; }

      chip.classList.remove("dragging");
      _dragState = null;

      // Compute new order.
      const steps = getSteps();
      const chips = [...railEl.querySelectorAll(".chip")];
      let targetIdx = steps.length;
      for (const c of chips) {
        if (c === chip) continue;
        const r = c.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          targetIdx = Number(c.dataset.idx);
          break;
        }
      }

      if (targetIdx === originIdx) return; // no-op

      const reordered = steps.slice();
      const [moved_step] = reordered.splice(originIdx, 1);
      const insertAt = targetIdx > originIdx ? targetIdx - 1 : targetIdx;
      reordered.splice(insertAt, 0, moved_step);
      onReorder(reordered);
    }

    chip.addEventListener("pointermove", onMove);
    chip.addEventListener("pointerup", onUp);
    chip.addEventListener("pointercancel", onUp);
  });

  // Keyboard reorder: Ctrl+Left / Ctrl+Right on a focused chip.
  railEl.addEventListener("keydown", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

    const chip = e.target.closest(".chip");
    if (!chip) return;
    e.preventDefault();

    const steps = getSteps();
    const idx = Number(chip.dataset.idx);
    if (isNaN(idx)) return;

    const delta = e.key === "ArrowRight" ? 1 : -1;
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= steps.length) return;

    const reordered = steps.slice();
    const [moved_step] = reordered.splice(idx, 1);
    reordered.splice(newIdx, 0, moved_step);
    onReorder(reordered);
  });
}
