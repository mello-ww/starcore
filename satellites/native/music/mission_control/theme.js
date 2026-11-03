import * as api from "./api.js";
import * as store from "./store.js";

const palettes = new Map();
let playingAlbum = null; // the playing track's album: its cover colours the player in "artwork" mode
const themed = new Set();
const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

// Music's accent preference: "starcore" (default) follows StarCore's global accent, "#rrggbb" is a
// colour for Music only, and "artwork" also follows StarCore except in the player, which takes
// the playing cover's colour. Anything not yet loaded or unknown reads as "starcore".
function accentMode() {
    const value = String(store.preference("accent", "starcore") || "starcore").toLowerCase();
    return value === "artwork" || /^#[0-9a-f]{6}$/.test(value) ? value : "starcore";
}

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
    const mode = accentMode();
    setColour("--mu-accent", "--mu-on-accent", mode.startsWith("#") ? hexToRgb(mode) : null);
    if (mode === "artwork") {
        followArtwork(playingAlbum);
    } else {
        setColour("--mu-player-accent", "--mu-player-on-accent", null);
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

// Sets one of Music's own colours, with the text colour that reads on it; null removes it, and
// page.css then falls back to StarCore's --sc-accent / --sc-on-accent, so the global choice
// applies live without anything here listening for it.
function setColour(property, onProperty, rgb) {
    const root = document.documentElement.style;
    if (rgb) {
        root.setProperty(property, `rgb(${rgb.join(",")})`);
        root.setProperty(onProperty, onColourFor(rgb));
    } else {
        root.removeProperty(property);
        root.removeProperty(onProperty);
    }
}

// StarCore's dark ink or white, whichever has more contrast (the same rule Mission Control uses)
export function onColourFor(rgb) {
    const [r, g, b] = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return (light + 0.05) / 0.0573 >= 1.05 / (light + 0.05) ? "#141215" : "#ffffff";
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

// called by the player bar whenever the playing album changes
export async function followArtwork(albumId) {
    playingAlbum = albumId || null;
    if (accentMode() !== "artwork") {
        return;
    }
    const colours = await palette(playingAlbum);
    if (playingAlbum === (albumId || null) && accentMode() === "artwork") {
        setColour("--mu-player-accent", "--mu-player-on-accent", colours ? colours.primary : null);
    }
}
