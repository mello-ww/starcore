const REFRESH_MS = 5000;
const STOP_CONFIRM_MS = 4000;

const CORE_PAGES = {
    overview: "Home",
    satellites: "Satellites",
    console: "Console",
    configuration: "Configuration",
};

let pollTimer = null;
let confirmStopTimer = null;
let stopped = false;
let satellites = [];
let navSignature = "";
let route = { name: "overview", satellite: null, section: null };
let mounted = null;
let configurationSettings = [];
let satelliteConfigState = null;
let directoryPickerState = null;
// "<name>:enable" | "<name>:disable" | "<name>:reload" while a lifecycle
// request is in flight, so a card or topbar button re-rendered mid-request
// (the 5s poll doesn't wait for one to finish) still shows as busy instead of
// silently becoming clickable again
let pendingSatelliteActions = new Set();
let accountName = "";
let homeSignature = null;

async function getJson(path) {
    const response = await fetch(path, { headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error((payload && payload.error) || `${path} failed with status ${response.status}`);
    }

    return payload;
}

async function postJson(path, body) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error((payload && payload.error) || `${path} failed with status ${response.status}`);
    }

    return payload;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function shape(tag, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) {
        node.setAttribute(name, value);
    }
    return node;
}

function label(key) {
    return key.replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());
}

function formatValue(value) {
    if (value === null || value === undefined || value === "") {
        return "—";
    }
    if (typeof value === "boolean") {
        return value ? "yes" : "no";
    }
    if (Array.isArray(value)) {
        return value.length ? value.join(", ") : "—";
    }
    if (typeof value === "object") {
        return JSON.stringify(value);
    }
    return String(value);
}

function formatUptime(seconds) {
    const total = Math.floor(Number(seconds) || 0);
    if (total < 60) {
        return `${total}s`;
    }
    if (total < 3600) {
        return `${Math.floor(total / 60)}m ${total % 60}s`;
    }
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

function setText(id, text) {
    document.getElementById(id).textContent = text;
}

function showBanner(message, kind) {
    const banner = document.getElementById("banner");
    banner.textContent = message;
    banner.className = `banner ${kind}`;
    banner.hidden = false;
}

function clearBanner() {
    document.getElementById("banner").hidden = true;
}

function setLink(reachable) {
    document.getElementById("pulse").className = `pulse ${reachable ? "live" : "lost"}`;
    setText("link-state", reachable ? "System online" : "Connection lost");
}

function greeting() {
    return accountName ? `Welcome back, ${accountName}` : "Welcome back";
}

// a satellite earns its own page by shipping one (page.js), by describing one
// declaratively (ui.json, drawn by ui/renderer.js), or by publishing state
// through the state.py convention; satellites that do none of these stay list-only
function hasPage(satellite) {
    return Boolean(satellite.page) || hasUiDocument(satellite) || Object.keys(satellite.state || {}).length > 0;
}

// a ui.json the Engine validated - an entry with only an "error" has none to draw
function hasUiDocument(satellite) {
    return Boolean(satellite.ui && satellite.ui.revision);
}

// A Satellite's ui.json is drawn by the shared renderer (ui/renderer.js). Its own
// page.js is used when it has no valid ui.json - or, in Developer Mode, when its
// "own page" is chosen: a Satellite migrating to ui.json keeps its page.js for
// comparison until it retires it.
const OWN_PAGE_KEY = "starcore.ownPage";

function ownPagePreferred() {
    try {
        return new Set(JSON.parse(localStorage.getItem(OWN_PAGE_KEY) || "[]"));
    } catch {
        return new Set();
    }
}

function usesOwnPage(satellite) {
    return Boolean(satellite.page)
        && (!hasUiDocument(satellite) || (developerMode && ownPagePreferred().has(satellite.name)));
}

// what a mounted page was built from: a page.js, or one revision of a ui.json -
// a new revision (after an update or a rediscovery) remounts the page
function pageRevision(satellite) {
    return usesOwnPage(satellite) ? "page.js" : hasUiDocument(satellite) ? satellite.ui.revision : null;
}

// the first enabled Satellite providing a capability, from GET /api/satellites -
// generic code asks for what it needs ("files.browse"), never for a Satellite
function findCapabilityProvider(capability) {
    for (const satellite of satellites) {
        const entry = satellite.provides && satellite.provides[capability];
        if (entry && satellite.enabled && entry.version === 1) {
            return { satellite, operations: entry.operations || {} };
        }
    }
    return null;
}

// a satellite whose manifest names another as its host (section_of) is
// opened as a section of that host's page and gets no navigation entry of
// its own - presentation only; its routes are as protected as any other
function isSection(satellite) {
    return Boolean(satellite.section_of);
}

function satelliteHash(satellite) {
    if (isSection(satellite)) {
        return `#/satellite/${encodeURIComponent(satellite.section_of)}/${encodeURIComponent(satellite.name)}`;
    }
    return `#/satellite/${encodeURIComponent(satellite.name)}`;
}

function satelliteUrl(name, path = "") {
    return `/api/satellites/${encodeURIComponent(name)}${path}`;
}

// "running" / "stopped" / "disabled" / "error" -> a compact badge, entirely
// generic (see docs/satellites.md - Core never branches on a satellite's name)
const STATUS_BADGES = {
    running: ["badge-up", "running"],
    stopped: ["badge-stopped", "stopped"],
    disabled: ["badge-down", "disabled"],
    error: ["badge-error", "error"],
};

function buildStatusBadge(satellite) {
    const [cls, label] = STATUS_BADGES[satellite.status] || ["badge-unknown", satellite.status || "unknown"];
    return element("span", `badge ${cls}`, label);
}

// a generic orbiting-dot glyph, used whenever a satellite doesn't ship (or
// declare) its own icon - never a per-satellite fallback, just one shared mark
function buildGenericIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.appendChild(shape("ellipse", {
        cx: "12", cy: "12", rx: "9", ry: "5",
        stroke: "currentColor", "stroke-width": "1.6",
    }));
    svg.appendChild(shape("circle", { cx: "12", cy: "12", r: "2.4", fill: "currentColor" }));
    return svg;
}

// small square carrying a satellite's own icon (served through the same
// generic assets route as its Mission Control page), or the generic fallback
// when it has none / its declared icon couldn't be loaded
function buildSatelliteIcon(satellite, extraClass = "") {
    const wrapper = element("span", `satellite-icon${extraClass ? ` ${extraClass}` : ""}`);
    wrapper.setAttribute("aria-hidden", "true");
    if (satellite.icon) {
        // painted through a mask so the icon takes the text colour; as an <img>,
        // an SVG drawn in currentColor always comes out black
        const url = satelliteUrl(satellite.name, `/assets/${satellite.icon}`);
        const mark = element("span", "icon-mask");
        mark.style.setProperty("--icon", `url("${url}")`);
        wrapper.appendChild(mark);
        const probe = new Image();
        probe.addEventListener("error", () => mark.replaceWith(buildGenericIcon()));
        probe.src = url;
    } else {
        wrapper.appendChild(buildGenericIcon());
    }
    return wrapper;
}

function findSatellite(name) {
    return satellites.find((satellite) => satellite.name.toLowerCase() === String(name).toLowerCase());
}

/* ---------- routing ---------- */

function applyRoute() {
    // a real navigation (as opposed to the ~5s poll refresh, which never
    // touches the hash or calls this) is the right moment to close the
    // mobile sidebar - it does nothing when the sidebar isn't a phone-width
    // overlay in the first place
    closeSidebar();

    const [name, param, section] = location.hash.replace(/^#\/?/, "").split("/");

    if (name === "satellite" && param) {
        route = { name: "satellite", satellite: decodeURIComponent(param), section: section ? decodeURIComponent(section) : null };
    } else if (name in CORE_PAGES && (developerMode || !DEVELOPER_ROUTES.has(name))) {
        route = { name, satellite: null, section: null };
    } else {
        route = { name: "overview", satellite: null, section: null };
    }

    // a real navigation to the page already showing: let it switch section
    if (mounted && route.name === "satellite" && mounted.name.toLowerCase() === route.satellite.toLowerCase()
        && mounted.section !== route.section) {
        mounted.section = route.section;
        if (mounted.cleanup && typeof mounted.cleanup.showSection === "function") {
            mounted.cleanup.showSection(route.section);
        }
    }

    showRoute();
}

function showRoute() {
    const view = route.name === "satellite" ? "satellite" : route.name;
    document.body.dataset.route = view;

    for (const section of document.querySelectorAll(".view")) {
        section.hidden = section.id !== `view-${view}`;
    }

    for (const item of document.querySelectorAll(".nav-item")) {
        const active = item.dataset.route === route.name
            || (route.name === "satellite" && item.dataset.satellite === route.satellite);
        item.classList.toggle("active", active);
        item.toggleAttribute("aria-current", active);
    }

    if (route.name === "satellite") {
        setText("page-eyebrow", "Satellite");
        setText("page-title", route.satellite);
        renderSatellitePage();
    } else {
        unmountSatellitePage();
        setText("page-eyebrow", route.name === "overview" ? "StarCore" : "Core");
        setText("page-title", route.name === "overview" ? greeting() : CORE_PAGES[route.name]);
        if (route.name === "configuration") {
            loadConfiguration();
            loadSessions();
        }
    }

    updateSatelliteConfigButton();
    updateSatelliteReloadButton();
    updateSatelliteToggleButton();
}

/* ---------- core ---------- */

// ---------- About / build info ----------
// Everything here comes from the Engine's /api/status "build" (see
// engine/starcore/build_info.py): the VERSION file plus Git, never a value
// typed into this page. A field the Engine couldn't determine stays "-".

let buildInfo = null;

function buildCommitText(build) {
    if (!build.commit) {
        return "-";
    }
    return build.dirty ? `${build.commit} + local changes` : build.commit;
}

function buildInfoText(build) {
    return [
        "StarCore build info",
        `Engine version: ${build.version} (${build.channel})`,
        `Build: ${build.build ?? "unknown"}`,
        `Commit: ${buildCommitText(build) === "-" ? "unknown" : buildCommitText(build)}`,
        `Build date: ${build.date ? build.date.slice(0, 10) : "unknown"}`,
        "Client: Mission Control (web)",
    ].join("\n");
}

function renderBuild(build) {
    if (!build) {
        return;
    }
    buildInfo = build;
    setText("about-version", build.version);
    setText("about-channel", build.channel);
    setText("about-build", build.build ?? "-");
    setText("about-commit", buildCommitText(build));
    setText("about-date", build.date ? build.date.slice(0, 10) : "-");
    const label = document.getElementById("sidebar-version");
    label.textContent = `v${build.version}`;
    label.title = buildInfoText(build).split("\n").slice(1, 4).join(" \u00b7 ");
    label.hidden = false;
}

async function copyText(text) {
    // navigator.clipboard needs a secure context (HTTPS or localhost) and a
    // browser may still refuse it; a plain-HTTP LAN address, or a refusal,
    // falls back to the older selection-based copy
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (error) {
            // permission denied - try the fallback below
        }
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) {
        throw new Error("copy is not available in this browser");
    }
}

