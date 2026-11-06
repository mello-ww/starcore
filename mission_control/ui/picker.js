// The media picker (client capability media.picker, UI contract 1.2's pick action).
//
// A dialog over the page that lists what a media.gallery provider offers, in the shared
// media-grid, and resolves with what the person chose: references, never paths -
// [{provider, capability, id, kind}] - or null when they cancel. It knows the capability,
// never which Satellite provides it: the catalog says that, and the provider's own routes
// (with this session) decide what may be listed.

import { isSafeRoute } from "./contract.js";
import { createGallery, mediaKind } from "./gallery.js";
import { icon } from "./icons.js";

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

/** The references a pick returns for the items chosen from `provider`. */
export function references(provider, capability, items) {
    return items.map((item) => ({
        provider: provider.satellite,
        capability,
        id: String(item.id),
        kind: mediaKind(item.kind),
    }));
}

// what the picker asks a provider for at a time (media.gallery's optional paging)
export const PICK_PAGE = 200;

/** The provider's `list` route for these kinds, or null when it isn't a safe route. With
 * `paged`, it asks for PICK_PAGE at a time; a provider without paging answers everything. */
export function listRoute(provider, kinds, paged = false) {
    const route = provider && provider.operations && provider.operations.list;
    if (!isSafeRoute(route)) {
        return null;
    }
    const wanted = (Array.isArray(kinds) && kinds.length ? kinds : ["image", "video"]).filter((kind) => kind === "image" || kind === "video");
    // the comma is encoded: a route stays within the contract's URL-safe characters
    const listed = `${route}${route.includes("?") ? "&" : "?"}kinds=${wanted.join("%2C")}`;
    return paged ? `${listed}&limit=${PICK_PAGE}` : listed;
}

/**
 * Opens the picker. options: {provider (a catalog entry), capability, kinds, multiple, title}.
 * Resolves with the chosen references, or null when cancelled.
 */
export function pickMedia({ provider, capability, kinds, multiple = false, title = "" }) {
    return new Promise((resolve) => {
        const base = `/api/satellites/${encodeURIComponent(provider.satellite)}`;
        const thumbnail = provider.operations && provider.operations.thumbnail;
        const accepted = new Set(Array.isArray(kinds) && kinds.length ? kinds : ["image", "video"]);
        let chosen = [];
        const returnFocus = document.activeElement;

        const overlay = el("div", "ui-picker");
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        const sheet = el("div", "ui-picker-sheet");
        const head = el("div", "ui-picker-head");
        const heading = el("div", "ui-picker-heading");
        const label = title || (multiple ? "Choose media" : "Choose an item");
        heading.appendChild(el("p", "ui-picker-title", label));
        const count = el("p", "ui-picker-count", multiple ? "Nothing selected" : "Choose one");
        count.setAttribute("role", "status");
        heading.appendChild(count);
        overlay.setAttribute("aria-label", label);
        const close = el("button", "ui-viewer-button ui-picker-close");
        close.type = "button";
        close.setAttribute("aria-label", "Cancel");
        close.title = "Cancel";
        close.appendChild(icon("x", 20) || el("span", null, "×"));
        head.append(heading, close);
        const body = el("div", "ui-picker-body");
        body.appendChild(el("p", "ui-text ui-text-caption", "Loading…"));
        const foot = el("div", "ui-picker-foot");
        const cancel = el("button", "ui-pill", "Cancel");
        cancel.type = "button";
        const confirm = el("button", "ui-pill ui-pill-primary", multiple ? "Add" : "Choose");
        confirm.type = "button";
        confirm.disabled = true;
        foot.append(cancel, confirm);
        sheet.append(head, body, foot);
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);
        document.body.classList.add("ui-viewer-open");

        const load = (route) => fetch(`${base}/${route}`, { headers: { Accept: "application/json" } })
            .then(async (response) => {
                const payload = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error((payload && payload.error) || `Request failed with status ${response.status}`);
                }
                return payload;
            });
        const gallery = createGallery({
            satelliteBase: base,
            load,
            runAction: async () => false,
            setNotice: () => {},
            afterSelection: () => {},
            picking: {
                multiple,
                onChange(items) {
                    chosen = items;
                    confirm.disabled = items.length === 0;
                    confirm.textContent = multiple ? (items.length ? `Add ${items.length}` : "Add") : "Choose";
                    count.textContent = items.length ? `${items.length} selected` : (multiple ? "Nothing selected" : "Choose one");
                },
            },
        });

        function finish(result) {
            gallery.dispose();
            overlay.remove();
            document.body.classList.remove("ui-viewer-open");
            document.removeEventListener("keydown", onKey, true);
            if (returnFocus && document.contains(returnFocus)) {
                returnFocus.focus();
            }
            resolve(result);
        }

        function onKey(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
            }
        }

        close.addEventListener("click", () => finish(null));
        cancel.addEventListener("click", () => finish(null));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                finish(null);
            }
        });
        confirm.addEventListener("click", () => {
            if (chosen.length) {
                finish(references(provider, capability, chosen));
            }
        });
        document.addEventListener("keydown", onKey, true);
        close.focus();

        const route = listRoute(provider, kinds, true);
        if (!route || !isSafeRoute(thumbnail)) {
            body.replaceChildren(el("p", "ui-unsupported", `${provider.satellite} doesn't offer anything to choose from.`));
            return;
        }
        load(route)
            .then((payload) => {
                if (!document.contains(overlay)) {
                    return;
                }
                // a provider answers for the kinds asked; the picker never offers another kind
                const only = (list) => (Array.isArray(list) ? list : [])
                    .filter((item) => item && item.id !== undefined && accepted.has(mediaKind(item.kind)));
                const data = { ...(payload || {}), items: only(payload && payload.items) };
                const block = {
                    type: "media-grid",
                    items: "$.items",
                    size: "medium",
                    empty: "There is nothing to choose from yet.",
                    item: { image: `${thumbnail}/{$.id}`, key: "$.id", kind: "$.kind", duration: "$.duration", group: "$.group" },
                    selection: { actions: [] },
                    // the provider's next page, as the grid scrolls (media.gallery's paging)
                    more: { route: `${route}&cursor={$value}`, cursor: "$.next" },
                };
                body.replaceChildren(gallery.render(block, { data, page: data, params: {}, state: {}, sources: {} }));
            })
            .catch((error) => {
                if (document.contains(overlay)) {
                    body.replaceChildren(el("p", "ui-form-error", error.message));
                }
            });
    });
}
