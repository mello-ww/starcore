// The media-grid block (UI contract 1.2) and its shared viewer, for Mission Control's renderer.
//
// A grid of images and videos from a Satellite's own routes: tiles in groups, revealed a page
// at a time as the grid scrolls into view, a selection with the document's actions, and a
// full-screen viewer with the document's facts and actions on the item shown. It knows the
// contract, never a Satellite: everything it shows and does comes from the block.

import { formatValue, isSafeRoute, isVisible, resolve, resolveTemplate } from "./contract.js";
import { icon } from "./icons.js";

// tiles revealed at a time: enough for a first screen, little enough to paint at once
export const GRID_PAGE = 60;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined && text !== null) {
        node.textContent = String(text);
    }
    return node;
}

function glyph(name, size = 18) {
    return icon(name, size) || el("span");
}

/** What a tile's `kind` resolves to: "video", or "image" for anything else. */
export function mediaKind(value) {
    return value === "video" ? "video" : "image";
}

/** A stable key for an item: its `key` binding, else its position. */
export function itemKey(block, item, index, scope) {
    const key = block.item && block.item.key !== undefined ? resolve(block.item.key, { ...scope, data: item }) : null;
    return key === null || key === undefined || key === "" ? `#${index}` : String(key);
}

/** "1:05" for a video tile's badge. */
export function clock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * host: {satelliteBase, runAction(action, scope), afterSelection(then), setNotice(text, kind)},
 * and for the media picker `picking: {multiple, onChange(selectedItems)}`: every tile then
 * selects (one at a time unless `multiple`), and the picker draws its own bar.
 * Returns {render(block, scope), afterRender(), reset(), dispose()}.
 */
