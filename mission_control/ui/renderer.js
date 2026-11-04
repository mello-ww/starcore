// Mission Control's renderer for StarCore UI contract 1.0 (docs/ui-contract.md).
//
// Mounted exactly like a Satellite's own mission_control/page.js - same
// mount(context) and cleanup - for any Satellite that ships a ui.json
// instead. It knows the contract's blocks and capabilities, never a
// Satellite: it fetches the document, the page data its routes return, and
// draws both with Mission Control's own components. Nothing a document
// contains is ever evaluated; every action is an ordinary request to the
// Satellite's own routes, which keep their own authentication and checks.

import {
    BLOCK_TYPES, checkDocument, findProvider, formatValue, isSafeRoute, isVisible,
    missingRequirements, resolve, resolveTemplate, toneOf,
} from "./contract.js";
import { icon } from "./icons.js";

const STYLESHEET = "/ui/ui.css";

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

function loadStylesheet() {
    if (!document.querySelector(`link[href="${STYLESHEET}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = STYLESHEET;
        document.head.appendChild(link);
    }
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, { headers: { Accept: "application/json", ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error((payload && payload.error) || `Request failed with status ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}

/** "item?id=3" (the section in #/satellite/<name>/<section>) -> {page, params} */
export function parseSection(section) {
    if (!section) {
        return { page: null, params: {} };
    }
    const [page, query = ""] = section.split("?");
    return { page, params: Object.fromEntries(new URLSearchParams(query)) };
}

export function sectionFor(page, params) {
    const query = new URLSearchParams(params || {}).toString();
    return query ? `${page}?${query}` : page;
}

export function mount(context) {
    loadStylesheet();
    const root = el("div", "ui-root");
    context.element.appendChild(root);
    const satelliteName = context.satellite.name;
    const satelliteBase = `/api/satellites/${encodeURIComponent(satelliteName)}`;

    const state = {
        document: null,
        revision: null,
        catalog: null,
        page: null,
        params: {},
        data: null,
        dataError: null,
        forms: {},
        notice: null,
        timer: null,
        noticeTimer: null,
        disposed: false,
        loadToken: 0,
    };

    // ---------- navigation ----------

    function navigate(page, params = {}) {
        location.hash = `#/satellite/${encodeURIComponent(satelliteName)}/${sectionFor(page, params)}`;
    }

    function goBack() {
        const entry = state.document.entry;
        if (history.length > 1) {
            history.back();
        } else {
            navigate(entry);
        }
    }

    function showSection(section) {
        if (!state.document) {
            return;
        }
        const { page, params } = parseSection(section);
        const target = page && Object.hasOwn(state.document.pages, page) ? page : state.document.entry;
        const required = state.document.pages[target].params || [];
        if (required.some((name) => !(name in params))) {
            navigate(state.document.entry);
            return;
        }
        if (target !== state.page || JSON.stringify(params) !== JSON.stringify(state.params)) {
            state.page = target;
            state.params = params;
            state.data = null;
            state.dataError = null;
            state.forms = {};
            loadData();
        }
    }

    // ---------- data ----------

    function pageDefinition() {
        return state.document.pages[state.page];
    }

    function scheduleRefresh() {
        clearTimeout(state.timer);
        const source = pageDefinition().source;
        if (source && source.refresh) {
            state.timer = setTimeout(() => loadData({ background: true }), Math.max(2, source.refresh) * 1000);
        }
    }

    function userIsEditing() {
        const active = document.activeElement;
        return Boolean(active && root.contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)
            && active.type !== "checkbox");
    }

    async function loadData({ background = false } = {}) {
        const token = ++state.loadToken;
        const source = pageDefinition().source;
        if (!source) {
            state.data = {};
            render();
            return;
        }
        if (background && userIsEditing()) {
            scheduleRefresh();  // never pull a form or slider out from under the user
            return;
        }
        const route = resolveTemplate(source.route, { params: state.params });
        try {
            if (!isSafeRoute(route)) {
                throw new Error("This page points outside its Satellite and was not loaded.");
            }
            const data = await requestJson(`${satelliteBase}/${route}`);
            if (token !== state.loadToken || state.disposed) {
                return;
            }
            state.data = data && typeof data === "object" ? data : {};
            state.dataError = null;
        } catch (error) {
            if (token !== state.loadToken || state.disposed) {
                return;
            }
            state.dataError = error.message;
        }
        render();
        scheduleRefresh();
    }

    // ---------- actions ----------

    // a floating toast, so a confirmation never shifts the page under the pointer
    function setNotice(text, kind = "notice") {
        clearTimeout(state.noticeTimer);
        state.notice = text ? { text, kind } : null;
        renderNotice();
        if (text) {
            state.noticeTimer = setTimeout(() => setNotice(null), kind === "error" ? 8000 : 3500);
        }
    }

    /** Runs one action; true once its request (if any) succeeded. */
    async function runAction(action, scope, value) {
        if (!action) {
            return false;
        }
        const bindings = { ...scope, value };
        if (action.navigate) {
            navigate(action.navigate, resolve(action.params || {}, bindings));
            return true;
        }
        if (action.confirm && !window.confirm(String(resolve(action.confirm, bindings)))) {
            return false;
        }
        const route = resolveTemplate(action.route, bindings);
        if (!isSafeRoute(route)) {
            setNotice("That action points outside its Satellite and was refused.", "error");
            return false;
        }
        const method = action.method || "POST";
        const body = action.body !== undefined ? resolve(action.body, bindings) : (scope.form || {});
        let result;
        try {
            result = await requestJson(`${satelliteBase}/${route}`, method === "GET" ? {} : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (error) {
            setNotice(error.message, "error");
            loadData({ background: true });  // show what's actually true now
            return false;
        }
        setNotice(result && typeof result.message === "string" ? result.message : null);
        const then = action.then;
        if (then === "back") {
            goBack();
        } else if (then && typeof then === "object" && then.navigate) {
            navigate(then.navigate, resolve(then.params || {}, { ...bindings, data: result || {} }));
        } else if (then === "refresh") {
            loadData({ background: false });
        }
        return true;
    }

    // ---------- blocks ----------

    function scopeFor(data) {
        return { data, page: state.data, params: state.params, form: undefined };
    }

    function text(value, scope) {
        const resolved = resolve(value, scope);
        return resolved === null || resolved === undefined ? "" : String(resolved);
    }

    function renderBlocks(blocks, scope, container) {
        for (const block of blocks || []) {
            const node = renderBlock(block, scope);
            if (node) {
                container.appendChild(node);
            }
        }
    }

    function renderBlock(block, scope) {
        if (!block || typeof block !== "object") {
            return null;
        }
        if (block.developer && !context.developer.enabled) {
            return null;
        }
        if ("visible" in block && !isVisible(resolve(block.visible, scope))) {
            return null;
        }
        if (!BLOCK_TYPES.has(block.type)) {
            // a newer block this Mission Control doesn't know - skipped, unless
            // the Satellite said the page makes no sense without it
            return block.required ? el("p", "ui-unsupported", "Part of this page needs a newer Mission Control.") : null;
        }
        const renderer = BLOCKS[block.type];
        return renderer(block, scope);
    }

    const BLOCKS = {
        heading: (block, scope) => el("h3", "ui-heading", text(block.text, scope)),

        text: (block, scope) => el("p", `ui-text ui-text-${block.style || "body"}`, text(block.text, scope)),

        field: (block, scope) => {
            const row = el("div", "ui-field");
            row.appendChild(el("span", "ui-field-label", text(block.label, scope)));
            const value = el("span", `ui-field-value ui-tone-${toneOf(resolve(block.tone, scope))}`,
                formatValue(resolve(block.value, scope), block.format, block.unit));
            row.appendChild(value);
            return row;
        },

        metric: (block, scope) => {
            const value = resolve(block.value, scope);
            const tile = el("div", `ui-metric ui-tone-${toneOf(resolve(block.tone, scope))}`);
            tile.appendChild(el("span", "ui-metric-label", text(block.label, scope)));
            tile.appendChild(el("span", "ui-metric-value", formatValue(value, block.format, block.unit)));
            const max = resolve(block.max, scope);
            if (typeof max === "number" && max > 0 && typeof value === "number") {
                const bar = el("span", "ui-metric-bar");
                const fill = el("span", "ui-metric-fill");
                fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
                bar.appendChild(fill);
                tile.appendChild(bar);
            }
            return tile;
        },

        card: (block, scope) => {
            const card = el("section", "ui-card");
            if (block.title !== undefined) {
                card.appendChild(el("p", "eyebrow", text(block.title, scope)));
            }
            const body = el("div", "ui-card-body");
            renderBlocks(block.blocks, scope, body);
            card.appendChild(body);
            return card;
        },

        list: (block, scope) => {
            const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
            const list = el("div", "ui-list");
            if (!Array.isArray(items) || items.length === 0) {
                list.appendChild(el("p", "ui-text ui-text-caption", block.empty ? text(block.empty, scope) : "Nothing here."));
                return list;
            }
            const formats = (block.item && block.item.format) || {};
            for (const item of items) {
                const itemScope = { ...scope, data: item };
                const row = el(block.action ? "button" : "div", "ui-list-row");
                if (block.action) {
                    row.type = "button";
                    row.addEventListener("click", () => runAction(block.action, itemScope));
                }
                const glyph = icon(resolve(block.item.icon, itemScope));
                if (glyph) {
                    const holder = el("span", "ui-list-icon");
                    holder.appendChild(glyph);
                    row.appendChild(holder);
                }
                const main = el("span", "ui-list-main");
                main.appendChild(el("span", "ui-list-title", text(block.item.title, itemScope)));
                if (block.item.subtitle !== undefined) {
                    main.appendChild(el("span", "ui-list-subtitle",
                        formatValue(resolve(block.item.subtitle, itemScope), formats.subtitle)));
                }
                row.appendChild(main);
                if (block.item.value !== undefined) {
                    row.appendChild(el("span", "ui-list-value", formatValue(resolve(block.item.value, itemScope), formats.value)));
                }
                if (block.action) {
                    row.appendChild(el("span", "ui-list-chevron", "›"));
                }
                list.appendChild(row);
            }
            return list;
        },

        button: (block, scope) => {
            const style = block.style || "secondary";
            const button = el("button", `sc-button ui-button${style === "primary" ? " sc-button-accent" : ""}${style === "danger" ? " ui-button-danger" : ""}`,
                text(block.label, scope));
            button.type = "button";
            button.addEventListener("click", async () => {
                button.disabled = true;
                try {
                    await runAction(block.action, scope);
                } finally {
                    button.disabled = false;
                }
            });
            return button;
        },

        toggle: (block, scope) => {
            const row = el("label", "ui-toggle");
            const words = el("span", "ui-toggle-text");
            words.appendChild(el("span", "ui-field-label", text(block.label, scope)));
            if (block.description !== undefined) {
                words.appendChild(el("span", "ui-text ui-text-caption", text(block.description, scope)));
            }
            row.appendChild(words);
            const input = el("input", "sc-switch");
            input.type = "checkbox";
            input.setAttribute("role", "switch");
            input.checked = Boolean(resolve(block.value, scope));
            input.addEventListener("change", () => runAction(block.action, scope, input.checked));
            row.appendChild(input);
            return row;
        },

        slider: (block, scope) => {
            const min = Number(resolve(block.min, scope));
            const max = Number(resolve(block.max, scope));
            const step = Number(resolve(block.step, scope)) || 1;
            const current = Number(resolve(block.value, scope));
            const wrapper = el("div", "ui-slider");
            const head = el("div", "ui-field");
            head.appendChild(el("span", "ui-field-label", text(block.label, scope)));
            const shown = el("span", "ui-field-value", formatValue(current, block.format, block.unit));
            head.appendChild(shown);
            wrapper.appendChild(head);
            const input = el("input", "ui-range");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(Number.isFinite(current) ? current : min);
            input.setAttribute("aria-label", text(block.label, scope));
            const paint = () => {
                const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
                input.style.setProperty("--ui-fill", `${ratio * 100}%`);
                shown.textContent = formatValue(Number(input.value), block.format, block.unit);
            };
            paint();
            input.addEventListener("input", paint);
            input.addEventListener("change", () => {
                input.blur();
                runAction(block.action, scope, Number(input.value));
            });
            wrapper.appendChild(input);
            return wrapper;
        },

        form: (block, scope) => {
            const key = block.id || `form-${JSON.stringify(block.fields.map((field) => field.key))}`;
            if (!state.forms[key]) {
                state.forms[key] = Object.fromEntries(block.fields.map((field) => [field.key,
                    field.value !== undefined ? resolve(field.value, scope) : (field.kind === "toggle" ? false : "")]));
            }
            const values = state.forms[key];
            const form = el("form", "ui-form");
            form.noValidate = true;
            for (const field of block.fields) {
                form.appendChild(renderFormField(field, values, scope));
            }
            const error = el("p", "ui-form-error");
            error.hidden = true;
            form.appendChild(error);
            const submit = el("button", "sc-button sc-button-accent ui-button", text(block.submit.label, scope));
            submit.type = "submit";
            form.appendChild(submit);
            form.addEventListener("submit", async (event) => {
                event.preventDefault();
                const missing = block.fields.filter((field) => field.required
                    && (values[field.key] === "" || values[field.key] === null || values[field.key] === undefined));
                if (missing.length) {
                    error.textContent = `${missing.map((field) => field.label).join(", ")} ${missing.length === 1 ? "is" : "are"} required.`;
                    error.hidden = false;
                    return;
                }
                error.hidden = true;
                submit.disabled = true;
                try {
                    if (await runAction(block.submit.action, { ...scope, form: { ...values } })) {
                        delete state.forms[key];  // a successful submit starts the form afresh
                    }
                } finally {
                    submit.disabled = false;
                }
            });
            return form;
        },

        "file-browser": (block, scope) => renderFileBrowser(block, scope),
    };

    function renderFormField(field, values, scope) {
        const label = el("label", field.kind === "toggle" ? "ui-toggle" : "ui-input-field");
        label.appendChild(el("span", "ui-field-label", `${text(field.label, scope)}${field.required ? " *" : ""}`));
        let input;
        if (field.kind === "select") {
            input = el("select", "ui-input");
            for (const option of field.options || []) {
                const node = el("option", null, text(option.label, scope));
                node.value = String(option.value);
                input.appendChild(node);
            }
            input.value = String(values[field.key] ?? "");
            input.addEventListener("change", () => {
                const chosen = (field.options || []).find((option) => String(option.value) === input.value);
                values[field.key] = chosen ? chosen.value : input.value;
            });
        } else if (field.kind === "toggle") {
            input = el("input", "sc-switch");
            input.type = "checkbox";
            input.setAttribute("role", "switch");
            input.checked = Boolean(values[field.key]);
            input.addEventListener("change", () => { values[field.key] = input.checked; });
        } else {
            input = el("input", "ui-input");
            input.type = field.kind === "number" ? "number" : "text";
            input.value = values[field.key] === null || values[field.key] === undefined ? "" : String(values[field.key]);
            if (field.placeholder !== undefined) {
                input.placeholder = text(field.placeholder, scope);
            }
            input.addEventListener("input", () => {
                values[field.key] = field.kind === "number"
                    ? (input.value === "" ? "" : Number(input.value))
                    : input.value;
            });
        }
        input.name = field.key;
        label.appendChild(input);
        return label;
    }

    // A shared block bound to a capability, not to a Satellite: it browses
    // through whichever Satellite the catalog says provides files.browse.
    function renderFileBrowser(block, scope) {
        const box = el("div", "ui-files");
        const provider = findProvider(state.catalog && state.catalog.capabilities, block.capability);
        const route = provider && provider.operations && provider.operations.list;
        if (!provider || !isSafeRoute(route)) {
            box.appendChild(el("p", "ui-unsupported",
                `No enabled Satellite provides ${block.capability}, so there is nothing to browse yet.`));
            return box;
        }
        const select = block.select || "none";
        const head = el("div", "ui-files-head");
        const up = el("button", "sc-button ui-button", "Up");
        up.type = "button";
        const where = el("span", "ui-files-path", "");
        head.append(up, where);
        const rows = el("div", "ui-list");
        const foot = el("div", "ui-files-foot");
        const choose = el("button", "sc-button sc-button-accent ui-button", text(block.label, scope) || "Choose");
        choose.type = "button";
        choose.hidden = select !== "directory" || !block.action;
        foot.appendChild(choose);
        box.append(head, rows, foot);

        const view = { path: "", parent: null };
        async function open(path) {
            rows.replaceChildren(el("p", "ui-text ui-text-caption", "Loading…"));
            try {
                const listing = await requestJson(
                    `/api/satellites/${encodeURIComponent(provider.satellite)}/${route}?path=${encodeURIComponent(path)}`);
                view.path = listing.path || "";
                view.parent = listing.parent ?? null;
                where.textContent = view.path || "Locations";
                up.disabled = view.path === "";
                choose.disabled = view.path === "";
                rows.replaceChildren();
                const entries = Array.isArray(listing.entries) ? listing.entries : [];
                if (entries.length === 0) {
                    rows.appendChild(el("p", "ui-text ui-text-caption", "This folder is empty."));
                }
                for (const entry of entries) {
                    const isDir = entry.type === "dir";
                    // at the roots an entry's name is already an absolute path
                    const target = view.path === "" ? entry.name : joinPath(view.path, entry.name);
                    const clickable = isDir || (select === "file" && block.action);
                    const row = el(clickable ? "button" : "div", "ui-list-row");
                    if (clickable) {
                        row.type = "button";
                        row.addEventListener("click", () => (isDir ? open(target) : runAction(block.action, scope, target)));
                    }
                    const holder = el("span", "ui-list-icon");
                    holder.appendChild(icon(isDir ? "folder" : "file"));
                    row.appendChild(holder);
                    const main = el("span", "ui-list-main");
                    main.appendChild(el("span", "ui-list-title", entry.name));
                    row.appendChild(main);
                    if (!isDir && typeof entry.size === "number") {
                        row.appendChild(el("span", "ui-list-value", formatValue(entry.size, "bytes")));
                    }
                    rows.appendChild(row);
                }
            } catch (error) {
                rows.replaceChildren(el("p", "ui-form-error", error.message));
            }
        }
        up.addEventListener("click", () => open(view.parent || ""));
        choose.addEventListener("click", () => runAction(block.action, scope, view.path));
        open("");
        return box;
    }

    function joinPath(base, name) {
        const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
        return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
    }

    // ---------- page ----------

    // on <body>: the page container is animated (a transform), which would
    // otherwise pin a fixed-position toast to it instead of to the window
    const noticeSlot = el("div", "ui-notice-slot");
    document.body.appendChild(noticeSlot);

    function renderNotice() {
        noticeSlot.replaceChildren();
        if (state.notice) {
            const toast = el("p", `ui-toast${state.notice.kind === "error" ? " ui-toast-error" : ""}`, state.notice.text);
            toast.setAttribute("role", state.notice.kind === "error" ? "alert" : "status");
            noticeSlot.appendChild(toast);
        }
    }

    function renderNavigation() {
        const items = state.document.navigation || [];
        if (items.length < 2) {
            return null;
        }
        const nav = el("nav", "ui-tabs");
        nav.setAttribute("aria-label", `${satelliteName} pages`);
        const current = items.some((item) => item.page === state.page)
            ? state.page
            : null;
        for (const item of items) {
            const tab = el("button", `ui-tab${item.page === current ? " active" : ""}`);
            tab.type = "button";
            if (item.page === current) {
                tab.setAttribute("aria-current", "page");
            }
            const glyph = icon(item.icon, 16);
            if (glyph) {
                tab.appendChild(glyph);
            }
            tab.appendChild(el("span", null, item.label));
            tab.addEventListener("click", () => navigate(item.page));
            nav.appendChild(tab);
        }
        return nav;
    }

    function render() {
        if (state.disposed || !state.document) {
            return;
        }
        const page = pageDefinition();
        const scope = scopeFor(state.data || {});
        root.replaceChildren();

        const nav = renderNavigation();
        if (nav) {
            root.appendChild(nav);
        }
        const isTopLevel = (state.document.navigation || []).some((item) => item.page === state.page)
            || state.page === state.document.entry;
        if (!isTopLevel) {
            // a detail page: the tabs don't name it, so it gets a title and a way back
            const head = el("div", "ui-page-head");
            const back = el("button", "sc-icon-button sc-icon-button-quiet ui-back", "‹ Back");
            back.type = "button";
            back.addEventListener("click", goBack);
            head.appendChild(back);
            if (page.title !== undefined && state.data) {
                head.appendChild(el("h2", "ui-page-title", text(page.title, scope)));
            }
            root.appendChild(head);
        }
        renderNotice();

        if (state.dataError) {
            root.appendChild(el("p", "banner error ui-notice", state.dataError));
            if (!state.data) {
                return;
            }
        }
        if (!state.data) {
            root.appendChild(el("p", "ui-text ui-text-caption", "Loading…"));
            return;
        }
        const body = el("div", "ui-page");
        renderBlocks(page.blocks, scope, body);
        root.appendChild(body);
    }

    function fail(message) {
        root.replaceChildren(el("p", "banner error ui-notice", message));
    }

    async function start() {
        try {
            const [payload, catalog] = await Promise.all([
                requestJson(`${satelliteBase}/ui`),
                requestJson("/api/catalog").catch(() => ({ capabilities: {} })),
            ]);
            if (state.disposed) {
                return;
            }
            const problem = checkDocument(payload && payload.document);
            if (problem) {
                fail(problem);
                return;
            }
            state.document = payload.document;
            state.revision = payload.revision;
            state.catalog = catalog;
            const missing = missingRequirements(state.document.requires, catalog.capabilities);
            if (missing.length) {
                fail(missing.map((item) => (item.kind === "client"
                    ? `This interface needs ${item.name}, which this Mission Control doesn't offer yet.`
                    : `This interface needs a Satellite that provides ${item.name}.`)).join(" "));
                return;
            }
            showSection(context.section);
        } catch (error) {
            if (!state.disposed) {
                fail(`The ${satelliteName} interface could not be loaded: ${error.message}`);
            }
        }
    }

    const unsubscribe = context.developer.subscribe(() => render());
    start();

    const cleanup = () => {
        state.disposed = true;
        clearTimeout(state.timer);
        clearTimeout(state.noticeTimer);
        unsubscribe();
        root.remove();
        noticeSlot.remove();
    };
    cleanup.showSection = showSection;
    cleanup.revision = () => state.revision;
    return cleanup;
}
