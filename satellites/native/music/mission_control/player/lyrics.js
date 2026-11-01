import * as api from "../api.js";
import * as store from "../store.js";
import { button, el, emptyState } from "../ui/dom.js";
import { player } from "./player.js";

const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function lyricsPanel({ karaoke = false } = {}) {
    const node = el("div", `mu-lyrics${karaoke ? " mu-lyrics-karaoke" : ""}`);
    const toolbar = el("div", "mu-lyrics-tools");
    const body = el("div", "mu-lyrics-body");
    node.append(toolbar, body);
    let data = null;
    let trackId = null;
    let lines = [];
    let activeIndex = -1;
    let frame = null;
    let offset = 0;
    let language = null;
    let userScrolled = 0;

    body.addEventListener("wheel", () => { userScrolled = Date.now(); }, { passive: true });
    body.addEventListener("touchmove", () => { userScrolled = Date.now(); }, { passive: true });

    async function load() {
        const track = player().engine.track || (player().remote && player().remote.track);
        if (!track) {
            body.replaceChildren(emptyState("Nothing playing", "Lyrics appear here for the song that's playing."));
            toolbar.replaceChildren();
            return;
        }
        if (track.id === trackId && data !== undefined) {
            return;
        }
        trackId = track.id;
        data = undefined;
        body.replaceChildren(el("div", "mu-skeleton mu-skeleton-lyrics"));
        try {
            data = await api.get(`lyrics/${encodeURIComponent(track.id)}${api.query({ language })}`);
        } catch (error) {
            data = null;
        }
        if (trackId !== track.id) {
            return;
        }
        render();
    }

    function render() {
        toolbar.replaceChildren();
        activeIndex = -1;
        if (!data) {
            body.replaceChildren(emptyState("No lyrics for this song",
                "Add a .lrc or .txt file with the same name beside the track, or embed lyrics in its tags, then rescan."));
            lines = [];
            return;
        }
        offset = Number(data.offset || 0) + Number(store.preference("lyrics_offset", 0));
        if (data.languages && data.languages.length > 1) {
            const select = el("select", "mu-select");
            select.setAttribute("aria-label", "Lyrics language");
            for (const code of data.languages) {
                const option = el("option", null, code.toUpperCase());
                option.value = code;
                option.selected = code === data.language;
                select.append(option);
            }
            select.addEventListener("change", () => {
                language = select.value;
                trackId = null;
                load();
            });
            toolbar.append(select);
        }
        if (data.synced) {
            const label = el("span", "mu-lyrics-offset", offsetLabel());
            const change = (delta) => {
                const own = Number(data.offset || 0) + delta;
                data.offset = own;
                offset = own + Number(store.preference("lyrics_offset", 0));
                label.textContent = offsetLabel();
                api.post(`lyrics/${encodeURIComponent(trackId)}`, { offset: own }).catch((error) => store.toast(error.message, "error"));
            };
            toolbar.append(button("−0.25s", "mu-chip", () => change(-250), "Show lyrics later"), label,
                button("+0.25s", "mu-chip", () => change(250), "Show lyrics earlier"));
        }
        toolbar.append(el("span", "mu-lyrics-source", data.source === "sidecar" ? `From ${data.format.toUpperCase()} file` : "From the file's tags"));

        if (!data.synced) {
            const plain = el("div", "mu-lyrics-plain");
            for (const text of (data.plain || "").split("\n")) {
                plain.append(el("p", null, text || " "));
            }
            body.replaceChildren(plain);
            lines = [];
            return;
        }
        lines = data.lines.map((line) => {
            const row = el("p", "mu-lyric-line");
            if (line.words && line.words.length) {
                const timed = line.words.map((word) => word.text).join("").trim();
                const lead = line.text.endsWith(timed) ? line.text.slice(0, line.text.length - timed.length) : "";
                if (lead.trim()) {
                    const span = el("span", "mu-lyric-word", lead);
                    span.dataset.time = String(line.time);
                    row.append(span);
                }
                for (const word of line.words) {
                    const span = el("span", "mu-lyric-word", word.text);
                    span.dataset.time = String(word.time);
                    row.append(span);
                }
            } else {
                row.append(el("span", null, line.text || "♪"));
            }
            if (line.translation) {
                row.append(el("span", "mu-lyric-translation", line.translation));
            }
            row.tabIndex = 0;
            const seek = () => player().seek(Math.max(0, (line.time - offset) / 1000));
            row.addEventListener("click", seek);
            row.addEventListener("keydown", (event) => event.key === "Enter" && seek());
            return { line, row, words: [...row.querySelectorAll(".mu-lyric-word")] };
        });
        body.replaceChildren(...lines.map((entry) => entry.row), el("div", "mu-lyrics-spacer"));
    }

    function offsetLabel() {
        const own = Number(data && data.offset) || 0;
        return own ? `${own > 0 ? "+" : ""}${(own / 1000).toFixed(2)}s` : "In sync";
    }

    function tick() {
        frame = requestAnimationFrame(tick);
        if (!lines.length) {
            return;
        }
        const now = player().engine.position * 1000 + offset;
        let index = -1;
        for (let position = 0; position < lines.length; position += 1) {
            if (lines[position].line.time <= now) {
                index = position;
            } else {
                break;
            }
        }
        if (index !== activeIndex) {
            if (activeIndex >= 0 && lines[activeIndex]) {
                lines[activeIndex].row.classList.remove("active");
                for (const word of lines[activeIndex].words) {
                    word.classList.remove("sung");
                }
            }
            activeIndex = index;
            lines.forEach((entry, position) => entry.row.classList.toggle("past", position < index));
            if (index >= 0) {
                const row = lines[index].row;
                row.classList.add("active");
                if (Date.now() - userScrolled > 4000) {
                    const top = row.offsetTop - body.clientHeight * 0.38;
                    body.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
                }
            }
        }
        if (index >= 0) {
            for (const word of lines[index].words) {
                word.classList.toggle("sung", Number(word.dataset.time) <= now);
            }
        }
    }

    const stopTrack = player().on("track", () => { language = null; load(); });
    const stopPrefs = store.on("preferences", () => data && render());
    load();
    tick();
    node.dispose = () => {
        stopTrack();
        stopPrefs();
        cancelAnimationFrame(frame);
    };
    return node;
}