async function handleCopyBuildInfo() {
    if (!buildInfo) {
        return;
    }
    const note = document.getElementById("about-copied");
    try {
        await copyText(buildInfoText(buildInfo));
        note.textContent = "Copied";
    } catch (error) {
        note.textContent = `Could not copy: ${error.message}`;
    }
    note.hidden = false;
    clearTimeout(handleCopyBuildInfo.timer);
    handleCopyBuildInfo.timer = setTimeout(() => { note.hidden = true; }, 2500);
}

function renderCore(status) {
    document.title = `${status.engine} Mission Control`;
    renderBuild(status.build);

    const state = document.getElementById("core-state");
    state.textContent = status.running ? "running" : "stopped";
    state.className = `badge ${status.running ? "badge-up" : "badge-down"}`;

    setText("updated", new Date().toLocaleTimeString());
    renderHomeStatus(status);
}

/* ---------- home ---------- */

const STATUS_LABELS = { running: "Running", stopped: "Stopped", disabled: "Disabled", error: "Error" };

function homeAlerts() {
    return satellites
        .filter((satellite) => satellite.status === "error" || satellite.status === "stopped")
        .map((satellite) => ({
            satellite,
            level: satellite.status,
            text: satellite.status === "error"
                ? `${satellite.name} reported an error`
                : `${satellite.name} is enabled but not running`,
        }));
}

function setHomeState(dot, state, detail) {
    document.getElementById("home-state-dot").className = `home-dot ${dot}`;
    setText("home-state", state);
    setText("home-state-detail", detail);
}

function renderHomeStatus(status) {
    const online = satellites.filter((satellite) => satellite.status === "running").length;
    const alerts = homeAlerts().length;

    if (status.running) {
        setHomeState(alerts ? "warn" : "on", "Online",
            alerts ? `${status.engine} is running · ${alerts} alert${alerts === 1 ? "" : "s"}` : `${status.engine} is running`);
    } else {
        setHomeState("off", "Stopped", `${status.engine} is not running.`);
    }
    setText("home-uptime", formatUptime(status.uptime_seconds));
    setText("home-online", `${online}/${satellites.length}`);
    setText("home-commands", String(status.commands));
}

function renderHomeUnreachable(message) {
    setHomeState("off", "Unreachable", message);
    for (const id of ["home-uptime", "home-online", "home-commands"]) {
        setText(id, "—");
    }
    if (homeSignature === null) {
        const satellitesBox = document.getElementById("home-satellites");
        satellitesBox.replaceChildren(homeEmpty("Satellites will appear once StarCore answers.", "Try again", refresh));
        homeSignature = "unreachable";
    }
}

function homeEmpty(text, actionLabel, onAction) {
    const box = element("div", "home-empty");
    box.appendChild(element("p", null, text));
    if (actionLabel) {
        const button = element("button", "sc-button", actionLabel);
        button.type = "button";
        button.addEventListener("click", onAction);
        box.appendChild(button);
    }
    return box;
}

function openSatellite(satellite) {
    location.hash = satelliteHash(satellite);
}

function buildHomeIcon(satellite) {
    const mark = element("span", "home-card-icon");
    mark.setAttribute("aria-hidden", "true");
    if (satellite.icon) {
        // a mask lets the satellite's own stroke icon take the accent colour
        mark.style.setProperty("--icon", `url("${satelliteUrl(satellite.name, `/assets/${satellite.icon}`)}")`);
        mark.classList.add("masked");
    } else {
        mark.appendChild(buildGenericIcon());
    }
    return mark;
}

function buildHomeCard(satellite) {
    const card = element("article", `home-card status-${satellite.status || "unknown"}`);

    const head = element("div", "home-card-head");
    head.appendChild(buildHomeIcon(satellite));
    head.appendChild(element("h3", null, satellite.name));
    const state = element("span", "home-card-state");
    state.appendChild(element("i", "home-dot"));
    state.appendChild(document.createTextNode(STATUS_LABELS[satellite.status] || satellite.status || "Unknown"));
    head.appendChild(state);
    card.appendChild(head);

    card.appendChild(element("p", "home-card-desc", satellite.description || `${satellite.type} satellite`));

    const actions = element("div", "home-card-actions");
    if (hasPage(satellite)) {
        const open = element("button", "sc-button sc-button-accent");
        open.type = "button";
        open.appendChild(openIcon());
        open.appendChild(element("span", null, "Open"));
        open.addEventListener("click", () => openSatellite(satellite));
        actions.appendChild(open);
    } else {
        // no page of its own: its commands and state live on the Satellites list
        const details = element("button", "sc-button", "Details");
        details.type = "button";
        details.addEventListener("click", () => {
            location.hash = "#/satellites";
        });
        actions.appendChild(details);
    }

    if (satellite.configurable) {
        const configure = element("button", "sc-icon-button sc-icon-button-quiet home-card-config");
        configure.type = "button";
        configure.title = `${satellite.name} configuration`;
        configure.setAttribute("aria-label", `${satellite.name} configuration`);
        configure.appendChild(slidersIcon());
        configure.addEventListener("click", () => openSatelliteConfig(satellite));
        actions.appendChild(configure);
    }
    card.appendChild(actions);
    return card;
}

function renderHomeSatellites() {
    const listed = satellites.filter((satellite) => !isSection(satellite));
    const signature = listed
        .map((satellite) => [satellite.name, satellite.status, satellite.icon, satellite.description,
            satellite.configurable, hasPage(satellite)].join(":"))
        .join("|");
    if (signature === homeSignature) {
        return;
    }
    homeSignature = signature;

    const grid = document.getElementById("home-satellites");
    const online = listed.filter((satellite) => satellite.status === "running").length;
    setText("home-satellite-count", listed.length ? `${online} of ${listed.length} online` : "");

    if (listed.length === 0) {
        grid.replaceChildren(homeEmpty("No satellites are loaded on this StarCore."));
    } else {
        // satellites with a page of their own first, then by name
        const ordered = [...listed].sort((a, b) =>
            Number(hasPage(b)) - Number(hasPage(a)) || a.name.localeCompare(b.name));
        grid.replaceChildren(...ordered.map(buildHomeCard));
    }

    const alerts = homeAlerts();
    const box = document.getElementById("home-alerts");
    if (alerts.length === 0) {
        box.replaceChildren(homeEmpty("No alerts. Every enabled satellite is running."));
        return;
    }
    const list = element("ul", "home-alerts");
    for (const alert of alerts) {
        const item = element("li", `home-alert ${alert.level}`);
        item.appendChild(element("i", "home-dot"));
        item.appendChild(element("span", null, alert.text));
        const view = element("button", "sc-button", "View");
        view.type = "button";
        view.addEventListener("click", () => {
            location.hash = hasPage(alert.satellite) ? satelliteHash(alert.satellite) : "#/satellites";
        });
        item.appendChild(view);
        list.appendChild(item);
    }
    box.replaceChildren(list);
}

/* ---------- home: widgets ---------- */

// Each Satellite's ui.json may declare widgets (UI contract 1.1). A widget
// without a source binds to the state the Satellite publishes with
// /api/satellites - the answer the regular poll already has - so Home makes
// no request of its own for it; documents are fetched once per revision.
const widgetDocuments = new Map();  // satellite name -> {revision, widgets}
let widgetRenderer = null;

