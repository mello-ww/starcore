// A media-list's reorder (UI contract 1.2, change 8): the person drags a row by its handle, or
// moves it with Alt+ArrowUp and Alt+ArrowDown, and the list's route gets {from, to} as $value.
// The rows move at once; the renderer puts them back if the route refuses.

const SVG = "http://www.w3.org/2000/svg";

/** Moves one item of `items` in place, from index `from` to index `to` (its final index). */
export function moveItem(items, from, to) {
    if (!Array.isArray(items) || from === to || from < 0 || from >= items.length) {
        return false;
    }
    const target = Math.max(0, Math.min(to, items.length - 1));
    const [moved] = items.splice(from, 1);
    items.splice(target, 0, moved);
    return true;
}

/** Where a row dragged `dy` pixels from index `from` lands, rows being `pitch` apart. */
export function targetIndex(from, dy, pitch, count) {
    if (!(pitch > 0) || count < 1) {
        return from;
    }
    return Math.max(0, Math.min(count - 1, from + Math.round(dy / pitch)));
}

/** How far row `index` steps aside while the row from `from` is held over `target`. */
export function shiftFor(index, from, target, pitch) {
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

/** The handle's drawing: three short lines, the client's own (the vocabulary names no grip). */
export function handleGlyph(size = 18) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const y of [7, 12, 17]) {
        const line = document.createElementNS(SVG, "path");
        line.setAttribute("d", `M5 ${y}L19 ${y}`);
        svg.appendChild(line);
    }
    return svg;
}

/**
 * Lets the rows of `list` (its `.ui-media-row` children, each with a `.ui-row-handle`) be
 * dragged and moved by keyboard. `onMove(from, to, {keyboard})` commits a move.
 */
export function attachReorder(list, onMove) {
    const rows = () => [...list.children].filter((child) => child.classList.contains("ui-media-row"));

    list.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
            return;
        }
        const row = event.target.closest && event.target.closest(".ui-media-row");
        const all = rows();
        const from = all.indexOf(row);
        if (from === -1) {
            return;
        }
        event.preventDefault();
        const to = from + (event.key === "ArrowUp" ? -1 : 1);
        if (to >= 0 && to < all.length) {
            onMove(from, to, { keyboard: true });
        }
    });

    list.addEventListener("pointerdown", (event) => {
        const handle = event.target.closest && event.target.closest(".ui-row-handle");
        if (!handle || event.button !== 0) {
            return;
        }
        const all = rows();
        const row = handle.closest(".ui-media-row");
        const from = all.indexOf(row);
        if (from === -1) {
            return;
        }
        event.preventDefault();
        const top = row.getBoundingClientRect().top;
        const next = all[from + 1] || all[from - 1];
        const pitch = next ? Math.abs(next.getBoundingClientRect().top - top) : row.getBoundingClientRect().height;
        const startY = event.clientY;
        let target = from;
        handle.setPointerCapture(event.pointerId);
        list.classList.add("is-reordering");
        row.classList.add("is-dragging");

        const move = (moved) => {
            const dy = moved.clientY - startY;
            row.style.transform = `translateY(${dy}px)`;
            target = targetIndex(from, dy, pitch, all.length);
            all.forEach((other, index) => {
                if (other !== row) {
                    const shift = shiftFor(index, from, target, pitch);
                    other.style.transform = shift ? `translateY(${shift}px)` : "";
                }
            });
        };
        const end = (ended) => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", end);
            handle.removeEventListener("pointercancel", end);
            list.classList.remove("is-reordering");
            row.classList.remove("is-dragging");
            for (const other of all) {
                other.style.transform = "";
            }
            if (ended.type === "pointerup" && target !== from) {
                onMove(from, target, { keyboard: false });
            }
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    });
}
