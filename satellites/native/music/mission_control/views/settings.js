import * as api from "../api.js";
import * as store from "../store.js";
import { BANDS, PRESETS } from "../audio/effects.js";
import { connect } from "../connect.js";
import { player } from "../player/player.js";
import { button, debounce, el, longDuration, plural, size } from "../ui/dom.js";
import { trackList } from "../ui/lists.js";
import { confirm } from "../ui/overlay.js";

let pending = {};
const save = debounce(() => {
    const changes = pending;
    pending = {};
    store.setPreferences(changes).catch((error) => store.toast(error.message, "error"));
}, 250);

function set(key, value) {
    pending[key] = value;
    store.state.preferences = { ...store.state.preferences, [key]: value };
    store.emit("preferences", store.state.preferences);
    save();
}

function section(title, description) {
    const node = el("section", "mu-settings-section");
    node.append(el("h2", null, title));
    if (description) {
        node.append(el("p", "mu-hint", description));
    }
    return node;
}

function row(label, control, hint) {
    const node = el("label", "mu-setting");
    const text = el("span", "mu-setting-label", label);
    node.append(text, control);
    if (hint) {
        node.append(el("small", "mu-setting-hint", hint));
    }
    return node;
}

function choice(key, options) {
    const select = el("select", "mu-select");
    for (const [value, label] of options) {
        select.append(new Option(label, value));
    }
    select.value = String(store.preference(key));
    select.addEventListener("change", () => set(key, select.value));
    return select;
}

function toggle(key, disabled = false) {
    const input = el("input");
    input.type = "checkbox";
    input.className = "sc-switch";
    input.setAttribute("role", "switch");
    input.checked = Boolean(store.preference(key));
    input.disabled = disabled;
    input.addEventListener("change", () => set(key, input.checked));
    return input;
}

function slider(key, min, max, step, format) {
    const wrap = el("span", "mu-slider");
    const input = el("input", "mu-range");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(store.preference(key));
    const value = el("output", null, format(Number(input.value)));
    const paint = () => input.style.setProperty("--progress", `${((Number(input.value) - min) / (max - min)) * 100}%`);
    input.addEventListener("input", () => {
        value.textContent = format(Number(input.value));
        paint();
        set(key, Number(input.value));
    });
    paint();
    wrap.append(input, value);
    return wrap;
}

function playback(transcoding) {
    const node = section("Playback");
    const qualities = [["original", "Original file"], ["high", "High (transcoded)"], ["normal", "Normal (transcoded)"], ["low", "Low (transcoded)"]];
    node.append(
        row("Streaming quality", choice("streaming_quality", qualities), transcoding
            ? "Lossy originals are never re-encoded upward. Transcoding is only used when it makes the stream smaller."
            : "FFmpeg isn't available on this server, so everything streams in its original quality."),
        row("Transcode format", choice("transcode_format", [["opus", "Opus"], ["aac", "AAC"], ["mp3", "MP3"]])),
        row("ReplayGain", choice("replaygain", [["off", "Off"], ["track", "Track gain"], ["album", "Album gain"]]), "Uses gain tags from your files. Peaks are never pushed past full scale."),
        row("Normalize loudness", toggle("normalize"), "A gentle compressor for files without ReplayGain tags. Changes the sound."),
        row("Crossfade", slider("crossfade", 0, 12, 1, (value) => (value ? `${value} s` : "Off"))),
        row("Gapless playback", toggle("gapless"), "The next song is buffered in advance and started the moment this one ends."),
        row("Speed", slider("speed", 0.5, 2, 0.05, (value) => `${value.toFixed(2)}×`)),
        row("Keep pitch when changing speed", toggle("preserve_pitch")),
        row("Pitch shift", slider("pitch", -12, 12, 1, (value) => `${value > 0 ? "+" : ""}${value} st`),
            "Independent pitch isn't available in the browser: it has no pitch shifter for streamed audio. The setting is used by the Android app."),
        row("When the queue ends", choice("queue_end", [["stop", "Stop"], ["repeat", "Start again"], ["autoplay", "Autoplay similar songs"]])),
    );
    return node;
}