async function loadWidgetDocument(satellite) {
    const known = widgetDocuments.get(satellite.name);
    if (known && known.revision === satellite.ui.revision) {
        return known.widgets;
    }
    try {
        const payload = await getJson(satelliteUrl(satellite.name, "/ui"));
        const widgets = (payload && payload.document && Array.isArray(payload.document.widgets))
            ? payload.document.widgets : [];
        widgetDocuments.set(satellite.name, { revision: satellite.ui.revision, widgets });
        return widgets;
    } catch {
        return [];
    }
}

async function renderHomeWidgets() {
    const container = document.getElementById("home-widgets");
    const candidates = satellites.filter((satellite) => satellite.enabled && hasUiDocument(satellite));
    const found = await Promise.all(candidates.map(async (satellite) => ({
        satellite, widgets: await loadWidgetDocument(satellite),
    })));
    if (!found.some((entry) => entry.widgets.length)) {
        container.replaceChildren();
        return;
    }
    widgetRenderer = widgetRenderer || await import("/ui/renderer.js");
    const cards = [];
    for (const { satellite, widgets } of found) {
        for (const widget of widgets) {
            if (widget.source) {
                continue;  // a widget with its own source belongs to a client that polls it; Home stays on the listing
            }
            const state = satellite.state || {};
            if (!Object.keys(state).length) {
                continue;  // nothing published yet - a disabled Satellite publishes nothing
            }
            cards.push(widgetRenderer.renderWidget(widget, state, {
                developer: developerContext.enabled,
                title: satellite.name,
                onOpen: (section) => {
                    location.hash = section ? `${satelliteHash(satellite)}/${section}` : satelliteHash(satellite);
                },
            }));
        }
    }
    container.replaceChildren(...cards);
}

function openIcon() {
    const svg = shape("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.6",
        "stroke-linecap": "round", "stroke-linejoin": "round", width: "15", height: "15", "aria-hidden": "true" });
    svg.appendChild(shape("path", { d: "M5.5 3.5h7v7M12.5 3.5 3.5 12.5" }));
    return svg;
}

function slidersIcon() {
    const svg = shape("svg", { viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", "stroke-width": "1.5",
        "stroke-linecap": "round", width: "18", height: "18", "aria-hidden": "true" });
    svg.appendChild(shape("path", { d: "M3 5h7M13 5h2M3 9h2M8 9h7M3 13h8M14 13h1" }));
    svg.appendChild(shape("path", { d: "M11.5 3.5v3M6.5 7.5v3M12.5 11.5v3" }));
    return svg;
}

/* ---------- accent colour ---------- */

const ACCENTS = [["red", "Red"], ["orange", "Orange"], ["green", "Green"], ["blue", "Blue"], ["mono", "Mono"]];
const ACCENT_KEY = "starcore.accent";
const HEX_PATTERN = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

// "#abc" / "abc" / "#AABBCC" -> "#aabbcc"; anything else -> null
function normalizeHex(value) {
    const match = HEX_PATTERN.exec(String(value || "").trim());
    if (!match) {
        return null;
    }
    const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
    return `#${digits.toLowerCase()}`;
}

function luminance(hex) {
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// the dark StarCore ink (#141215, luminance ~0.0073) or white - whichever contrasts more
function onAccentFor(hex) {
    const light = luminance(hex);
    return (light + 0.05) / 0.0573 >= 1.05 / (light + 0.05) ? "#141215" : "#ffffff";
}

// a preset's name, or the custom "#rrggbb"
function currentAccent() {
    const custom = normalizeHex(document.documentElement.style.getPropertyValue("--sc-accent"));
    return custom || document.documentElement.dataset.accent || "red";
}

function currentAccentHex() {
    return normalizeHex(getComputedStyle(document.documentElement).getPropertyValue("--sc-accent")) || "#ee444b";
}

function storedAccent() {
    try {
        return localStorage.getItem(ACCENT_KEY) || "red";
    } catch (error) {
        return currentAccent();
    }
}

// applies a preset name or a custom hex; `save` false only previews it
function setAccent(value, save = true) {
    const root = document.documentElement;
    const hex = normalizeHex(value);
    if (hex) {
        delete root.dataset.accent;
        root.style.setProperty("--sc-accent", hex);
        root.style.setProperty("--sc-on-accent", onAccentFor(hex));
    } else {
        root.style.removeProperty("--sc-accent");
        root.style.removeProperty("--sc-on-accent");
        if (value === "red") {
            delete root.dataset.accent;
        } else {
            root.dataset.accent = value;
        }
    }
    if (save) {
        try {
            localStorage.setItem(ACCENT_KEY, hex || value);
        } catch (error) {
            // private mode: the choice still applies until the page closes
        }
    }
    syncAccentMenu();
}

function syncAccentMenu() {
    const menu = document.getElementById("accent-menu");
    const current = currentAccent();
    menu.querySelectorAll(".accent-swatch").forEach((swatch) => {
        swatch.setAttribute("aria-checked", String(swatch.dataset.accent === current));
    });
    const hex = currentAccentHex();
    const picker = menu.querySelector(".accent-custom-picker");
    const field = menu.querySelector(".accent-custom-hex");
    if (picker && picker.value !== hex) {
        picker.value = hex;
    }
    if (field && document.activeElement !== field) {
        field.value = hex.toUpperCase();
        field.removeAttribute("aria-invalid");
    }
}

function renderAccentMenu() {
    const menu = document.getElementById("accent-menu");
    const presets = element("div", "accent-presets");
    presets.setAttribute("role", "radiogroup");
    presets.setAttribute("aria-label", "Accent presets");
    presets.append(...ACCENTS.map(([name, title]) => {
        const swatch = element("button", "accent-swatch");
        swatch.type = "button";
        swatch.dataset.accent = name;
        swatch.title = title;
        swatch.setAttribute("role", "radio");
        swatch.setAttribute("aria-label", title);
        swatch.addEventListener("click", () => {
            setAccent(name);
            toggleAccentMenu(false);
            document.getElementById("accent-button").focus();
        });
        return swatch;
    }));

    // a custom colour: the picker and HEX field preview live, and save once the value is final
    const custom = element("div", "accent-custom");
    const picker = element("input", "accent-custom-picker");
    picker.type = "color";
    picker.setAttribute("aria-label", "Custom accent colour");
    picker.addEventListener("input", () => setAccent(picker.value, false));
    picker.addEventListener("change", () => setAccent(picker.value));

    const field = element("input", "accent-custom-hex");
    field.type = "text";
    field.maxLength = 7;
    field.spellcheck = false;
    field.autocomplete = "off";
    field.placeholder = "#RRGGBB";
    field.setAttribute("aria-label", "Custom accent HEX value");
    const commit = () => {
        const hex = normalizeHex(field.value);
        // an invalid value falls back to the remembered accent
        setAccent(hex || storedAccent(), Boolean(hex));
        field.value = currentAccentHex().toUpperCase();
        field.removeAttribute("aria-invalid");
    };
    field.addEventListener("input", () => {
        const hex = normalizeHex(field.value);
        field.setAttribute("aria-invalid", String(!hex));
        if (hex) {
            setAccent(hex, false);
        }
    });
    field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            commit();
        }
    });
    field.addEventListener("change", commit);
    custom.append(picker, field);

    menu.replaceChildren(presets, custom);
    syncAccentMenu();
}

function toggleAccentMenu(open) {
    const menu = document.getElementById("accent-menu");
    menu.hidden = !open;
    document.getElementById("accent-button").setAttribute("aria-expanded", String(open));
    if (open) {
        renderAccentMenu();
        (menu.querySelector('[aria-checked="true"]') || menu.querySelector(".accent-custom-hex")).focus();
    }
}

/* ---------- satellites ---------- */

/* ---------- Developer Mode ----------
   A visibility preference, never a permission: it decides whether advanced settings, diagnostics
   and developer tools are shown. Every route keeps its own server-side authentication and
   authorization, whatever this says. Off by default, remembered per account in this browser.

   The shared mechanism, for the shell and every Satellite page alike:
   - mark any element data-developer: shown only in Developer Mode (one CSS rule, home.css);
     data-developer-hint: shown only outside it (say where the hidden thing lives);
   - a setting a Satellite describes with "developer": true is marked that way in every form;
   - a Satellite page's mount context has `developer` ({enabled, subscribe}) for anything that
     has to react in code, such as leaving a section that just disappeared. */
const DEVELOPER_KEY = "starcore.developerMode";
const DEVELOPER_ROUTES = new Set(["console"]);
const developerListeners = new Set();
let developerMode = false;

function developerStorageKey() {
    return `${DEVELOPER_KEY}.${accountName || "-"}`;
}

function storedDeveloperMode() {
    try {
        return localStorage.getItem(developerStorageKey()) === "on";
    } catch (error) {
        return false;
    }
}

function setDeveloperMode(enabled, save = true) {
    developerMode = Boolean(enabled);
    document.documentElement.dataset.developerMode = developerMode ? "on" : "off";
    const button = document.getElementById("developer-button");
    button.setAttribute("aria-pressed", String(developerMode));
    button.title = developerMode ? "Developer Mode is on" : "Developer Mode";
    if (save) {
        try {
            localStorage.setItem(developerStorageKey(), developerMode ? "on" : "off");
        } catch (error) {
            // storage unavailable: still applies for this visit
        }
    }
    if (!developerMode && DEVELOPER_ROUTES.has(route.name)) {
        location.hash = "#/";
    }
    for (const listener of [...developerListeners]) {
        try {
            listener(developerMode);
        } catch (error) {
            console.error(error);
        }
    }
}

