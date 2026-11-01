import * as api from "./api.js";
import * as store from "./store.js";

const palettes = new Map();
let currentAlbum = null; // the album whose cover colours Music when the accent follows artwork
const themed = new Set();
const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

export function register(node) {
    themed.add(node);
    apply();
    return () => themed.delete(node);
}

function resolvedTheme() {
    const theme = store.preference("theme", "system");
    if (theme === "system") {
        return media && media.matches ? "light" : "dark";
    }
    return theme;
}

export function apply() {
    const theme = resolvedTheme();
    const density = store.preference("density", "comfortable");
    for (const node of themed) {
        node.dataset.muTheme = theme;
        node.dataset.muDensity = density;
    }
    const accent = store.preference("accent", "artwork");
    if (accent && accent !== "artwork") {
        setAccent(hexToRgb(accent));
    } else {
        followArtwork(currentAlbum);
    }
}

if (media && media.addEventListener) {
    media.addEventListener("change", apply);
}
store.on("preferences", apply);

function hexToRgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// Music's own accent (a picked colour or the cover's) lives in --mu-accent and only colours Music.
// With none set, page.css falls back to StarCore's --sc-accent, so the global choice applies live.
function setAccent(rgb) {
    const root = document.documentElement.style;
    if (rgb) {
        root.setProperty("--mu-accent", `rgb(${rgb.join(",")})`);
    } else {
        root.removeProperty("--mu-accent");
    }
}

// the most saturated colours of the cover, sampled small; artwork is same-origin so the canvas stays readable
export function palette(albumId) {
    if (!albumId) {
        return Promise.resolve(null);
    }
    if (palettes.has(albumId)) {
        return palettes.get(albumId);
    }
    const promise = new Promise((resolve) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = 24;
                canvas.height = 24;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                context.drawImage(image, 0, 0, 24, 24);
                const data = context.getImageData(0, 0, 24, 24).data;
                const buckets = new Map();
                for (let index = 0; index < data.length; index += 4) {
                    const [r, g, b] = [data[index], data[index + 1], data[index + 2]];
                    const max = Math.max(r, g, b);
                    const min = Math.min(r, g, b);
                    const saturation = max ? (max - min) / max : 0;
                    const key = `${r >> 5},${g >> 5},${b >> 5}`;
                    const entry = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0, weight: 0 };
                    entry.r += r;
                    entry.g += g;
                    entry.b += b;
                    entry.count += 1;
                    entry.weight += 0.3 + saturation * (max > 40 && max < 245 ? 1 : 0.2);
                    buckets.set(key, entry);
                }
                const ranked = [...buckets.values()].sort((a, b) => b.weight - a.weight);
                const colour = (entry) => [entry.r, entry.g, entry.b].map((sum) => Math.round(sum / entry.count));
                resolve(ranked[0] ? { primary: lift(colour(ranked[0])) } : null);
            } catch (error) {
                resolve(null);
            }
        };
        image.onerror = () => resolve(null);
        image.src = api.artworkUrl(albumId, 96);
    });
    palettes.set(albumId, promise);
    return promise;
}

function lift(rgb) {
    const max = Math.max(...rgb);
    // bright enough for dark on-accent text to stay readable on it
    if (max < 170) {
        const scale = 170 / Math.max(max, 1);
        return rgb.map((channel) => Math.min(255, Math.round(channel * scale)));
    }
    return rgb;
}

export async function followArtwork(albumId) {
    currentAlbum = albumId || null;
    if (store.preference("accent", "artwork") !== "artwork") {
        return;
    }
    const colours = await palette(albumId);
    if (currentAlbum === (albumId || null) && store.preference("accent", "artwork") === "artwork") {
        setAccent(colours ? colours.primary : null);
    }
}
