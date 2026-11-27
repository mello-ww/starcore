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
    BLOCK_TYPES, canOpenSync, checkDocument, findProvider, formatValue, isSafeRoute, isVisible, servesBlock,
    locateProvider, missingRequirements, openedSection, openersFor, resolve, resolveTemplate, toneOf,
} from "./contract.js";
import { emptyRow, formBody, formProblem, formValues } from "./forms.js";
import { canShareFiles, downloadFile, fileName, openFile, shareFile } from "./files.js";
import { createGallery } from "./gallery.js";
import { slideSelection } from "./motion.js";
import { createListPaging } from "./listpaging.js";
import { icon } from "./icons.js";
import { createMaps } from "./map.js";
import { closeMenu, openMenu } from "./menu.js";
import { openChooser, runChoose } from "./choose.js";
import { pickMedia } from "./picker.js";
import { attachReorder, handleGlyph, moveItem } from "./reorder.js";
import { askSecrets, bodyWithSecrets, promptSecret, revealFrom, showRevealed } from "./secrets.js";
import { promptPin, runSecure, secureProvider } from "./secure.js";
import { chooseFiles, runUploads, sendFile, uploadReport } from "./upload.js";
import { createVaultGate, protectedProvider } from "./vault.js";
import { createEntries, groupOf as rowGroup, isPlayingRow, mergeItem, rowMenu, rowQuick } from "./rows.js";

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
    // the section action (1.2): another Satellite this one hosts (section_of), which the host
    // opens; null when the host can't, and the action's controls hide
    const sections = context.sections && typeof context.sections.open === "function" ? context.sections : null;
    // another Satellite's shared interface (1.2, change 16), where an opener or locate's answer
    // leads; null when the host can't open one, and the openers line and locate controls hide
    const satellites = context.satellites && typeof context.satellites.open === "function" ? context.satellites : null;
    // the hash of one of this interface's sections - beneath its host's when it is a hosted one
    const hashFor = typeof context.hash === "function" ? context.hash
        : (section) => `#/satellite/${encodeURIComponent(satelliteName)}/${section}`;
    // a protected document's gate (1.2, ui/vault.js), and the section to show once it is open
    let gate = null;
    let wanted = context.section;

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

    // the document's own icons (UI contract 1.2): what the Engine added to the document it served
    const ownIcons = () => (state.document && state.document.icons) || null;

    // the document's own routes. For a protected document a 403 means "locked again": its gate
    // asks the server, and nothing of the store stays on screen once it says so
    const call = (url, options) => requestJson(url, options).catch((error) => {
        if (gate && error && error.status === 403) {
            gate.check({ quiet: true });
        }
        throw error;
    });

    // the media-grid block and its viewer (1.2), which keep their own state across renders
    // whether an action's control is drawn here: a secure action only where it can run, an own
    // action only where this Satellite has an own interface, a section only where the host can
    // open it, a sync only where this client has that sync screen (never so far), never an
    // offline (a browser keeps no tracks), and share only where this browser can hand a file to
    // the system share sheet - never in a protected document, which shares nothing
    function canRun(action) {
        return !action || ((action.own === undefined || Boolean(own))
            && action.offline === undefined
            && (action.section === undefined || canOpenSection(action.section))
            && (action.locate === undefined || (Boolean(satellites) && !isProtected() && Boolean(locateProvider(capabilities()))))
            && (action.sync === undefined || canOpenSync(action))
            && (action.share === undefined || (!isProtected() && canShareFiles(globalThis.navigator)))
            && (!action.secure || Boolean(secureProvider(action, state.catalog && state.catalog.capabilities, satelliteName))));
    }

    function capabilities() {
        return (state.catalog && state.catalog.capabilities) || null;
    }

    // change 16: run a provider's operation on a path, then open the page it answers in that
    // provider's shared interface - never a page the answer doesn't name properly
    async function openProvided(provider, route, path, method) {
        const base = `/api/satellites/${encodeURIComponent(provider.satellite)}/${route}`;
        let answer;
        try {
            answer = method === "GET"
                ? await requestJson(`${base}?${new URLSearchParams({ path })}`)
                : await requestJson(base, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path }),
                });
        } catch (error) {
            setNotice(error.status === 404 ? "That file can't be opened there." : error.message, "error");
            return false;
        }
        const section = openedSection(answer);
        if (!section || !satellites || !satellites.open(provider.satellite, section)) {
            setNotice("That isn't available in Mission Control.", "error");
            return false;
        }
        return true;
    }

    function isProtected() {
        return Boolean(state.document && state.document.protected);
    }

    // a name the document gives (not one bound to its data) is known now
    function canOpenSection(name) {
        if (!sections) {
            return false;
        }
        return typeof name !== "string" || name.startsWith("$") || typeof sections.has !== "function" || sections.has(name);
    }

    const gallery = createGallery({
        satelliteBase,
        // the document's own icons (UI contract 1.2), which its names may be one of
        icons: () => ownIcons(),
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
        load: (route) => call(`${satelliteBase}/${route}`),
        runAction: (...args) => runAction(...args),
        // a tile's menu (1.2 `menu`), beside the tile or where it was right-clicked
        openMenu: (block, item, scope, at) => showRowMenu(block, item, scope, null, at),
        // the secure action (1.2): once for a whole selection, and hidden where it can't run
        runSecure: (action, items, scope, imagesOf) => runSecureAction(action, items, scope, imagesOf),
        canRun: (action) => canRun(action),
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

    // a list's further pages (1.2 `more`), kept across renders; `listViews` is each paged list
    // as last drawn, where a page that arrives is appended
    const listPaging = createListPaging({ load: (route) => call(`${satelliteBase}/${route}`) });
    let listViews = new WeakMap();
    const listObservers = new Set();

    // what each history entry of this interface left behind (its data, its lists' pages, its
    // scroll position), so Back draws it again as it was - never for a protected document
    const entries = createEntries();
    const ENTRY = "starcore.uiEntry";
    let entryId = null;

    function historyEntry() {
        const held = history.state && history.state[ENTRY];
        if (typeof held === "string" && held) {
            return held;
        }
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        try {
            history.replaceState({ ...(history.state || {}), [ENTRY]: id }, "", location.href);
        } catch {
            // without history state this entry starts afresh when it is come back to
        }
        return id;
    }

    function scroller() {
        for (let parent = root.parentElement; parent; parent = parent.parentElement) {
            const overflow = getComputedStyle(parent).overflowY;
            if (overflow === "auto" || overflow === "scroll") {
                return parent;
            }
        }
        return document.scrollingElement || document.documentElement;
    }

    function leaveEntry() {
        if (!entryId || !state.page || !state.data || state.dataError || isProtected()) {
            return;
        }
        entries.save(entryId, {
            page: state.page,
            params: state.params,
            pageState: state.pageState,
            data: state.data,
            sources: state.sources,
            lists: listPaging.snapshot(),
            scroll: scroller().scrollTop,
        });
    }

    // the track playing now, when it is one of this Satellite's (`item.audio`, 1.2): its rows
    // are marked as the host moves on
    const playing = { id: null, off: null };

    function watchPlaying() {
        if (playing.off) {
            return;
        }
        playing.off = () => {};
        import("/media/host.js").then((host) => {
            if (state.disposed || typeof host.nowPlaying !== "function") {
                return;
            }
            playing.off = host.nowPlaying(satelliteName, (id) => {
                playing.id = id;
                for (const row of root.querySelectorAll(".ui-media-row[data-audio]")) {
                    const now = row.dataset.audio === id;
                    row.classList.toggle("is-playing", now);
                    const title = row.querySelector(".ui-list-title");
                    if (title) {
                        title.toggleAttribute("aria-current", now);
                    }
                }
            });
        }).catch(() => {});
    }

    // reloads and follows (1.2): what the client keeps from one of this Satellite's
    // capabilities - only the audio host's preferences and likes (audio.session) so far
    const RELOADERS = {
        "audio.session": () => import("/media/session.js").then((session) => session.reload()),
    };
    const followed = { off: null };

    function reloadKept(capability) {
        const reload = RELOADERS[capability];
        if (reload) {
            reload().catch(() => {});
        }
    }

    // a page that follows a capability loads again when the client changes that state itself
    // (a like in the player): its source and named sources, in the background
    function watchFollowed() {
        if (followed.off) {
            return;
        }
        followed.off = () => {};
        import("/media/session.js").then((session) => {
            if (state.disposed || typeof session.on !== "function") {
                return;
            }
            followed.off = session.on("changed", (capability) => {
                const page = state.document && state.page ? pageDefinition() : null;
                if (state.disposed || !page || !Array.isArray(page.follows) || !page.follows.includes(capability)) {
                    return;
                }
                loadData({ background: true });
                for (const name of Object.keys(page.sources || {})) {
                    loadNamed(name);
                }
            });
        }).catch(() => {});
    }

    function resetLists() {
        listPaging.reset();
        listViews = new WeakMap();
        for (const entry of listObservers) {
            entry.observer.disconnect();
        }
        listObservers.clear();
    }

    // the map block (1.2): its Leaflet map lives across renders, and its markers open the
    // gallery's shared viewer
    const maps = createMaps({
        satelliteBase, runAction: (...args) => runAction(...args), gallery,
        load: (route) => call(`${satelliteBase}/${route}`),
    });
    // the search block (1.2): one input per block, kept across renders so typing is never lost
    let searchInputs = new WeakMap();
    const SEARCH_PAUSE = 300;

    // ---------- lists ----------

    function listRow(block, item, scope) {
        const formats = (block.item && block.item.format) || {};
        const itemScope = { ...scope, data: item };
        const row = el(block.action ? "button" : "div", "ui-list-row");
        if (block.action) {
            row.type = "button";
            row.addEventListener("click", () => runAction(block.action, itemScope));
        }
        if (block.item.tone !== undefined) {
            row.appendChild(stateDot(resolve(block.item.tone, itemScope)));
        }
        const glyph = icon(resolve(block.item.icon, itemScope), 18, ownIcons());
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
        return row;
    }

    /** A list with `more` (1.2): its rows, then a footer that loads the next page - by itself as
     * it comes near the screen, or with "Show more" - says "Loading…", or offers "Try again". */
    function pagedList(block, scope, list, append) {
        const wrapper = el("div", "ui-list-paged");
        const sentinel = el("div", "ui-list-more");
        sentinel.setAttribute("aria-hidden", "true");
        const footer = el("div", "ui-list-footer");
        wrapper.append(list, sentinel, footer);
        const view = { list, wrapper, footer, sentinel, scope, append };
        listViews.set(block, view);

        const near = () => typeof window !== "undefined" && view.wrapper.isConnected
            && view.sentinel.getBoundingClientRect().top < window.innerHeight + 800;
        const draw = () => {
            const status = listPaging.status(block);
            footer.replaceChildren();
            if (status.error) {
                footer.appendChild(el("p", "ui-text ui-text-caption", status.error));
                const retry = el("button", "ui-pill", "Try again");
                retry.type = "button";
                retry.addEventListener("click", () => next());
                footer.appendChild(retry);
            } else if (status.loading) {
                const note = el("p", "ui-text ui-text-caption", "Loading…");
                note.setAttribute("role", "status");
                footer.appendChild(note);
            } else if (status.more) {
                const button = el("button", "ui-pill", "Show more");
                button.type = "button";
                button.addEventListener("click", () => next());
                footer.appendChild(button);
            }
            footer.hidden = footer.childElementCount === 0;
        };
        view.draw = draw;
        // the rows of a page go into the list as it is drawn when the page arrives
        const next = () => {
            const pending = listPaging.loadMore(block).then((added) => {
                const current = listViews.get(block);
                if (!current || !current.wrapper.isConnected) {
                    return;
                }
                for (const item of added) {
                    current.append(current.list, item, current.scope);
                }
                current.draw();
                const status = listPaging.status(block);
                if (status.more && !status.error && (status.restoring || current.near())) {
                    current.next();
                } else if (current.rearm) {
                    // the browser may keep the end of the list in view as rows arrive (scroll
                    // anchoring), so the sentinel never "enters" again: watching it afresh
                    // reports where it is now
                    current.rearm();
                }
            });
            draw();
            return pending;
        };
        view.next = next;
        view.near = near;
        draw();

        if (typeof IntersectionObserver === "function") {
            const observer = new IntersectionObserver((entries) => {
                const status = listPaging.status(block);
                if (entries.some((entry) => entry.isIntersecting) && status.more && !status.loading && !status.error) {
                    next();
                }
            }, { rootMargin: "800px 0px" });
            observer.observe(sentinel);
            view.rearm = () => {
                observer.unobserve(sentinel);
                observer.observe(sentinel);
            };
            // one observer per list: the one of its previous drawing goes
            for (const previous of listObservers) {
                if (previous.block === block) {
                    previous.observer.disconnect();
                    listObservers.delete(previous);
                }
            }
            listObservers.add({ block, observer });
        }
        const status = listPaging.status(block);
        if (status.restoring && !status.loading) {
            next();
        }
        return wrapper;
    }

    // ---------- navigation ----------

    function navigationItems() {
        return (state.document.navigation || []).filter((item) => !item.developer || developer.enabled);
    }

    function navigate(page, params = {}) {
        location.hash = hashFor(sectionFor(page, params));
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

    // a protected document shows only what its gate allows: the setup page while it isn't set
    // up, its forgot page after "Forgot your PIN?", any page once it is open, and nothing
    // otherwise - the section waits for the unlock
    function showSection(section) {
        if (!state.document) {
            return;
        }
        if (gate) {
            wanted = section;
            const now = gate.state();
            if (now === "setup") {
                openPage(state.document.protected.setup);
            } else if (now === "forgot") {
                openPage(state.document.protected.forgot);
            } else if (now === "open") {
                openPage(section);
            }
            return;
        }
        openPage(section);
    }

    function openPage(section) {
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
            leaveEntry();
            closeMenu();
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
            resetLists();
            searchInputs = new WeakMap();
            for (const [name, timer] of state.timers) {
                if (name !== "header") {
                    clearTimeout(timer);
                    state.timers.delete(name);
                }
            }
            state.charts.forEach((chart) => chart.destroy());
            state.charts.clear();
            entryId = historyEntry();
            const kept = isProtected() ? null : entries.get(entryId);
            if (kept && kept.page === target && JSON.stringify(kept.params) === JSON.stringify(params)) {
                // Back (or Forward) to an entry left earlier: drawn at once as it was, where it
                // was, then refreshed in place
                state.pageState = kept.pageState;
                state.data = kept.data;
                state.sources = kept.sources;
                state.lastGood = Date.now();
                listPaging.restore(kept.lists);
                render();
                scroller().scrollTop = kept.scroll;
                loadData({ background: true });
                for (const name of Object.keys(pageDefinition().sources || {})) {
                    loadNamed(name);
                }
                return;
            }
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
        const data = await call(`${satelliteBase}/${route}`);
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
        if (!state.page) {
            return;  // a protected document that locked meanwhile
        }
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
        if (!state.page) {
            return;
        }
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
        if (gate) {
            gate.setHidden(document.hidden);
        }
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
        // a progress notice ("Uploading 2 of 5") stays until what follows replaces it
        if (text && kind !== "progress") {
            state.noticeTimer = setTimeout(() => setNotice(null), kind === "error" ? 8000 : 3500);
        }
    }

    /** Runs one action; true once its request (if any) succeeded. `quiet` (one item of a
     * selection) leaves notices and refreshing to the caller. */
    // an action that succeeded closes the open dropdown, wherever it ran from (1.2, change 11)
    async function runAction(action, scope, value, options) {
        const done = await runActionNow(action, scope, value, options);
        if (done) {
            closeDropdown();
        }
        return done;
    }

    async function runActionNow(action, scope, value, { quiet = false, update = null } = {}) {
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
        if (action.section !== undefined) {
            // 1.2: the interface of a Satellite this one hosts - nothing runs here
            const name = resolve(action.section, bindings);
            if (!sections || typeof name !== "string" || !name || !sections.open(name)) {
                setNotice("That isn't available in Mission Control.", "error");
                return false;
            }
            return true;
        }
        if (action.locate !== undefined) {
            // 1.2, change 16: the folder holding a path, in whichever Satellite browses files
            const path = resolve(action.locate, bindings);
            const provider = locateProvider(capabilities());
            if (!provider || isProtected() || typeof path !== "string" || !path) {
                setNotice("That isn't available in Mission Control.", "error");
                return false;
            }
            return openProvided(provider, provider.operations.locate, path, "GET");
        }
        if (action.offline !== undefined) {
            // 1.2: tracks kept on the device - a browser keeps none, so the control is hidden
            setNotice("That isn't available in Mission Control.", "error");
            return false;
        }
        if (action.sync !== undefined) {
            // 1.2: the client's own sync screen - a browser has none, so the control is hidden
            // (canRun) and this is only reached from a row or tile that drew it anyway
            setNotice("That isn't available in Mission Control.", "error");
            return false;
        }
        if (action.download !== undefined || action.share !== undefined) {
            // 1.2: a file from the Satellite's own route, with this session: saved, opened in a
            // new tab (`open`), or handed to the system share sheet
            const sharing = action.share !== undefined;
            const route = resolveTemplate(sharing ? action.share : action.download, bindings);
            if (!route || !isSafeRoute(route)) {
                setNotice("That file isn't available.", "error");
                return false;
            }
            const url = `${satelliteBase}/${route}`;
            const name = fileName(action.name !== undefined ? resolve(action.name, bindings) : null, route);
            if (!sharing && action.open === true) {
                openFile(url);
                return true;
            }
            if (!sharing) {
                downloadFile(url, name);
                return true;
            }
            try {
                return await shareFile(url, name);
            } catch (error) {
                setNotice(error.message, "error");
                return false;
            }
        }
        if (action.upload !== undefined) {
            return runUpload(action, bindings);
        }
        if (action.choose) {
            return runChooseAction(action, bindings);
        }
        if (action.play) {
            // 1.2: played by the shell's audio host - a search from whichever Satellite provides
            // audio.library, or this Satellite's own tracks (it must be the one the host plays from)
            try {
                const host = await import("/media/host.js");
                const play = action.play;
                if (play.search !== undefined) {
                    const found = await host.playSearch(String(resolve(play.search, bindings) ?? ""));
                    setNotice(found ? null : "Nothing to play was found.", found ? "info" : "error");
                    return found > 0;
                }
                let tracks;
                let page = null;
                // a route's answer may name what it plays from (a radio station's context)
                let context = play.context !== undefined ? resolve(play.context, bindings) : null;
                if (play.route !== undefined) {
                    const route = resolveTemplate(play.route, bindings);
                    if (!route || !isSafeRoute(route)) {
                        setNotice("That action points outside its Satellite and was refused.", "error");
                        return false;
                    }
                    const answer = await requestJson(`${satelliteBase}/${route}`);
                    tracks = answer && answer.tracks;
                    if (play.context === undefined && answer && typeof answer.context === "string") {
                        context = answer.context;
                    }
                    // a long list answers page by page: the host asks the same route for more
                    // (cursor=, or positions= to shuffle) as the queue runs low
                    const joiner = route.includes("?") ? "&" : "?";
                    page = {
                        answer,
                        load: (params) => requestJson(`${satelliteBase}/${route}${joiner}${new URLSearchParams(params)}`),
                    };
                } else {
                    tracks = resolve(play.tracks, bindings);
                }
                const played = await host.playTracks(satelliteName, tracks, {
                    start: play.start !== undefined ? resolve(play.start, bindings) : null,
                    shuffle: play.shuffle === true,
                    queue: play.queue,
                    context,
                    page,
                });
                setNotice(played ? null : "There is nothing to play here.", played ? "info" : "error");
                return played > 0;
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
        let body = action.body !== undefined ? resolve(action.body, bindings) : (scope.form || {});
        if (action.secrets !== undefined) {
            // 1.2: asked in Mission Control's own prompt, only for a protected document, and put
            // in this one request's body - never in the form, the page's state or a notice
            if (!isProtected() || method === "GET") {
                setNotice("That action asks for a secret this interface may not ask for.", "error");
                return false;
            }
            const who = (state.document && state.document.title) || satelliteName;
            const secrets = await askSecrets(action.secrets, (ask) => promptSecret({ ...ask, satellite: who }));
            if (!secrets) {
                return false;  // cancelled: nothing is sent
            }
            body = bodyWithSecrets(body, secrets);
        }
        let result;
        try {
            result = await call(`${satelliteBase}/${route}`, method === "GET" ? {} : {
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
        } finally {
            body = null;
        }
        if (action.reveal !== undefined && isProtected()) {
            // 1.2: shown once in Mission Control's own dialog, then gone from the answer before a
            // notice or `then` sees it
            const who = (state.document && state.document.title) || satelliteName;
            result = await revealFrom(result, action.reveal, (secret) => showRevealed({ value: secret, satellite: who }));
        }
        if (!quiet) {
            setNotice(result && typeof result.message === "string" ? result.message : null);
        }
        if (gate) {
            // the store may have changed state: set up now (locked, the prompt follows), a new
            // PIN (every unlock ended), delinked (back to setup); still open stays as it is
            gate.check({ quiet: true });
        }
        if (typeof action.reloads === "string") {
            reloadKept(action.reloads);
        }
        const then = action.then;
        if (then === "back") {
            goBack();
        } else if (then && typeof then === "object" && then.navigate) {
            navigate(then.navigate, resolve(then.params || {}, { ...bindings, data: result || {} }));
        } else if (then === "refresh") {
            loadData({ background: false });
        } else if (then === "update" && mergeItem(scope.data, result)) {
            // 1.2: the answer's item is merged into the row it ran from, which is drawn again
            (update || render)();
        }
        return true;
    }

    /** The choose action (1.2, change 8): one row of what the Satellite's source route answers,
     * picked in Mission Control's dialog (or a new one named there), sent to the action's route
     * as $value; a 409 asks before sending again. True once a request succeeded. */
    async function runChooseAction(action, bindings) {
        const post = (route, body) => call(`${satelliteBase}/${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        let outcome;
        try {
            outcome = await runChoose(action, bindings, {
                load: (route) => call(`${satelliteBase}/${route}`),
                choose: (options) => openChooser({
                    ...options,
                    frame: (route) => mediaFrame(route, {}, "ui-media-thumb ui-choose-thumb", ""),
                }),
                request: post,
                confirm: (question) => window.confirm(question),
            });
        } catch (error) {
            setNotice((error && error.payload && error.payload.message) || error.message, "error");
            return false;
        }
        if (!outcome) {
            return false;  // cancelled: nothing more runs
        }
        const result = outcome.result;
        setNotice(result && typeof result.message === "string" ? result.message : null);
        if (typeof action.reloads === "string") {
            reloadKept(action.reloads);
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

    /** The upload action (1.2): files picked with the browser's own dialog, each streamed as
     * the raw body of a POST to the Satellite's route, a conflict asked about file by file, then
     * one report of every file. True once at least one file arrived. */
    async function runUpload(action, bindings) {
        const files = await chooseFiles({ multiple: Boolean(action.upload && action.upload.multiple === true) });
        if (!files.length) {
            return false;  // the dialog was closed: nothing runs
        }
        const result = await runUploads(files, action, {
            url: (template, value) => {
                const route = resolveTemplate(template, { ...bindings, value });
                return isSafeRoute(route) ? `${satelliteBase}/${route}` : null;
            },
            send: sendFile,
            confirm: (value, message) => {
                const asked = message === undefined ? "" : String(resolve(message, { ...bindings, value }) ?? "");
                return window.confirm(`${value.name}\n\n${asked || "It is already there. Replace it?"}`);
            },
            progress: (index, total, value) => setNotice(
                total > 1 ? `Uploading ${index + 1} of ${total}: ${value.name}…` : `Uploading ${value.name}…`, "progress"),
        });
        const report = uploadReport(result);
        setNotice(report.text, report.kind);
        if (result.uploaded.length) {
            if (action.then === "back") {
                goBack();
            } else {
                loadData({ background: false });
            }
        } else if (result.failed.length) {
            loadData({ background: true });  // show what's actually true now
        }
        return result.uploaded.length > 0;
    }

    /** What left the page is no longer served, so ask the browser to fetch each image again: that
     * replaces the copy it cached (a week, as served) with the answer for an item that's gone. */
    function refreshImages(urls) {
        for (const url of new Set(urls)) {
            fetch(url, { cache: "reload", credentials: "same-origin" }).catch(() => {});
        }
    }

    /** The secure action (1.2) on `items` - one request and one prompt for all of them. True once
     * something was done. A partial result is reported as partial, never as done. */
    async function runSecureAction(action, items, scope, imagesOf) {
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
            if (imagesOf) {
                const movedIds = new Set(result.moved.map((item) => String(item && item.id)));
                refreshImages(items.filter((item, at) => movedIds.has(String(ids[at]))).flatMap((item) => imagesOf(item)));
            }
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

    // The dropdown whose panel is open (1.2, change 11): one at a time, on the page it was opened
    // on, kept open through a redraw (a refresh of the page's data).
    let openDropdown = null;
    let openDropdownPage = null;
    let releaseDropdown = null;  // hides the open panel and drops its document listeners
    let dropdownCount = 0;

    function closeDropdown() {
        openDropdown = null;
        openDropdownPage = null;
        if (releaseDropdown) {
            const release = releaseDropdown;
            releaseDropdown = null;
            release();
        }
    }

    // A button of an actions row that opens a panel under itself holding its own blocks (a form,
    // buttons). Pressing it again, pressing elsewhere or Escape closes it, and so does an action
    // that succeeded.
    function renderDropdown(block, scope) {
        const holder = el("div", "ui-dropdown");
        const style = block.style || "secondary";
        const button = el("button", `sc-button ui-button ui-dropdown-toggle${style === "primary" ? " sc-button-accent" : ""}${style === "danger" ? " ui-button-danger" : ""}`);
        button.type = "button";
        button.appendChild(el("span", "", text(block.label, scope)));
        const caret = el("span", "ui-dropdown-caret");
        caret.setAttribute("aria-hidden", "true");
        button.appendChild(caret);
        const panel = el("div", "ui-dropdown-panel");
        dropdownCount += 1;
        panel.id = `ui-dropdown-${dropdownCount}`;
        panel.hidden = true;
        button.setAttribute("aria-controls", panel.id);
        button.setAttribute("aria-expanded", "false");
        renderBlocks(block.blocks, scope, panel);
        holder.append(button, panel);
        const show = (focus) => {
            if (releaseDropdown) {
                const release = releaseDropdown;
                releaseDropdown = null;
                release();
            }
            openDropdown = block;
            openDropdownPage = state.page;
            panel.hidden = false;
            holder.classList.add("open");
            button.setAttribute("aria-expanded", "true");
            const outside = (event) => {
                if (!holder.contains(event.target)) {
                    closeDropdown();
                }
            };
            const escape = (event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    closeDropdown();
                    button.focus();
                }
            };
            document.addEventListener("pointerdown", outside, true);
            document.addEventListener("keydown", escape, true);
            releaseDropdown = () => {
                panel.hidden = true;
                holder.classList.remove("open");
                button.setAttribute("aria-expanded", "false");
                document.removeEventListener("pointerdown", outside, true);
                document.removeEventListener("keydown", escape, true);
            };
            if (focus) {
                const first = panel.querySelector("input, select, textarea, button");
                if (first) {
                    first.focus();
                }
            }
        };
        button.addEventListener("click", () => {
            if (openDropdown === block && !panel.hidden) {
                closeDropdown();
            } else {
                show(true);
            }
        });
        if (openDropdown === block && openDropdownPage === state.page) {
            show(false);
        }
        return holder;
    }

    // a field's value longer than this takes the whole width of its group (Android: WIDE_FIELD)
    const WIDE_FIELD = 24;

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

    /** One media-list row (1.2): what it opens, then its quick buttons and its More button. A
     * row's own actions are buttons beside the row's, never inside it. */
    function mediaRow(block, item, scope) {
        const itemScope = { ...scope, data: item };
        const formats = block.item.format || {};
        const quick = rowQuick(block, itemScope, canRun);
        const menu = rowMenu(block, itemScope, canRun);
        const row = el("div", `ui-list-row ui-media-row${block.action ? " is-action" : ""}`);
        if (reorders(block)) {
            // 1.2 (change 8): dragged by this handle, or moved with Alt+ArrowUp and Alt+ArrowDown
            const handle = el("button", "sc-icon-button sc-icon-button-quiet ui-row-handle");
            handle.type = "button";
            handle.setAttribute("aria-label", `Move ${text(block.item.title, itemScope)}`);
            handle.title = "Drag to move, or press Alt+Up or Alt+Down";
            handle.appendChild(handleGlyph(18));
            row.appendChild(handle);
        }
        const open = el(block.action ? "button" : "div", "ui-media-row-open");
        if (block.action) {
            open.type = "button";
            open.addEventListener("click", () => runAction(block.action, itemScope));
        }
        if (block.item.image !== undefined) {
            open.appendChild(mediaFrame(block.item.image, itemScope, "ui-media-thumb", ""));
        }
        const main = el("span", "ui-list-main");
        const title = text(block.item.title, itemScope);
        main.appendChild(el("span", "ui-list-title", title));
        if (block.item.subtitle !== undefined) {
            const subtitle = resolve(block.item.subtitle, itemScope);
            if (subtitle !== null && subtitle !== undefined && subtitle !== "") {
                main.appendChild(el("span", "ui-list-subtitle", formatValue(subtitle, formats.subtitle)));
            }
        }
        open.appendChild(main);
        if (block.item.meta !== undefined) {
            const meta = resolve(block.item.meta, itemScope);
            if (meta !== null && meta !== undefined && meta !== "") {
                open.appendChild(el("span", "ui-list-value", formatValue(meta, formats.meta)));
            }
        }
        if (block.action && !quick.length && !block.menu) {
            open.appendChild(el("span", "ui-list-chevron", "›"));
        }
        row.appendChild(open);
        if (block.item.audio !== undefined) {
            const id = resolve(block.item.audio, itemScope);
            if (id !== null && id !== undefined && id !== "") {
                row.dataset.audio = String(id);
                if (isPlayingRow(block, itemScope, playing.id)) {
                    row.classList.add("is-playing");
                    main.firstChild.setAttribute("aria-current", "true");
                }
            }
        }
        quick.forEach((entry, index) => {
            const label = text(entry.label, itemScope);
            const button = el("button", `sc-icon-button sc-icon-button-quiet ui-row-quick${entry.style === "primary" ? " is-active" : ""}`);
            button.type = "button";
            button.dataset.index = String(index);
            button.setAttribute("aria-label", label);
            button.title = label;
            const glyph = icon(entry.icon, 18, ownIcons());
            if (glyph) {
                button.appendChild(glyph);
            }
            button.addEventListener("click", () => runRowAction(entry, block, item, scope, row, `.ui-row-quick[data-index="${index}"]`));
            row.appendChild(button);
        });
        if (menu.length) {
            const more = el("button", "sc-icon-button sc-icon-button-quiet ui-row-more", "⋯");
            more.type = "button";
            more.setAttribute("aria-haspopup", "menu");
            more.setAttribute("aria-label", `More for ${title}`);
            more.title = "More";
            more.addEventListener("click", () => showRowMenu(block, item, scope, row, more));
            row.appendChild(more);
            row.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                showRowMenu(block, item, scope, row, { x: event.clientX, y: event.clientY });
            });
            row.addEventListener("keydown", (event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    showRowMenu(block, item, scope, row, more);
                }
            });
        }
        return row;
    }

    // a media-list whose rows the person may move: a whole list, never one loaded page by page
    const reorders = (block) => block.type === "media-list" && Boolean(block.reorder) && !block.more;

    /** A reorderable media-list's move (1.2, change 8): the rows move at once and the list is
     * drawn again, then the route gets {from, to} as $value; if it fails, they move back. */
    function reorderList(block, scope, list, items) {
        let shown = list;
        const redraw = (focus) => {
            const fresh = BLOCKS["media-list"](block, scope);
            if (shown.isConnected) {
                shown.replaceWith(fresh);
            }
            shown = fresh;
            const handle = focus === null ? null : fresh.querySelectorAll(".ui-row-handle")[focus];
            if (handle) {
                handle.focus();
            }
        };
        attachReorder(list, async (from, to, { keyboard }) => {
            const moved = items[from];
            if (!moveItem(items, from, to)) {
                return;
            }
            redraw(keyboard ? to : null);
            const done = await runAction(block.reorder, { ...scope, data: moved }, { from, to });
            if (!done) {
                moveItem(items, to, from);
                redraw(keyboard ? from : null);
            }
        });
    }

    /** Runs one of a row's own actions; `then: "update"` draws that row again in place (and
     * keeps the focus on the control that ran it), or the whole page for a tile. */
    function runRowAction(entry, block, item, scope, row, control = null) {
        const itemScope = { ...scope, data: item };
        const update = row && block.type === "media-list" ? () => {
            if (!row.isConnected) {
                render();
                return;
            }
            const focused = control && row.contains(document.activeElement);
            const fresh = mediaRow(block, item, scope);
            row.replaceWith(fresh);
            const again = focused ? fresh.querySelector(control) : null;
            if (again) {
                again.focus({ preventScroll: true });
            }
        } : null;
        return runAction(entry.action, itemScope, undefined, { update });
    }

    /** A row's or a tile's menu: what this client can run, beside `at` (an element, or where it
     * was right-clicked). Nothing opens when every entry is left out. */
    function showRowMenu(block, item, scope, row, at) {
        const itemScope = { ...scope, data: item };
        const entries = rowMenu(block, itemScope, canRun).map((entry) => ({
            label: text(entry.label, itemScope),
            glyph: entry.icon !== undefined ? icon(entry.icon, 16, ownIcons()) : null,
            danger: entry.style === "danger",
            run: () => runRowAction(entry, block, item, scope, row),
        }));
        openMenu(entries, at, { back: document.activeElement, label: block.item.title !== undefined ? text(block.item.title, itemScope) : "Actions" });
    }

    function renderBlock(block, scope) {
        if (!block || typeof block !== "object") {
            return null;
        }
        if ((block.developer && !developer.enabled) || !servesBlock(block)) {
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
            const shown = formatValue(resolve(block.value, scope), block.format, block.unit);
            // a long value (a path, a sentence) takes a line of its own instead of wrapping
            // in a narrow column beside the others
            const row = el("div", String(shown).length > WIDE_FIELD ? "ui-field is-wide" : "ui-field");
            row.appendChild(el("span", "ui-field-label", text(block.label, scope)));
            const value = el("span", `ui-field-value ui-tone-${toneOf(resolve(block.tone, scope))}`, shown);
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
            const items = listPaging.rows(block, scope);
            const list = el("div", "ui-list");
            const paging = block.more ? listPaging.status(block) : null;
            if (items.length === 0 && !(paging && (paging.more || paging.error))) {
                list.appendChild(el("p", "ui-text ui-text-caption", block.empty ? text(block.empty, scope) : "Nothing here."));
                return list;
            }
            for (const item of items) {
                list.appendChild(listRow(block, item, scope));
            }
            return block.more ? pagedList(block, scope, list, (target, item, at) => target.appendChild(listRow(block, item, at))) : list;
        },

        // The way down to the current place on one row: every entry but the last runs the
        // action; the last is where the person is.
        breadcrumb: (block, scope) => {
            const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
            const nav = el("nav", "ui-breadcrumb");
            nav.setAttribute("aria-label", "Breadcrumb");
            const trail = Array.isArray(items) ? items : [];
            trail.forEach((item, index) => {
                const itemScope = { ...scope, data: item };
                const title = text(block.item.title, itemScope);
                const last = index === trail.length - 1;
                if (index > 0) {
                    const sep = icon("chevron-right", 14);
                    const holder = el("span", "ui-breadcrumb-sep");
                    holder.setAttribute("aria-hidden", "true");
                    if (sep) {
                        holder.appendChild(sep);
                    }
                    nav.appendChild(holder);
                }
                if (last || !block.action) {
                    const here = el("span", "ui-breadcrumb-item ui-breadcrumb-here", title);
                    if (last) {
                        here.setAttribute("aria-current", "page");
                    }
                    nav.appendChild(here);
                } else {
                    const step = el("button", "ui-breadcrumb-item", title);
                    step.type = "button";
                    step.addEventListener("click", () => runAction(block.action, itemScope));
                    nav.appendChild(step);
                }
            });
            // the current place stays in view when the trail is longer than the row
            requestAnimationFrame(() => { nav.scrollLeft = nav.scrollWidth; });
            return nav;
        },

        // The Satellites that open this file (change 16): one link per files.open provider whose
        // extensions hold the file's, each opening the page that provider answers for it
        openers: (block, scope) => {
            const path = text(block.path, scope);
            const found = satellites && !isProtected() ? openersFor(capabilities(), path) : [];
            if (!found.length) {
                return null;
            }
            const line = el("div", "ui-openers");
            line.appendChild(el("span", "ui-openers-label", block.label !== undefined ? text(block.label, scope) : "Opens with"));
            const links = el("div", "ui-openers-links");
            for (const provider of found) {
                const link = el("button", "ui-pill ui-opener", provider.label || provider.satellite);
                link.type = "button";
                link.addEventListener("click", async () => {
                    link.disabled = true;
                    try {
                        await openProvided(provider, provider.operations.open, path, "POST");
                    } finally {
                        link.disabled = false;
                    }
                });
                links.appendChild(link);
            }
            line.appendChild(links);
            return line;
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

        // A page's actions on one line (1.2, change 11): buttons and dropdowns, wrapping where
        // the page is narrow. With none of them shown, the row isn't drawn.
        actions: (block, scope) => {
            const row = el("div", "ui-actions");
            for (const child of block.blocks || []) {
                if (child && (child.type === "button" || child.type === "dropdown")) {
                    const node = renderBlock(child, scope);
                    if (node) {
                        row.appendChild(node);
                    }
                }
            }
            return row.childElementCount ? row : null;
        },

        dropdown: (block, scope) => renderDropdown(block, scope),

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
            const items = listPaging.rows(block, scope);
            const list = el("div", `ui-list ui-media-list ui-media-${block.size || "small"} ui-shape-${block.shape || "square"}`);
            const paging = block.more ? listPaging.status(block) : null;
            if (items.length === 0 && !(paging && (paging.more || paging.error))) {
                list.appendChild(el("p", "ui-text ui-text-caption", block.empty ? text(block.empty, scope) : "Nothing here."));
                return list;
            }
            if (block.item.audio !== undefined) {
                watchPlaying();
            }
            // a group's heading goes before its first row, also when that row came with a page
            const groups = { label: undefined };
            const append = (target, item, at) => {
                if (block.item.group !== undefined) {
                    const formats = block.item.format || {};
                    const label = rowGroup(block, { ...at, data: item }, (value) => formatValue(value, formats.group));
                    if (label !== groups.label) {
                        groups.label = label;
                        if (label) {
                            target.appendChild(el("h3", "ui-media-group ui-list-group", label));
                        }
                    }
                }
                target.appendChild(mediaRow(block, item, at));
            };
            for (const item of items) {
                append(list, item, scope);
            }
            if (reorders(block)) {
                list.classList.add("is-reorderable");
                reorderList(block, scope, list, items);
            }
            return block.more ? pagedList(block, scope, list, append) : list;
        },

        button: (block, scope) => {
            if (block.action && !canRun(block.action)) {
                return null;  // an own page this Satellite doesn't have here, or a share this browser can't do
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
                state.forms[key] = formValues(block.fields, scope);
            }
            const values = state.forms[key];
            const form = el("form", "ui-form");
            form.noValidate = true;
            for (const field of block.fields) {
                form.appendChild(field.kind === "rows"
                    ? renderRowsField(field, values, scope)
                    : renderFormField(field, values, scope));
            }
            const error = el("p", "ui-form-error");
            error.hidden = true;
            form.appendChild(error);
            const submit = el("button", "sc-button sc-button-accent ui-button", text(block.submit.label, scope));
            submit.type = "submit";
            form.appendChild(submit);
            form.addEventListener("submit", async (event) => {
                event.preventDefault();
                const problem = formProblem(block.fields, values);
                if (problem) {
                    error.textContent = problem;
                    error.hidden = false;
                    return;
                }
                error.hidden = true;
                submit.disabled = true;
                try {
                    if (await runAction(block.submit.action, { ...scope, form: formBody(values) })) {
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
            // the accent slides to the segment picked, from where this choice last had it
            group.dataset.slide = `choice:${block.key}`;
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

    /** A rows field (1.2): one card per row with its inputs and a Remove button, and a button that
     * adds an empty row. `values[field.key]` is the list of rows the form sends. */
    function renderRowsField(field, values, scope) {
        const box = el("fieldset", "ui-rows");
        box.appendChild(el("legend", "ui-field-label", `${text(field.label, scope)}${field.required ? " *" : ""}`));
        const list = el("div", "ui-rows-list");
        const add = el("button", "ui-pill ui-rows-add", field.add !== undefined ? text(field.add, scope) : "Add");
        add.type = "button";
        const draw = () => {
            const rows = values[field.key];
            list.replaceChildren(...rows.map((row, index) => {
                const card = el("div", "ui-rows-row");
                for (const input of field.fields) {
                    card.appendChild(renderFormField(input, row, scope));
                }
                const remove = el("button", "ui-pill ui-rows-remove", "Remove");
                remove.type = "button";
                remove.setAttribute("aria-label", `Remove row ${index + 1}`);
                remove.addEventListener("click", () => {
                    rows.splice(index, 1);
                    draw();
                });
                card.appendChild(remove);
                return card;
            }));
            if (!rows.length) {
                list.appendChild(el("p", "ui-text ui-text-caption", "None yet."));
            }
        };
        add.addEventListener("click", () => {
            values[field.key].push(emptyRow(field.fields));
            draw();
            const inputs = list.querySelectorAll(".ui-rows-row:last-child input, .ui-rows-row:last-child select");
            if (inputs.length) {
                inputs[0].focus();
            }
        });
        draw();
        box.append(list, add);
        return box;
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

    /** Whether the document puts its navigation in a column beside every page (1.2, change 13). */
    function hasSidebar() {
        return state.document.layout === "sidebar" && navigationItems().length >= 2;
    }

    function renderNavigation(sidebar = false) {
        const items = navigationItems();
        if (items.length < 2) {
            return null;
        }
        const nav = el("nav", sidebar ? "ui-tabs ui-sidebar" : "ui-tabs");
        nav.setAttribute("aria-label", `${state.document.title || satelliteName} pages`);
        // beside a detail page, the sidebar keeps the top-level page it was opened from selected
        const shown = sidebar && !items.some((item) => item.page === state.page) ? state.topPage : state.page;
        const current = items.some((item) => item.page === shown) ? shown : null;
        for (const item of items) {
            const tab = el("button", `ui-tab${item.page === current ? " active" : ""}`);
            tab.type = "button";
            if (item.page === current) {
                tab.setAttribute("aria-current", "page");
            }
            const glyph = icon(item.icon, 16, ownIcons());
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

        const isTopLevel = navigationItems().some((item) => item.page === state.page)
            || state.page === state.document.entry;
        if (isTopLevel) {
            state.topPage = state.page;
        }
        // the page's content goes beside the sidebar when the document has one, else in the root
        let host = root;
        let nav = null;
        if (hasSidebar()) {
            const frame = el("div", "ui-sidebar-layout");
            nav = renderNavigation(true);
            host = el("div", "ui-sidebar-main");
            frame.append(nav, host);
            root.appendChild(frame);
        }
        if (isTopLevel) {
            const header = renderHeader();
            if (header) {
                host.appendChild(header);
            }
            if (!nav) {
                nav = renderNavigation();
                if (nav) {
                    host.appendChild(nav);
                }
            }
        } else {
            // a detail page: the tabs don't name it, so it gets a title and a way back - unless
            // it carries its own way out (`back: false`, 1.2 change 12), such as an Up action
            const head = el("div", "ui-page-head");
            if (page.back !== false) {
                const back = el("button", "sc-icon-button sc-icon-button-quiet ui-back", "‹ Back");
                back.type = "button";
                // the forgot page leads back to the unlock, not through the history
                back.addEventListener("click", () => (gate && gate.state() === "forgot" ? gate.check() : goBack()));
                head.appendChild(back);
            }
            if (page.title !== undefined && state.data) {
                head.appendChild(el("h2", "ui-page-title", text(page.title, scope)));
            }
            host.appendChild(head);
        }
        if (nav) {
            slideSelection(nav, nav.querySelector(".ui-tab.active"), `tabs:${satelliteName}`);
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
            host.appendChild(notice);
        } else if (state.dataError) {
            host.appendChild(renderFailure());
            return;
        }
        if (!state.data) {
            host.appendChild(renderSkeleton(template));
            return;
        }
        const body = el("div", `ui-page${state.dataError ? " ui-page-stale" : ""}`);
        renderPageBlocks(page.blocks, scope, body, template);
        host.appendChild(body);
        for (const group of body.querySelectorAll(".ui-segmented[data-slide], .ui-pill-group[data-slide]")) {
            slideSelection(group, group.querySelector(".ui-segment.active, .ui-pill-segment[aria-pressed=\"true\"]"), group.dataset.slide);
        }
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

    // ---------- a protected document (1.2) ----------

    function documentTitle() {
        return typeof state.document.title === "string" && state.document.title ? state.document.title : satelliteName;
    }

    /** Everything the store showed or holds in page state, gone: on screen, in timers, in flight. */
    function forget() {
        for (const [name, token] of state.tokens) {
            state.tokens.set(name, token + 1);  // an answer still on its way is dropped
        }
        state.timers.forEach((timer) => clearTimeout(timer));
        state.timers.clear();
        state.page = null;
        state.params = {};
        state.pageState = {};
        state.data = null;
        entries.clear();
        state.dataError = null;
        state.lastGood = 0;
        state.sources = {};
        state.header = null;
        state.forms = {};
        gallery.reset();
        maps.reset();
        resetLists();
        searchInputs = new WeakMap();
        state.charts.forEach((chart) => chart.destroy());
        state.charts.clear();
        root.replaceChildren();
    }

    function onGate(next, why) {
        if (state.disposed) {
            return;
        }
        if (next === "open") {
            loadHeader();
            openPage(wanted);
            return;
        }
        forget();
        if (next === "setup") {
            openPage(state.document.protected.setup);
            return;
        }
        if (next === "forgot") {
            openPage(state.document.protected.forgot);
            return;
        }
        renderGate(next, why);
    }

    function renderGate(next, why) {
        const box = el("section", "ui-card ui-failure ui-locked");
        box.setAttribute("role", "status");
        const head = el("div", "ui-locked-head");
        const glyph = icon(next === "failed" ? "info" : "lock", 18);
        if (glyph) {
            head.appendChild(glyph);
        }
        head.appendChild(el("p", "eyebrow", next === "failed" ? `${documentTitle()} is unavailable`
            : next === "checking" ? documentTitle() : `${documentTitle()} is locked`));
        box.appendChild(head);
        if (next === "checking") {
            box.appendChild(el("p", "ui-text ui-text-caption", "Checking…"));
        } else {
            box.appendChild(el("p", "ui-text ui-text-caption", next === "failed"
                ? why || "StarCore did not answer."
                : "Unlock it to see what it holds. It locks again when you leave it."));
            const button = el("button", "sc-button ui-button", next === "failed" ? "Try again" : "Unlock");
            button.type = "button";
            button.addEventListener("click", () => (next === "failed" ? gate.check() : gate.unlock()));
            box.appendChild(button);
            if (next === "locked" && state.document.protected.forgot) {
                const forgot = el("button", "ui-unlock-forgot", "Forgot your PIN?");
                forgot.type = "button";
                forgot.addEventListener("click", () => gate.forgot());
                box.appendChild(forgot);
            }
        }
        root.replaceChildren(box);
    }

    function openGate(provider) {
        const base = `/api/satellites/${encodeURIComponent(provider.satellite)}`;
        gate = createVaultGate({
            provider,
            request: (route, body) => requestJson(`${base}/${route}`, body === undefined ? {} : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            prompt: (options) => promptPin({ ...options, title: documentTitle(),
                onForgot: state.document.protected.forgot ? () => gate.forgot() : null }),
            // sent even as the page goes away; the server's idle time ends it if this is lost
            lock: (route) => {
                fetch(`${base}/${route}`, {
                    method: "POST",
                    keepalive: true,
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: "{}",
                }).catch(() => {});
            },
            onChange: onGate,
        });
        window.addEventListener("pagehide", onPageHide);
        gate.check();
    }

    function onPageHide() {
        if (gate) {
            gate.leave();
        }
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
            if (Object.values(state.document.pages || {}).some((page) => Array.isArray(page.follows))) {
                watchFollowed();
            }
            state.catalog = catalog;
            const missing = missingRequirements(state.document.requires, catalog.capabilities);
            if (missing.length) {
                fail(missing.map((item) => (item.kind === "client"
                    ? `This interface needs ${item.name}, which this Mission Control doesn't offer yet.`
                    : `This interface needs a Satellite that provides ${item.name}.`)).join(" "));
                return;
            }
            if (state.document.protected) {
                // nothing shows before the store's own status says what may
                const provider = protectedProvider(state.document, catalog.capabilities, satelliteName);
                if (!provider) {
                    fail(`This interface is kept locked by ${state.document.protected.capability}, which ${satelliteName} doesn't offer on this server.`);
                    return;
                }
                openGate(provider);
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
        window.removeEventListener("pagehide", onPageHide);
        if (gate) {
            gate.dispose();  // the document closed: it locks now
        }
        unsubscribe();
        root.remove();
        noticeSlot.remove();
        gallery.dispose();
        maps.reset();
        closeMenu();
        if (playing.off) {
            playing.off();
        }
        if (followed.off) {
            followed.off();
        }
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
export function renderWidget(widget, data, { developer = false, title, onOpen, icons = null } = {}) {
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
    // `icons`: the Satellite's own icons (UI contract 1.2), which its widget may name
    const glyph = icon(widget.icon, 16, icons);
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
        if (!block || typeof block !== "object" || (block.developer && !developer) || !servesBlock(block)
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
