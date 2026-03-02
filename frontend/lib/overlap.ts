/**
 * Label overlap detection and resolution for SVG annotation labels.
 *
 * Labels (correction text above bboxes) can visually overlap when annotations
 * are dense. This module computes purely visual y-offsets that push overlapping
 * labels apart without modifying annotation data.
 *
 * Annotations with user-defined ``label_x``/``label_y`` are included in
 * overlap detection but never receive an automatic offset.
 */

import type { Annotation } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LabelEntry {
  localId: string;
  rect: Rect;
  offsetY: number;
  /** True when the label has a custom position and must not be shifted. */
  pinned: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the AABB of a label's text positioned above its annotation bbox.
 *
 * Width is estimated as `charCount × fontSize × 0.6` (reasonable for
 * sans-serif fonts at typical SVG rendering).
 */
function getLabelRect(
  a: { _localId: string; bbox_x1: number; bbox_y1: number; bbox_x2: number; bbox_y2: number; reference_word: string; label_x?: number | null; label_y?: number | null },
  fontSize: number,
): Rect {
  const textWidth = a.reference_word.length * fontSize * 0.6;

  // If the label has a custom position, use it
  if (a.label_x != null && a.label_y != null) {
    return {
      x: a.label_x - textWidth / 2,
      y: a.label_y - fontSize / 2,
      width: textWidth,
      height: fontSize,
    };
  }

  const cx = (a.bbox_x1 + a.bbox_x2) / 2;
  const labelBottomY = a.bbox_y1 - 8; // matches text y in renderAnnotation
  return {
    x: cx - textWidth / 2,
    y: labelBottomY - fontSize, // top of the text
    width: textWidth,
    height: fontSize,
  };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Find connected components of overlapping labels using union-find.
 * Labels in the same component must all be adjusted together to resolve overlaps.
 */
function findOverlappingGroups(entries: LabelEntry[]): LabelEntry[][] {
  const n = entries.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    if (parent[x] !== x) {
      parent[x] = find(parent[x]);
    }
    return parent[x];
  }

  function union(x: number, y: number) {
    const px = find(x);
    const py = find(y);
    if (px !== py) {
      parent[px] = py;
    }
  }

  // Union all overlapping pairs
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const aRect: Rect = { ...entries[i].rect, y: entries[i].rect.y + entries[i].offsetY };
      const bRect: Rect = { ...entries[j].rect, y: entries[j].rect.y + entries[j].offsetY };
      if (rectsOverlap(aRect, bRect)) {
        union(i, j);
      }
    }
  }

  // Group by parent
  const groups = new Map<number, LabelEntry[]>();
  for (let i = 0; i < n; i++) {
    const p = find(i);
    if (!groups.has(p)) {
      groups.set(p, []);
    }
    groups.get(p)!.push(entries[i]);
  }

  return Array.from(groups.values());
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute y-offsets for annotation labels to prevent visual overlap.
 *
 * Uses a stable algorithm:
 * 1. Find all overlapping groups (connected components) using union-find
 * 2. For each group, compute the minimum offset needed to separate all labels
 *
 * This approach is stable because:
 * - It doesn't depend on sort order
 * - It resolves all overlaps in a group at once, not iteratively
 * - The result is deterministic regardless of initial positions
 *
 * @param annotations Array of annotations (must have `_localId` field).
 * @returns Map from `_localId` to a negative y-offset (in px) to apply.
 *          Annotations without a `reference_word` or without overlap get 0
 *          and are omitted from the map.
 */
export function resolveOverlaps(
  annotations: ReadonlyArray<{
    _localId: string;
    bbox_x1: number;
    bbox_y1: number;
    bbox_x2: number;
    bbox_y2: number;
    reference_word: string | null;
    label_x?: number | null;
    label_y?: number | null;
    label_font_size?: number | null;
  }>,
): Map<string, number> {
  const result = new Map<string, number>();

  // Filter to annotations that actually render a label
  const labeled = annotations.filter(
    (a): a is typeof a & { reference_word: string } =>
      a.reference_word !== null && a.reference_word !== "",
  );

  if (labeled.length <= 1) return result;

  // Build label entries with initial offset 0
  const entries: LabelEntry[] = labeled.map((a) => {
    const bboxHeight = a.bbox_y2 - a.bbox_y1;
    const customFontSize = a.label_font_size;
    const fontSize = customFontSize != null && customFontSize > 0
      ? customFontSize
      : Math.max(Math.min(Math.round(bboxHeight * 0.5), 48), 10);
    const pinned = a.label_x != null && a.label_y != null;
    return {
      localId: a._localId,
      rect: getLabelRect(a as any, fontSize),
      offsetY: 0,
      pinned,
    };
  });

  // Find all overlapping groups
  const groups = findOverlappingGroups(entries);

  // Process each group: distribute offsets evenly among non-pinned labels
  for (const group of groups) {
    // Skip if group has only one entry or all are pinned
    const nonPinned = group.filter((e) => !e.pinned);
    if (nonPinned.length <= 1) continue;

    // Sort by y position to assign offsets from top to bottom
    nonPinned.sort((a, b) => a.rect.y - b.rect.y);

    // Assign increasing negative offsets to separate each label
    for (let i = 0; i < nonPinned.length; i++) {
      const entry = nonPinned[i];
      // Each label gets pushed further up: 0, -(h+4), -2*(h+4), ...
      entry.offsetY = -(i * (entry.rect.height + 4));
    }
  }

  // Collect non-zero offsets (skip pinned — they always stay at 0)
  for (const entry of entries) {
    if (entry.offsetY !== 0 && !entry.pinned) {
      result.set(entry.localId, entry.offsetY);
    }
  }

  return result;
}