function equalizer() {
    const node = section("Equalizer", "Ten bands, applied to the real playback in the browser. When it's off, the equalizer is removed from the audio path entirely.");
    const eq = { enabled: false, preset: "flat", bands: PRESETS.flat.slice(), preamp: 0, ...(store.preference("equalizer") || {}) };
    const update = () => set("equalizer", { ...eq, bands: eq.bands.slice() });
    const enabled = el("input");
    enabled.type = "checkbox";
    enabled.className = "sc-switch";
    enabled.setAttribute("role", "switch");
    enabled.setAttribute("aria-label", "Equalizer");
    enabled.checked = eq.enabled;
    enabled.addEventListener("change", () => { eq.enabled = enabled.checked; update(); });
    const preset = el("select", "mu-select");
    for (const name of [...Object.keys(PRESETS), "custom"]) {
        preset.append(new Option(name[0].toUpperCase() + name.slice(1), name));
    }
    preset.value = PRESETS[eq.preset] ? eq.preset : "custom";
    const sliders = el("div", "mu-eq");
    const inputs = BANDS.map((frequency, index) => {
        const column = el("label", "mu-eq-band");
        const input = el("input", "mu-range mu-range-vertical");
        input.type = "range";
        input.min = "-12";
        input.max = "12";
        input.step = "0.5";
        input.value = String(eq.bands[index] || 0);
        input.setAttribute("aria-label", `${frequency} Hz`);
        const value = el("output", null, `${eq.bands[index] || 0}`);
        input.addEventListener("input", () => {
            eq.bands[index] = Number(input.value);
            value.textContent = input.value;
            eq.preset = "custom";
            preset.value = "custom";
            update();
        });
        column.append(value, input, el("small", null, frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)));
        sliders.append(column);
        return { input, value };
    });
    preset.addEventListener("change", () => {
        if (PRESETS[preset.value]) {
            eq.bands = PRESETS[preset.value].slice();
            eq.preset = preset.value;
            inputs.forEach(({ input, value }, index) => { input.value = String(eq.bands[index]); value.textContent = String(eq.bands[index]); });
            update();
        }
    });
    const preampWrap = el("span", "mu-slider");
    const preamp = el("input", "mu-range");
    preamp.type = "range";
    preamp.min = "-12";
    preamp.max = "12";
    preamp.step = "0.5";
    preamp.value = String(eq.preamp);
    const preampValue = el("output", null, `${eq.preamp} dB`);
    preamp.addEventListener("input", () => { eq.preamp = Number(preamp.value); preampValue.textContent = `${preamp.value} dB`; update(); });
    preampWrap.append(preamp, preampValue);
    node.append(row("Equalizer on", enabled), row("Preset", preset), sliders, row("Preamp", preampWrap),
        row("Bass boost", slider("bass_boost", 0, 12, 1, (value) => (value ? `+${value} dB` : "Off"))));
    const path = el("p", "mu-hint mu-audio-path");
    const describe = () => { path.textContent = player().engine.effects.describe(); };
    describe();
    store.on("preferences", describe);
    node.append(path);
    return node;
}

// the picker starts on StarCore's own accent (a #rrggbb token) when Music has none of its own
function starcoreAccent() {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--sc-accent").trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ee444b";
}

