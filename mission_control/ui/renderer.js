// Mission Control's renderer for StarCore UI contract 1.1 (docs/ui-contract.md).
//
// Mounted exactly like a Satellite's own mission_control/page.js - same
// mount(context) and cleanup - for any Satellite that ships a ui.json
// instead. It knows the contract's blocks and capabilities, never a
// Satellite: it fetches the document, the page data its routes return, and
// draws both with Mission Control's own components. Nothing a document
// contains is ever evaluated; every action is an ordinary request to the
// Satellite's own routes, which keep their own authentication and checks.

import { createChart, meter, sparkline } from "./charts.js";
import {
    BLOCK_TYPES, checkDocument, findProvider, formatValue, isSafeRoute, isVisible,
    missingRequirements, resolve, resolveTemplate, toneOf,
} from "./contract.js";
import { createGallery, holdsCollection } from "./gallery.js";
import { icon } from "./icons.js";
import { createMaps } from "./map.js";
import { pickMedia } from "./picker.js";
import { promptPin, runSecure, secureProvider } from "./secure.js";

const STYLESHEET = "/ui/ui.css";
const TONE_LEVEL = { warn: "warning", danger: "critical" };

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
        error.payload = payload;  // e.g. a lockout's retry_after
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

/** A dot and a word, never colour alone. */
function stateDot(tone) {
    const dot = el("i", `ui-dot ui-dot-${toneOf(tone)}`);
    dot.setAttribute("aria-hidden", "true");
    return dot;
}

/** A severity meter: its fill is neutral until the tone says otherwise. */
function toneMeter(value, max, tone, label) {
    const percent = typeof value === "number" && typeof max === "number" && max > 0 ? (value / max) * 100 : null;
    const node = meter(percent, { warn: Infinity, critical: Infinity, label });
    const level = TONE_LEVEL[toneOf(tone)];
    if (level && percent !== null) {
        node.classList.add(level);
    }
    return node;
}

/** The value of a chart point: [time, value, peak?] or a plain number. */
function pointValue(point) {
    return Array.isArray(point) ? point[1] : point;
}

/** How a chart's axis rounds, from the format its values are shown in. */
function chartScale(format) {
    return { percent: "percent", bytes: "bytes", byterate: "bytes", bitrate: "bits" }[format] || "plain";
}

/** Blocks a dashboard lays out side by side: tiles, charts, and cards
 * without a table (judged by what was drawn - a hidden table doesn't count). */
function groupOf(block, node) {
    if (block.type === "field") {
        return "fields";
    }
    if (block.type === "metric") {
        return "tiles";
    }
    if (block.type === "chart" && block.kind !== "bars") {
        return "charts";
    }
    if (block.type === "card" && !node.querySelector(".ui-table-wrap")) {
        return "columns";
    }
    return null;
}

