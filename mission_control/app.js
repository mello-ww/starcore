const REFRESH_MS = 5000;
const STOP_CONFIRM_MS = 4000;

const CORE_PAGES = {
    overview: "Overview",
    satellites: "Satellites",
    console: "Console",
};

let pollTimer = null;
let confirmStopTimer = null;
let stopped = false;
let satellites = [];
let navSignature = "";
let route = { name: "overview", satellite: null };
let mounted = null;

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
    }
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

// native satellites hold the inner orbit, link satellites the outer one
function renderOrbit() {
    const bodies = document.getElementById("orbit-bodies");
    bodies.replaceChildren();

    for (const [type, radius, phase] of [["native", 58, -1.4], ["link", 88, 0.7]]) {
        const members = satellites.filter((satellite) => satellite.type === type);

        members.forEach((satellite, index) => {
            const angle = (index / members.length) * Math.PI * 2 + phase;
            const body = shape("circle", {
                cx: (110 + Math.cos(angle) * radius).toFixed(1),
                cy: (110 + Math.sin(angle) * radius).toFixed(1),
                r: 4,
                class: `orbit-body ${type}${satellite.enabled ? "" : " off"}`,
            });

            const title = shape("title", {});
            title.textContent = `${satellite.name} (${type})`;
            body.appendChild(title);
            bodies.appendChild(body);
        });
    }
}

/* ---------- satellites ---------- */

function renderSatelliteNav() {
    const pages = satellites.filter(hasPage);
    const signature = pages.map((satellite) => `${satellite.name}:${satellite.enabled}`).join("|");
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
        button.title = satellite.name;
        button.appendChild(element("i", `dot${satellite.enabled ? " on" : ""}`));
        button.appendChild(element("span", null, satellite.name));
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
    head.appendChild(element("h3", null, satellite.name));
    head.appendChild(element("span", "badge badge-type", satellite.type));
    head.appendChild(element("span", `badge ${satellite.enabled ? "badge-up" : "badge-down"}`, satellite.enabled ? "enabled" : "disabled"));
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

function renderSatelliteList() {
    const container = document.getElementById("satellites");
    container.replaceChildren();

    setText("satellite-count", String(satellites.length));

    if (satellites.length === 0) {
        container.appendChild(element("p", "muted", "No satellites are loaded."));
        return;
    }

    for (const satellite of satellites) {
        container.appendChild(renderSatelliteCard(satellite));
    }
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

    const enabled = document.getElementById("satellite-enabled");
    enabled.textContent = satellite.enabled ? "enabled" : "disabled";
    enabled.className = `badge ${satellite.enabled ? "badge-up" : "badge-down"}`;

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
document.getElementById("stop-button").addEventListener("click", handleStopClick);
window.addEventListener("hashchange", applyRoute);

resetConsole();
applyRoute();
loadCommands();
refresh();
pollTimer = setInterval(refresh, REFRESH_MS);
