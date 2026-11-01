import * as api from "./api.js";
import * as store from "./store.js";

const DEFAULT_ACCENT = [108, 155, 240];
const palettes = new Map();
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

function setAccent(rgb, secondary) {
    const root = document.documentElement.style;
    root.setProperty("--mu-accent", `rgb(${rgb.join(",")})`);
    root.setProperty("--mu-accent-rgb", rgb.join(","));
    const second = secondary || rgb.map((channel) => Math.round(channel * 0.35));
    root.setProperty("--mu-accent-deep-rgb", second.join(","));
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
                const primary = ranked[0] ? lift(colour(ranked[0])) : DEFAULT_ACCENT;
                const secondary = ranked[1] ? colour(ranked[1]).map((channel) => Math.round(channel * 0.5)) : null;
                resolve({ primary, secondary });
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
    if (max < 110) {
        const scale = 110 / Math.max(max, 1);
        return rgb.map((channel) => Math.min(255, Math.round(channel * scale)));
    }
    return rgb;
}

export async function followArtwork(albumId) {
    if (store.preference("accent", "artwork") !== "artwork") {
        return;
    }
    const colours = await palette(albumId);
    setAccent(colours ? colours.primary : DEFAULT_ACCENT, colours ? colours.secondary : null);
}

setAccent(DEFAULT_ACCENT);
