import * as store from "../store.js";
import { encode, go } from "../router.js";
import { register } from "../theme.js";
import { visualizer } from "../audio/visualizer.js";
import { addToPlaylist, trackDetails } from "../ui/actions.js";
import { artwork } from "../ui/artwork.js";
import { button, el, emptyState, iconButton } from "../ui/dom.js";
import { artistLinks, likeButton, qualityBadge } from "../ui/lists.js";
import { menu } from "../ui/overlay.js";
import { devicesPanel } from "./devices.js";
import { lyricsPanel } from "./lyrics.js";
import { player } from "./player.js";
import { queuePanel } from "./queuepanel.js";
import { seekBar } from "./seek.js";

let open = null;
const TABS = [["lyrics", "Lyrics"], ["queue", "Queue"], ["info", "Info"], ["devices", "Devices"]];
const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

export function closeFullscreen() {
    if (open) {
        open.dispose();
        open = null;
    }
}

export function isFullscreenOpen() {
    return Boolean(open);
}

export async function openFullscreen(tab = "lyrics") {
    if (open) {
        open.select(tab);
        return;
    }
    const { transport } = await import("./bar.js");
    const { sleepMenu } = await import("./bar.js");
    const root = el("div", "mu-full");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Now playing");
    register(root);
    const backdrop = el("div", "mu-full-backdrop");
    const close = iconButton("collapse", "Close (Esc)", closeFullscreen, "mu-icon-button mu-full-close");

    const stage = el("div", "mu-full-stage");
    const cover = el("div", "mu-full-cover");
    const canvas = el("canvas", "mu-visualizer");
    const titles = el("div", "mu-full-titles");
    const seek = seekBar("mu-seek mu-seek-large");
    const controls = transport("mu-transport mu-transport-large");
    const extras = el("div", "mu-full-extras");
    stage.append(cover, canvas, titles, seek, controls, extras);

    const side = el("div", "mu-full-side");
    const tabs = el("div", "mu-tabs");
    tabs.setAttribute("role", "tablist");
    const panel = el("div", "mu-full-panel");
    side.append(tabs, panel);
    root.append(backdrop, close, stage, side);
    document.body.appendChild(root);
    document.body.classList.add("mu-full-open");

    let current = null;
    let content = null;
    let karaoke = false;
    const buttons = new Map();
    for (const [key, label] of TABS) {
        const node = button(label, "mu-tab", () => select(key));
        node.setAttribute("role", "tab");
        buttons.set(key, node);
        tabs.append(node);
    }
    const karaokeButton = button("Karaoke", "mu-tab", () => {
        karaoke = !karaoke;
        root.classList.toggle("karaoke", karaoke);
        karaokeButton.classList.toggle("active", karaoke);
        select("lyrics", true);
    });
    tabs.append(karaokeButton);

    function select(key, force = false) {
        if (key === current && !force) {
            return;
        }
        current = key;
        for (const [name, node] of buttons) {
            node.classList.toggle("active", name === key);
            node.setAttribute("aria-selected", String(name === key));
        }
        if (content && content.dispose) {
            content.dispose();
        }
        if (key === "lyrics") {
            content = lyricsPanel({ karaoke });
        } else if (key === "queue") {
            content = queuePanel();
        } else if (key === "devices") {
            content = devicesPanel();
        } else {
            content = infoPanel();
        }
        panel.replaceChildren(content);
    }

    function infoPanel() {
        const track = player().engine.track;
        if (!track) {
            return emptyState("Nothing playing", "");
        }
        const node = el("div", "mu-info");
        const engine = player().engine;
        node.append(el("p", "mu-info-path", engine.effects.describe()));
        node.append(trackDetails(track, engine.plan));
        return node;
    }

    const viz = visualizer(canvas, player().engine.effects, () => store.preference("visualizer", "off"));
    viz.start();

    function render() {
        const instance = player();
        const track = instance.remote ? instance.remote.track : instance.engine.track;
        if (!track) {
            titles.replaceChildren(el("h2", null, instance.remote ? `Connected to ${instance.remote.device.name}` : "Nothing playing"));
            cover.replaceChildren(artwork(null, 600, "mu-art mu-full-art"));
            return;
        }
        if (cover.dataset.album !== track.album_id) {
            cover.dataset.album = track.album_id || "";
            cover.replaceChildren(artwork(track.album_id, 600, "mu-art mu-full-art"));
        }
        const title = el("h2", "mu-full-title", track.title);
        const line = el("div", "mu-full-sub");
        line.append(artistLinks(track));
        if (track.album_id) {
            const album = el("a", "mu-link", track.album || "");
            album.href = "#";
            album.addEventListener("click", (event) => {
                event.preventDefault();
                closeFullscreen();
                go(`album/${encode(track.album_id)}`);
            });
            line.append(" · ", album);
        }
        const badges = el("div", "mu-full-badges");
        const badge = qualityBadge(track.quality);
        if (badge) {
            badges.append(badge);
        }
        const plan = instance.engine.plan;
        if (plan && !instance.remote) {
            badges.append(el("span", "mu-badge mu-badge-plain", plan.delivery === "original"
                ? `Original ${(plan.format || "").toUpperCase()}`
                : `Streaming ${plan.codec} ${Math.round(plan.bitrate / 1000)} kbps`));
        }
        if (instance.remote) {
            badges.append(el("span", "mu-badge mu-badge-plain", `On ${instance.remote.device.name}`));
        }
        titles.replaceChildren(title, line, badges);
        extras.replaceChildren(likeButton("track", track.id), iconButton("plus", "Add to playlist", () => addToPlaylist([track])),
            button(`${instance.engine.speed}×`, "mu-chip", (event) => speedMenu(event), "Playback speed"),
            iconButton("timer", "Sleep timer", (event) => sleepMenu(event)));
        canvas.hidden = store.preference("visualizer", "off") === "off";
    }

    function speedMenu(anchor) {
        menu([
            ...SPEEDS.map((speed) => ({ label: `${speed}×${speed === 1 ? " (normal)" : ""}`, action: () => store.setPreferences({ speed }) })),
            "-",
            { label: store.preference("preserve_pitch", true) ? "✓ Keep pitch when changing speed" : "Keep pitch when changing speed", action: () => store.setPreferences({ preserve_pitch: !store.preference("preserve_pitch", true) }) },
        ], anchor);
    }

    const stops = [player().on("track", render), player().on("remote", render), player().on("state", render), store.on("preferences", render)];
    const onKey = (event) => {
        if (event.key === "Escape") {
            closeFullscreen();
        }
    };
    document.addEventListener("keydown", onKey);
    render();
    select(tab);
    close.focus();

    open = {
        select,
        dispose() {
            stops.forEach((stop) => stop());
            document.removeEventListener("keydown", onKey);
            viz.stop();
            if (content && content.dispose) {
                content.dispose();
            }
            seek.dispose();
            controls.dispose();
            root.remove();
            document.body.classList.remove("mu-full-open");
        },
    };
}
