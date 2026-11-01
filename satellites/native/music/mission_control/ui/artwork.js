import * as api from "../api.js";
import { el, icon } from "./dom.js";

export function artwork(albumId, size = 300, className = "mu-art") {
    const frame = el("div", className);
    if (albumId) {
        const image = el("img");
        image.loading = "lazy";
        image.decoding = "async";
        image.alt = "";
        image.src = api.artworkUrl(albumId, size);
        image.addEventListener("error", () => {
            image.remove();
            frame.classList.add("mu-art-empty");
            frame.appendChild(icon("library", 28));
        });
        frame.appendChild(image);
    } else {
        frame.classList.add("mu-art-empty");
        frame.appendChild(icon("library", 28));
    }
    return frame;
}

export function mosaic(albumIds, cover, className = "mu-art", size = 300) {
    if (cover) {
        const frame = el("div", className);
        const image = el("img");
        image.alt = "";
        image.loading = "lazy";
        image.src = api.coverUrl(cover, size);
        frame.appendChild(image);
        return frame;
    }
    const ids = (albumIds || []).filter(Boolean);
    if (ids.length < 4) {
        return artwork(ids[0], size, className);
    }
    const frame = el("div", `${className} mu-mosaic`);
    for (const id of ids.slice(0, 4)) {
        const image = el("img");
        image.alt = "";
        image.loading = "lazy";
        image.src = api.artworkUrl(id, Math.round(size / 2));
        frame.appendChild(image);
    }
    return frame;
}
