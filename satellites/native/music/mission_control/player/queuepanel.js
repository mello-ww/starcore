import { encode, go } from "../router.js";
import { trackMenu } from "../ui/actions.js";
import { artwork } from "../ui/artwork.js";
import { button, duration, el, emptyState, icon, iconButton } from "../ui/dom.js";
import { player } from "./player.js";

export function queuePanel() {
    const node = el("div", "mu-queue");
    const stops = [player().on("queue", render), player().on("remote", render)];

    function row(track, position, label) {
        const item = el("div", `mu-queue-row${position === player().index ? " current" : ""}`);
        item.draggable = position !== player().index;
        item.tabIndex = 0;
        const handle = el("span", "mu-drag-handle");
        handle.appendChild(icon("drag", 14));
        const info = el("div", "mu-queue-info");
        info.append(el("span", "mu-track-title", track.title), el("span", "mu-track-sub", track.artist || track.album_artist || ""));
        item.append(handle, artwork(track.album_id, 96, "mu-art mu-queue-art"), info, el("span", "mu-track-duration", duration(track.duration)));
        if (position !== player().index) {
            item.append(iconButton("close", `Remove ${track.title} from the queue`, () => player().remove(position)));
        }
        item.addEventListener("dblclick", () => player().jump(position));
        item.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                player().jump(position);
            } else if (event.key === "Delete") {
                player().remove(position);
            } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                player().move(position, position + (event.key === "ArrowUp" ? -1 : 1));
            }
        });
        item.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            trackMenu(track, event, [{ label: "Remove from queue", action: () => player().remove(position), disabled: position === player().index }]);
        });
        item.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData("text/plain", String(position));
            event.dataTransfer.effectAllowed = "move";
            item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => item.classList.remove("dragging"));
        item.addEventListener("dragover", (event) => {
            event.preventDefault();
            item.classList.add("drop-target");
        });
        item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
        item.addEventListener("drop", (event) => {
            event.preventDefault();
            item.classList.remove("drop-target");
            const from = Number(event.dataTransfer.getData("text/plain"));
            if (Number.isInteger(from)) {
                player().move(from, position);
            }
        });
        item.setAttribute("aria-label", label);
        return item;
    }

    function render() {
        const instance = player();
        if (instance.remote) {
            node.replaceChildren(emptyState(`Queue on ${instance.remote.device.name}`, "The queue lives on the device that's playing. Move playback here to edit it."));
            return;
        }
        if (!instance.queue.length) {
            node.replaceChildren(emptyState("Your queue is empty", "Play something, or use “Add to queue” on any song."));
            return;
        }
        const head = el("div", "mu-queue-head");
        head.append(el("h4", null, "Now playing"), button("Clear queue", "mu-text-button", () => instance.clear()));
        const current = instance.current;
        const items = [head];
        if (current) {
            items.push(row(current, instance.index, `Now playing ${current.title}`));
        }
        const next = instance.queue.slice(instance.index + 1);
        if (next.length) {
            items.push(el("h4", null, instance.context ? `Next from ${describe(instance.context)}` : "Next up"));
            next.forEach((track, offset) => items.push(row(track, instance.index + 1 + offset, `${offset + 1}: ${track.title}`)));
        }
        if (instance.repeat === "all" && instance.index > 0) {
            items.push(el("p", "mu-queue-note", `Repeat is on: ${instance.index} earlier song${instance.index === 1 ? "" : "s"} play again after these.`));
        }
        const footer = el("div", "mu-queue-foot");
        if (current && current.album_id) {
            footer.append(button("Go to album", "mu-text-button", () => go(`album/${encode(current.album_id)}`)));
        }
        items.push(footer);
        node.replaceChildren(...items);
    }

    render();
    node.dispose = () => stops.forEach((stop) => stop());
    return node;
}

function describe(context) {
    const [kind] = context.split(":");
    return { album: "the album", playlist: "the playlist", artist: "the artist", mix: "the mix", radio: "the radio station", liked: "Liked Songs", search: "search", genre: "the genre", folder: "the folder", library: "your library", queue: "your queue" }[kind] || "your queue";
}