// what a Satellite page receives as context.developer
const developerContext = {
    get enabled() {
        return developerMode;
    },
    subscribe(listener) {
        developerListeners.add(listener);
        return () => developerListeners.delete(listener);
    },
};

// marks a node built from a setting the Satellite described as developer-only
function markDeveloper(node, setting) {
    if (setting && setting.developer) {
        node.dataset.developer = "";
    }
    return node;
}

function developerHint(count, noun = "setting") {
    const hint = element("p", "hint developer-hint",
        `${count} advanced ${noun}${count === 1 ? " is" : "s are"} shown in Developer Mode.`);
    hint.dataset.developerHint = "";
    return hint;
}

function renderSatelliteNav() {
    const pages = satellites.filter((satellite) => hasPage(satellite) && !isSection(satellite));
    const signature = pages.map((satellite) => `${satellite.name}:${satellite.status}:${satellite.icon}`).join("|");
    if (signature === navSignature) {
        return;
    }
    navSignature = signature;

    const list = document.getElementById("satellite-nav");
    list.replaceChildren();
    document.getElementById("satellite-nav-empty").hidden = pages.length > 0;

    for (const satellite of pages) {
        const button = element("button", "nav-item");
        button.type = "button";
        button.dataset.satellite = satellite.name;
        button.title = `${satellite.name} — ${satellite.status}`;
        button.appendChild(buildSatelliteIcon(satellite, "small"));
        button.appendChild(element("span", null, satellite.name));
        button.appendChild(element("i", `dot${satellite.status === "running" ? " on" : ""}${satellite.status === "error" ? " error" : ""}`));
        button.addEventListener("click", () => {
            location.hash = `#/satellite/${encodeURIComponent(satellite.name)}`;
        });

        const item = document.createElement("li");
        item.appendChild(button);
        list.appendChild(item);
    }

    showRoute();
}

function renderState(state) {
    const keys = Object.keys(state || {});
    if (keys.length === 0) {
        return element("p", "muted", "No state published.");
    }

    const list = element("dl", "facts");
    for (const key of keys) {
        const row = document.createElement("div");
        row.appendChild(element("dt", null, label(key)));
        row.appendChild(element("dd", null, formatValue(state[key])));
        list.appendChild(row);
    }
    return list;
}

function renderCommands(commands) {
    const wrapper = element("div", "chips");

    if (!commands || commands.length === 0) {
        wrapper.appendChild(element("span", "muted", "No commands."));
        return wrapper;
    }

    for (const command of commands) {
        const chip = element("code", "chip", command.name);
        chip.title = command.description || command.name;
        wrapper.appendChild(chip);
    }
    return wrapper;
}

function renderSatelliteCard(satellite) {
    const card = element("article", "card");

    const head = element("div", "card-head");
    head.appendChild(buildSatelliteIcon(satellite));
    head.appendChild(element("h3", null, satellite.name));
    const badges = element("div", "card-badges");
    badges.appendChild(element("span", "badge badge-type", satellite.type));
    badges.appendChild(buildStatusBadge(satellite));
    head.appendChild(badges);

    const actions = element("div", "card-actions");
    if (satellite.configurable) {
        actions.appendChild(buildConfigButton(satellite));
    }
    actions.appendChild(buildReloadButton(satellite));
    actions.appendChild(buildToggleButton(satellite));
    head.appendChild(actions);

    card.appendChild(head);

    const meta = element("p", "card-meta", `v${satellite.version} · ${satellite.author}`);
    meta.dataset.developer = "";
    card.appendChild(meta);
    if (satellite.description) {
        card.appendChild(element("p", "description", satellite.description));
    }

    const commands = renderCommands(satellite.commands);
    commands.dataset.developer = "";
    card.appendChild(commands);

    if (hasPage(satellite)) {
        const link = element("button", "card-link", isSection(satellite) ? `Open in ${satellite.section_of} →` : "Open page →");
        link.type = "button";
        link.addEventListener("click", () => {
            location.hash = satelliteHash(satellite);
        });
        card.appendChild(link);
    }

    return card;
}

// native and link satellites are kept in two clearly separate groups rather
// than one mixed grid - "the same lifecycle and extension model" (docs/
// satellites.md) doesn't mean they should look interchangeable in the list
function renderSatelliteGroup(title, members) {
    const section = element("section", "satellite-group");

    const head = element("div", "satellite-group-head");
    head.appendChild(element("p", "eyebrow", title));
    head.appendChild(element("span", "badge badge-unknown", String(members.length)));
    section.appendChild(head);

    const grid = element("div", "cards");
    if (members.length === 0) {
        grid.appendChild(element("p", "muted", "None."));
    } else {
        for (const satellite of members) {
            grid.appendChild(renderSatelliteCard(satellite));
        }
    }
    section.appendChild(grid);

    return section;
}

function renderSatelliteList() {
    const container = document.getElementById("satellites");
    container.replaceChildren();

    setText("satellite-count", String(satellites.length));

    if (satellites.length === 0) {
        container.appendChild(element("p", "muted", "No satellites are loaded."));
        return;
    }

    const native = satellites.filter((satellite) => satellite.type === "native");
    const link = satellites.filter((satellite) => satellite.type === "link");

    container.appendChild(renderSatelliteGroup("Native Satellites", native));
    container.appendChild(renderSatelliteGroup("Link Satellites", link));
}

// a satellite can ship its own Mission Control page as an ES module; the module
// is asked to render into a container of its own and to clean up when the user
// navigates away
async function mountSatellitePage(satellite) {
    const container = document.getElementById("satellite-page");
    const revision = pageRevision(satellite);
    if (mounted && mounted.name === satellite.name && mounted.revision === revision) {
        return;
    }

    unmountSatellitePage();
    mounted = { name: satellite.name, section: route.section, revision, cleanup: null };
    container.replaceChildren();

    const ownPage = usesOwnPage(satellite);
    if (ownPage && satellite.page.stylesheet) {
        loadStylesheet(satelliteUrl(satellite.name, `/assets/${satellite.page.stylesheet}`));
    }

    // the shared renderer for its ui.json, or else a Satellite's own page.js -
    // both mounted through the same context, so neither is special-cased below
    const moduleUrl = ownPage
        ? satelliteUrl(satellite.name, `/assets/${satellite.page.module}`)
        : "/ui/renderer.js";

    try {
        const module = await import(moduleUrl);
        if (!mounted || mounted.name !== satellite.name) {
            return;  // the user navigated away while the module was loading
        }
        mounted.cleanup = module.mount({
            element: container,
            satellite,
            // the section the route names (#/satellite/<name>/<section>), if any
            section: route.section,
            // Developer Mode, for code that must react to it - see "Developer Mode" above
            developer: developerContext,
            api: {
                url: (path) => satelliteUrl(satellite.name, path),
                get: (path) => getJson(satelliteUrl(satellite.name, path)),
                post: (path, body) => postJson(satelliteUrl(satellite.name, path), body),
            },
        });
    } catch (error) {
        showBanner(`The ${satellite.name} page could not be loaded: ${error.message}`, "error");
    }
}

function unmountSatellitePage() {
    if (mounted && typeof mounted.cleanup === "function") {
        mounted.cleanup();
    }

    mounted = null;
    document.getElementById("satellite-page").replaceChildren();
}