export function mount(context) {
    loadStylesheet();
    const root = el("div", "ui-root");
    context.element.appendChild(root);
    const satelliteName = context.satellite.name;
    const satelliteBase = `/api/satellites/${encodeURIComponent(satelliteName)}`;
    // a host without Developer Mode shows everything
    const developer = context.developer || { enabled: true, subscribe: () => () => {} };
    // the Satellite's own interface (its page.js), which the own action (1.2) opens at a
    // section; null when the host has none for this Satellite, and the action's controls hide
    const own = context.own && typeof context.own.open === "function" ? context.own : null;

    const state = {
        document: null,
        revision: null,
        catalog: null,
        page: null,
        params: {},
        pageState: {},
        data: null,
        dataError: null,
        loading: false,
        lastGood: 0,
        sources: {},
        header: null,
        forms: {},
        notice: null,
        timers: new Map(),
        noticeTimer: null,
        disposed: false,
        tokens: new Map(),
        charts: new Map(),
        openTables: new WeakSet(),
    };

    // the media-grid block and its viewer (1.2), which keep their own state across renders
    const gallery = createGallery({
        satelliteBase,
        // what the person chooses here (a grid's size), remembered for this Satellite in this
        // browser - this server's own Mission Control, so per server as well
        preferences: {
            get: (key) => {
                try {
                    return localStorage.getItem(`starcore.ui.${satelliteName}.${key}`);
                } catch {
                    return null;
                }
            },
            set: (key, value) => {
                try {
                    localStorage.setItem(`starcore.ui.${satelliteName}.${key}`, value);
                } catch {
                    // without storage the choice lasts until the page is left
                }
            },
        },
        // a grid's next page (`more`), from the Satellite's own route, with this session
        load: (route) => requestJson(`${satelliteBase}/${route}`),
        runAction: (...args) => runAction(...args),
        // the secure action (1.2): once for a whole selection, and hidden where it can't run
        runSecure: (action, items, scope) => runSecureAction(action, items, scope),
        // and an own action only where this Satellite has an own interface here
        canRun: (action) => !action || ((action.own === undefined || Boolean(own)) && (!action.secure
            || Boolean(secureProvider(action, state.catalog && state.catalog.capabilities, satelliteName)))),
        setNotice: (...args) => setNotice(...args),
        afterSelection: (then) => {
            if (then === "back") {
                goBack();
            } else if (then === "refresh") {
                loadData({ background: false });
            } else {
                render();
            }
        },
    });

    // the map block (1.2): its Leaflet map lives across renders, and its markers open the
    // gallery's shared viewer
    const maps = createMaps({
        satelliteBase, runAction: (...args) => runAction(...args), gallery,
        load: (route) => requestJson(`${satelliteBase}/${route}`),
    });
    // the search block (1.2): one input per block, kept across renders so typing is never lost
    let searchInputs = new WeakMap();
    const SEARCH_PAUSE = 300;

    // ---------- navigation ----------

    function navigationItems() {
        return (state.document.navigation || []).filter((item) => !item.developer || developer.enabled);
    }

    function navigate(page, params = {}) {
        location.hash = `#/satellite/${encodeURIComponent(satelliteName)}/${sectionFor(page, params)}`;
    }

    function goBack() {
        if (history.length > 1) {
            history.back();
        } else {
            navigate(state.document.entry);
        }
    }

    function isAvailable(page) {
        const item = (state.document.navigation || []).find((entry) => entry.page === page);
        return !(item && item.developer && !developer.enabled);
    }

    function showSection(section) {
        if (!state.document) {
            return;
        }
        const { page, params } = parseSection(section);
        let target = page && Object.hasOwn(state.document.pages, page) ? page : state.document.entry;
        if (!isAvailable(target)) {
            target = state.document.entry;
        }
        const required = state.document.pages[target].params || [];
        if (required.some((name) => !(name in params))) {
            navigate(state.document.entry);
            return;
        }
        if (target !== state.page || JSON.stringify(params) !== JSON.stringify(state.params)) {
            state.page = target;
            state.params = params;
            state.pageState = { ...(pageDefinition().state || {}) };
            state.data = null;
            state.dataError = null;
            state.lastGood = 0;
            state.sources = {};
            state.forms = {};
            gallery.reset();
            maps.reset();
            searchInputs = new WeakMap();
            for (const [name, timer] of state.timers) {
                if (name !== "header") {
                    clearTimeout(timer);
                    state.timers.delete(name);
                }
            }
            state.charts.forEach((chart) => chart.destroy());
            state.charts.clear();
            loadPage();
        }
    }

    // ---------- data ----------

    function pageDefinition() {
        return state.document.pages[state.page];
    }

    function userIsEditing() {
        const active = document.activeElement;
        return Boolean(active && root.contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)
            && active.type !== "checkbox");
    }

    /** One source on its own timer: "page" (the page's own), "header", or a named one. */
    function schedule(name, source, run) {
        clearTimeout(state.timers.get(name));
        if (source && source.refresh) {
            state.timers.set(name, setTimeout(run, Math.max(2, source.refresh) * 1000));
        }
    }

    async function fetchSource(name, source) {
        const token = (state.tokens.get(name) || 0) + 1;
        state.tokens.set(name, token);
        const route = resolveTemplate(source.route, { params: state.params, state: state.pageState });
        if (!isSafeRoute(route)) {
            throw new Error("This page points outside its Satellite and was not loaded.");
        }
        const data = await requestJson(`${satelliteBase}/${route}`);
        if (token !== state.tokens.get(name) || state.disposed) {
            return undefined;  // a newer request for this source is under way
        }
        return data && typeof data === "object" ? data : {};
    }

    function loadPage() {
        loadData();
        for (const name of Object.keys(pageDefinition().sources || {})) {
            loadNamed(name);
        }
    }

    async function loadData({ background = false } = {}) {
        const page = state.page;
        const source = pageDefinition().source;
        if (!source) {
            state.data = {};
            render();
            return;
        }
        const again = () => loadData({ background: true });
        if (background && (userIsEditing() || document.hidden)) {
            schedule("page", source, again);  // never pull a form out from under the user, nor poll a hidden tab
            return;
        }
        state.loading = true;
        markLoading();
        try {
            const data = await fetchSource("page", source);
            if (data === undefined || page !== state.page) {
                return;
            }
            state.data = data;
            state.dataError = null;
            state.lastGood = Date.now();
        } catch (error) {
            if (state.disposed || page !== state.page) {
                return;
            }
            state.dataError = error.message || "StarCore did not answer";
            // an answer with an error status is not StarCore being unreachable
            state.dataUnreachable = !(error.status > 0);
        }
        state.loading = false;
        render();
        schedule("page", source, again);
    }

    async function loadNamed(name) {
        const page = state.page;
        const source = (pageDefinition().sources || {})[name];
        if (!source) {
            return;
        }
        const again = () => loadNamed(name);
        if (document.hidden) {
            schedule(name, source, again);
            return;
        }
        try {
            const data = await fetchSource(name, source);
            if (data !== undefined && page === state.page) {
                state.sources = { ...state.sources, [name]: data };
                render();
            }
        } catch {
            // a named source is supplementary: its blocks show what they have, the page stays
        }
        if (page === state.page && !state.disposed) {
            schedule(name, source, again);
        }
    }

    async function loadHeader() {
        const header = state.document.header;
        if (!header || !header.source) {
            state.header = {};
            return;
        }
        const again = () => loadHeader();
        if (!document.hidden) {
            try {
                const data = await fetchSource("header", header.source);
                if (data !== undefined) {
                    state.header = data;
                    render();
                }
            } catch {
                // the page's own notice says when StarCore isn't answering
            }
        }
        if (!state.disposed) {
            schedule("header", header.source, again);
        }
    }

    function onVisibility() {
        if (!document.hidden && !state.disposed && state.document && state.page) {
            loadData({ background: true });
            for (const name of Object.keys(pageDefinition().sources || {})) {
                loadNamed(name);
            }
            loadHeader();
        }
    }

    function setPageState(key, value) {
        if (state.pageState[key] === value) {
            return;
        }
        state.pageState = { ...state.pageState, [key]: value };
        render();  // the choice shows at once; the data follows
        loadData();
        for (const name of Object.keys(pageDefinition().sources || {})) {
            loadNamed(name);
        }
    }

    // refetching keeps the frame: what is shown stays, dimmed, until the new data arrives
    function markLoading() {
        root.classList.toggle("ui-refreshing", Boolean(state.loading && state.data));
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

    /** Runs one action; true once its request (if any) succeeded. `quiet` (one item of a
     * selection) leaves notices and refreshing to the caller. */
    async function runAction(action, scope, value, { quiet = false } = {}) {
        if (!action) {
            return false;
        }
        const bindings = { ...scope, value };
        if (action.navigate) {
            navigate(action.navigate, resolve(action.params || {}, bindings));
            return true;
        }
        if (action.secure) {
            // 1.2: one protected operation on this item, behind Mission Control's own prompt
            return runSecureAction(action, [scope.data], scope);
        }
        if (action.own !== undefined) {
            // 1.2: the Satellite's own page, at a section it names - nothing runs here
            if (!own) {
                setNotice("That isn't available in Mission Control.", "error");
                return false;
            }
            own.open(String(action.own));
            return true;
        }
        if (action.play) {
            // 1.2: played by the shell's audio host, from whichever Satellite provides audio.library
            try {
                const host = await import("/media/host.js");
                const found = await host.playSearch(String(resolve(action.play.search, bindings) ?? ""));
                setNotice(found ? null : "Nothing to play was found.", found ? "info" : "error");
                return found > 0;
            } catch (error) {
                setNotice(error.message, "error");
                return false;
            }
        }
        if (action.pick) {
            // 1.2: the person chooses through the media picker, from whichever Satellite the
            // catalog says provides the capability; the route then gets the references as $value
            const provider = findProvider(state.catalog && state.catalog.capabilities, action.pick.capability);
            if (!provider) {
                setNotice(`No enabled Satellite provides ${action.pick.capability}, so there is nothing to choose from.`, "error");
                return false;
            }
            const picked = await pickMedia({
                provider,
                capability: action.pick.capability,
                kinds: action.pick.kinds,
                multiple: action.pick.multiple === true,
                title: action.pick.title !== undefined ? text(action.pick.title, scope) : "",
            });
            if (!picked) {
                return false;  // cancelled: nothing runs
            }
            bindings.value = picked;
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
            if (!quiet) {
                setNotice(error.message, "error");
                loadData({ background: true });  // show what's actually true now
            }
            return false;
        }
        if (!quiet) {
            setNotice(result && typeof result.message === "string" ? result.message : null);
        }
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

    /** The secure action (1.2) on `items` - one request and one prompt for all of them. True once
     * something was done. A partial result is reported as partial, never as done. */
    async function runSecureAction(action, items, scope) {
        const provider = secureProvider(action, state.catalog && state.catalog.capabilities, satelliteName);
        if (!provider) {
            setNotice("That isn't available on this server.", "error");
            return false;
        }
        const first = { ...scope, data: items[0], value: items.length };
        if (action.confirm && !window.confirm(String(resolve(action.confirm, first)))) {
            return false;
        }
        const base = `/api/satellites/${encodeURIComponent(provider.satellite)}`;
        const ids = items.map((item) => resolve(action.item, { ...scope, data: item }));
        const result = await runSecure({
            action, ids, satellite: satelliteName, provider, prompt: promptPin,
            request: (route, body) => requestJson(`${base}/${route}`, body === undefined ? {} : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
        });
        if (result.outcome === "cancelled") {
            return false;
        }
        setNotice(result.text, result.outcome === "done" ? "info" : "error");
        if (result.moved.length) {
            if (action.then === "back") {
                goBack();
            } else {
                loadData({ background: false });  // what left the page is gone from it
            }
        }
        return result.moved.length > 0;
    }

    // ---------- blocks ----------

    function scopeFor(data) {
        return { data, page: state.data, params: state.params, state: state.pageState, sources: state.sources,
            form: undefined };
    }

    function text(value, scope) {
        const resolved = resolve(value, scope);
        return resolved === null || resolved === undefined ? "" : String(resolved);
    }

    // consecutive fields form one group, which a wide card lays out as a grid of facts
    function renderBlocks(blocks, scope, container) {
        let fields = null;
        for (const block of blocks || []) {
            const node = renderBlock(block, scope);
            if (!node) {
                continue;
            }
            if (block.type === "field") {
                if (!fields) {
                    fields = el("div", "ui-fields");
                    container.appendChild(fields);
                }
                fields.appendChild(node);
            } else {
                fields = null;
                container.appendChild(node);
            }
        }
    }

    /** A page's own blocks: on a dashboard, runs of tiles, charts and plain
     * cards sit side by side where the page is wide enough. */
    function renderPageBlocks(blocks, scope, container, template) {
        if (template !== "dashboard") {
            renderBlocks(blocks, scope, container);
            return;
        }
        let group = null;
        let holder = null;
        for (const block of blocks || []) {
            const node = renderBlock(block, scope);
            if (!node) {
                continue;
            }
            const kind = block && typeof block === "object" ? groupOf(block, node) : null;
            if (!kind) {
                group = null;
                container.appendChild(node);
                continue;
            }
            if (kind !== group) {
                group = kind;
                holder = el("div", `ui-${kind}`);
                container.appendChild(holder);
            }
            holder.appendChild(node);
        }
        // a chart or card on its own takes the whole width
        for (const lone of container.querySelectorAll(":scope > .ui-charts, :scope > .ui-columns")) {
            if (lone.children.length === 1) {
                lone.replaceWith(lone.firstElementChild);
            }
        }
    }

    // ---------- media (1.2) ----------

    // An image from one of the Satellite's own routes: loaded with this session, lazily, with a
    // quiet placeholder while it loads and the image glyph if it can't be.
    function mediaFrame(template, scope, className, alt) {
        const frame = el("div", `${className} ui-media-frame is-loading`);
        const route = template === undefined ? null : resolveTemplate(template, scope);
        const failed = () => {
            frame.classList.remove("is-loading");
            frame.classList.add("is-empty");
            frame.replaceChildren(icon("image") || el("span"));
        };
        if (!route || !isSafeRoute(route)) {
            failed();
            return frame;
        }
        const image = el("img");
        image.loading = "lazy";
        image.decoding = "async";
        image.alt = alt || "";
        image.addEventListener("load", () => frame.classList.remove("is-loading"), { once: true });
        image.addEventListener("error", failed, { once: true });
        image.src = `${satelliteBase}/${route}`;
        frame.appendChild(image);
        return frame;
    }

    function renderBlock(block, scope) {
        if (!block || typeof block !== "object") {
            return null;
        }
        if (block.developer && !developer.enabled) {
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

        text: (block, scope) => (block.style === "eyebrow"
            ? el("p", "eyebrow ui-eyebrow", text(block.text, scope))
            : el("p", `ui-text ui-text-${block.style || "body"}`, text(block.text, scope))),

        field: (block, scope) => {
            const row = el("div", "ui-field");
            row.appendChild(el("span", "ui-field-label", text(block.label, scope)));
            const value = el("span", `ui-field-value ui-tone-${toneOf(resolve(block.tone, scope))}`,
                formatValue(resolve(block.value, scope), block.format, block.unit));
            const detail = block.detail !== undefined ? text(block.detail, scope) : "";
            if (detail) {
                value.appendChild(el("small", "ui-field-detail", detail));
            }
            row.appendChild(value);
            return row;
        },

        metric: (block, scope) => renderMetric(block, scope),

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
                if (block.item.tone !== undefined) {
                    row.appendChild(stateDot(resolve(block.item.tone, itemScope)));
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
                    const subtitle = resolve(block.item.subtitle, itemScope);
                    if (subtitle !== null && subtitle !== undefined && subtitle !== "") {
                        main.appendChild(el("span", "ui-list-subtitle", formatValue(subtitle, formats.subtitle)));
                    }
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

        image: (block, scope) => {
            const figure = el("figure", `ui-image ui-image-${block.size || "medium"} ui-shape-${block.shape || "square"} ui-fit-${block.fit || "cover"}`);
            figure.appendChild(mediaFrame(block.src, scope, "ui-image-frame", block.alt !== undefined ? text(block.alt, scope) : ""));
            if (block.caption !== undefined) {
                const caption = text(block.caption, scope);
                if (caption) {
                    figure.appendChild(el("figcaption", "ui-image-caption", caption));
                }
            }
            return figure;
        },

        "media-grid": (block, scope) => gallery.render(block, scope),

        map: (block, scope) => maps.render(block, scope),

        // A search field: it sets the page state `key` a moment after the person stops
        // typing, and routes templated with $state.<key> load the results, as for a choice.
        search: (block, scope) => {
            let entry = searchInputs.get(block);
            if (!entry) {
                const wrapper = el("label", "ui-search");
                const glyph = icon("search", 18);
                if (glyph) {
                    wrapper.appendChild(glyph);
                }
                const input = el("input", "ui-search-input");
                input.type = "search";
                input.autocomplete = "off";
                input.spellcheck = false;
                input.value = state.pageState[block.key] ?? "";
                let timer = null;
                input.addEventListener("input", () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => setPageState(block.key, input.value.trim()), SEARCH_PAUSE);
                });
                input.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") {
                        clearTimeout(timer);
                        setPageState(block.key, input.value.trim());
                    }
                });
                wrapper.appendChild(input);
                entry = { wrapper, input };
                searchInputs.set(block, entry);
            }
            const label = block.label !== undefined ? text(block.label, scope) : "";
            entry.input.placeholder = block.placeholder !== undefined ? text(block.placeholder, scope) : (label || "Search");
            entry.input.setAttribute("aria-label", label || entry.input.placeholder);
            return entry.wrapper;
        },

        "media-list": (block, scope) => {
            const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
            const list = el("div", `ui-list ui-media-list ui-media-${block.size || "small"} ui-shape-${block.shape || "square"}`);
            if (!Array.isArray(items) || items.length === 0) {
                list.appendChild(el("p", "ui-text ui-text-caption", block.empty ? text(block.empty, scope) : "Nothing here."));
                return list;
            }
            const formats = (block.item && block.item.format) || {};
            for (const item of items) {
                const itemScope = { ...scope, data: item };
                const row = el(block.action ? "button" : "div", "ui-list-row ui-media-row");
                if (block.action) {
                    row.type = "button";
                    row.addEventListener("click", () => runAction(block.action, itemScope));
                }
                if (block.item.image !== undefined) {
                    row.appendChild(mediaFrame(block.item.image, itemScope, "ui-media-thumb", ""));
                }
                const main = el("span", "ui-list-main");
                main.appendChild(el("span", "ui-list-title", text(block.item.title, itemScope)));
                if (block.item.subtitle !== undefined) {
                    const subtitle = resolve(block.item.subtitle, itemScope);
                    if (subtitle !== null && subtitle !== undefined && subtitle !== "") {
                        main.appendChild(el("span", "ui-list-subtitle", formatValue(subtitle, formats.subtitle)));
                    }
                }
                row.appendChild(main);
                if (block.item.meta !== undefined) {
                    const meta = resolve(block.item.meta, itemScope);
                    if (meta !== null && meta !== undefined && meta !== "") {
                        row.appendChild(el("span", "ui-list-value", formatValue(meta, formats.meta)));
                    }
                }
                if (block.action) {
                    row.appendChild(el("span", "ui-list-chevron", "›"));
                }
                list.appendChild(row);
            }
            return list;
        },

        button: (block, scope) => {
            if (block.action && block.action.own !== undefined && !own) {
                return null;  // opens an own page this Satellite doesn't have here
            }
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

        chart: (block, scope) => (block.kind === "bars" ? renderBars(block, scope) : renderChart(block, scope)),

        table: (block, scope) => renderTable(block, scope),

        choice: (block, scope) => {
            const wrapper = el("div", "ui-choice");
            const group = el("div", "ui-segmented");
            group.setAttribute("role", "radiogroup");
            const label = block.label !== undefined ? text(block.label, scope) : "";
            if (label) {
                group.setAttribute("aria-label", label);
            }
            const current = state.pageState[block.key];
            for (const option of block.options || []) {
                const selected = option.value === current;
                const button = el("button", `ui-segment${selected ? " active" : ""}`, text(option.label, scope));
                button.type = "button";
                button.setAttribute("role", "radio");
                button.setAttribute("aria-checked", String(selected));
                button.tabIndex = selected ? 0 : -1;
                button.addEventListener("click", () => setPageState(block.key, option.value));
                button.addEventListener("keydown", (event) => {
                    const options = block.options || [];
                    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                    if (move) {
                        event.preventDefault();
                        const index = options.findIndex((entry) => entry.value === current);
                        const next = options[(index + move + options.length) % options.length];
                        setPageState(block.key, next.value);
                        requestAnimationFrame(() => {
                            const focused = root.querySelector(".ui-segment.active");
                            if (focused) {
                                focused.focus();
                            }
                        });
                    }
                });
                group.appendChild(button);
            }
            wrapper.appendChild(group);
            return wrapper;
        },

        status: (block, scope) => {
            const tone = toneOf(resolve(block.tone, scope));
            const pill = el("div", `ui-status ui-status-${tone}`);
            pill.append(stateDot(tone), el("span", null, text(block.label, scope)));
            const detail = block.detail !== undefined ? text(block.detail, scope) : "";
            if (detail) {
                pill.appendChild(el("small", null, detail));
            }
            return pill;
        },

        code: (block, scope) => {
            const value = resolve(block.value, scope);
            const content = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
            const box = el("details", "ui-code");
            box.appendChild(el("summary", null, block.label !== undefined ? text(block.label, scope) : "Details"));
            box.appendChild(el("pre", null, content));
            if (block.copy) {
                const copy = el("button", "sc-button ui-button", "Copy");
                copy.type = "button";
                copy.addEventListener("click", async () => {
                    try {
                        await navigator.clipboard.writeText(content);
                        copy.textContent = "Copied";
                    } catch {
                        copy.textContent = "Select the text to copy it";
                    }
                    setTimeout(() => {
                        copy.textContent = "Copy";
                    }, 2000);
                });
                box.appendChild(copy);
            }
            return box;
        },
    };

    function renderMetric(block, scope) {
        const value = resolve(block.value, scope);
        const tone = toneOf(resolve(block.tone, scope));
        const max = resolve(block.max, scope);
        const label = text(block.label, scope);
        const formatted = formatValue(value, block.format, block.unit);
        const detail = block.detail !== undefined ? text(block.detail, scope) : "";
        const tile = el(block.action ? "button" : "div", `ui-metric ui-tone-${tone}`);
        if (block.action) {
            tile.type = "button";
            tile.addEventListener("click", () => runAction(block.action, scope));
        }
        tile.appendChild(el("span", "ui-metric-label", label));
        tile.appendChild(el("span", "ui-metric-value", formatted));
        if (detail) {
            tile.appendChild(el("span", "ui-metric-detail", detail));
        }
        if (typeof max === "number" && max > 0 && typeof value === "number") {
            tile.appendChild(toneMeter(value, max, tone, label));
        }
        if (block.trend !== undefined) {
            const points = resolve(block.trend, scope);
            if (Array.isArray(points)) {
                tile.appendChild(sparkline(points.map(pointValue)));
            }
        }
        tile.setAttribute("aria-label", `${label}: ${formatted}${detail ? `, ${detail}` : ""}`);
        return tile;
    }

    function chartModel(block, scope) {
        const series = (block.series || []).map((line, index) => {
            const points = resolve(line.points, scope);
            return {
                key: `s${index}`,
                label: line.label !== undefined ? text(line.label, scope) : "",
                points: Array.isArray(points) ? points.filter((point) => Array.isArray(point) && typeof point[1] === "number") : [],
            };
        });
        const times = series.flatMap((line) => line.points.map((point) => point[0]));
        const now = Date.now() / 1000;
        const to = Number(resolve(block.to, scope)) || (times.length ? Math.max(...times) : now);
        const from = Number(resolve(block.from, scope)) || (times.length ? Math.min(...times) : to - 3600);
        const span = Math.max(1, to - from);
        const resolution = Number(resolve(block.resolution, scope)) || Math.max(1, span / Math.max(1, times.length));
        const max = resolve(block.max, scope);
        const format = (value) => formatValue(value, block.format, block.unit);
        const scale = chartScale(block.format);
        const empty = block.empty !== undefined ? text(block.empty, scope) : "";
        return {
            title: block.title !== undefined ? text(block.title, scope) : "",
            from,
            to,
            resolution,
            scale,
            max: typeof max === "number" && max > 0 ? max : null,
            format,
            tickFormat: scale === "percent" ? (value) => `${Math.round(value)}%` : format,
            tick: (time) => formatValue(time, span <= 2 * 86400 ? "time" : "date"),
            moment: (time) => formatValue(time, span <= 86400 ? "time" : "datetime"),
            empty: empty || "Nothing recorded yet",
            series,
        };
    }

    function renderChart(block, scope) {
        const model = chartModel(block, scope);
        let chart = state.charts.get(block);
        if (!chart) {
            chart = createChart({ label: model.title || "Chart" });
            state.charts.set(block, chart);
        }
        const panel = el("div", "ui-chart");
        panel.appendChild(chart.element);
        // drawn once it is in the document, so it knows its width
        requestAnimationFrame(() => chart.render(model));
        chart.render(model);
        panel.appendChild(chartValues(block, model));
        return panel;
    }

    /** Every value behind a chart, as a table - the chart's accessible twin. */
    function chartValues(block, model) {
        const box = el("div", "ui-chart-values");
        const toggle = el("button", "ui-chart-toggle", state.openTables.has(block) ? "Hide values" : "Show values");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(state.openTables.has(block)));
        toggle.addEventListener("click", () => {
            if (state.openTables.has(block)) {
                state.openTables.delete(block);
            } else {
                state.openTables.add(block);
            }
            render();
        });
        box.appendChild(toggle);
        if (!state.openTables.has(block)) {
            return box;
        }
        const times = new Map();
        model.series.forEach((line, index) => {
            for (const [time, value, peak] of line.points) {
                if (!times.has(time)) {
                    times.set(time, { time });
                }
                times.get(time)[`s${index}`] = typeof peak === "number" && peak > value
                    ? `${model.format(value)} (peak ${model.format(peak)})` : model.format(value);
            }
        });
        const rows = [...times.values()].sort((a, b) => b.time - a.time)
            .map((row) => ({ ...row, time: model.moment(row.time) }));
        const columns = [{ key: "time", label: "Time" },
            ...model.series.map((line, index) => ({ key: `s${index}`, label: line.label || "Value", end: true }))];
        box.appendChild(tableOf(columns, rows, model.empty, true));
        return box;
    }

    function renderBars(block, scope) {
        const series = (block.series || [])[0] || {};
        const points = resolve(series.points, scope);
        const values = Array.isArray(points) ? points.map(pointValue).filter((value) => typeof value === "number") : [];
        const max = Number(resolve(block.max, scope)) || Math.max(1, ...values);
        const label = series.label !== undefined ? text(series.label, scope) : "";
        const figure = el("figure", "ui-bars-figure");
        if (block.title !== undefined) {
            figure.appendChild(el("figcaption", "eyebrow ui-eyebrow", text(block.title, scope)));
        }
        const bars = el("div", "ui-bars");
        bars.setAttribute("role", "img");
        bars.setAttribute("aria-label", `${text(block.title, scope) || label}: ${values.map((value) => formatValue(value, block.format, block.unit)).join(", ")}`);
        values.forEach((value, index) => {
            const column = el("div", "ui-bar");
            column.title = `${label ? `${label} ` : ""}${index + 1}: ${formatValue(value, block.format, block.unit)}`;
            const fill = el("span", "ui-bar-fill");
            fill.style.height = `${Math.max(2, Math.min(100, (value / max) * 100))}%`;
            column.appendChild(fill);
            bars.appendChild(column);
        });
        figure.appendChild(bars);
        return figure;
    }

    function renderTable(block, scope) {
        const rows = Array.isArray(block.rows) ? block.rows : resolve(block.rows, scope);
        const empty = block.empty !== undefined ? text(block.empty, scope) : "Nothing to show.";
        const columns = (block.columns || []).map((column, index) => ({ ...column, key: `c${index}`, end: column.align === "end" }));
        const shaped = (Array.isArray(rows) ? rows : []).map((row) => {
            const rowScope = { ...scope, data: row };
            const cells = {};
            for (const column of columns) {
                const value = resolve(column.value, rowScope);
                const shown = formatValue(value, column.format, column.unit === undefined ? undefined : text(column.unit, rowScope));
                const max = resolve(column.max, rowScope);
                if (column.tone !== undefined && column.max === undefined) {
                    const cell = el("span", "ui-cell-state");
                    cell.append(stateDot(resolve(column.tone, rowScope)), el("span", null, shown));
                    cells[column.key] = cell;
                } else if (typeof max === "number" && typeof value === "number") {
                    const cell = el("span", "ui-cell-usage");
                    cell.append(toneMeter(value, max, resolve(column.tone, rowScope), `${text(column.label, rowScope)}`),
                        el("span", null, shown));
                    cells[column.key] = cell;
                } else {
                    cells[column.key] = shown;
                }
            }
            return cells;
        });
        return tableOf(columns.map((column) => ({ key: column.key, label: column.label, end: column.end })), shaped, empty);
    }

    function tableOf(columns, rows, emptyText, scroll = false) {
        if (!rows.length) {
            return el("p", "ui-text ui-text-caption", emptyText || "Nothing to show.");
        }
        const wrapper = el("div", `ui-table-wrap${scroll ? " ui-table-scroll" : ""}`);
        const grid = el("table", "ui-table");
        const head = el("tr");
        for (const column of columns) {
            const cell = el("th", column.end ? "ui-end" : null, column.label);
            cell.scope = "col";
            head.appendChild(cell);
        }
        grid.appendChild(el("thead")).appendChild(head);
        const body = el("tbody");
        for (const row of rows) {
            const line = el("tr");
            for (const column of columns) {
                const value = row[column.key];
                const cell = el("td", column.end ? "ui-end" : null);
                if (value instanceof Node) {
                    cell.appendChild(value);
                } else {
                    cell.textContent = value === null || value === undefined ? "—" : String(value);
                }
                line.appendChild(cell);
            }
            body.appendChild(line);
        }
        grid.appendChild(body);
        wrapper.appendChild(grid);
        return wrapper;
    }

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

    function renderHeader() {
        const header = state.document.header;
        if (!header || !state.header) {
            return null;
        }
        const scope = { data: state.header, page: state.header, params: {}, state: {}, sources: {} };
        const band = el("header", "ui-header");
        const main = el("div", "ui-header-main");
        const side = el("div", "ui-header-side");
        for (const block of header.blocks || []) {
            const node = renderBlock(block, scope);
            if (node) {
                (block.type === "status" ? side : main).appendChild(node);
            }
        }
        band.append(main, side);
        return band;
    }

    function renderNavigation() {
        const items = navigationItems();
        if (items.length < 2) {
            return null;
        }
        const nav = el("nav", "ui-tabs");
        nav.setAttribute("aria-label", `${state.document.title || satelliteName} pages`);
        const current = items.some((item) => item.page === state.page) ? state.page : null;
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

    function renderSkeleton(template) {
        const grid = el("div", template === "dashboard" ? "ui-tiles" : "ui-page");
        for (let index = 0; index < (template === "dashboard" ? 6 : 3); index += 1) {
            grid.appendChild(el("div", "ui-skeleton"));
        }
        return grid;
    }

    function renderFailure() {
        const box = el("section", "ui-card ui-failure");
        box.appendChild(el("p", "eyebrow", `${state.document.title || satelliteName} is unavailable`));
        box.appendChild(el("p", "ui-text ui-text-caption", state.dataError));
        const retry = el("button", "sc-button ui-button", "Try again");
        retry.type = "button";
        retry.addEventListener("click", () => {
            state.dataError = null;
            render();
            loadData();
        });
        box.appendChild(retry);
        return box;
    }

    function render() {
        if (state.disposed || !state.document || !state.page) {
            return;
        }
        const page = pageDefinition();
        const scope = scopeFor(state.data || {});
        const template = page.template || "stack";
        // a field kept across renders (a search) keeps its focus and caret through a redraw
        const active = document.activeElement;
        const keep = active && root.contains(active) && active.classList.contains("ui-search-input")
            ? { node: active, start: active.selectionStart, end: active.selectionEnd } : null;
        root.replaceChildren();
        // a dashboard, and a page of photos or a map, use the page's width
        const collection = template !== "dashboard" && holdsCollection(page);
        root.classList.toggle("ui-wide", template === "dashboard" || collection);
        root.classList.toggle("ui-collection", collection);

        const isTopLevel = navigationItems().some((item) => item.page === state.page)
            || state.page === state.document.entry;
        if (isTopLevel) {
            const header = renderHeader();
            if (header) {
                root.appendChild(header);
            }
            const nav = renderNavigation();
            if (nav) {
                root.appendChild(nav);
            }
        } else {
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

        if (state.dataError && state.data) {
            // readings that are no longer current stay visible, dimmed, under the notice
            const seconds = Math.max(1, Math.round((Date.now() - state.lastGood) / 1000));
            const reason = state.dataUnreachable
                ? `StarCore is not answering (${state.dataError}).`
                : `This page could not be refreshed (${state.dataError}).`;
            const notice = el("p", "ui-stale", `${reason} Showing what StarCore said ${formatValue(seconds, "duration")} ago.`);
            notice.setAttribute("role", "status");
            root.appendChild(notice);
        } else if (state.dataError) {
            root.appendChild(renderFailure());
            return;
        }
        if (!state.data) {
            root.appendChild(renderSkeleton(template));
            return;
        }
        const body = el("div", `ui-page${state.dataError ? " ui-page-stale" : ""}`);
        renderPageBlocks(page.blocks, scope, body, template);
        root.appendChild(body);
        markLoading();
        gallery.afterRender();
        if (keep && root.contains(keep.node)) {
            keep.node.focus({ preventScroll: true });
            try {
                keep.node.setSelectionRange(keep.start, keep.end);
            } catch {
                // not every input type has a caret to restore
            }
        }
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
            loadHeader();
            showSection(context.section);
        } catch (error) {
            if (!state.disposed) {
                fail(`The ${satelliteName} interface could not be loaded: ${error.message}`);
            }
        }
    }

    // a developer-only page disappears with Developer Mode: never leave it open
    const unsubscribe = developer.subscribe(() => {
        if (state.document && state.page && !isAvailable(state.page)) {
            navigate(state.document.entry);
            return;
        }
        render();
    });
    document.addEventListener("visibilitychange", onVisibility);
    start();

    const cleanup = () => {
        state.disposed = true;
        state.timers.forEach((timer) => clearTimeout(timer));
        clearTimeout(state.noticeTimer);
        state.charts.forEach((chart) => chart.destroy());
        document.removeEventListener("visibilitychange", onVisibility);
        unsubscribe();
        root.remove();
        noticeSlot.remove();
        gallery.dispose();
        maps.reset();
    };
    cleanup.showSection = showSection;
    cleanup.revision = () => state.revision;
    return cleanup;
}

