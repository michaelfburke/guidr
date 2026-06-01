import { describe, it, expect } from "vitest";
import { mapPointToPct, buildAnnotationFromDrag, clamp01 } from "../sidepanel/annotate.js";

describe("clamp01", () => {
  it("clamps to the 0-1 range", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);
  });
});

describe("mapPointToPct", () => {
  it("maps a centre click to 0.5/0.5 when box matches buffer aspect", () => {
    const rect = { left: 0, top: 0, width: 800, height: 450 };
    const p = mapPointToPct(400, 225, rect, 800, 450);
    expect(p.x).toBeCloseTo(0.5, 5);
    expect(p.y).toBeCloseTo(0.5, 5);
  });

  it("accounts for vertical letterboxing when the box is taller than the buffer", () => {
    // Buffer is 16:9 (800x450) but box is 800x600 → image is letterboxed
    // vertically: rendered height 450, offset 75px top.
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    // A click at the top edge of the *rendered image* (y=75) maps to 0.
    expect(mapPointToPct(400, 75, rect, 800, 450).y).toBeCloseTo(0, 5);
    // Centre of the box (y=300) maps to the image centre.
    expect(mapPointToPct(400, 300, rect, 800, 450).y).toBeCloseTo(0.5, 5);
  });

  it("accounts for horizontal letterboxing when the box is wider than the buffer", () => {
    // Buffer 450x450 (square) in a 800x450 box → letterboxed horizontally,
    // rendered width 450, offset 175px left.
    const rect = { left: 0, top: 0, width: 800, height: 450 };
    expect(mapPointToPct(175, 225, rect, 450, 450).x).toBeCloseTo(0, 5);
    expect(mapPointToPct(400, 225, rect, 450, 450).x).toBeCloseTo(0.5, 5);
  });

  it("clamps out-of-bounds clicks (into the letterbox margin)", () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    expect(mapPointToPct(400, 0, rect, 800, 450).y).toBe(0);
    expect(mapPointToPct(400, 600, rect, 800, 450).y).toBe(1);
  });
});

describe("buildAnnotationFromDrag", () => {
  const start = { x: 0.2, y: 0.2 };

  it("places a numbered circle at the end point, ignoring drag distance", () => {
    const a = buildAnnotationFromDrag("circle", start, { x: 0.6, y: 0.7 }, []);
    expect(a.kind).toBe("circle");
    expect(a.xPct).toBe(0.6);
    expect(a.yPct).toBe(0.7);
    expect(a.number).toBe(1);
  });

  it("increments circle numbers based on existing circles", () => {
    const existing = [{ kind: "circle" }, { kind: "arrow" }, { kind: "circle" }];
    expect(buildAnnotationFromDrag("circle", start, start, existing).number).toBe(3);
  });

  it("builds an arrow from start to end", () => {
    const a = buildAnnotationFromDrag("arrow", start, { x: 0.8, y: 0.9 }, []);
    expect(a).toMatchObject({ kind: "arrow", x1Pct: 0.2, y1Pct: 0.2, x2Pct: 0.8, y2Pct: 0.9 });
  });

  it("rejects a too-short arrow on commit", () => {
    const a = buildAnnotationFromDrag("arrow", start, { x: 0.205, y: 0.205 }, [], true);
    expect(a).toBeNull();
  });

  it("normalises highlight rect regardless of drag direction", () => {
    const a = buildAnnotationFromDrag("highlight", { x: 0.6, y: 0.6 }, { x: 0.2, y: 0.3 }, []);
    expect(a).toMatchObject({ kind: "highlight", xPct: 0.2, yPct: 0.3 });
    expect(a.wPct).toBeCloseTo(0.4, 5);
    expect(a.hPct).toBeCloseTo(0.3, 5);
  });

  it("rejects a too-small highlight/mask on commit", () => {
    expect(buildAnnotationFromDrag("mask", start, { x: 0.201, y: 0.201 }, [], true)).toBeNull();
  });

  it("returns null for an unknown tool", () => {
    expect(buildAnnotationFromDrag("scribble", start, start, [])).toBeNull();
  });
});