function loadStylesheet(href) {
    if (document.querySelector(`link[href="${href}"]`)) {
        return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
}

function renderSatellitePage() {
    const satellite = findSatellite(route.satellite);
    if (!satellite) {
        // the route can be opened before the first poll answers, so only send a
        // dead link back to the list once the satellites are actually known
        if (satellites.length) {
            location.hash = "#/satellites";
        }
        return;
    }
    if (isSection(satellite) && findSatellite(satellite.section_of)) {
        // an old link to a satellite that now lives inside another page
        location.replace(satelliteHash(satellite));
        return;
    }

    const rendered = Boolean(satellite.page) || hasUiDocument(satellite);
    document.getElementById("satellite-generic").hidden = rendered;
    if (rendered) {
        setText("page-title", satellite.name);
        mountSatellitePage(satellite);
        return;
    }

    unmountSatellitePage();
    setText("page-title", satellite.name);
    setText("satellite-title", satellite.name);
    setText("satellite-type", satellite.type);
    setText("satellite-description", satellite.description || "");
    setText("satellite-version", satellite.version);
    setText("satellite-author", satellite.author);

    const [statusClass, statusLabel] = STATUS_BADGES[satellite.status] || ["badge-unknown", satellite.status || "unknown"];
    const enabled = document.getElementById("satellite-enabled");
    enabled.textContent = statusLabel;
    enabled.className = `badge ${statusClass}`;

    document.getElementById("satellite-state").replaceChildren(renderState(satellite.state));
    document.getElementById("satellite-commands").replaceChildren(renderCommands(satellite.commands));
}

// Rediscover: the Engine re-reads every Satellite's ui.json and manifest
// metadata (never its code) and reports folders that need a restart to load
function describeRediscovery(result) {
    const parts = [];
    if (result.updated.length) {
        parts.push(`Updated ${result.updated.join(", ")}.`);
    }
    if (result.pending.length) {
        parts.push(`Found ${result.pending.map((item) => item.name).join(", ")} - restart StarCore to load ${result.pending.length === 1 ? "it" : "them"}.`);
    }
    if (result.reload_required.length) {
        parts.push(`${result.reload_required.join(", ")} changed on disk - reload ${result.reload_required.length === 1 ? "it" : "them"} to apply.`);
    }
    if (result.missing.length) {
        parts.push(`${result.missing.join(", ")} ${result.missing.length === 1 ? "is" : "are"} no longer on disk and keep${result.missing.length === 1 ? "s" : ""} running until StarCore restarts.`);
    }
    for (const problem of result.errors) {
        parts.push(`${problem.satellite || problem.folder}: ${problem.error}`);
    }
    return parts.length ? parts.join(" ") : "Everything is up to date.";
}

async function handleRediscoverClick() {
    const button = document.getElementById("rediscover-button");
    const output = document.getElementById("rediscover-result");
    button.disabled = true;
    try {
        output.textContent = describeRediscovery(await postJson("/api/catalog/rediscover"));
    } catch (error) {
        output.textContent = `Rediscovery failed: ${error.message}`;
    } finally {
        output.hidden = false;
        button.disabled = false;
    }
    refresh();
}

/* ---------- polling ---------- */

async function refresh() {
    if (stopped) {
        return;
    }

    try {
        const [status, payload] = await Promise.all([
            getJson("/api/status"),
            getJson("/api/satellites"),
        ]);

        satellites = payload.satellites;

        renderCore(status);
        renderHomeSatellites();
        renderHomeWidgets();
        renderSatelliteList();
        renderSatelliteNav();
        if (route.name === "satellite") {
            renderSatellitePage();
        }
        updateSatelliteConfigButton();
        updateSatelliteReloadButton();
        updateSatelliteToggleButton();

        setLink(true);
        clearBanner();
    } catch (error) {
        setLink(false);
        showBanner(`Cannot reach StarCore: ${error.message}`, "error");
        renderHomeUnreachable(error.message);
    }
}

/* ---------- console: a web equivalent of the terminal CLI ---------- */

async function loadCommands() {
    try {
        const payload = await getJson("/api/commands");
        renderConsoleCommands(payload.commands);
    } catch (error) {
        // the console still works without the command list, so this failure is silent
    }
}

function renderConsoleCommands(commands) {
    const container = document.getElementById("console-commands");
    container.replaceChildren();
    container.appendChild(element("span", "muted", "Available"));

    for (const command of commands) {
        const chip = element("button", "chip", command.name);
        chip.type = "button";
        chip.title = command.description || command.name;
        chip.addEventListener("click", () => {
            const input = document.getElementById("console-input");
            input.value = command.name;
            input.focus();
        });
        container.appendChild(chip);
    }
}

function resetConsole() {
    document.getElementById("console-output")
        .replaceChildren(element("div", "console-idle", "No commands run yet."));
}

function appendConsoleLine(command, response) {
    const output = document.getElementById("console-output");
    const idle = output.querySelector(".console-idle");
    if (idle) {
        idle.remove();
    }

    const entry = element("div", "console-entry");
    entry.appendChild(element("div", "console-echo", command));

    const text = (response.output || "").replace(/\s+$/, "");
    if (text) {
        // the command system reports its own failures on stdout, so those lines
        // are picked out here rather than being lost in the regular output
        for (const line of text.split("\n")) {
            entry.appendChild(element("div", line.startsWith("[ERROR]") ? "console-error" : null, line));
        }
    }
    if (response.error) {
        entry.appendChild(element("div", "console-error", `[ERROR]: ${response.error}`));
    }

    output.appendChild(entry);
    output.scrollTop = output.scrollHeight;
}

async function runConsoleCommand(command) {
    try {
        const response = await fetch("/api/commands/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command }),
        });
        const payload = await response.json();
        appendConsoleLine(command, payload);
    } catch (error) {
        appendConsoleLine(command, { output: "", error: error.message });
    }
}

/* ---------- configuration ---------- */

function settingValue(path) {
    const setting = configurationSettings.find((item) => item.path === path);
    return setting ? setting.value : "";
}

function renderConfiguration(payload) {
    configurationSettings = payload.settings;

    document.getElementById("config-host").value = settingValue("server.host");
    document.getElementById("config-port").value = settingValue("server.port");
    document.getElementById("config-enabled").checked = Boolean(settingValue("server.enabled"));

    document.getElementById("configuration-restart").hidden = !payload.restart_required;
}

async function loadConfiguration() {
    const errorBox = document.getElementById("configuration-error");
    errorBox.hidden = true;

    try {
        renderConfiguration(await getJson("/api/configuration"));
    } catch (error) {
        errorBox.textContent = `Configuration could not be loaded: ${error.message}`;
        errorBox.hidden = false;
    }
}

async function handleConfigurationSubmit(event) {
    event.preventDefault();

    const errorBox = document.getElementById("configuration-error");
    errorBox.hidden = true;

    const fields = [
        ["server.host", document.getElementById("config-host").value.trim()],
        ["server.port", document.getElementById("config-port").value],
        ["server.enabled", document.getElementById("config-enabled").checked],
    ];
    // only changed fields are sent - the API (like the CLI) saves one setting at
    // a time, so an untouched field is never re-validated or re-written
    const changed = fields.filter(([path, value]) => String(value) !== String(settingValue(path)));
    if (changed.length === 0) {
        return;
    }

    const button = document.getElementById("configuration-save");
    button.disabled = true;

    for (const [path, value] of changed) {
        const [section, key] = path.split(".");
        try {
            // rendered as each field saves, so a field that succeeded before one
            // that failed is reflected correctly rather than left showing stale
            // pre-save state
            renderConfiguration(await postJson("/api/configuration", { section, key, value }));
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            break;
        }
    }

    button.disabled = false;
}

/* ---------- active sessions ----------
 *
 * Every session AuthStore currently considers valid (see starcore/auth.py) -
 * a browser's own "web" session and, once a StarCore mobile app exists,
 * whatever "mobile" sessions it has established by logging in the same way
 * a browser does (see docs/locked_folder.md). This never sees a token, only
 * the opaque session_id list_sessions() reports - revoking asks for that id,
 * never the token itself. */

function formatSessionTime(epochSeconds) {
    if (!epochSeconds) {
        return "—";
    }
    return new Date(epochSeconds * 1000).toLocaleString();
}

async function loadSessions() {
    const errorBox = document.getElementById("sessions-error");
    errorBox.hidden = true;

    try {
        const payload = await getJson("/api/auth/sessions");
        renderSessions(payload.sessions);
    } catch (error) {
        errorBox.textContent = `Sessions could not be loaded: ${error.message}`;
        errorBox.hidden = false;
    }
}

function renderSessions(sessions) {
    const container = document.getElementById("sessions-list");
    container.replaceChildren();

    if (!sessions.length) {
        container.appendChild(element("p", "muted", "No active sessions."));
        return;
    }

    for (const session of sessions) {
        const row = element("div", "session-row");

        const info = element("div", "session-info");
        const title = session.device_name || (session.kind === "mobile" ? "Mobile device" : "Browser");
        info.appendChild(element("span", "session-title", title));
        info.appendChild(element("span", `badge badge-type`, session.kind));
        if (session.current) {
            info.appendChild(element("span", "badge badge-up", "this device"));
        }
        row.appendChild(info);

        row.appendChild(element("span", "session-meta", `Signed in ${formatSessionTime(session.created)}`));

        const revoke = element("button", "button button-stop", session.current ? "Sign out" : "Revoke");
        revoke.type = "button";
        revoke.addEventListener("click", () => handleRevokeSession(session.session_id, revoke, session.current));
        row.appendChild(revoke);

        container.appendChild(row);
    }
}

async function handleRevokeSession(sessionId, button, isCurrent) {
    button.disabled = true;
    try {
        await postJson("/api/auth/sessions/revoke", { session_id: sessionId });
        if (isCurrent) {
            // the same session this browser is using - reloading lands back
            // on the login screen, exactly like the Logout button does
            location.reload();
            return;
        }
        await loadSessions();
    } catch (error) {
        const errorBox = document.getElementById("sessions-error");
        errorBox.textContent = error.message;
        errorBox.hidden = false;
        button.disabled = false;
    }
}

/* ---------- satellite lifecycle: enable, disable, reload ----------
 *
 * Just as generic as satellite configuration below: every satellite gets a
 * reload button and an enable/disable button, native or link, whether or not
 * it has a background service at all - the Core's set_satellite_enabled()
 * and reload_satellite() are what actually run, and neither this file nor
 * the Core has to know anything Photo- or Music-specific to offer them. */

function reloadIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.appendChild(shape("path", { d: "M12.8 5.2A5.4 5.4 0 1 0 13.6 9" }));
    svg.appendChild(shape("path", { d: "M12.6 2.6v3h-3" }));
    return svg;
}

function powerIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.appendChild(shape("path", { d: "M8 2.6v5.2" }));
    svg.appendChild(shape("path", { d: "M4.6 4.4a5.4 5.4 0 1 0 6.8 0" }));
    return svg;
}