/**
 * One widget from a document's `widgets` (UI contract 1.1), for Home: a
 * compact card of the blocks a summary needs - status, metrics, fields,
 * text and lists - drawn from `data` (the Satellite's published state, or
 * the widget's own source). It opens the Satellite, and never acts on it.
 */
export function renderWidget(widget, data, { developer = false, title, onOpen } = {}) {
    loadStylesheet();
    const scope = { data, page: data, params: {}, state: {}, sources: {} };
    const words = (value) => {
        const resolved = resolve(value, scope);
        return resolved === null || resolved === undefined ? "" : String(resolved);
    };
    const card = el("article", "ui-widget");
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    const head = el("div", "ui-widget-head");
    const glyph = icon(widget.icon, 16);
    if (glyph) {
        head.appendChild(glyph);
    }
    const name = widget.title !== undefined ? words(widget.title) : title || "";
    head.appendChild(el("h2", "sc-eyebrow ui-widget-title", name));
    head.appendChild(el("span", "ui-widget-open", "Open"));
    card.appendChild(head);
    card.setAttribute("aria-label", `${name}: open`);

    const body = el("div", "ui-widget-body");
    let metrics = null;
    for (const block of widget.blocks || []) {
        if (!block || typeof block !== "object" || (block.developer && !developer)
            || ("visible" in block && !isVisible(resolve(block.visible, scope)))) {
            continue;
        }
        if (block.type !== "metric") {
            metrics = null;
        }
        if (block.type === "status") {
            const tone = toneOf(resolve(block.tone, scope));
            const state = el("p", "ui-widget-state");
            state.append(stateDot(tone), el("span", null, words(block.label)));
            const detail = block.detail !== undefined ? words(block.detail) : "";
            if (detail) {
                state.appendChild(el("small", null, detail));
            }
            body.appendChild(state);
        } else if (block.type === "metric") {
            if (!metrics) {
                metrics = el("dl", "ui-widget-metrics");
                body.appendChild(metrics);
            }
            const value = resolve(block.value, scope);
            const max = resolve(block.max, scope);
            const tone = toneOf(resolve(block.tone, scope));
            const item = el("div");
            item.append(el("dt", null, words(block.label)), el("dd", `ui-tone-${tone}`, formatValue(value, block.format, block.unit)));
            if (typeof max === "number" && max > 0 && typeof value === "number") {
                item.appendChild(toneMeter(value, max, tone, words(block.label)));
            } else if (block.detail !== undefined) {
                item.appendChild(el("span", "ui-widget-note", words(block.detail)));
            }
            metrics.appendChild(item);
        } else if (block.type === "list") {
            const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
            const list = el("ul", "ui-widget-list");
            for (const entry of Array.isArray(items) ? items.slice(0, 3) : []) {
                const itemScope = { ...scope, data: entry };
                const row = el("li");
                if (block.item && block.item.tone !== undefined) {
                    row.appendChild(stateDot(resolve(block.item.tone, itemScope)));
                }
                const text = resolve(block.item && block.item.title, itemScope);
                row.appendChild(el("span", null, text === null || text === undefined ? "" : String(text)));
                list.appendChild(row);
            }
            if (list.children.length) {
                body.appendChild(list);
            }
        } else if (block.type === "field") {
            const row = el("p", "ui-widget-field");
            row.append(el("span", null, words(block.label)),
                el("strong", null, formatValue(resolve(block.value, scope), block.format, block.unit)));
            body.appendChild(row);
        } else if (block.type === "text" || block.type === "heading") {
            body.appendChild(el("p", "ui-text ui-text-caption", words(block.text)));
        }
        // anything else belongs on the Satellite's own pages, not in a summary
    }
    card.appendChild(body);
    const open = () => onOpen && onOpen(widget.action && widget.action.navigate
        ? sectionFor(widget.action.navigate, resolve(widget.action.params || {}, scope)) : null);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
        }
    });
    return card;
}
