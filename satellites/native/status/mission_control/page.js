// The Status page: health, hardware, network, services, history and diagnostics
// for this machine, from the Status satellite's monitor (see ../api.py).
//
// One poller reads /metrics at the sampler's own interval while the page is
// open and the browser tab is visible; history is read when a view needs it.
// Every value shown is a real reading - one the machine can't provide says so.

import { createChart, meter, sparkline } from "./charts.js";
import * as format from "./format.js";

const SECTIONS = [
    ["overview", "Overview"], ["hardware", "Hardware"], ["network", "Network"],
    ["services", "Services"], ["history", "History"], ["diagnostics", "Diagnostics"],
];
// shown only in StarCore's Developer Mode (a visibility preference: the routes stay signed-in only)
const DEVELOPER_SECTIONS = new Set(["diagnostics"]);
const PERIODS = [["1h", "1 hour"], ["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"]];
const CHARTS = [
    { key: "cpu", title: "CPU", series: [["cpu", "CPU"]], scale: "percent" },
    { key: "memory", title: "Memory", series: [["memory", "Memory"]], scale: "percent" },
    { key: "network", title: "Network", series: [["net_rx", "Download"], ["net_tx", "Upload"]], scale: "bits",
      unsupported: "network" },
    { key: "disk", title: "Disk throughput", series: [["disk_read", "Read"], ["disk_write", "Write"]], scale: "bytes",
      unsupported: "storage.io" },
    { key: "storage", title: "Fullest drive", series: [["storage", "Used"]], scale: "percent" },
    { key: "swap", title: "Swap", series: [["swap", "Swap"]], scale: "percent" },
    { key: "load", title: "Load average", series: [["load", "1 minute"]], scale: "plain", unsupported: "cpu.load" },
    { key: "temperature", title: "CPU temperature", series: [["temperature", "Hottest CPU sensor"]], scale: "plain",
      unsupported: "cpu.temperature" },
];
const HEALTH = { ok: "Healthy", warning: "Warning", critical: "Critical" };
const STATE_LABELS = { running: "Running", stopped: "Stopped", disabled: "Disabled", error: "Error" };
const HISTORY_REFRESH = { "1h": 15000, "24h": 60000, "7d": 300000, "30d": 600000 };
const OVERVIEW_REFRESH = 30000;
const DIAGNOSTICS_REFRESH = 15000;

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

function dot(level) {
    const node = el("i", `status-dot status-dot-${level}`);
    node.setAttribute("aria-hidden", "true");
    return node;
}

function facts(rows) {
    const list = el("dl", "status-facts");
    for (const [label, value, note] of rows) {
        const row = el("div");
        row.appendChild(el("dt", null, label));
        const cell = el("dd", null, value);
        if (note) {
            cell.appendChild(el("small", null, note));
        }
        row.appendChild(cell);
        list.appendChild(row);
    }
    return list;
}

function panel(title, ...children) {
    const node = el("section", "panel status-panel");
    if (title) {
        node.appendChild(el("p", "eyebrow", title));
    }
    node.append(...children.filter(Boolean));
    return node;
}

function table(columns, rows, emptyText) {
    if (!rows.length) {
        return el("p", "muted", emptyText || "Nothing to show.");
    }
    const wrapper = el("div", "status-table-wrap");
    const grid = el("table", "status-table");
    const head = el("tr");
    for (const [, heading, align] of columns) {
        const cell = el("th", align ? `align-${align}` : null, heading);
        cell.scope = "col";
        head.appendChild(cell);
    }
    grid.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    for (const row of rows) {
        const line = el("tr");
        for (const [key, , align] of columns) {
            const value = row[key];
            const cell = el("td", align ? `align-${align}` : null);
            if (value instanceof Node) {
                cell.appendChild(value);
            } else {
                cell.textContent = value === null || value === undefined ? format.DASH : String(value);
            }
            line.appendChild(cell);
        }
        body.appendChild(line);
    }
    grid.appendChild(body);
    wrapper.appendChild(grid);
    return wrapper;
}

function stateLabel(level, text) {
    const node = el("span", "status-state");
    node.append(dot(level), el("span", null, text));
    return node;
}

function unsupportedNote(metrics, key, fallback) {
    const reason = (metrics.unsupported || {})[key];
    return reason || fallback || "Not available on this machine";
}