// action is "enable", "disable" or "reload" - each is a reserved route
// segment the Core handles directly (see docs/api.md), never a satellite's
// own route, so this is the one function every lifecycle control goes through
async function runSatelliteAction(satellite, action) {
    const key = `${satellite.name}:${action}`;
    if (pendingSatelliteActions.has(key)) {
        return;
    }

    pendingSatelliteActions.add(key);
    renderSatelliteList();
    updateSatelliteReloadButton();
    updateSatelliteToggleButton();

    // do not fake success: the badge and every button reflect satellite.enabled
    // from the Core's own response after refresh() below, never an assumption
    // that the request worked - and the banner itself is only shown after that
    // refresh, since refresh() would otherwise immediately clear it again
    let message;
    let kind = "notice";
    try {
        const result = await postJson(satelliteUrl(satellite.name, `/${action}`), {});
        if (result.error) {
            message = `${satellite.name}: ${result.error}`;
            kind = "error";
        } else {
            message = `${satellite.name} ${action === "reload" ? "reloaded" : `${action}d`}.`;
        }
    } catch (error) {
        message = `${satellite.name}: ${error.message}`;
        kind = "error";
    } finally {
        pendingSatelliteActions.delete(key);
        await refresh();
        showBanner(message, kind);
    }
}

function buildReloadButton(satellite) {
    const pending = pendingSatelliteActions.has(`${satellite.name}:reload`);
    const button = element("button", "icon-button");
    button.type = "button";
    button.title = `Reload ${satellite.name}`;
    button.dataset.developer = "";  // lifecycle detail: Developer Mode only
    button.disabled = pending;
    button.appendChild(reloadIcon());
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        runSatelliteAction(satellite, "reload");
    });
    return button;
}

function buildToggleButton(satellite) {
    const action = satellite.enabled ? "disable" : "enable";
    const pending = pendingSatelliteActions.has(`${satellite.name}:${action}`);
    const button = element("button", "icon-button");
    button.classList.toggle("icon-button-alert", satellite.enabled);
    button.type = "button";
    button.title = `${satellite.enabled ? "Disable" : "Enable"} ${satellite.name}`;
    button.disabled = pending;
    button.appendChild(powerIcon());
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        runSatelliteAction(satellite, action);
    });
    return button;
}

// shown in the topbar for any satellite route, in addition to the same two
// buttons already on its card in the list - so the controls are reachable
// both from the overview and from the satellite's own page (including a
// satellite that ships a custom Mission Control page of its own)
function updateSatelliteReloadButton() {
    const button = document.getElementById("satellite-reload-button");
    const satellite = route.name === "satellite" ? findSatellite(route.satellite) : null;

    if (!satellite) {
        button.hidden = true;
        button.onclick = null;
        return;
    }

    button.hidden = false;
    button.disabled = pendingSatelliteActions.has(`${satellite.name}:reload`);
    button.title = `Reload ${satellite.name}`;
    button.onclick = () => runSatelliteAction(satellite, "reload");
}

function updateSatelliteToggleButton() {
    const button = document.getElementById("satellite-toggle-button");
    const satellite = route.name === "satellite" ? findSatellite(route.satellite) : null;

    if (!satellite) {
        button.hidden = true;
        button.onclick = null;
        return;
    }

    const action = satellite.enabled ? "disable" : "enable";
    button.hidden = false;
    button.disabled = pendingSatelliteActions.has(`${satellite.name}:${action}`);
    button.title = `${satellite.enabled ? "Disable" : "Enable"} ${satellite.name}`;
    button.classList.toggle("icon-button-alert", satellite.enabled);
    button.onclick = () => runSatelliteAction(satellite, action);
}

/* ---------- satellite configuration ----------
 *
 * Generic for any satellite: whether one has configuration at all comes from
 * satellite.configurable (the Core's own generic discovery - see payloads.py),
 * and what its settings are comes entirely from GET/POST
 * /api/satellites/<name>/configuration, which every satellite answers for
 * itself. Nothing here knows what any particular satellite's settings mean. */

// the shared Settings gear (.sc-gear in core.css), sized for card and topbar buttons
function gearIcon() {
    const gear = element("i", "sc-gear");
    gear.setAttribute("aria-hidden", "true");
    return gear;
}

function buildConfigButton(satellite, extraClass) {
    const button = element("button", extraClass ? `icon-button ${extraClass}` : "icon-button");
    button.type = "button";
    button.title = `${satellite.name} configuration`;
    button.setAttribute("aria-label", button.title);
    button.appendChild(gearIcon());
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        openSatelliteConfig(satellite);
    });
    return button;
}

// shown in the topbar whenever the current route is a configurable satellite's
// page, in addition to the same button already on its card in the list
// Developer Mode only: a Satellite with both a ui.json and a page.js can be shown either way
function updateSatelliteOwnPageButton() {
    const button = document.getElementById("satellite-classic-button");
    const satellite = route.name === "satellite" ? findSatellite(route.satellite) : null;
    if (!satellite || !satellite.page || !hasUiDocument(satellite)) {
        button.hidden = true;
        button.onclick = null;
        return;
    }
    const chosen = ownPagePreferred().has(satellite.name);
    button.hidden = false;
    button.setAttribute("aria-pressed", String(chosen));
    button.title = chosen ? "Show the shared interface (ui.json)" : "Show the Satellite's own page (page.js)";
    button.setAttribute("aria-label", button.title);
    button.onclick = () => {
        const names = ownPagePreferred();
        if (names.has(satellite.name)) {
            names.delete(satellite.name);
        } else {
            names.add(satellite.name);
        }
        try {
            localStorage.setItem(OWN_PAGE_KEY, JSON.stringify([...names]));
        } catch {
            // without storage the choice lasts until the page is reloaded
        }
        updateSatelliteOwnPageButton();
        renderSatellitePage();
    };
}

developerContext.subscribe(() => {
    updateSatelliteOwnPageButton();
    if (route.name === "satellite") {
        renderSatellitePage();
    }
});

function updateSatelliteConfigButton() {
    updateSatelliteOwnPageButton();
    const button = document.getElementById("satellite-config-button");
    const satellite = route.name === "satellite" ? findSatellite(route.satellite) : null;

    if (!satellite || !satellite.configurable) {
        button.hidden = true;
        button.onclick = null;
        return;
    }

    button.hidden = false;
    button.onclick = () => openSatelliteConfig(satellite);
}

function openSatelliteConfig(satellite) {
    satelliteConfigState = { satellite, settings: [] };

    setText("satellite-config-title", `${satellite.name} configuration`);
    document.getElementById("satellite-config-error").hidden = true;
    document.getElementById("satellite-config-note").hidden = true;
    document.getElementById("satellite-config-overlay").hidden = false;

    loadSatelliteConfig(satellite);
}

function closeSatelliteConfig() {
    document.getElementById("satellite-config-overlay").hidden = true;
    satelliteConfigState = null;
}

async function loadSatelliteConfig(satellite) {
    const fields = document.getElementById("satellite-config-fields");
    fields.replaceChildren(element("p", "muted", "Loading…"));

    try {
        renderSatelliteConfig(await getJson(satelliteUrl(satellite.name, "/configuration")));
    } catch (error) {
        fields.replaceChildren();
        showSatelliteConfigError(`Configuration could not be loaded: ${error.message}`);
    }
}

function renderSatelliteConfig(payload) {
    // the modal can be closed (or reopened on a different satellite) while a
    // request from the one before it is still in flight
    if (!satelliteConfigState) {
        return;
    }

    satelliteConfigState.settings = payload.settings || [];

    const fields = document.getElementById("satellite-config-fields");
    fields.replaceChildren();
    for (const setting of satelliteConfigState.settings) {
        fields.appendChild(markDeveloper(buildConfigField(setting), setting));
    }
    const advanced = satelliteConfigState.settings.filter((setting) => setting.developer).length;
    if (advanced) {
        fields.appendChild(developerHint(advanced));
    }

    const note = document.getElementById("satellite-config-note");
    if (payload.note) {
        note.textContent = payload.note;
        note.hidden = false;
    } else if (payload.restart_required) {
        note.textContent = "Saved. A restart may be required for this to take effect.";
        note.hidden = false;
    } else {
        note.hidden = true;
    }
}

function showSatelliteConfigError(message) {
    const errorBox = document.getElementById("satellite-config-error");
    errorBox.textContent = message;
    errorBox.hidden = false;
}

// one field per setting, its input type inferred from the current value - a
// satellite's settings can be anything, so the form has to be built from
// whatever shape the response actually has rather than a fixed template
function buildConfigField(setting) {
    const id = `satellite-config-${setting.key}`;

    if (typeof setting.value === "boolean") {
        const wrapper = element("label", "config-checkbox");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "sc-switch";
        input.setAttribute("role", "switch");
        input.id = id;
        input.dataset.key = setting.key;
        input.checked = setting.value;
        wrapper.append(input, element("span", null, label(setting.key)));
        if (setting.description) {
            wrapper.appendChild(element("p", "hint", setting.description));
        }
        return wrapper;
    }

    const wrapper = element("div", "config-field");
    const fieldLabel = element("label", null, label(setting.key));
    fieldLabel.htmlFor = id;

    const input = document.createElement("input");
    input.id = id;
    input.dataset.key = setting.key;
    input.autocomplete = "off";
    input.spellcheck = false;

    if (typeof setting.value === "number") {
        input.type = "number";
        input.value = String(setting.value);
    } else {
        input.type = "text";
        input.value = setting.value ?? "";
    }

    wrapper.appendChild(fieldLabel);

    // a "path"-typed setting gets a "Browse…" button that opens a directory
    // picker backed by whichever Satellite provides the files.browse
    // capability (docs/ui-contract.md) - this form never names one
    const browser = setting.type === "path" ? findCapabilityProvider("files.browse") : null;
    if (browser && browser.operations.list) {
        const row = element("div", "config-field-row");
        const browse = element("button", "button", "Browse…");
        browse.type = "button";
        browse.addEventListener("click", () => {
            openDirectoryPicker(input.value, (chosen) => {
                input.value = chosen;
            });
        });
        row.append(input, browse);
        wrapper.appendChild(row);
    } else {
        wrapper.appendChild(input);
    }

    if (setting.description) {
        wrapper.appendChild(element("p", "hint", setting.description));
    }
    return wrapper;
}

