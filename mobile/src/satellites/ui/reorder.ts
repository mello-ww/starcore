// A media-list's reorder (UI contract 1.2, change 8): how the rows move and where a dragged row
// lands - the same arithmetic as Mission Control's mission_control/ui/reorder.js.

/** Moves one item of `items` in place, from index `from` to index `to` (its final index). */
export function moveItem(items: unknown[], from: number, to: number): boolean {
  if (!Array.isArray(items) || from === to || from < 0 || from >= items.length) {
    return false;
  }
  const target = Math.max(0, Math.min(to, items.length - 1));
  const [moved] = items.splice(from, 1);
  items.splice(target, 0, moved);
  return true;
}

/** Where a row dragged `dy` points from index `from` lands, rows being `pitch` apart. */
export function targetIndex(from: number, dy: number, pitch: number, count: number): number {
  if (!(pitch > 0) || count < 1) {
    return from;
  }
  return Math.max(0, Math.min(count - 1, from + Math.round(dy / pitch)));
}

/** How far row `index` steps aside while the row from `from` is held over `target`. */
export function shiftFor(index: number, from: number, target: number, pitch: number): number {
  if (index === from) {
    return 0;
  }
  if (from < target && index > from && index <= target) {
    return -pitch;
  }
  if (target < from && index >= target && index < from) {
    return pitch;
  }
  return 0;
}
