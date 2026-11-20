// The choose action (UI contract 1.2, change 8): the person picks one row from a list the
// Satellite's own route answers - or names a new one - and the action's route then gets that
// row as $value. Used for "add this to one of my lists": the dialog lists the lists, offers to
// create one, and a 409 from the route asks before sending again.
//
// runChoose is the flow, kept free of the page so it can be tested; openChooser is Mission
// Control's dialog for it, drawn like the media picker's.

import { isSafeRoute, resolve, resolveTemplate } from "./contract.js";
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

function refused() {
    return new Error("That action points outside its Satellite and was refused.");
}

function shown(value) {
    return value === null || value === undefined ? "" : String(value);
}

/** The rows a choose action offers, from its source's answer: [{row, title, subtitle, image}],
 * `image` the route of its picture (or null). Inside `item`, `$.` is the source's row. */
export function chooseRows(spec, answer, bindings) {
    const rows = resolve(spec.items, { ...bindings, data: answer || {} });
    return (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === "object").map((row) => {
        const scope = { ...bindings, data: row };
        const item = spec.item || {};
        const image = item.image !== undefined ? resolveTemplate(item.image, scope) : null;
        return {
            row,
            title: shown(resolve(item.title, scope)),
            subtitle: item.subtitle !== undefined ? shown(resolve(item.subtitle, scope)) : "",
            image: image && isSafeRoute(image) ? image : null,
        };
    });
}

/**
 * Runs a choose action. deps:
 *  - load(route): the source's answer;
 *  - choose({title, empty, rows, create}): resolves with {row}, {create: text} or null;
 *  - request(route, body): the POST's answer, or throws with `status` (and `message`);
 *  - confirm(text): whether to go on after a 409.
 * Resolves with {result} once a request succeeded, or null when the person cancelled. Anything
 * else throws, with the route's own error.
 */
export async function runChoose(action, bindings, deps) {
    const spec = action.choose || {};
    const source = resolveTemplate(spec.source, bindings);
    if (!source || !isSafeRoute(source)) {
        throw refused();
    }
    const answer = await deps.load(source);
    const rows = chooseRows(spec, answer, bindings);
    const title = spec.title !== undefined ? shown(resolve(spec.title, bindings)) : "";
    const empty = spec.empty !== undefined ? shown(resolve(spec.empty, bindings)) : "";
    const create = spec.create ? {
        label: shown(resolve(spec.create.label, bindings)),
        field: shown(resolve(spec.create.field, bindings)),
    } : null;
    const picked = await deps.choose({ title, empty, rows, create });
    if (!picked) {
        return null;
    }
    if (picked.create !== undefined) {
        // a new one, named by the person: the create route gets the text as $value
        const scope = { ...bindings, value: String(picked.create) };
        const route = resolveTemplate(spec.create.route, scope);
        if (!route || !isSafeRoute(route)) {
            throw refused();
        }
        const body = spec.create.body !== undefined ? resolve(spec.create.body, scope) : { value: scope.value };
        return { result: await deps.request(route, body) };
    }
    const scope = { ...bindings, value: picked.row };
    const route = resolveTemplate(action.route, scope);
    if (!route || !isSafeRoute(route)) {
        throw refused();
    }
    const body = action.body !== undefined ? resolve(action.body, scope) : {};
    try {
        return { result: await deps.request(route, body) };
    } catch (error) {
        const conflict = action.conflict;
        if (!error || error.status !== 409 || !conflict) {
            throw error;
        }
        // already there: asked, then sent again to the conflict's route (or the same one)
        const asked = conflict.confirm !== undefined ? shown(resolve(conflict.confirm, scope)) : "";
        if (!deps.confirm(asked || error.message || "It is already there. Go on?")) {
            return null;
        }
        const again = resolveTemplate(conflict.route !== undefined ? conflict.route : action.route, scope);
        if (!again || !isSafeRoute(again)) {
            throw refused();
        }
        const second = conflict.body !== undefined ? conflict.body : action.body;
        return { result: await deps.request(again, second !== undefined ? resolve(second, scope) : {}) };
    }
}

/**
 * Mission Control's dialog for a choose action: the create row first (a button that opens a
 * name field), then each row with its picture, title and subtitle. `frame(route)` draws a
 * picture. Resolves with {row}, {create: text} or null.
 */
export function openChooser({ title, empty, rows, create, frame }) {
    return new Promise((resolve) => {
        const returnFocus = document.activeElement;
        const overlay = el("div", "ui-picker ui-choose");
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        const label = title || "Choose";
        overlay.setAttribute("aria-label", label);
        const sheet = el("div", "ui-picker-sheet ui-choose-sheet");
        const head = el("div", "ui-picker-head");
        const heading = el("div", "ui-picker-heading");
        heading.appendChild(el("p", "ui-picker-title", label));
        const close = el("button", "ui-viewer-button ui-picker-close");
        close.type = "button";
        close.setAttribute("aria-label", "Cancel");
        close.title = "Cancel";
        close.appendChild(icon("x", 20) || el("span", null, "×"));
        head.append(heading, close);
        const body = el("div", "ui-picker-body ui-choose-body");
        const list = el("div", "ui-choose-list");
        list.setAttribute("role", "list");

        function finish(result) {
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

        if (create) {
            const opener = el("button", "ui-choose-row ui-choose-new");
            opener.type = "button";
            const plus = el("span", "ui-choose-thumb ui-choose-plus");
            plus.appendChild(icon("plus", 22) || el("span", null, "+"));
            opener.append(plus, el("span", "ui-choose-title", create.label || "New"));
            const form = el("form", "ui-choose-form");
            form.hidden = true;
            const input = el("input", "ui-input");
            input.type = "text";
            input.setAttribute("aria-label", create.field || create.label);
            input.placeholder = create.field || "";
            const submit = el("button", "ui-pill ui-pill-primary", "Create");
            submit.type = "submit";
            submit.disabled = true;
            form.append(input, submit);
            input.addEventListener("input", () => {
                submit.disabled = !input.value.trim();
            });
            opener.addEventListener("click", () => {
                opener.hidden = true;
                form.hidden = false;
                input.focus();
            });
            form.addEventListener("submit", (event) => {
                event.preventDefault();
                const name = input.value.trim();
                if (name) {
                    finish({ create: name });
                }
            });
            body.append(opener, form);
        }
        if (!rows.length) {
            body.appendChild(el("p", "ui-text ui-text-caption ui-choose-empty", empty || "There is nothing to choose from yet."));
        }
        for (const entry of rows) {
            const button = el("button", "ui-choose-row");
            button.type = "button";
            button.setAttribute("role", "listitem");
            if (entry.image && frame) {
                button.appendChild(frame(entry.image));
            }
            const main = el("span", "ui-list-main");
            main.appendChild(el("span", "ui-list-title", entry.title));
            if (entry.subtitle) {
                main.appendChild(el("span", "ui-list-subtitle", entry.subtitle));
            }
            button.appendChild(main);
            button.addEventListener("click", () => finish({ row: entry.row }));
            list.appendChild(button);
        }
        body.appendChild(list);
        sheet.append(head, body);
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);
        document.body.classList.add("ui-viewer-open");
        close.addEventListener("click", () => finish(null));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                finish(null);
            }
        });
        document.addEventListener("keydown", onKey, true);
        (body.querySelector("button") || close).focus();
    });
}