function fieldValue(setting) {
    const input = document.getElementById(`satellite-config-${setting.key}`);
    return input.type === "checkbox" ? input.checked : input.value;
}

async function handleSatelliteConfigSubmit(event) {
    event.preventDefault();
    if (!satelliteConfigState) {
        return;
    }

    const { satellite, settings } = satelliteConfigState;
    document.getElementById("satellite-config-error").hidden = true;

    // only changed fields are sent - the satellite (like the Core's own
    // configuration) saves one setting at a time, so an untouched field is
    // never re-validated or re-written
    const changed = settings.filter((setting) => String(fieldValue(setting)) !== String(setting.value))
        .map((setting) => [setting.key, fieldValue(setting)]);
    if (changed.length === 0) {
        return;
    }

    const button = document.getElementById("satellite-config-save");
    button.disabled = true;

    for (const [key, value] of changed) {
        try {
            renderSatelliteConfig(await postJson(satelliteUrl(satellite.name, "/configuration"), { key, value }));
        } catch (error) {
            showSatelliteConfigError(error.message);
            break;
        }
    }

    button.disabled = false;
}

/* ---------- directory picker ----------
 *
 * Opened from any "path"-typed configuration field (see buildConfigField
 * above). It browses through the files.browse capability's "list"
 * operation - whichever Satellite provides it - so a directory
 * can be chosen without retyping a path by hand. Nothing here is specific to
 * Photo, Music, or any other caller: it just hands back whatever absolute
 * path the user picked. */

function openDirectoryPicker(initialPath, onChoose) {
    directoryPickerState = { onChoose, path: "", parent: null };

    document.getElementById("directory-picker-error").hidden = true;
    document.getElementById("directory-picker-overlay").hidden = false;
    document.getElementById("directory-picker-choose").disabled = true;

    // an already-typed absolute path is opened directly so the picker starts
    // where the field already points; anything else (empty, relative, or a
    // path that turns out not to exist) just falls back to the roots list
    const start = typeof initialPath === "string" && initialPath.trim() ? initialPath.trim() : "";
    loadDirectoryPicker(start, /* fallbackToRoots */ true);
}

function closeDirectoryPicker() {
    document.getElementById("directory-picker-overlay").hidden = true;
    directoryPickerState = null;
}

async function loadDirectoryPicker(path, fallbackToRoots = false) {
    const list = document.getElementById("directory-picker-list");
    list.replaceChildren(element("p", "dir-picker-empty", "Loading…"));

    try {
        const browser = findCapabilityProvider("files.browse");
        if (!browser || !browser.operations.list) {
            throw new Error("No enabled Satellite provides files.browse any more.");
        }
        const payload = await getJson(satelliteUrl(browser.satellite.name,
            `/${browser.operations.list}?path=${encodeURIComponent(path)}`));
        renderDirectoryPicker(payload);
    } catch (error) {
        if (fallbackToRoots && path !== "") {
            loadDirectoryPicker("", false);
            return;
        }
        list.replaceChildren();
        showDirectoryPickerError(error.message);
    }
}

function renderDirectoryPicker(payload) {
    // the picker can be closed (or the field it was opened from can vanish
    // with the whole modal) while a request from before is still in flight
    if (!directoryPickerState) {
        return;
    }

    directoryPickerState.path = payload.path;
    directoryPickerState.parent = payload.parent;
    document.getElementById("directory-picker-error").hidden = true;
    document.getElementById("directory-picker-current").textContent = payload.path || "Computer";
    document.getElementById("directory-picker-choose").disabled = payload.path === "";

    const breadcrumb = document.getElementById("directory-picker-breadcrumb");
    breadcrumb.replaceChildren(buildDirectoryPickerCrumb("Computer", ""));
    if (payload.path) {
        for (const segment of directoryPickerSegments(payload.path)) {
            breadcrumb.append(
                element("span", "dir-picker-crumb-sep", "/"),
                buildDirectoryPickerCrumb(segment.label, segment.path),
            );
        }
    }

    const directories = (payload.entries || []).filter((entry) => entry.type === "dir");
    const list = document.getElementById("directory-picker-list");
    list.replaceChildren();

    if (directories.length === 0) {
        list.appendChild(element("p", "dir-picker-empty", "No subdirectories here."));
        return;
    }

    for (const entry of directories) {
        // at the roots level an entry's name IS the absolute path already
        // (e.g. "/", or "C:\") - everywhere else it's a bare name that has to
        // be joined onto the directory being shown (the files.browse protocol,
        // which every provider follows - see docs/ui-contract.md)
        const target = payload.path === "" ? entry.name : joinDirectoryPickerPath(payload.path, entry.name);
        const row = element("button", "dir-picker-row");
        row.type = "button";
        row.appendChild(element("span", null, entry.name));
        row.addEventListener("click", () => loadDirectoryPicker(target));
        list.appendChild(row);
    }
}

function buildDirectoryPickerCrumb(text, path) {
    const button = element("button", "dir-picker-crumb", text);
    button.type = "button";
    button.addEventListener("click", () => loadDirectoryPicker(path));
    return button;
}

// splits an absolute path into breadcrumb segments without branching on the
// platform - both POSIX ("/a/b") and Windows ("C:\a\b") paths are just a
// leading anchor followed by "/"-or-"\"-separated names
function directoryPickerSegments(path) {
    const normalized = path.replace(/\\/g, "/");
    const match = normalized.match(/^([A-Za-z]:\/|\/)(.*)$/);
    if (!match) {
        return [];
    }

    const [, anchor, rest] = match;
    const names = rest.split("/").filter(Boolean);
    const segments = [];
    let current = anchor;

    for (const name of names) {
        current = joinDirectoryPickerPath(current, name);
        segments.push({ label: name, path: current });
    }

    return segments;
}

function joinDirectoryPickerPath(base, name) {
    const normalized = base.replace(/\\/g, "/");
    return normalized.endsWith("/") ? `${normalized}${name}` : `${normalized}/${name}`;
}

function showDirectoryPickerError(message) {
    const errorBox = document.getElementById("directory-picker-error");
    errorBox.textContent = message;
    errorBox.hidden = false;
}

function chooseDirectoryPickerCurrent() {
    if (!directoryPickerState || !directoryPickerState.path) {
        return;
    }

    directoryPickerState.onChoose(directoryPickerState.path);
    closeDirectoryPicker();
}

/* ---------- shutdown ---------- */

// the topbar's icon buttons only spell out a label while they need one
function setButtonLabel(button, text) {
    button.querySelector(".sc-icon-button-label").textContent = text;
}

function setStopButtonConfirming(confirming) {
    const button = document.getElementById("stop-button");
    button.classList.toggle("confirm", confirming);
    setButtonLabel(button, confirming ? "Confirm stop?" : "");
}

async function handleStopClick() {
    const button = document.getElementById("stop-button");

    if (!button.classList.contains("confirm")) {
        setStopButtonConfirming(true);
        confirmStopTimer = setTimeout(() => setStopButtonConfirming(false), STOP_CONFIRM_MS);
        return;
    }

    clearTimeout(confirmStopTimer);
    button.disabled = true;
    setButtonLabel(button, "Stopping…");

    try {
        await fetch("/api/shutdown", { method: "POST" });
    } catch (error) {
        // the connection can drop as part of the shutdown itself; that's expected
    }

    onStarCoreStopped();
}

let confirmRestartTimer = null;

function setRestartButtonConfirming(confirming) {
    const button = document.getElementById("restart-button");
    button.classList.toggle("confirm", confirming);
    setButtonLabel(button, confirming ? "Confirm restart?" : "");
}

async function handleRestartClick() {
    const button = document.getElementById("restart-button");

    if (!button.classList.contains("confirm")) {
        setRestartButtonConfirming(true);
        confirmRestartTimer = setTimeout(() => setRestartButtonConfirming(false), STOP_CONFIRM_MS);
        return;
    }

    clearTimeout(confirmRestartTimer);
    button.disabled = true;
    document.getElementById("stop-button").disabled = true;
    button.classList.remove("confirm");
    setButtonLabel(button, "Restarting…");

    try {
        await fetch("/api/restart", { method: "POST" });
    } catch (error) {
        // the connection drops as part of the restart itself; that's expected
    }

    // unlike a plain stop, StarCore comes back on its own - refresh() keeps
    // polling on its normal schedule and clears this banner itself the
    // moment the new process answers again, no reload needed
    showBanner("StarCore is restarting. This page will reconnect automatically.", "notice");

    const check = setInterval(async () => {
        try {
            await getJson("/api/status");
            clearInterval(check);
            setButtonLabel(button, "");
            button.disabled = false;
            document.getElementById("stop-button").disabled = false;
            refresh(); // clears the "restarting" banner immediately rather than
                       // waiting for the next scheduled poll
        } catch (error) {
            // still restarting - keep waiting
        }
    }, 1000);
}