function appearance() {
    const node = section("Appearance");
    const accent = el("span", "mu-accent-pick");
    const mode = el("select", "mu-select");
    mode.append(new Option("From the artwork", "artwork"), new Option("Fixed colour", "fixed"));
    const colour = el("input");
    colour.type = "color";
    const current = store.preference("accent", "artwork");
    mode.value = current === "artwork" ? "artwork" : "fixed";
    colour.value = current === "artwork" ? starcoreAccent() : current;
    colour.hidden = mode.value === "artwork";
    mode.addEventListener("change", () => {
        colour.hidden = mode.value === "artwork";
        set("accent", mode.value === "artwork" ? "artwork" : colour.value);
    });
    colour.addEventListener("input", () => set("accent", colour.value));
    accent.append(mode, colour);
    node.append(
        row("Theme", choice("theme", [["system", "Match the system"], ["dark", "Dark"], ["light", "Light"]])),
        row("Accent colour", accent),
        row("Density", choice("density", [["comfortable", "Comfortable"], ["compact", "Compact"]])),
        row("Visualizer", choice("visualizer", [["off", "Off"], ["bars", "Spectrum bars"], ["wave", "Waveform"]]), "Shown in the full-screen player, drawn from the audio that's actually playing."),
        row("Lyrics offset (all songs)", slider("lyrics_offset", -5000, 5000, 100, (value) => `${(value / 1000).toFixed(1)} s`)),
    );
    return node;
}

function privacy() {
    const node = section("Privacy", "History, statistics and recommendations stay on this server and are never sent anywhere.");
    node.append(
        row("Keep listening history", toggle("history_enabled")),
        row("Personalized Home and mixes", toggle("discovery_enabled")),
        row("Scrobbling", toggle("scrobbling", true), "Needs a Last.fm or ListenBrainz Link, which isn't installed. Nothing is scrobbled."),
        button("Clear listening history", "button button-stop", async () => {
            if (await confirm("Clear listening history", "This removes every recorded play, your statistics and Wrapped. Likes and playlists stay.", "Clear history")) {
                const result = await api.post("history/clear", {});
                store.toast(`Removed ${plural(result.removed, "play")}`);
            }
        }),
    );
    return node;
}

async function devices() {
    const node = section("Devices", "Browsers and phones signed in to this server that can play or control music.");
    const list = el("div", "mu-device-list");
    const hub = connect(player());
    const draw = () => {
        list.replaceChildren(...hub.devices.map((device) => {
            const item = el("div", "mu-device-row");
            item.append(el("strong", null, `${device.name}${device.id === player().device ? " (this browser)" : ""}`),
                el("span", null, device.online ? "Online" : `Last seen ${new Date(device.last_seen * 1000).toLocaleString()}`));
            if (device.id !== player().device) {
                item.append(button("Forget", "mu-text-button", async () => {
                    await api.post("connect/forget", { device_id: player().device, target: device.id });
                    await hub.refresh();
                    draw();
                }));
            }
            return item;
        }));
    };
    await hub.refresh();
    draw();
    node.append(list);
    return node;
}

async function server(alive) {
    const node = section("Library on this server", "These settings are shared by everyone using this StarCore. Your music files are only ever read, never changed.");
    const [summary, config] = await Promise.all([api.get("library"), api.get("configuration")]);
    if (!alive()) {
        return node;
    }
    const facts = el("dl", "mu-tiles");
    for (const [label, value] of [["Songs", summary.tracks], ["Albums", summary.albums], ["Artists", summary.artists], ["Playing time", longDuration(summary.duration)],
        ["Size", size(summary.size_bytes)], ["Lossless", summary.lossless], ["Hi-Res", summary.hires], ["Missing files", summary.missing], ["Transcoding", summary.transcoding ? "Available" : "Unavailable"]]) {
        const tile = el("div", "mu-tile");
        tile.append(el("dt", null, label), el("dd", null, String(value)));
        facts.append(tile);
    }
    node.append(facts);

    const form = el("div", "mu-config");
    for (const setting of config.settings) {
        let control;
        const list = setting.type === "path-list" || setting.type === "list";
        if (list) {
            control = el("textarea", "mu-input");
            control.rows = 3;
            control.value = String(setting.value || "").split(/;\s*/).filter(Boolean).join("\n");
            control.placeholder = setting.type === "path-list" ? "One folder per line" : "One pattern per line";
        } else if (setting.options) {
            control = el("select", "mu-select");
            for (const option of setting.options) {
                control.append(new Option(option, option));
            }
            control.value = setting.value;
        } else {
            control = el("input", "mu-input");
            control.type = typeof setting.value === "number" ? "number" : "text";
            control.value = String(setting.value ?? "");
        }
        const status = el("small", "mu-setting-hint", setting.description);
        control.addEventListener("change", async () => {
            let value = control.value;
            if (list) {
                value = control.value.split("\n").map((line) => line.trim()).filter(Boolean);
            } else if (control.type === "number") {
                value = Number(control.value);
            }
            try {
                const result = await api.post("configuration", { key: setting.key, value });
                status.textContent = result.note || "Saved.";
                status.classList.remove("error");
            } catch (error) {
                status.textContent = error.message;
                status.classList.add("error");
            }
        });
        const field = el("label", "mu-setting mu-setting-wide");
        field.append(el("span", "mu-setting-label", setting.key.replace(/_/g, " ")), control, status);
        form.append(field);
    }
    node.append(form, await scanner(alive), duplicates());
    return node;
}

