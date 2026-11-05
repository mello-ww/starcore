import { duration, el } from "./dom.js";
import { player } from "./player.js";

// a seek bar that follows playback (or the remote device) and only seeks once the drag is released
export function seekBar(className = "mu-seek") {
    const node = el("div", className);
    const elapsed = el("span", "mu-time", "0:00");
    const total = el("span", "mu-time", "0:00");
    const range = el("input", "mu-range");
    range.type = "range";
    range.min = "0";
    range.max = "1000";
    range.step = "1";
    range.value = "0";
    range.setAttribute("aria-label", "Seek");
    let dragging = false;

    function times() {
        const instance = player();
        if (instance.remote && instance.remote.state) {
            const state = instance.remote.state;
            const extra = state.playing && state.updated_at ? Math.max(0, Date.now() / 1000 - state.updated_at) : 0;
            return { position: Math.min((state.position || 0) + extra, state.duration || 0), length: state.duration || 0 };
        }
        return { position: instance.engine.position, length: instance.engine.duration };
    }

    function update() {
        if (dragging) {
            return;
        }
        const { position, length } = times();
        range.value = length ? String(Math.round((position / length) * 1000)) : "0";
        range.style.setProperty("--progress", `${length ? (position / length) * 100 : 0}%`);
        range.setAttribute("aria-valuetext", `${duration(position)} of ${duration(length)}`);
        elapsed.textContent = duration(position);
        total.textContent = duration(length);
    }

    range.addEventListener("input", () => {
        dragging = true;
        const { length } = times();
        elapsed.textContent = duration((Number(range.value) / 1000) * length);
        range.style.setProperty("--progress", `${Number(range.value) / 10}%`);
    });
    range.addEventListener("change", () => {
        const { length } = times();
        dragging = false;
        player().seek((Number(range.value) / 1000) * length);
    });
    node.append(elapsed, range, total);
    const stopTime = player().on("time", update);
    const stopTrack = player().on("track", update);
    const stopRemote = player().on("remote", update);
    const timer = setInterval(() => player().remote && update(), 1000);
    update();
    node.dispose = () => {
        stopTime();
        stopTrack();
        stopRemote();
        clearInterval(timer);
    };
    return node;
}
