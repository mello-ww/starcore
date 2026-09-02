const REFRESH_MS = 5000;
const STOP_CONFIRM_MS = 4000;

let pollTimer = null;
let confirmStopTimer = null;
let stopped = false;

async function getJson(path) {
    const response = await fetch(path, { headers: { Accept: "application/json" } });
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
    banner.className = kind;
    banner.hidden = false;
}

function clearBanner() {
    document.getElementById("banner").hidden = true;
}

function renderCore(status) {
    document.title = `${status.engine} Mission Control`;
    setText("engine-name", status.engine);

    const state = document.getElementById("core-state");
    state.textContent = status.running ? "running" : "stopped";
    state.className = status.running ? "badge badge-up" : "badge badge-down";

    setText("fact-state", status.running ? "running" : "stopped");
    setText("fact-uptime", formatUptime(status.uptime_seconds));
    setText("fact-satellites", `${status.satellites.total} (native: ${status.satellites.native}, link: ${status.satellites.link})`);
    setText("fact-commands", String(status.commands));
    setText("fact-mission-control", status.mission_control.url || (status.mission_control.enabled ? "not running" : "disabled"));
    setText("updated", `updated ${new Date().toLocaleTimeString()}`);
}

// satellite state is rendered generically, so any satellite can publish its own keys
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
    const wrapper = element("div", "commands");
    wrapper.appendChild(element("span", "muted", "Commands"));

    if (!commands || commands.length === 0) {
        wrapper.appendChild(element("span", "muted", "none"));
        return wrapper;
    }

    for (const command of commands) {
        const chip = element("code", "chip", command.name);
        chip.title = command.description || command.name;
        wrapper.appendChild(chip);
    }
    return wrapper;
}

function renderSatellite(satellite) {
    const card = element("article", "card");

    const header = element("div", "card-header");
    header.appendChild(element("h3", null, satellite.name));
    header.appendChild(element("span", "badge badge-type", satellite.type));
    if (!satellite.enabled) {
        header.appendChild(element("span", "badge badge-down", "disabled"));
    }
    card.appendChild(header);

    card.appendChild(element("p", "muted", `v${satellite.version} · ${satellite.author}`));
    if (satellite.description) {
        card.appendChild(element("p", null, satellite.description));
    }

    card.appendChild(renderCommands(satellite.commands));
    card.appendChild(renderState(satellite.state));
    return card;
}

function renderSatellites(satellites) {
    const container = document.getElementById("satellites");
    container.replaceChildren();

    setText("satellite-count", satellites.length ? `(${satellites.length})` : "");

    if (satellites.length === 0) {
        container.appendChild(element("p", "muted", "No satellites are loaded."));
        return;
    }

    for (const satellite of satellites) {
        container.appendChild(renderSatellite(satellite));
    }
}

async function refresh() {
    if (stopped) {
        return;
    }

    try {
        const [status, satellites] = await Promise.all([
            getJson("/api/status"),
            getJson("/api/satellites"),
        ]);

        renderCore(status);
        renderSatellites(satellites.satellites);
        clearBanner();
    } catch (error) {
        showBanner(`Cannot reach StarCore: ${error.message}`, "error");
    }
}

// --- tabs ---

function activateTab(name) {
    for (const button of document.querySelectorAll(".tab-button")) {
        button.classList.toggle("active", button.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll(".tab-panel")) {
        panel.hidden = panel.id !== `tab-${name}`;
    }
}

for (const button of document.querySelectorAll(".tab-button")) {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
}

// --- console: a web equivalent of the terminal CLI, using the same command system ---

async function loadConsoleCommands() {
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
    container.appendChild(element("span", "muted", "Available:"));

    for (const command of commands) {
        const chip = element("code", "chip chip-button", command.name);
        chip.title = command.description || command.name;
        chip.addEventListener("click", () => {
            const input = document.getElementById("console-input");
            input.value = command.name;
            input.focus();
        });
        container.appendChild(chip);
    }
}

function appendConsoleLine(command, response) {
    const output = document.getElementById("console-output");
    const trailer = response.error ? `[ERROR]: ${response.error}\n` : "";
    output.textContent += `> ${command}\n${response.output || ""}${trailer}\n`;
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

document.getElementById("console-clear").addEventListener("click", () => {
    document.getElementById("console-output").textContent = "";
});

// --- shutdown: a clearly identifiable, confirm-before-acting control ---

function setStopButtonConfirming(confirming) {
    const button = document.getElementById("stop-button");
    button.classList.toggle("stop-button-confirm", confirming);
    button.textContent = confirming ? "Confirm stop?" : "Stop StarCore";
}

async function handleStopClick() {
    const button = document.getElementById("stop-button");

    if (!button.classList.contains("stop-button-confirm")) {
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
    if (pollTimer) {
        clearInterval(pollTimer);
    }

    const state = document.getElementById("core-state");
    state.textContent = "stopped";
    state.className = "badge badge-down";
    setText("fact-state", "stopped");
    showBanner("StarCore has been stopped from Mission Control. You can close this page.", "notice");

    document.getElementById("console-input").disabled = true;
    document.getElementById("console-form").querySelector("button[type=submit]").disabled = true;
}

document.getElementById("stop-button").addEventListener("click", handleStopClick);

loadConsoleCommands();
refresh();
pollTimer = setInterval(refresh, REFRESH_MS);
