import * as store from "../store.js";
import { encode, go, href } from "../router.js";
import { register, followArtwork } from "../theme.js";
import { addToPlaylist } from "../ui/actions.js";
import { artwork } from "../ui/artwork.js";
import { button, el, icon, iconButton } from "../ui/dom.js";
import { likeButton, qualityBadge } from "../ui/lists.js";
import { menu } from "../ui/overlay.js";
import { devicesPanel } from "./devices.js";
import { openFullscreen } from "./fullscreen.js";
import { player } from "./player.js";
import { queuePanel } from "./queuepanel.js";
import { seekBar } from "./seek.js";

let bar = null;

// The bar can be put away: it then lives in the top bar as the playing cover, a spinning disc.
const COLLAPSED_KEY = "starcore.music.playerCollapsed";

function readCollapsed() {
    try {
        return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
        return false;
    }
}

function writeCollapsed(value) {
    try {
        localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
    } catch {
        // a private window: the choice lasts for this page only
    }
}

const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function sleepMenu(anchor) {
    const instance = player();
    const sleeping = instance.sleep;
    menu([
        sleeping ? { label: "Turn off sleep timer", action: () => instance.cancelSleep() } : null,
        sleeping ? "-" : null,
        ...[5, 15, 30, 45, 60, 90].map((minutes) => ({ label: `${minutes} minutes`, action: () => { instance.setSleep(minutes); store.toast(`Sleep timer set for ${minutes} minutes`); } })),
        { label: "End of this track", action: () => { instance.setSleep("track"); store.toast("Playback stops when this track ends"); } },
    ], anchor);
}

export function transport(className = "mu-transport") {
    const node = el("div", className);
    const shuffle = iconButton("shuffle", "Shuffle", () => player().setShuffle(!(player().remote ? player().remote.state && player().remote.state.shuffle : player().shuffle)), "mu-icon-button mu-toggle");
    const previous = iconButton("previous", "Previous", () => player().previous());
    const play = iconButton("play", "Play", () => player().toggle(), "mu-icon-button mu-play");
    const next = iconButton("next", "Next", () => player().next());
    const repeat = iconButton("repeat", "Repeat", () => player().cycleRepeat(), "mu-icon-button mu-toggle");
    node.append(shuffle, previous, play, next, repeat);

    function update() {
        const instance = player();
        const state = instance.remote ? instance.remote.state || {} : { shuffle: instance.shuffle, repeat: instance.repeat };
        const playing = instance.playing;
        play.replaceChildren(icon(playing ? "pause" : "play", 22));
        play.setAttribute("aria-label", playing ? "Pause" : "Play");
        play.title = playing ? "Pause (Space)" : "Play (Space)";
        play.classList.toggle("buffering", !instance.remote && instance.engine.buffering);
        shuffle.classList.toggle("on", Boolean(state.shuffle));
        shuffle.setAttribute("aria-pressed", String(Boolean(state.shuffle)));
        const mode = state.repeat || "off";
        repeat.classList.toggle("on", mode !== "off");
        repeat.classList.toggle("one", mode === "one");
        repeat.setAttribute("aria-label", `Repeat: ${mode}`);
        repeat.title = `Repeat: ${mode}`;
    }

    const stops = [player().on("state", update), player().on("queue", update), player().on("remote", update)];
    update();
    node.dispose = () => stops.forEach((stop) => stop());
    return node;
}

function volumeControl() {
    const node = el("div", "mu-volume");
    const mute = iconButton("volume", "Mute (M)", () => player().engine.toggleMute());
    const range = el("input", "mu-range");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.setAttribute("aria-label", "Volume");
    range.addEventListener("input", () => player().setVolume(Number(range.value) / 100));
    node.append(mute, range);
    const update = () => {
        const engine = player().engine;
        const remote = player().remote;
        const value = remote && remote.state ? remote.state.volume : engine.muted ? 0 : engine.volume;
        range.value = String(Math.round((value ?? 1) * 100));
        range.style.setProperty("--progress", `${range.value}%`);
        mute.replaceChildren(icon(engine.muted || value === 0 ? "mute" : "volume"));
    };
    player().on("state", update);
    player().on("remote", update);
    update();
    return node;
}