export function createGallery(host) {
    const picking = host.picking || null;
    let grids = new WeakMap();
    // the one viewer a page can have open: {block, key, index, overlay, stageKey}
    let viewer = null;
    let returnFocus = null;

    function gridState(block) {
        let entry = grids.get(block);
        if (!entry) {
            entry = { shown: GRID_PAGE, selected: new Set(), selecting: Boolean(picking), items: [], keys: [], scope: null, tiles: new Map(), bar: null };
            grids.set(block, entry);
        }
        return entry;
    }

    function source(template, scope) {
        if (template === undefined) {
            return null;
        }
        const route = resolveTemplate(template, scope);
        return route && isSafeRoute(route) ? `${host.satelliteBase}/${route}` : null;
    }

    function frame(url, className, alt) {
        const holder = el("div", `${className} ui-media-frame is-loading`);
        const failed = () => {
            holder.classList.remove("is-loading");
            holder.classList.add("is-empty");
            holder.replaceChildren(glyph("image"));
        };
        if (!url) {
            failed();
            return holder;
        }
        const image = el("img");
        image.loading = "lazy";
        image.decoding = "async";
        image.alt = alt || "";
        image.draggable = false;
        image.addEventListener("load", () => holder.classList.remove("is-loading"), { once: true });
        image.addEventListener("error", failed, { once: true });
        image.src = url;
        holder.appendChild(image);
        return holder;
    }

    // ---------- the grid ----------

    function render(block, scope) {
        const resolved = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
        const items = Array.isArray(resolved) ? resolved : [];
        const grid = gridState(block);
        grid.items = items;
        grid.scope = scope;
        grid.keys = items.map((item, index) => itemKey(block, item, index, scope));
        grid.tiles = new Map();
        const present = new Set(grid.keys);
        for (const key of [...grid.selected]) {
            if (!present.has(key)) {
                grid.selected.delete(key);
            }
        }

        const size = block.size || "medium";
        const wrapper = el("section", `ui-media-grid ui-media-grid-${size} ui-shape-${block.shape || "square"}`);
        if (items.length === 0) {
            const empty = block.empty !== undefined ? resolve(block.empty, scope) : null;
            wrapper.appendChild(el("p", "ui-text ui-text-caption ui-media-grid-empty",
                empty === null || empty === undefined || empty === "" ? "Nothing here." : String(empty)));
            return wrapper;
        }
        if (block.selection && !picking) {
            grid.bar = el("div", "ui-media-selection");
            wrapper.appendChild(grid.bar);
            renderSelectionBar(block, grid);
        }
        wrapper.classList.toggle("is-selecting", grid.selecting);
        const body = el("div", "ui-media-grid-body");
        wrapper.appendChild(body);

        const groups = { label: undefined, cells: null };
        const reveal = (from, to) => {
            for (let index = from; index < to; index += 1) {
                appendTile(block, grid, index, body, groups);
            }
        };
        const shown = Math.min(grid.shown, items.length);
        reveal(0, shown);
        if (shown < items.length) {
            // the next page arrives as the end of the grid comes near
            const sentinel = el("div", "ui-media-grid-more");
            sentinel.setAttribute("aria-hidden", "true");
            wrapper.appendChild(sentinel);
            const more = () => {
                const from = Math.min(grid.shown, grid.items.length);
                grid.shown = from + GRID_PAGE;
                const to = Math.min(grid.shown, grid.items.length);
                reveal(from, to);
                if (to >= grid.items.length) {
                    observer?.disconnect();
                    sentinel.remove();
                }
            };
            const observer = typeof IntersectionObserver === "function"
                ? new IntersectionObserver((entries) => {
                    if (entries.some((entry) => entry.isIntersecting)) {
                        more();
                    }
                }, { rootMargin: "800px 0px" })
                : null;
            if (observer) {
                observer.observe(sentinel);
            } else {
                const button = el("button", "sc-button ui-button", "Show more");
                button.type = "button";
                button.addEventListener("click", more);
                sentinel.appendChild(button);
            }
        }
        return wrapper;
    }

    function appendTile(block, grid, index, body, groups) {
        const item = grid.items[index];
        const itemScope = { ...grid.scope, data: item };
        const formats = (block.item && block.item.format) || {};
        if (block.item.group !== undefined) {
            const raw = resolve(block.item.group, itemScope);
            const label = raw === null || raw === undefined || raw === "" ? "" : formatValue(raw, formats.group);
            if (label !== groups.label || !groups.cells) {
                groups.label = label;
                if (label) {
                    body.appendChild(el("h3", "ui-media-group", label));
                }
                groups.cells = el("div", "ui-media-cells");
                body.appendChild(groups.cells);
            }
        } else if (!groups.cells) {
            groups.cells = el("div", "ui-media-cells");
            body.appendChild(groups.cells);
        }

        const key = grid.keys[index];
        const kind = mediaKind(block.item.kind !== undefined ? resolve(block.item.kind, itemScope) : "image");
        const title = block.item.title !== undefined ? resolve(block.item.title, itemScope) : null;
        const subtitle = block.item.subtitle !== undefined ? resolve(block.item.subtitle, itemScope) : null;
        const label = title === null || title === undefined || title === "" ? null : String(title);
        const opens = Boolean(picking || block.viewer || block.action || block.selection);

        const tile = el(opens ? "button" : "div", "ui-media-tile");
        if (opens) {
            tile.type = "button";
        }
        tile.dataset.key = key;
        tile.setAttribute("aria-label", [label || (kind === "video" ? "Video" : "Image"), index + 1].join(", "));
        const thumb = frame(source(block.item.image, itemScope), "ui-media-tile-frame", "");
        if (kind === "video") {
            const badge = el("span", "ui-media-badge");
            badge.appendChild(glyph("play", 12));
            const seconds = block.item.duration !== undefined ? resolve(block.item.duration, itemScope) : null;
            if (seconds !== null && seconds !== undefined && seconds !== "") {
                badge.appendChild(el("span", null, clock(seconds)));
            }
            thumb.appendChild(badge);
        }
        if (block.selection) {
            const check = el("span", "ui-media-check");
            check.appendChild(glyph("check", 14));
            check.addEventListener("click", (event) => {
                event.stopPropagation();
                toggleSelected(block, grid, key);
            });
            thumb.appendChild(check);
        }
        tile.appendChild(thumb);
        if (label || (subtitle !== null && subtitle !== undefined && subtitle !== "")) {
            const caption = el("span", "ui-media-tile-text");
            if (label) {
                caption.appendChild(el("span", "ui-media-tile-title", label));
            }
            if (subtitle !== null && subtitle !== undefined && subtitle !== "") {
                caption.appendChild(el("span", "ui-media-tile-subtitle", formatValue(subtitle, formats.subtitle)));
            }
            tile.appendChild(caption);
        }
        if (grid.selected.has(key)) {
            tile.classList.add("is-selected");
            tile.setAttribute("aria-pressed", "true");
        } else if (block.selection) {
            tile.setAttribute("aria-pressed", "false");
        }
        if (opens) {
            tile.addEventListener("click", (event) => {
                if (picking) {
                    toggleSelected(block, grid, key);
                } else if (block.selection && (grid.selecting || event.shiftKey || event.ctrlKey || event.metaKey)) {
                    toggleSelected(block, grid, key);
                } else if (block.viewer) {
                    openViewer(block, key, tile);
                } else if (block.action) {
                    host.runAction(block.action, itemScope);
                } else if (block.selection) {
                    toggleSelected(block, grid, key);
                }
            });
        }
        grid.tiles.set(key, tile);
        groups.cells.appendChild(tile);
    }

    // ---------- selection ----------

    function toggleSelected(block, grid, key) {
        if (grid.selected.has(key)) {
            grid.selected.delete(key);
        } else {
            if (picking && !picking.multiple) {
                // one at a time: choosing another replaces the choice
                for (const other of grid.selected) {
                    const tile = grid.tiles.get(other);
                    tile?.classList.remove("is-selected");
                    tile?.setAttribute("aria-pressed", "false");
                }
                grid.selected.clear();
            }
            grid.selected.add(key);
        }
        grid.selecting = grid.selected.size > 0 || grid.selecting;
        const tile = grid.tiles.get(key);
        if (tile) {
            const selected = grid.selected.has(key);
            tile.classList.toggle("is-selected", selected);
            tile.setAttribute("aria-pressed", String(selected));
        }
        renderSelectionBar(block, grid);
        if (picking) {
            picking.onChange(grid.items.filter((item, index) => grid.selected.has(grid.keys[index])));
        }
    }

    function clearSelection(block, grid) {
        grid.selected.clear();
        grid.selecting = false;
        for (const tile of grid.tiles.values()) {
            tile.classList.remove("is-selected");
            tile.setAttribute("aria-pressed", "false");
        }
        renderSelectionBar(block, grid);
    }

    function renderSelectionBar(block, grid) {
        const bar = grid.bar;
        if (!bar) {
            return;
        }
        bar.replaceChildren();
        bar.closest(".ui-media-grid")?.classList.toggle("is-selecting", grid.selecting);
        if (!grid.selecting) {
            const start = el("button", "ui-pill ui-media-select", "Select");
            start.type = "button";
            start.addEventListener("click", () => {
                grid.selecting = true;
                renderSelectionBar(block, grid);
            });
            bar.appendChild(start);
            return;
        }
        bar.classList.add("is-active");
        const count = grid.selected.size;
        const summary = el("span", "ui-media-selection-count", count ? `${count} selected` : "Select items");
        summary.setAttribute("role", "status");
        bar.appendChild(summary);
        const actions = el("div", "ui-media-selection-actions");
        for (const entry of block.selection.actions || []) {
            const button = actionButton(entry, grid.scope);
            button.disabled = count === 0;
            button.addEventListener("click", () => runOnSelection(block, grid, entry, button));
            actions.appendChild(button);
        }
        const cancel = el("button", "ui-pill", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => clearSelection(block, grid));
        actions.appendChild(cancel);
        bar.appendChild(actions);
    }

    async function runOnSelection(block, grid, entry, button) {
        const chosen = grid.items.filter((item, index) => grid.selected.has(grid.keys[index]));
        const action = entry.action;
        if (!chosen.length || !action) {
            return;
        }
        if (action.navigate || action.play) {
            // nothing to do item by item: it acts on the first one
            host.runAction(action, { ...grid.scope, data: chosen[0] });
            return;
        }
        const first = { ...grid.scope, data: chosen[0], value: chosen.length };
        if (action.confirm && !window.confirm(String(resolve(action.confirm, first)))) {
            return;
        }
        button.disabled = true;
        // each item gets the action on its own; confirm and then apply to the whole selection
        const single = { ...action, confirm: undefined, then: undefined };
        let failed = 0;
        for (const item of chosen) {
            if (!(await host.runAction(single, { ...grid.scope, data: item }, undefined, { quiet: true }))) {
                failed += 1;
            }
        }
        grid.selected.clear();
        grid.selecting = false;
        if (failed) {
            host.setNotice(`${failed} of ${chosen.length} could not be done.`, "error");
        }
        host.afterSelection(action.then);
    }

    function actionButton(entry, scope) {
        const style = entry.style || "secondary";
        const button = el("button", `ui-pill ui-pill-${style}`);
        button.type = "button";
        if (entry.icon) {
            button.appendChild(glyph(entry.icon, 16));
        }
        const label = resolve(entry.label, scope);
        button.appendChild(el("span", null, label === null || label === undefined ? "" : String(label)));
        return button;
    }

    // ---------- the viewer ----------

    function openViewer(block, key, from) {
        closeViewer();
        returnFocus = from || document.activeElement;
        const overlay = el("div", "ui-viewer");
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.tabIndex = -1;
        overlay.addEventListener("keydown", onViewerKey);
        document.body.appendChild(overlay);
        document.body.classList.add("ui-viewer-open");
        viewer = { block, key, index: gridState(block).keys.indexOf(key), overlay, stageKey: null, info: false };
        drawViewer();
        overlay.querySelector(".ui-viewer-close")?.focus();
    }

    function closeViewer() {
        if (!viewer) {
            return;
        }
        viewer.overlay.querySelector("video")?.pause();
        viewer.overlay.remove();
        document.body.classList.remove("ui-viewer-open");
        // back to the tile it was showing; the page may have been redrawn since it opened
        const tile = gridState(viewer.block).tiles.get(viewer.key);
        viewer = null;
        if (tile && document.contains(tile)) {
            tile.focus();
        } else if (returnFocus && document.contains(returnFocus)) {
            returnFocus.focus();
        }
        returnFocus = null;
    }

    function step(delta) {
        if (!viewer) {
            return;
        }
        const grid = gridState(viewer.block);
        const index = viewer.index + delta;
        if (index < 0 || index >= grid.items.length) {
            return;
        }
        viewer.index = index;
        viewer.key = grid.keys[index];
        drawViewer();
    }

    function onViewerKey(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            closeViewer();
        } else if (event.key === "ArrowLeft" && event.target.tagName !== "VIDEO") {
            event.preventDefault();
            step(-1);
        } else if (event.key === "ArrowRight" && event.target.tagName !== "VIDEO") {
            event.preventDefault();
            step(1);
        } else if (event.key === "Tab") {
            // focus stays inside the dialog
            const focusable = [...viewer.overlay.querySelectorAll("button:not([disabled]), video")];
            if (!focusable.length) {
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    function iconButton(name, label, className, onClick) {
        const button = el("button", `ui-viewer-button ${className}`);
        button.type = "button";
        button.setAttribute("aria-label", label);
        button.title = label;
        button.appendChild(glyph(name, 20));
        button.addEventListener("click", onClick);
        return button;
    }

    /** (Re)draws the open viewer from its grid's current items: the stage only when the item
     * shown changes, so a refresh never restarts a playing video. */
    function drawViewer() {
        if (!viewer) {
            return;
        }
        const { block, overlay } = viewer;
        const grid = gridState(block);
        const item = grid.items[viewer.index];
        if (!item) {
            closeViewer();
            return;
        }
        const scope = { ...grid.scope, data: item };
        const spec = block.viewer || {};
        const kind = mediaKind(block.item.kind !== undefined ? resolve(block.item.kind, scope) : "image");
        const title = spec.title !== undefined ? resolve(spec.title, scope) : null;
        const subtitle = spec.subtitle !== undefined ? resolve(spec.subtitle, scope) : null;
        overlay.setAttribute("aria-label", title === null || title === undefined || title === "" ? "Viewer" : String(title));

        let stage = overlay.querySelector(".ui-viewer-stage");
        if (!stage || viewer.stageKey !== viewer.key) {
            overlay.querySelector("video")?.pause();
            overlay.replaceChildren();
            stage = el("div", "ui-viewer-stage");
            const poster = source(block.item.image, scope);
            if (kind === "video" && source(spec.video, scope)) {
                const video = el("video", "ui-viewer-video");
                video.controls = true;
                video.playsInline = true;
                video.preload = "metadata";
                if (poster) {
                    video.poster = poster;
                }
                video.src = source(spec.video, scope);
                video.addEventListener("error", () => {
                    stage.replaceChildren(el("p", "ui-viewer-missing", "This video can't be played here."));
                }, { once: true });
                stage.appendChild(video);
            } else {
                const full = source(spec.image !== undefined ? spec.image : block.item.image, scope);
                const holder = frame(full, "ui-viewer-frame", title === null || title === undefined ? "" : String(title));
                holder.querySelector("img")?.removeAttribute("loading");
                stage.appendChild(holder);
                if (kind === "video") {
                    stage.appendChild(el("p", "ui-viewer-missing", "This video can't be played here."));
                }
            }
            overlay.appendChild(stage);
            overlay.appendChild(el("div", "ui-viewer-chrome"));
            viewer.stageKey = viewer.key;
            preloadNeighbours(block, grid);
        }

        const chrome = overlay.querySelector(".ui-viewer-chrome");
        chrome.replaceChildren();
        const top = el("div", "ui-viewer-top");
        top.appendChild(iconButton("x", "Close", "ui-viewer-close", closeViewer));
        const heading = el("div", "ui-viewer-heading");
        if (title !== null && title !== undefined && title !== "") {
            heading.appendChild(el("p", "ui-viewer-title", String(title)));
        }
        const position = `${viewer.index + 1} of ${grid.items.length}`;
        heading.appendChild(el("p", "ui-viewer-subtitle",
            subtitle !== null && subtitle !== undefined && subtitle !== ""
                ? `${subtitle} · ${position}` : position));
        top.appendChild(heading);
        if ((spec.fields || []).length) {
            const info = iconButton("info", viewer.info ? "Hide details" : "Show details", "ui-viewer-info-toggle", () => {
                viewer.info = !viewer.info;
                drawViewer();
            });
            info.setAttribute("aria-pressed", String(viewer.info));
            top.appendChild(info);
        }
        chrome.appendChild(top);

        const previous = iconButton("chevron-left", "Previous", "ui-viewer-previous", () => step(-1));
        previous.disabled = viewer.index === 0;
        const next = iconButton("chevron-right", "Next", "ui-viewer-next", () => step(1));
        next.disabled = viewer.index >= grid.items.length - 1;
        chrome.append(previous, next);

        if (viewer.info) {
            const panel = el("dl", "ui-viewer-details");
            for (const field of spec.fields || []) {
                const value = resolve(field.value, scope);
                if (value === null || value === undefined || value === "") {
                    continue;
                }
                panel.appendChild(el("dt", null, field.label));
                panel.appendChild(el("dd", null, formatValue(value, field.format, field.unit !== undefined ? resolve(field.unit, scope) : undefined)));
            }
            chrome.appendChild(panel);
        }

        const actions = (spec.actions || []).filter((entry) => entry.visible === undefined || isVisible(resolve(entry.visible, scope)));
        if (actions.length) {
            const bar = el("div", "ui-viewer-actions");
            for (const entry of actions) {
                const button = actionButton(entry, scope);
                button.addEventListener("click", async () => {
                    button.disabled = true;
                    await host.runAction(entry.action, scope);
                    button.disabled = false;
                });
                bar.appendChild(button);
            }
            chrome.appendChild(bar);
        }
    }

    function preloadNeighbours(block, grid) {
        const spec = block.viewer || {};
        for (const index of [viewer.index - 1, viewer.index + 1]) {
            const item = grid.items[index];
            if (!item) {
                continue;
            }
            const scope = { ...grid.scope, data: item };
            if (mediaKind(block.item.kind !== undefined ? resolve(block.item.kind, scope) : "image") === "image") {
                const url = source(spec.image !== undefined ? spec.image : block.item.image, scope);
                if (url) {
                    const image = new Image();
                    image.decoding = "async";
                    image.src = url;
                }
            }
        }
    }

    /** After the page re-rendered: the open viewer follows its item, or the next one when
     * it's gone (deleted from the viewer), and closes when nothing is left. */
    function afterRender() {
        if (!viewer) {
            return;
        }
        const grid = gridState(viewer.block);
        const index = grid.keys.indexOf(viewer.key);
        if (index >= 0) {
            viewer.index = index;
        } else if (grid.items.length) {
            viewer.index = Math.min(viewer.index, grid.items.length - 1);
            viewer.key = grid.keys[viewer.index];
        } else {
            closeViewer();
            return;
        }
        drawViewer();
    }

    function reset() {
        closeViewer();
        grids = new WeakMap();
    }

    return { render, afterRender, reset, dispose: reset };
}
