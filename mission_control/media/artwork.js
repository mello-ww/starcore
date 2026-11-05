import * as library from "./library.js";
import { el, icon } from "./dom.js";

export function artwork(albumId, size = 300, className = "mu-art") {
    const frame = el("div", className);
    if (albumId) {
        const image = el("img");
        image.loading = "lazy";
        image.decoding = "async";
        image.alt = "";
        image.src = library.artworkUrl(albumId, size);
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
