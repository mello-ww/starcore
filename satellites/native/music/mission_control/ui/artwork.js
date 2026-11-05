// Music's playlist covers: an uploaded cover or a mosaic of four album covers, from Music's
// own routes. A single album cover is the shared player's artwork().
import * as api from "../api.js";
import { artwork } from "/media/artwork.js";
import { el } from "/media/dom.js";

export { artwork };

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