export function mount(context) {
    const { element: root, api } = context;
    // a host without Developer Mode shows every section
    const developer = context.developer || { enabled: true, subscribe: () => () => {} };
    const available = (key) => SECTIONS.some(([name]) => name === key)
        && (developer.enabled || !DEVELOPER_SECTIONS.has(key));
    let tab = available(context.section) ? context.section : "overview";
    let period = "24h";
    let tableView = false;
    let metrics = null;
    let metricsError = null;
    let lastGood = 0;
    let overviewHistory = null;
    let overviewHistoryAt = 0;
    let rangeHistory = null;
    let rangeHistoryKey = null;
    let rangeHistoryAt = 0;
    let rangeLoading = false;
    let diagnostics = null;
    let diagnosticsAt = 0;
    let timer = null;
    let destroyed = false;
    const charts = new Map();

    const page = el("div", "status-page");
    const head = buildHead();
    const tabs = buildTabs();
    const notice = el("p", "status-notice");
    notice.hidden = true;
    notice.setAttribute("role", "status");
    const panels = new Map(SECTIONS.map(([key]) => {
        const section = el("div", "status-section");
        section.id = `status-section-${key}`;
        section.setAttribute("role", "tabpanel");
        section.setAttribute("aria-labelledby", `status-tab-${key}`);
        return [key, section];
    }));
    page.append(head.element, tabs, notice, ...panels.values());
    root.replaceChildren(page);

    setTab(tab, false);
    // Diagnostics disappears with Developer Mode: never leave an empty page behind
    const unsubscribe = developer.subscribe((enabled) => {
        if (!enabled && DEVELOPER_SECTIONS.has(tab)) {
            setTab("overview", true);
        }
    });
    renderSkeleton();
    tick();
    document.addEventListener("visibilitychange", onVisibility);

    const cleanup = () => {
        destroyed = true;
        unsubscribe();
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        charts.forEach((chart) => chart.destroy());
        charts.clear();
    };
    cleanup.showSection = (section) => setTab(available(section) ? section : "overview", false);
    return cleanup;

    /* ---------- structure ---------- */

    function buildHead() {
        const element = el("header", "status-head");
        const text = el("div", "status-head-text");
        const eyebrow = el("p", "sc-eyebrow", "Status");
        const title = el("h2", null, "System status");
        const meta = el("p", "status-meta", "Connecting…");
        text.append(eyebrow, title, meta);
        const health = el("div", "status-health");
        health.dataset.state = "unknown";
        health.append(dot("unknown"), el("span", null, "Waiting"));
        element.append(text, health);
        return { element, eyebrow, meta, health };
    }

    function buildTabs() {
        const bar = el("div", "status-tabs");
        bar.setAttribute("role", "tablist");
        bar.setAttribute("aria-label", "Status sections");
        for (const [key, label] of SECTIONS) {
            const button = el("button", "status-tab", label);
            button.type = "button";
            button.id = `status-tab-${key}`;
            button.dataset.tab = key;
            button.setAttribute("role", "tab");
            button.setAttribute("aria-controls", `status-section-${key}`);
            if (DEVELOPER_SECTIONS.has(key)) {
                button.dataset.developer = "";
            }
            button.addEventListener("click", () => setTab(key, true));
            button.addEventListener("keydown", (event) => {
                const shown = SECTIONS.filter(([name]) => available(name));
                const index = shown.findIndex(([name]) => name === key);
                const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (move) {
                    event.preventDefault();
                    const next = shown[(index + move + shown.length) % shown.length][0];
                    setTab(next, true);
                    bar.querySelector(`[data-tab="${next}"]`).focus();
                }
            });
            bar.appendChild(button);
        }
        return bar;
    }

    function setTab(name, remember) {
        tab = name;
        for (const button of tabs.querySelectorAll(".status-tab")) {
            const active = button.dataset.tab === name;
            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", String(active));
            button.tabIndex = active ? 0 : -1;
        }
        panels.forEach((section, key) => {
            section.hidden = key !== name;
        });
        if (remember) {
            // a reload or a shared link opens the same section
            history.replaceState(null, "", `#/satellite/${encodeURIComponent(context.satellite.name)}/${name}`);
        }
        if (metrics) {
            renderSection();
        }
        loadForSection();
    }

    /* ---------- loading ---------- */

    function onVisibility() {
        if (!document.hidden && !destroyed) {
            tick();
        }
    }

    async function tick() {
        clearTimeout(timer);
        if (destroyed || document.hidden) {
            return;  // the visibility handler starts it again
        }
        await loadMetrics();
        loadForSection();
        if (!destroyed) {
            const interval = Math.max(2, (metrics && metrics.interval) || 5);
            timer = setTimeout(tick, (metricsError ? Math.min(interval * 2, 30) : interval) * 1000);
        }
    }

    async function loadMetrics() {
        try {
            metrics = await api.get("/metrics");
            metricsError = null;
            lastGood = Date.now();
        } catch (error) {
            metricsError = error.message || "StarCore did not answer";
        }
        if (destroyed) {
            return;
        }
        renderHead();
        if (metrics) {
            renderSection();
        } else if (metricsError) {
            renderFailure();
        }
    }

    function loadForSection() {
        const now = Date.now();
        if (["overview", "network"].includes(tab) && now - overviewHistoryAt > OVERVIEW_REFRESH) {
            overviewHistoryAt = now;
            api.get("/history?period=1h&series=cpu,memory,net_rx,net_tx,disk_read&points=120")
                .then((data) => {
                    overviewHistory = data;
                    if (!destroyed && metrics) {
                        renderSection();
                    }
                })
                .catch(() => {
                    overviewHistoryAt = 0;
                });
        }
        if (tab === "history") {
            const key = `${period}`;
            if (key !== rangeHistoryKey || now - rangeHistoryAt > HISTORY_REFRESH[period]) {
                loadRange(key);
            }
        }
        if (tab === "diagnostics" && now - diagnosticsAt > DIAGNOSTICS_REFRESH) {
            diagnosticsAt = now;
            api.get("/diagnostics")
                .then((data) => {
                    diagnostics = data;
                    if (!destroyed && metrics && tab === "diagnostics") {
                        renderSection();
                    }
                })
                .catch(() => {
                    diagnosticsAt = 0;
                });
        }
    }

    function loadRange(key) {
        rangeHistoryKey = key;
        rangeHistoryAt = Date.now();
        rangeLoading = true;
        markLoading();
        api.get(`/history?period=${encodeURIComponent(period)}&points=360`)
            .then((data) => {
                if (rangeHistoryKey === key) {
                    rangeHistory = data;
                }
            })
            .catch((error) => {
                if (rangeHistoryKey === key) {
                    rangeHistory = { error: error.message || "history could not be read" };
                }
                rangeHistoryAt = 0;
            })
            .finally(() => {
                rangeLoading = false;
                if (!destroyed && metrics && tab === "history") {
                    renderSection();
                }
            });
    }

    function markLoading() {
        // refetch keeps the frame: the previous charts stay, dimmed, until the new ones arrive
        const section = panels.get("history");
        section.classList.toggle("status-refreshing", rangeLoading);
    }

    /* ---------- head ---------- */

    function renderHead() {
        const stale = metricsError && metrics;
        if (metrics) {
            const node = metrics.node || {};
            head.eyebrow.textContent = node.name ? `Status · ${node.name}` : "Status";
            const sampling = metrics.sampling ? `Sampling every ${metrics.interval} s` : "Sampling off — readings are taken on request";
            head.meta.textContent = `Updated ${format.clock(metrics.sampled_at)} · ${sampling}`;
            const state = metrics.health.state;
            head.health.dataset.state = state;
            head.health.replaceChildren(dot(state), el("span", null, HEALTH[state] || state));
            const count = metrics.health.warnings.length;
            if (count) {
                head.health.appendChild(el("small", null, `${count} warning${count === 1 ? "" : "s"}`));
            }
        }
        page.classList.toggle("status-stale", Boolean(stale));
        if (stale) {
            const seconds = Math.round((Date.now() - lastGood) / 1000);
            notice.textContent = `StarCore is not answering (${metricsError}). Showing readings from ${seconds}s ago.`;
            notice.hidden = false;
        } else {
            notice.hidden = true;
        }
    }

    function renderSkeleton() {
        const grid = el("div", "status-kpis");
        for (let index = 0; index < 6; index += 1) {
            grid.appendChild(el("div", "status-kpi status-skeleton"));
        }
        panels.get(tab).replaceChildren(grid);
    }

    function renderFailure() {
        const box = el("div", "panel status-panel status-failure");
        box.appendChild(el("p", "eyebrow", "Status unavailable"));
        box.appendChild(el("p", null, `The Status satellite did not answer: ${metricsError}`));
        const retry = el("button", "sc-button", "Try again");
        retry.type = "button";
        retry.addEventListener("click", () => tick());
        box.appendChild(retry);
        panels.get(tab).replaceChildren(box);
    }

    function renderSection() {
        const section = panels.get(tab);
        const render = {
            overview: renderOverview, hardware: renderHardware, network: renderNetwork,
            services: renderServices, history: renderHistory, diagnostics: renderDiagnostics,
        }[tab];
        render(section);
    }

    /* ---------- overview ---------- */

    function series(name) {
        const line = overviewHistory && overviewHistory.series && overviewHistory.series[name];
        return line ? line.points.map((point) => point[1]) : [];
    }

    function kpi(label, value, detail, extra, link) {
        const tile = el(link ? "button" : "div", "status-kpi");
        if (link) {
            tile.type = "button";
            tile.addEventListener("click", () => setTab(link, true));
        }
        tile.appendChild(el("p", "status-kpi-label", label));
        tile.appendChild(el("p", "status-kpi-value", value));
        if (detail) {
            tile.appendChild(el("p", "status-kpi-detail", detail));
        }
        for (const item of extra || []) {
            tile.appendChild(item);
        }
        return tile;
    }

    function fullest(partitions) {
        return (partitions || []).filter((item) => item.kind === "fixed" || item.kind === "removable")
            .sort((a, b) => (b.percent || 0) - (a.percent || 0))[0];
    }

    function renderWarnings() {
        const warnings = metrics.health.warnings;
        if (!warnings.length) {
            const calm = el("div", "status-allclear");
            calm.append(dot("ok"), el("span", null, "No warnings. Every reading is within its normal range."));
            return calm;
        }
        const list = el("ul", "status-warnings");
        for (const warning of warnings) {
            const item = el("li", `status-warning status-warning-${warning.level}`);
            item.appendChild(dot(warning.level));
            const text = el("div");
            text.appendChild(el("strong", null, warning.title));
            if (warning.detail) {
                text.appendChild(el("span", null, warning.detail));
            }
            item.appendChild(text);
            item.appendChild(el("span", "status-warning-level", warning.level === "critical" ? "Critical" : "Warning"));
            list.appendChild(item);
        }
        return panel("Warnings", list);
    }

    function renderOverview(section) {
        const cpu = metrics.cpu || {};
        const memory = metrics.memory;
        const network = metrics.network;
        const drive = fullest((metrics.storage || {}).partitions);
        const servicesState = metrics.services;
        const system = metrics.system || {};

        const grid = el("div", "status-kpis");
        grid.append(
            kpi("CPU", format.percent(cpu.percent),
                cpu.logical_cores ? `${cpu.logical_cores} threads${cpu.frequency && cpu.frequency.current_mhz
                    ? ` · ${format.megahertz(cpu.frequency.current_mhz)}` : ""}` : null,
                [meter(cpu.percent, { warn: 90, critical: 98, label: "CPU usage" }), sparkline(series("cpu"))], "hardware"),
            kpi("Memory", memory ? format.percent(memory.percent) : format.DASH,
                memory ? `${format.bytes(memory.used)} of ${format.bytes(memory.total)}` : unsupportedNote(metrics, "memory"),
                [meter(memory && memory.percent, { warn: 90, critical: 97, label: "Memory in use" }),
                    sparkline(series("memory"))], "hardware"),
            kpi("Storage", drive ? format.percent(drive.percent) : format.DASH,
                drive ? `${drive.mount} · ${format.bytes(drive.free)} free` : "No drives were read",
                [meter(drive && drive.percent, { warn: 90, critical: 97, label: "Fullest drive" })], "hardware"),
            kpi("Network", network ? format.bitRate(network.rx_bps) : format.DASH,
                network ? `down · ${format.bitRate(network.tx_bps)} up` : unsupportedNote(metrics, "network"),
                [sparkline(series("net_rx"))], "network"),
            kpi("Satellites", `${servicesState.online}/${servicesState.total}`, "online", [], "services"),
            kpi("Uptime", format.duration(system.uptime_seconds),
                `StarCore ${format.duration(servicesState.engine.uptime_seconds)}`, []),
        );

        const trends = el("div", "status-charts");
        trends.append(
            chartCard("overview-cpu", overviewModel("CPU · last hour", [["cpu", "CPU"]], "percent")),
            chartCard("overview-memory", overviewModel("Memory · last hour", [["memory", "Memory"]], "percent")),
        );
        section.replaceChildren(renderWarnings(), grid, trends);
    }

    function overviewModel(title, lines, scale) {
        const data = overviewHistory || { from: Date.now() / 1000 - 3600, to: Date.now() / 1000, resolution: 30, series: {} };
        return historyModel(title, data, lines, scale, "1h", metrics.sampling ? null
            : "History is recorded while the Status service runs");
    }

    /* ---------- charts ---------- */

    function historyModel(title, data, lines, scale, chartPeriod, empty) {
        const first = data.series && data.series[lines[0][0]];
        const formatter = format.formatterFor(lines[0][0], first ? first.unit : "");
        return {
            title,
            from: data.from,
            to: data.to,
            resolution: data.resolution || 10,
            scale,
            max: scale === "percent" ? 100 : null,
            format: formatter,
            tickFormat: scale === "percent" ? (value) => `${Math.round(value)}%` : formatter,
            tick: (time) => format.tick(time, chartPeriod),
            moment: (time) => format.moment(time, chartPeriod),
            empty,
            series: lines.map(([key, label]) => ({
                key, label, points: (data.series && data.series[key] && data.series[key].points) || [],
            })),
        };
    }

    function chartCard(key, model) {
        let chart = charts.get(key);
        if (!chart) {
            chart = createChart({ label: model.title });
            charts.set(key, chart);
        }
        const card = el("div", "panel status-panel status-chart-card");
        card.appendChild(chart.element);
        // rendered once it is in the document, so it knows its width
        requestAnimationFrame(() => chart.render(model));
        chart.render(model);
        return card;
    }

    /* ---------- hardware ---------- */

    function renderHardware(section) {
        const cpu = metrics.cpu || {};
        const memory = metrics.memory;
        const storage = metrics.storage || {};
        const system = metrics.system || {};
        const frequency = cpu.frequency;
        const temperature = cpu.temperature;
        const load = cpu.load;

        const cores = el("div", "status-cores");
        cores.setAttribute("aria-label", "Usage per logical processor");
        (cpu.per_core || []).forEach((value, index) => {
            const column = el("div", "status-core");
            column.title = `Thread ${index + 1}: ${format.percent(value)}`;
            const bar = el("span", "status-core-bar");
            bar.style.height = `${Math.max(2, value || 0)}%`;
            column.appendChild(bar);
            cores.appendChild(column);
        });

        const cpuPanel = panel("Processor",
            el("p", "status-panel-title", cpu.model || "Unknown processor"),
            facts([
                ["Usage", format.percent(cpu.percent)],
                ["Threads / cores", `${cpu.logical_cores || format.DASH} / ${cpu.physical_cores || format.DASH}`],
                ["Frequency", frequency && frequency.current_mhz ? format.megahertz(frequency.current_mhz) : format.DASH,
                    frequency && frequency.base_mhz ? `base ${format.megahertz(frequency.base_mhz)}`
                        : frequency && frequency.max_mhz ? `max ${format.megahertz(frequency.max_mhz)}`
                            : frequency ? null : unsupportedNote(metrics, "cpu.frequency")],
                ["Load average", load ? `${load["1m"]} · ${load["5m"]} · ${load["15m"]}` : format.DASH,
                    load ? "1, 5 and 15 minutes" : unsupportedNote(metrics, "cpu.load")],
                ["Temperature", temperature ? format.celsius(temperature.current) : format.DASH,
                    temperature ? `${temperature.sensors.length} sensor${temperature.sensors.length === 1 ? "" : "s"}`
                        : unsupportedNote(metrics, "cpu.temperature")],
            ]),
            cpu.per_core ? el("p", "eyebrow status-subhead", "Per thread") : null,
            cpu.per_core ? cores : null,
            temperature && temperature.sensors.length > 1 ? table(
                [["label", "Sensor"], ["value", "Temperature", "end"]],
                temperature.sensors.map((sensor) => ({ label: sensor.label, value: format.celsius(sensor.celsius) }))) : null,
        );

        let memoryPanel;
        if (memory) {
            const swap = memory.swap;
            memoryPanel = panel("Memory",
                el("p", "status-panel-title", `${format.bytes(memory.used)} of ${format.bytes(memory.total)} in use`),
                meter(memory.percent, { warn: 90, critical: 97, label: "Memory in use" }),
                facts([
                    ["Available", format.bytes(memory.available)],
                    ["In use", format.percent(memory.percent)],
                    ["Swap", swap.total ? `${format.bytes(swap.used)} of ${format.bytes(swap.total)}` : "None configured",
                        swap.total ? format.percent(swap.percent) : null],
                ]),
                swap.total ? meter(swap.percent, { warn: 80, critical: 95, label: "Swap in use" }) : null,
            );
        } else {
            memoryPanel = panel("Memory", el("p", "muted", unsupportedNote(metrics, "memory")));
        }

        const partitions = (storage.partitions || []).map((item) => {
            const usage = el("div", "status-usage");
            usage.append(meter(item.percent, { warn: 90, critical: 97, label: `${item.mount} used` }),
                el("span", null, format.percent(item.percent)));
            return {
                mount: item.label ? `${item.mount} · ${item.label}` : item.mount,
                kind: item.kind,
                fs: item.fs,
                usage,
                size: format.bytes(item.total),
                free: format.bytes(item.free),
            };
        });
        const io = storage.io;
        const storagePanel = panel("Storage",
            storage.stale ? el("p", "status-inline-warning", "A drive is not answering; these figures are from its last reading.") : null,
            table([["mount", "Drive"], ["kind", "Kind"], ["fs", "File system"], ["usage", "Used"],
                ["size", "Size", "end"], ["free", "Free", "end"]], partitions, "No drives could be read."),
            el("p", "eyebrow status-subhead", "Disk activity"),
            io ? table([["name", "Disk"], ["volumes", "Volumes"], ["read", "Read", "end"], ["write", "Write", "end"],
                ["busy", "Busy", "end"]], io.disks.map((disk) => ({
                name: disk.name, volumes: disk.volumes || format.DASH, read: format.byteRate(disk.read_bps),
                write: format.byteRate(disk.write_bps), busy: format.percent(disk.busy_percent),
            })), "Disk activity appears after the second reading.")
                : el("p", "muted", unsupportedNote(metrics, "storage.io")),
        );

        const systemPanel = panel("System", facts([
            ["Operating system", system.os || format.DASH],
            ["Kernel", system.kernel || format.DASH],
            ["Architecture", system.architecture || format.DASH],
            ["Hardware", [system.vendor, system.model].filter(Boolean).join(" ") || format.DASH],
            ["Host name", system.hostname || format.DASH],
            ["Booted", system.boot_time ? new Date(system.boot_time * 1000).toLocaleString() : format.DASH,
                system.uptime_seconds !== null && system.uptime_seconds !== undefined
                    ? `up ${format.duration(system.uptime_seconds)}` : null],
        ]));

        const columns = el("div", "status-columns");
        columns.append(cpuPanel, memoryPanel);
        section.replaceChildren(columns, storagePanel, systemPanel);
    }

    /* ---------- network ---------- */

    function renderNetwork(section) {
        const network = metrics.network;
        if (!network) {
            section.replaceChildren(panel("Network", el("p", "muted", unsupportedNote(metrics, "network"))));
            return;
        }
        const up = network.interfaces.filter((item) => item.up).length;
        const grid = el("div", "status-kpis status-kpis-compact");
        grid.append(
            kpi("Download", format.bitRate(network.rx_bps), "all physical adapters", [sparkline(series("net_rx"))]),
            kpi("Upload", format.bitRate(network.tx_bps), "all physical adapters", [sparkline(series("net_tx"))]),
            kpi("Interfaces", `${up}/${network.interfaces.length}`, "connected"),
        );
        const rows = network.interfaces.map((item) => ({
            name: item.name,
            kind: item.kind,
            state: stateLabel(item.up ? "ok" : "off", item.up ? "Up" : "Down"),
            link: format.linkSpeed(item.speed_mbps),
            down: format.bitRate(item.rx_bps),
            upRate: format.bitRate(item.tx_bps),
            received: format.bytes(item.rx_bytes),
            sent: format.bytes(item.tx_bytes),
            errors: `${format.count(item.rx_errors + item.tx_errors)} / ${format.count(item.rx_drops + item.tx_drops)}`,
        }));
        const interfaces = panel("Interfaces", table([
            ["name", "Interface"], ["kind", "Kind"], ["state", "State"], ["link", "Link", "end"],
            ["down", "Download", "end"], ["upRate", "Upload", "end"], ["received", "Received", "end"],
            ["sent", "Sent", "end"], ["errors", "Errors / drops", "end"],
        ], rows, "No network interfaces were found."),
        el("p", "muted status-footnote", "Totals count since the adapter came up. Addresses are deliberately not collected."));
        const trend = el("div", "status-charts status-charts-single");
        trend.appendChild(chartCard("network-throughput", overviewModel("Throughput · last hour",
            [["net_rx", "Download"], ["net_tx", "Upload"]], "bits")));
        section.replaceChildren(grid, interfaces, trend);
    }

    /* ---------- services ---------- */

    function renderServices(section) {
        const state = metrics.services;
        const engine = state.engine;
        const enginePanel = panel("Engine",
            el("p", "status-panel-title", `${engine.name} · ${engine.running ? "running" : "stopped"}`),
            facts([
                ["Uptime", format.duration(engine.uptime_seconds)],
                ["Mission Control", engine.mission_control.enabled
                    ? (engine.mission_control.running ? "Running" : "Not running") : "Disabled"],
                ["Satellite services", engine.satellite_services ? "On" : "Off"],
                ["Commands", format.count(engine.commands)],
            ]));
        const checks = panel("Checks", table([["check", "Check"], ["state", "State"], ["detail", "Detail"]],
            state.checks.map((check) => ({
                check: check.check.replace(/^./, (letter) => letter.toUpperCase()),
                state: stateLabel(check.ok ? "ok" : "critical", check.ok ? "Passing" : "Failing"),
                detail: check.detail,
            }))));
        const satellites = panel(`Satellites · ${state.online} of ${state.total} online`, table([
            ["name", "Satellite"], ["status", "Status"], ["service", "Background service"], ["version", "Version"],
            ["commands", "Commands"], ["error", "Last error"],
        ], state.satellites.map((item) => ({
            name: item.name,
            status: stateLabel({ running: "ok", stopped: "warning", error: "critical" }[item.status] || "off",
                STATE_LABELS[item.status] || item.status),
            service: item.service ? "Yes" : "No",
            version: item.version,
            commands: item.commands.length ? item.commands.join(", ") : format.DASH,
            error: item.last_error || format.DASH,
        }))));
        const dependencies = panel("Dependencies",
            state.dependencies.length ? table([["satellite", "Satellite"], ["needs", "Needs"], ["kind", "How"]],
                state.dependencies.map((item) => ({ ...item, kind: item.kind === "section" ? "shown inside it" : item.kind })))
                : el("p", "muted", "No satellite depends on another."),
            el("p", "eyebrow status-subhead", "Optional components"),
            table([["name", "Component"], ["state", "State"], ["used", "Used for"]], state.components.map((item) => ({
                name: item.name,
                state: stateLabel(item.available ? "ok" : "off", item.available ? "Installed" : "Not installed"),
                used: item.used_for,
            }))));
        const columns = el("div", "status-columns");
        columns.append(enginePanel, checks);
        section.replaceChildren(columns, satellites, dependencies);
    }

    /* ---------- history ---------- */

    function renderHistory(section) {
        const filters = el("div", "status-filters");
        const range = el("div", "status-segmented");
        range.setAttribute("role", "radiogroup");
        range.setAttribute("aria-label", "Time range");
        for (const [key, label] of PERIODS) {
            const button = el("button", `status-segment${key === period ? " active" : ""}`, label);
            button.type = "button";
            button.setAttribute("role", "radio");
            button.setAttribute("aria-checked", String(key === period));
            button.addEventListener("click", () => {
                if (period !== key) {
                    period = key;
                    loadRange(period);
                    renderHistory(section);
                }
            });
            range.appendChild(button);
        }
        const toggle = el("button", "sc-button status-table-toggle", tableView ? "Show charts" : "Show as table");
        toggle.type = "button";
        toggle.setAttribute("aria-pressed", String(tableView));
        toggle.addEventListener("click", () => {
            tableView = !tableView;
            renderHistory(section);
        });
        filters.append(range, toggle);

        const data = rangeHistory && rangeHistory.period === period ? rangeHistory : null;
        const body = el("div", "status-charts");
        if (rangeHistory && rangeHistory.error && !data) {
            body.appendChild(panel("History", el("p", "muted", `History could not be read: ${rangeHistory.error}`)));
        } else if (data) {
            const unsupported = [];
            for (const chart of CHARTS) {
                const hasData = chart.series.some(([key]) => data.series[key] && data.series[key].points.length);
                if (!hasData && chart.unsupported && metrics.unsupported && metrics.unsupported[chart.unsupported]) {
                    unsupported.push(`${chart.title}: ${metrics.unsupported[chart.unsupported]}`);
                    continue;
                }
                if (!hasData && ["swap", "load", "temperature", "storage"].includes(chart.key)) {
                    continue;  // optional series with nothing recorded yet
                }
                const model = historyModel(chart.title, data, chart.series, chart.scale, period,
                    data.sampling ? "No samples in this period yet" : "Nothing recorded: the Status service is not running");
                body.appendChild(tableView ? historyTable(model) : chartCard(`history-${chart.key}`, model));
            }
            if (unsupported.length) {
                const note = panel("Not recorded on this machine");
                const list = el("ul", "status-plain-list");
                for (const line of unsupported) {
                    list.appendChild(el("li", null, line));
                }
                note.appendChild(list);
                body.appendChild(note);
            }
        } else {
            for (let index = 0; index < 4; index += 1) {
                body.appendChild(el("div", "panel status-panel status-chart-card status-skeleton"));
            }
        }
        const caption = el("p", "muted status-footnote", data
            ? `${data.resolution >= 60 ? `${Math.round(data.resolution / 60)} min` : `${data.resolution} s`} per point · `
              + "averages, with each point's peak in the tooltip"
            : "Loading history…");
        section.replaceChildren(filters, caption, body);
        markLoading();
    }

    function historyTable(model) {
        const rows = [];
        const times = new Map();
        model.series.forEach((line, index) => {
            for (const [time, average, peak] of line.points) {
                if (!times.has(time)) {
                    times.set(time, { time });
                }
                times.get(time)[`s${index}`] = `${model.format(average)} (peak ${model.format(peak)})`;
            }
        });
        for (const entry of [...times.values()].sort((a, b) => b.time - a.time)) {
            rows.push({ ...entry, time: model.moment(entry.time) });
        }
        const columns = [["time", "Time"], ...model.series.map((line, index) => [`s${index}`, line.label, "end"])];
        const card = panel(model.title, table(columns, rows, model.empty));
        card.classList.add("status-history-table");
        return card;
    }

    /* ---------- diagnostics ---------- */

    function renderDiagnostics(section) {
        if (!diagnostics) {
            section.replaceChildren(el("div", "panel status-panel status-chart-card status-skeleton"));
            return;
        }
        const sampler = diagnostics.sampler;
        const store = diagnostics.history;
        const process = diagnostics.process || {};
        const developer = el("p", "muted status-footnote",
            "Developer Mode is not part of this StarCore yet, so these details are shown to every signed-in "
            + "administrator. They never include addresses, tokens or file contents.");
        const samplerPanel = panel("Sampler", facts([
            ["State", sampler.running ? (sampler.stalled ? "Stalled" : "Running") : "Not running"],
            ["Interval", `${sampler.interval} s`],
            ["Samples taken", format.count(sampler.samples)],
            ["Collection time", sampler.last_ms !== null && sampler.last_ms !== undefined ? `${sampler.last_ms} ms` : format.DASH,
                sampler.average_ms !== null && sampler.average_ms !== undefined ? `average ${sampler.average_ms} ms` : null],
            ["Errors", format.count(sampler.errors), sampler.last_error],
            ["Started", sampler.started_at ? new Date(sampler.started_at * 1000).toLocaleString() : format.DASH],
        ]));
        const processPanel = panel("StarCore process", facts([
            ["CPU", format.percent(process.cpu_percent), "of the whole machine"],
            ["Memory", format.bytes(process.memory)],
            ["Python", diagnostics.python || format.DASH],
            ["Platform", diagnostics.platform || format.DASH],
        ]));
        const tiers = table([["tier", "Tier"], ["bucket", "Point every", "end"], ["kept", "Kept for", "end"],
            ["rows", "Points stored", "end"]], store.tiers.map((tier) => ({
            tier: tier.tier,
            bucket: format.span(tier.bucket_seconds),
            kept: format.span(tier.kept_seconds),
            rows: format.count(store.rows[tier.tier]),
        })));
        const historyPanel = panel("History file", facts([
            ["Size", format.bytes(store.bytes)],
            ["State", store.problem || "Healthy"],
        ]), el("p", "eyebrow status-subhead", "Tiers"), tiers);
        const unsupported = Object.entries(diagnostics.unsupported || {});
        const supportPanel = panel("Not available on this machine", unsupported.length
            ? table([["key", "Reading"], ["reason", "Why"]], unsupported.map(([key, reason]) => ({ key, reason })))
            : el("p", "muted", "Every reading is available here."));
        const raw = el("details", "status-raw");
        raw.appendChild(el("summary", null, "Raw diagnostics (JSON)"));
        const text = JSON.stringify(diagnostics, null, 2);
        raw.appendChild(el("pre", null, text));
        const copy = el("button", "sc-button", "Copy");
        copy.type = "button";
        copy.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(text);
                copy.textContent = "Copied";
            } catch (error) {
                copy.textContent = "Select the text to copy it";
            }
            setTimeout(() => {
                copy.textContent = "Copy";
            }, 2000);
        });
        raw.appendChild(copy);
        const columns = el("div", "status-columns");
        columns.append(samplerPanel, processPanel);
        section.replaceChildren(developer, columns, historyPanel, supportPanel, panel("Raw", raw));
    }
}