async function scanner(alive) {
    const node = el("div", "mu-scan");
    const status = el("div", "mu-scan-status");
    const start = button("Scan now", "button button-primary", async () => {
        try {
            await api.post("scan", { background: true });
            poll();
        } catch (error) {
            store.toast(error.message, "error");
        }
    });
    const cancel = button("Cancel", "button", () => api.post("scan", { cancel: true }).then(poll));
    node.append(el("h3", null, "Scanning"), status, el("div", "mu-scan-actions"));
    node.lastChild.append(start, cancel);
    let timer = null;
    const draw = (state) => {
        start.disabled = state.running;
        cancel.hidden = !state.running;
        if (state.running) {
            const progress = state.progress;
            status.textContent = progress ? `Scanning… ${progress.found} files checked, ${progress.added} new, ${progress.updated} updated${progress.current ? ` (${progress.current})` : ""}` : "Scanning…";
        } else if (state.last) {
            const last = state.last;
            status.textContent = `Last scan ${state.last_scan ? new Date(state.last_scan).toLocaleString() : ""}: ${last.found} files, ${last.added} added, ${last.updated} updated, ${last.removed} missing, ${last.duplicates} duplicates${last.failed && last.failed.length ? `, ${last.failed.length} unreadable` : ""}.`;
            if (last.failed && last.failed.length) {
                const details = el("details");
                details.append(el("summary", null, "Unreadable files"));
                for (const failure of last.failed.slice(0, 50)) {
                    details.append(el("div", "mu-hint", `${failure.file}: ${failure.reason}`));
                }
                status.append(details);
            }
        } else {
            status.textContent = "Never scanned.";
        }
        if (state.error && state.error !== "cancelled") {
            status.append(el("div", "mu-error-text", state.error));
        }
    };
    const poll = async () => {
        clearTimeout(timer);
        if (!alive()) {
            return;
        }
        const state = await api.get("scan").catch(() => null);
        if (!state) {
            return;
        }
        draw(state);
        if (state.running) {
            timer = setTimeout(poll, 1000);
        } else {
            store.refreshPlaylists().catch(() => {});
        }
    };
    await poll();
    return node;
}

function duplicates() {
    const node = el("div", "mu-duplicates");
    node.append(el("h3", null, "Duplicates"), button("Find duplicates", "button", async () => {
        const payload = await api.get("duplicates");
        const blocks = [el("p", "mu-hint", `${plural(payload.identical.length, "song")} with identical copies elsewhere on disk (indexed once), ${plural(payload.likely.length, "likely duplicate group")} across releases. Nothing is ever deleted.`)];
        for (const group of payload.likely.slice(0, 50)) {
            blocks.push(trackList(group.tracks, { art: true }));
        }
        node.replaceChildren(el("h3", null, "Duplicates"), ...blocks);
    }));
    return node;
}

export async function render({ node, alive }) {
    pending = {};
    await store.load();
    const transcoding = await api.get("library").then((summary) => summary.transcoding).catch(() => false);
    node.append(el("h1", "mu-page-title", "Music settings"), playback(transcoding), equalizer(), appearance(), privacy());
    node.append(await devices());
    node.append(await server(alive));
    return () => save.cancel();
}