function onStarCoreStopped() {
    stopped = true;
    clearInterval(pollTimer);

    const state = document.getElementById("core-state");
    state.textContent = "stopped";
    state.className = "badge badge-down";

    document.getElementById("stop-button").classList.remove("confirm");
    setButtonLabel(document.getElementById("stop-button"), "");
    setHomeState("off", "Stopped", "StarCore was stopped from Mission Control.");
    setLink(false);
    setText("link-state", "System stopped");
    showBanner("StarCore has been stopped from Mission Control. You can close this page.", "notice");

    document.getElementById("console-input").disabled = true;
    document.getElementById("console-form").querySelector("button[type=submit]").disabled = true;
    // the process is gone for good after a plain stop (unlike a restart) -
    // there's nothing left to restart via the API
    document.getElementById("restart-button").disabled = true;
}

/* ---------- mobile sidebar ---------- */

// only meaningful on phone-width viewports, where the sidebar is a
// slide-in overlay (see the ≤600px rules in style.css) rather than the
// permanently-visible column it is everywhere else
const MOBILE_SIDEBAR_QUERY = "(max-width: 600px)";

function openSidebar() {
    document.body.classList.add("sidebar-open");
    const toggle = document.getElementById("sidebar-toggle");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Close menu");
}

function closeSidebar() {
    document.body.classList.remove("sidebar-open");
    const toggle = document.getElementById("sidebar-toggle");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open menu");
}

function toggleSidebar() {
    if (document.body.classList.contains("sidebar-open")) {
        closeSidebar();
    } else {
        openSidebar();
    }
}

/* ---------- wiring ---------- */

for (const item of document.querySelectorAll(".nav-item[data-route]")) {
    item.addEventListener("click", () => {
        location.hash = `#/${item.dataset.route}`;
    });
}

document.getElementById("console-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("console-input");
    const command = input.value.trim();
    if (!command) {
        return;
    }
    input.value = "";
    runConsoleCommand(command);
});

document.getElementById("console-clear").addEventListener("click", resetConsole);
document.getElementById("configuration-form").addEventListener("submit", handleConfigurationSubmit);
document.getElementById("about-copy").addEventListener("click", handleCopyBuildInfo);
document.getElementById("satellite-config-form").addEventListener("submit", handleSatelliteConfigSubmit);
document.getElementById("satellite-config-close").addEventListener("click", closeSatelliteConfig);
document.getElementById("satellite-config-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
        closeSatelliteConfig();
    }
});
document.getElementById("directory-picker-close").addEventListener("click", closeDirectoryPicker);
document.getElementById("directory-picker-choose").addEventListener("click", chooseDirectoryPickerCurrent);
document.getElementById("directory-picker-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
        closeDirectoryPicker();
    }
});
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
        return;
    }
    if (!document.getElementById("accent-menu").hidden) {
        toggleAccentMenu(false);
        document.getElementById("accent-button").focus();
    } else if (!document.getElementById("directory-picker-overlay").hidden) {
        closeDirectoryPicker();
    } else if (!document.getElementById("satellite-config-overlay").hidden) {
        closeSatelliteConfig();
    } else if (document.body.classList.contains("sidebar-open")) {
        closeSidebar();
    }
});
document.getElementById("stop-button").addEventListener("click", handleStopClick);
document.getElementById("rediscover-button").addEventListener("click", handleRediscoverClick);
document.getElementById("restart-button").addEventListener("click", handleRestartClick);
document.getElementById("logout-button").addEventListener("click", handleLogoutClick);
document.getElementById("developer-button").addEventListener("click", () => {
    setDeveloperMode(!developerMode);
});
document.getElementById("accent-button").addEventListener("click", () => {
    toggleAccentMenu(document.getElementById("accent-menu").hidden);
});
document.addEventListener("click", (event) => {
    if (!event.target.closest(".accent-picker")) {
        toggleAccentMenu(false);
    }
});
window.addEventListener("hashchange", applyRoute);

document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
document.getElementById("sidebar-backdrop").addEventListener("click", closeSidebar);
// covers every nav item, including the satellite pages rendered later by
// renderSatelliteNav() - and closes the sidebar even when tapping the item
// for the page already showing, when the hash doesn't change and applyRoute()
// never runs
document.querySelector(".sidebar").addEventListener("click", (event) => {
    if (event.target.closest(".nav-item")) {
        closeSidebar();
    }
});
// if the viewport grows past the phone breakpoint while the sidebar happens
// to be open, drop the "open" state so it doesn't linger once the sidebar is
// back to being permanently visible rather than an overlay
const mobileSidebarQuery = window.matchMedia(MOBILE_SIDEBAR_QUERY);
mobileSidebarQuery.addEventListener("change", (event) => {
    if (!event.matches) {
        closeSidebar();
    }
});

initAuth();

/* ---------- authentication gate ---------- */

function showAppShell(visible) {
    document.querySelector(".sidebar").hidden = !visible;
    document.querySelector(".main").hidden = !visible;
}

async function loadAccount() {
    try {
        const status = await getJson("/api/auth/status");
        accountName = status.username || "";
    } catch (error) {
        accountName = "";
    }
    // per account: known only now, so a deep link to a developer page is checked again here
    setDeveloperMode(storedDeveloperMode(), false);
    applyRoute();
    // a page that mounted before this was known may have fallen back from a developer section
    if (developerMode && mounted && route.section && mounted.cleanup
        && typeof mounted.cleanup.showSection === "function") {
        mounted.cleanup.showSection(route.section);
    }
    if (route.name === "overview") {
        setText("page-title", greeting());
    }
}

function startApp() {
    resetConsole();
    applyRoute();
    loadAccount();
    loadCommands();
    refresh();
    pollTimer = setInterval(refresh, REFRESH_MS);
    startAudioHost();
}

// the shared audio player (media/host.js, docs/media-audio.md): on every page from sign-in on,
// playing from whichever Satellite the catalog lists as an audio library. A module, so it
// loads on its own; without it (an older browser) Mission Control works as before, silent.
function startAudioHost() {
    import("/media/host.js").then((host) => host.start()).catch((error) => console.warn("audio host:", error));
}

function setAuthMode(bootstrapped, setupCodeRequired = false) {
    document.getElementById("auth-title").textContent = bootstrapped
        ? "Sign in" : "Create the administrator account";
    document.getElementById("auth-subtitle").textContent = bootstrapped
        ? "Sign in to StarCore Mission Control."
        : "This StarCore install has no administrator account yet. Create one to continue - it's the only account needed to manage everything below.";
    document.getElementById("auth-submit").textContent = bootstrapped ? "Sign in" : "Create account";
    document.getElementById("auth-password").autocomplete = bootstrapped ? "current-password" : "new-password";
    // a fresh install reached from another device (or through the HTTPS
    // proxy) only accepts setup with the one-time code from its startup output
    const codeNeeded = !bootstrapped && setupCodeRequired;
    document.getElementById("auth-setup-code-field").hidden = !codeNeeded;
    document.getElementById("auth-setup-code").required = codeNeeded;
}

// gates the whole app behind a session: shown once at boot, before anything
// else touches the API - every other endpoint already enforces this
// server-side (see starcore.api.server._authorized), this is purely so the
// UI itself doesn't sit there showing empty cards and 401 errors
async function initAuth() {
    let status;
    try {
        status = await getJson("/api/auth/status");
    } catch (error) {
        // StarCore isn't reachable at all yet - show the app shell anyway so
        // the normal "Cannot reach StarCore" banner (from refresh()) explains
        // why, rather than a login form that could never succeed either way
        showAppShell(true);
        startApp();
        return;
    }

    if (status.authenticated) {
        showAppShell(true);
        startApp();
        return;
    }

    showAppShell(false);
    document.getElementById("auth-overlay").hidden = false;
    setAuthMode(status.bootstrapped, status.setup_code_required);
    document.getElementById("auth-username").focus();

    document.getElementById("auth-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const errorBox = document.getElementById("auth-error");
        errorBox.hidden = true;

        const username = document.getElementById("auth-username").value.trim();
        const password = document.getElementById("auth-password").value;
        const submit = document.getElementById("auth-submit");
        submit.disabled = true;

        try {
            const body = { username, password };
            if (!status.bootstrapped && status.setup_code_required) {
                body.setup_code = document.getElementById("auth-setup-code").value.trim();
            }
            await postJson(status.bootstrapped ? "/api/auth/login" : "/api/auth/setup", body);
            document.getElementById("auth-overlay").hidden = true;
            showAppShell(true);
            startApp();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            submit.disabled = false;
        }
    });
}

async function handleLogoutClick() {
    try {
        await postJson("/api/auth/logout");
    } catch (error) {
        // the session may already be gone server-side; reloading either way
        // lands back on the login screen, which is the goal either way
    }
    location.reload();
}
