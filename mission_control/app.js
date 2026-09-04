const REFRESH_MS = 5000;
const STOP_CONFIRM_MS = 4000;

const CORE_PAGES = {
    overview: "Overview",
    satellites: "Satellites",
    console: "Console",
    configuration: "Configuration",
};

let pollTimer = null;
let confirmStopTimer = null;
let stopped = false;
let satellites = [];
let navSignature = "";
let route = { name: "overview", satellite: null };
let mounted = null;
let configurationSettings = [];
let satelliteConfigState = null;
let directoryPickerState = null;
// "<name>:enable" | "<name>:disable" | "<name>:reload" while a lifecycle
// request is in flight, so a card or topbar button re-rendered mid-request
// (the 5s poll doesn't wait for one to finish) still shows as busy instead of
// silently becoming clickable again
let pendingSatelliteActions = new Set();

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
    setText("link-state", reachable ? "link established" : "link lost");
}

// a satellite earns its own page by shipping one, or by publishing state through
// the state.py convention; satellites that do neither stay list-only
function hasPage(satellite) {
    return Boolean(satellite.page) || Object.keys(satellite.state || {}).length > 0;
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
        const img = document.createElement("img");
        img.src = satelliteUrl(satellite.name, `/assets/${satellite.icon}`);
        img.alt = "";
        img.addEventListener("error", () => {
            img.replaceWith(buildGenericIcon());
        });
        wrapper.appendChild(img);
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
    const [name, param] = location.hash.replace(/^#\/?/, "").split("/");

    if (name === "satellite" && param) {
        route = { name: "satellite", satellite: decodeURIComponent(param) };
    } else if (name in CORE_PAGES) {
        route = { name, satellite: null };
    } else {
        route = { name: "overview", satellite: null };
    }

    showRoute();
}

function showRoute() {
    const view = route.name === "satellite" ? "satellite" : route.name;

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
        setText("page-eyebrow", "Core");
        setText("page-title", CORE_PAGES[route.name]);
        if (route.name === "configuration") {
            loadConfiguration();
        }
    }

    updateSatelliteConfigButton();
    updateSatelliteReloadButton();
    updateSatelliteToggleButton();
}

/* ---------- core ---------- */

function renderCore(status) {
    document.title = `${status.engine} Mission Control`;

    const state = document.getElementById("core-state");
    state.textContent = status.running ? "running" : "stopped";
    state.className = `badge ${status.running ? "badge-up" : "badge-down"}`;

    document.getElementById("tile-state-dot").className = `state-dot ${status.running ? "on" : "off"}`;
    setText("tile-state", status.running ? "running" : "stopped");
    setText("tile-uptime", formatUptime(status.uptime_seconds));
    setText("tile-satellites", String(status.satellites.total));
    setText("tile-satellites-split", `${status.satellites.native} native · ${status.satellites.link} link`);
    setText("tile-commands", String(status.commands));

    setText("fact-engine", status.engine);
    setText("fact-mission-control", status.mission_control.url || (status.mission_control.enabled ? "not running" : "disabled"));
    setText("fact-interface", status.mission_control.running ? "running" : "stopped");
    setText("fact-native", String(status.satellites.native));
    setText("fact-link", String(status.satellites.link));
    setText("updated", new Date().toLocaleTimeString());
}

// native satellites hold the inner orbit, link satellites the outer one - each
// ring is its own <g> (see index.html) so the two can spin independently
// (different speeds, opposite directions - see .orbit-spin-native/-link)
function renderOrbit() {
    for (const [type, radius, phase, groupId] of [
        ["native", 58, -1.4, "orbit-bodies-native"],
        ["link", 88, 0.7, "orbit-bodies-link"],
    ]) {
        const bodies = document.getElementById(groupId);
        bodies.replaceChildren();
        const members = satellites.filter((satellite) => satellite.type === type);

        members.forEach((satellite, index) => {
            const angle = (index / members.length) * Math.PI * 2 + phase;
            const body = shape("circle", {
                cx: (110 + Math.cos(angle) * radius).toFixed(1),
                cy: (110 + Math.sin(angle) * radius).toFixed(1),
                r: 4,
                class: `orbit-body ${type} status-${satellite.status || "unknown"}${satellite.status === "running" ? "" : " off"}`,
                tabindex: "0",
                role: "img",
            });
            // one real, generic status string - never hardcoded per-satellite
            // text - shown on hover and via a native tooltip on keyboard focus
            body.setAttribute("aria-label", `${satellite.name} — ${satellite.status || "unknown"}`);

            const title = shape("title", {});
            title.textContent = `${satellite.name} — ${satellite.status || "unknown"}`;
            body.appendChild(title);
            bodies.appendChild(body);
        });
    }
}

/* ---------- satellites ---------- */