function drawer(kind) {
    const existing = bar.drawer;
    if (existing) {
        existing.node.dispose && existing.node.dispose();
        existing.wrap.remove();
        bar.drawer = null;
        if (existing.kind === kind) {
            bar.element.querySelectorAll(".mu-bar-tools .on").forEach((node) => node.classList.remove("on"));
            return;
        }
    }
    const wrap = el("div", "mu-drawer");
    register(wrap);
    const panel = kind === "queue" ? queuePanel() : devicesPanel();
    wrap.append(panel);
    document.body.appendChild(wrap);
    bar.drawer = { kind, node: panel, wrap };
    bar.element.querySelectorAll(".mu-bar-tools [data-drawer]").forEach((node) => node.classList.toggle("on", node.dataset.drawer === kind));
}

export function toggleQueue() {
    if (bar) {
        drawer("queue");
    }
}

export function mountBar() {
    if (bar) {
        if (!bar.element.isConnected) {
            document.body.appendChild(bar.element);
        }
        return bar;
    }
    const element = el("div", "mu-bar");
    element.setAttribute("role", "region");
    element.setAttribute("aria-label", "Music player");
    register(element);

    const now = el("div", "mu-bar-now");
    const art = el("button", "mu-bar-art");
    art.type = "button";
    art.title = "Open the full-screen player";
    art.addEventListener("click", () => openFullscreen());
    const text = el("div", "mu-bar-text");
    const title = el("a", "mu-bar-title");
    const subtitle = el("div", "mu-bar-sub");
    text.append(title, subtitle);
    const like = el("span", "mu-bar-like");
    now.append(art, text, like);

    const center = el("div", "mu-bar-center");
    const controls = transport();
    const seek = seekBar();
    const status = el("div", "mu-bar-status");
    center.append(controls, seek, status);

    const tools = el("div", "mu-bar-tools");
    const lyrics = iconButton("lyrics", "Lyrics", () => openFullscreen("lyrics"));
    const queue = iconButton("queue", "Queue (Q)", () => drawer("queue"));
    queue.dataset.drawer = "queue";
    const devices = iconButton("devices", "Connect to a device", () => drawer("devices"));
    devices.dataset.drawer = "devices";
    const sleep = iconButton("timer", "Sleep timer", (event) => sleepMenu(event));
    const more = iconButton("more", "More", (event) => {
        const track = player().current;
        if (track) {
            menu([
                { label: "Add to playlist…", action: () => addToPlaylist([track]) },
                track.album_id ? { label: "Go to album", action: () => go(`album/${encode(track.album_id)}`) } : null,
                track.artist_id ? { label: "Go to artist", action: () => go(`artist/${encode(track.artist_id)}`) } : null,
                { label: "Open Music", action: () => go("") },
            ], event);
        }
    });
    const expand = iconButton("expand", "Full-screen player", () => openFullscreen());
    const retract = iconButton("retract", "Put the player away", () => setCollapsed(true), "mu-icon-button mu-retract");
    tools.append(lyrics, queue, devices, sleep, volumeControl(), more, expand, retract);
    element.append(now, center, tools);
    document.body.appendChild(element);
    bar = { element, drawer: null };

    // the disc: in Mission Control's top bar when it offers a slot, else floating at the top right
    const disc = el("button", "mu-now-disc");
    disc.type = "button";
    disc.hidden = true;
    const discArt = el("span", "mu-now-disc-art");
    disc.append(discArt, el("span", "mu-now-disc-hole"));
    disc.addEventListener("click", () => setCollapsed(!collapsed));
    register(disc);
    const slot = document.getElementById("topbar-extras");
    if (slot) {
        slot.append(disc);
    } else {
        disc.classList.add("mu-now-disc-floating");
        document.body.appendChild(disc);
    }

    let collapsed = readCollapsed();
    let visible = false;
    let flying = null;

    function layout() {
        element.hidden = !visible || collapsed;
        document.body.classList.toggle("mu-has-bar", visible && !collapsed);
        disc.hidden = !visible;
        disc.classList.toggle("open", !collapsed);
        disc.setAttribute("aria-expanded", String(!collapsed));
        disc.setAttribute("aria-label", collapsed ? "Show the player" : "Put the player away");
        disc.title = collapsed ? "Show the player" : "Put the player away";
    }

    // The cover travels between the disc and the bar: down and larger as the bar rises, back up
    // and spinning as it sinks. Without motion (or a cover), the bar simply appears or goes.
    function setCollapsed(value) {
        if (value === collapsed) {
            return;
        }
        if (flying) {
            flying.forEach((animation) => animation.finish());
        }
        const from = disc.getBoundingClientRect();
        collapsed = value;
        writeCollapsed(value);
        if (value && drawerOpen()) {
            drawer(bar.drawer.kind);
        }
        if (reducedMotion() || !visible || !from.width || !art.firstChild) {
            layout();
            return;
        }
        if (value) {
            const target = art.getBoundingClientRect();
            const sink = element.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(calc(100% + 24px))", opacity: 0 }],
                { duration: 280, easing: "cubic-bezier(.4,0,.6,1)" });
            const ghost = flight(target, from, true);
            flying = [sink, ghost];
            sink.onfinish = () => {
                layout();
                flying = null;
            };
        } else {
            layout();
            const target = art.getBoundingClientRect();
            const rise = element.animate([{ transform: "translateY(calc(100% + 24px))", opacity: 0 }, { transform: "none", opacity: 1 }],
                { duration: 380, delay: 60, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
            const ghost = flight(from, target, false);
            flying = [rise, ghost];
            rise.onfinish = () => {
                flying = null;
            };
        }
    }

    function drawerOpen() {
        return Boolean(bar.drawer);
    }

    // a copy of the cover flown from one rectangle to another; the real ones wait, hidden
    function flight(from, to, toDisc) {
        const ghost = el("div", "mu-now-disc-ghost");
        ghost.append(art.firstChild.cloneNode(true));
        Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
        document.body.appendChild(ghost);
        const dx = to.left - from.left;
        const dy = to.top - from.top;
        const scale = to.width / from.width;
        art.style.visibility = "hidden";
        disc.classList.add("landing");
        const animation = ghost.animate([
            { transform: "none", borderRadius: toDisc ? "14px" : "50%" },
            { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${toDisc ? 360 : -360}deg)`, borderRadius: toDisc ? "50%" : "14px" },
        ], { duration: toDisc ? 420 : 520, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
        animation.onfinish = () => {
            ghost.remove();
            art.style.visibility = "";
            disc.classList.remove("landing");
        };
        return animation;
    }

    function update() {
        const instance = player();
        const track = instance.remote ? instance.remote.track : instance.engine.track || instance.current;
        visible = Boolean(track) || Boolean(instance.remote);
        layout();
        disc.classList.toggle("spinning", Boolean(instance.playing));
        if (!track) {
            discArt.replaceChildren();
            title.textContent = instance.remote ? `Connected to ${instance.remote.device.name}` : "";
            subtitle.textContent = "";
            art.replaceChildren();
            like.replaceChildren();
            return;
        }
        if (art.dataset.album !== track.album_id) {
            art.dataset.album = track.album_id || "";
            art.replaceChildren(artwork(track.album_id, 96, "mu-art"));
            discArt.replaceChildren(artwork(track.album_id, 96, "mu-art"));
            followArtwork(track.album_id);
        }
        title.textContent = track.title || "";
        title.href = track.album_id ? href(`album/${encode(track.album_id)}`) : href();
        subtitle.replaceChildren();
        const badge = qualityBadge(track.quality);
        if (badge) {
            subtitle.append(badge);
        }
        const artist = el("a", "mu-link", track.artist || track.album_artist || "");
        artist.href = track.artist_id ? href(`artist/${encode(track.artist_id)}`) : href();
        subtitle.append(artist);
        if (like.dataset.track !== track.id) {
            like.dataset.track = track.id;
            like.replaceChildren(likeButton("track", track.id, "Save to Liked Songs (L)"));
        }
    }

    function updateStatus() {
        const instance = player();
        const engine = instance.engine;
        status.replaceChildren();
        status.className = "mu-bar-status";
        if (instance.remote) {
            status.classList.add("remote");
            status.append(icon("devices", 14), ` Playing on ${instance.remote.device.name}`);
        } else if (instance.blocked) {
            status.classList.add("blocked");
            status.append(button("Tap to resume here", "mu-chip mu-chip-accent", () => instance.resume()));
        } else if (engine.error) {
            status.classList.add("error");
            status.append(engine.error, button("Retry", "mu-chip", () => engine.retry(true)));
        } else if (engine.buffering && engine.track) {
            status.textContent = "Buffering…";
        } else if (instance.sleep) {
            status.textContent = instance.sleep.endOfTrack ? "Sleep timer: end of track" : `Sleep timer: ${Math.max(1, Math.round((instance.sleep.until - Date.now()) / 60000))} min`;
        }
        status.hidden = !status.childNodes.length;
        sleep.classList.toggle("on", Boolean(instance.sleep));
    }

    for (const name of ["track", "queue", "remote", "state"]) {
        player().on(name, update);
    }
    for (const name of ["state", "blocked", "sleep", "remote", "track"]) {
        player().on(name, updateStatus);
    }
    setInterval(() => player().sleep && updateStatus(), 30000);
    update();
    updateStatus();
    return bar;
}