function renderSatelliteNav() {
    const pages = satellites.filter(hasPage);
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
    head.appendChild(element("span", "badge badge-type", satellite.type));
    head.appendChild(buildStatusBadge(satellite));

    const actions = element("div", "card-actions");
    if (satellite.configurable) {
        actions.appendChild(buildConfigButton(satellite));
    }
    actions.appendChild(buildReloadButton(satellite));
    actions.appendChild(buildToggleButton(satellite));
    head.appendChild(actions);

    card.appendChild(head);

    card.appendChild(element("p", "card-meta", `v${satellite.version} · ${satellite.author}`));
    if (satellite.description) {
        card.appendChild(element("p", "description", satellite.description));
    }

    card.appendChild(renderCommands(satellite.commands));

    if (hasPage(satellite)) {
        const link = element("button", "card-link", "Open page →");
        link.type = "button";
        link.addEventListener("click", () => {
            location.hash = `#/satellite/${encodeURIComponent(satellite.name)}`;
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
    if (mounted && mounted.name === satellite.name) {
        return;
    }

    unmountSatellitePage();
    mounted = { name: satellite.name, cleanup: null };
    container.replaceChildren();

    if (satellite.page.stylesheet) {
        loadStylesheet(satelliteUrl(satellite.name, `/assets/${satellite.page.stylesheet}`));
    }

    try {
        const module = await import(satelliteUrl(satellite.name, `/assets/${satellite.page.module}`));
        if (!mounted || mounted.name !== satellite.name) {
            return;  // the user navigated away while the module was loading
        }
        mounted.cleanup = module.mount({
            element: container,
            satellite,
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

    document.getElementById("satellite-generic").hidden = Boolean(satellite.page);
    if (satellite.page) {
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
        renderOrbit();
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
    }
}

/* ---------- console: a web equivalent of the terminal CLI ---------- */

async function loadCommands() {
    try {
        const payload = await getJson("/api/commands");
        renderConsoleCommands(payload.commands);
        document.getElementById("overview-commands").replaceChildren(renderCommands(payload.commands));
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

function gearIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.appendChild(shape("circle", { cx: 8, cy: 8, r: 1.7 }));
    svg.appendChild(shape("path", {
        d: "M8 2.4v1.7M8 11.9v1.7M13.6 8h-1.7M4.1 8H2.4M11.7 4.3l-1.2 1.2M5.5 10.5l-1.2 1.2M11.7 11.7l-1.2-1.2M5.5 5.5 4.3 4.3",
    }));
    return svg;
}

function buildConfigButton(satellite, extraClass) {
    const button = element("button", extraClass ? `icon-button ${extraClass}` : "icon-button");
    button.type = "button";
    button.title = `${satellite.name} configuration`;
    button.appendChild(gearIcon());
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        openSatelliteConfig(satellite);
    });
    return button;
}

// shown in the topbar whenever the current route is a configurable satellite's
// page, in addition to the same button already on its card in the list
function updateSatelliteConfigButton() {
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
        fields.appendChild(buildConfigField(setting));
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
    // picker backed by the FileExplorer satellite's own /entries route - the
    // one, narrow exception to never hardcoding a satellite's name into this
    // generic form, since it's delegating to the satellite whose whole job is
    // generic filesystem browsing, not branching per caller (see docs/satellites.md)
    const fileExplorer = setting.type === "path" ? findSatellite("FileExplorer") : null;
    if (fileExplorer && fileExplorer.enabled) {
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
 * above). It browses through the FileExplorer satellite's own /entries
 * route - the same one its own Mission Control page uses - so a directory
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
        const payload = await getJson(satelliteUrl("FileExplorer", `/entries?path=${encodeURIComponent(path)}`));
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
        // be joined onto the directory being shown (see FileExplorer's own
        // page.js, which follows this same convention for the same reason)
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

function setStopButtonConfirming(confirming) {
    const button = document.getElementById("stop-button");
    button.classList.toggle("confirm", confirming);
    button.textContent = confirming ? "Confirm stop?" : "Stop StarCore";
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
    button.textContent = "Stopping…";

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
    button.textContent = confirming ? "Confirm restart?" : "Restart StarCore";
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
    button.textContent = "Restarting…";

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
            button.textContent = "Restart StarCore";
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

    document.getElementById("tile-state-dot").className = "state-dot off";
    setText("tile-state", "stopped");
    setLink(false);
    setText("link-state", "core stopped");
    showBanner("StarCore has been stopped from Mission Control. You can close this page.", "notice");

    document.getElementById("console-input").disabled = true;
    document.getElementById("console-form").querySelector("button[type=submit]").disabled = true;
    // the process is gone for good after a plain stop (unlike a restart) -
    // there's nothing left to restart via the API
    document.getElementById("restart-button").disabled = true;
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
    if (!document.getElementById("directory-picker-overlay").hidden) {
        closeDirectoryPicker();
    } else if (!document.getElementById("satellite-config-overlay").hidden) {
        closeSatelliteConfig();
    }
});
document.getElementById("stop-button").addEventListener("click", handleStopClick);
document.getElementById("restart-button").addEventListener("click", handleRestartClick);
document.getElementById("logout-button").addEventListener("click", handleLogoutClick);
window.addEventListener("hashchange", applyRoute);

initAuth();

/* ---------- authentication gate ---------- */

function showAppShell(visible) {
    document.querySelector(".sidebar").hidden = !visible;
    document.querySelector(".main").hidden = !visible;
}

function startApp() {
    resetConsole();
    applyRoute();
    loadCommands();
    refresh();
    pollTimer = setInterval(refresh, REFRESH_MS);
}

function setAuthMode(bootstrapped) {
    document.getElementById("auth-title").textContent = bootstrapped
        ? "Sign in" : "Create the administrator account";
    document.getElementById("auth-subtitle").textContent = bootstrapped
        ? "Sign in to StarCore Mission Control."
        : "This StarCore install has no administrator account yet. Create one to continue - it's the only account needed to manage everything below.";
    document.getElementById("auth-submit").textContent = bootstrapped ? "Sign in" : "Create account";
    document.getElementById("auth-password").autocomplete = bootstrapped ? "current-password" : "new-password";
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
    setAuthMode(status.bootstrapped);
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
            await postJson(status.bootstrapped ? "/api/auth/login" : "/api/auth/setup", { username, password });
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
