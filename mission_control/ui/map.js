// The map block (UI contract 1.2), for Mission Control's renderer.
//
// Items with a latitude and longitude on an interactive map, grouped into clusters that separate
// as it zooms (a grid about 64 px wide on screen, so thousands of items stay a few markers). A single marker
// opens the shared viewer (or runs the block's action); a cluster shows its thumbnails first.
// It draws with Leaflet and OpenStreetMap tiles, loaded only when a map is shown: the same
// library and tiles Photo's own page already uses, so no new service or key is involved.

import { isSafeRoute, resolve, resolveTemplate } from "./contract.js";
import { itemKey, mediaKind } from "./gallery.js";

const LEAFLET_VERSION = "1.9.4";
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const POPUP_THUMBNAILS = 12;
let leafletPromise = null;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined && text !== null) {
        node.textContent = String(text);
    }
    return node;
}

function loadLeaflet() {
    if (window.L) {
        return Promise.resolve(window.L);
    }
    if (!leafletPromise) {
        leafletPromise = new Promise((resolve, reject) => {
            if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
                const css = document.createElement("link");
                css.rel = "stylesheet";
                css.href = LEAFLET_CSS;
                document.head.appendChild(css);
            }
            const script = document.createElement("script");
            script.src = LEAFLET_JS;
            script.async = true;
            script.addEventListener("load", () => resolve(window.L));
            script.addEventListener("error", () => {
                leafletPromise = null;  // a later attempt (once the network is back) tries again
                reject(new Error("The map could not be loaded - check this device's internet connection."));
            });
            document.head.appendChild(script);
        });
    }
    return leafletPromise;
}

/** A valid coordinate pair, or null. */
export function coordinates(lat, lon) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (lat === null || lon === null || lat === "" || lon === "" || !Number.isFinite(latitude) || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return null;
    }
    return [latitude, longitude];
}

// a cluster covers about this many pixels of the map, whatever the zoom
export const CLUSTER_PIXELS = 64;

/**
 * Groups located points ({lat, lon, ...}) for a zoom level: points in the same cell of a grid
 * about CLUSTER_PIXELS wide on screen share a cluster, so the number of markers stays bounded
 * however many points there are, and clusters separate as the map zooms in.
 */
export function clusterPoints(points, zoom) {
    const cell = (360 / 2 ** Math.max(0, zoom)) * (CLUSTER_PIXELS / 256);
    const buckets = new Map();
    for (const point of points) {
        const key = `${Math.floor(point.lat / cell)}:${Math.floor(point.lon / cell)}`;
        if (!buckets.has(key)) {
            buckets.set(key, []);
        }
        buckets.get(key).push(point);
    }
    const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;
    return [...buckets.values()].map((group) => ({
        lat: average(group.map((point) => point.lat)),
        lon: average(group.map((point) => point.lon)),
        points: group,
    }));
}

/**
 * host: {satelliteBase, runAction(action, scope), gallery} - the gallery's shared viewer shows
 * a marker's items. Returns {render(block, scope), reset()}.
 */
export function createMaps(host) {
    let maps = new WeakMap();
    let live = [];  // every Leaflet map drawn on this page, removed when the page changes

    function located(block, scope) {
        const resolved = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
        const points = [];
        (Array.isArray(resolved) ? resolved : []).forEach((item, index) => {
            const itemScope = { ...scope, data: item };
            const pair = coordinates(resolve(block.item.lat, itemScope), resolve(block.item.lon, itemScope));
            if (pair) {
                points.push({ lat: pair[0], lon: pair[1], item, key: itemKey(block, item, index, scope), scope: itemScope });
            }
        });
        return points;
    }

    function thumbnail(block, point) {
        if (block.item.image === undefined) {
            return null;
        }
        const route = resolveTemplate(block.item.image, point.scope);
        return route && isSafeRoute(route) ? `${host.satelliteBase}/${route}` : null;
    }

    function open(block, entry, points, index) {
        const point = points[index];
        if (block.viewer) {
            entry.viewing = points.map((each) => each.key);
            host.gallery.view(block, points.map((each) => each.item), entry.scope, point.key);
        } else if (block.action) {
            host.runAction(block.action, point.scope);
        }
    }

    function popup(block, entry, points) {
        const body = el("div", "ui-map-popup");
        const title = block.item.title !== undefined && points.length === 1 ? resolve(block.item.title, points[0].scope) : null;
        body.appendChild(el("p", "ui-map-popup-title",
            title !== null && title !== undefined && title !== "" ? String(title) : `${points.length} here`));
        const grid = el("div", "ui-map-popup-grid");
        points.slice(0, POPUP_THUMBNAILS).forEach((point, index) => {
            const button = el("button", "ui-map-popup-thumb");
            button.type = "button";
            const label = block.item.title !== undefined ? resolve(block.item.title, point.scope) : null;
            button.setAttribute("aria-label", label ? String(label) : `Item ${index + 1}`);
            const url = thumbnail(block, point);
            if (url) {
                const image = el("img");
                image.src = url;
                image.alt = "";
                image.loading = "lazy";
                button.appendChild(image);
            }
            if (mediaKind(block.item.kind !== undefined ? resolve(block.item.kind, point.scope) : null) === "video") {
                button.classList.add("is-video");
            }
            button.addEventListener("click", () => {
                entry.map.closePopup();
                open(block, entry, points, index);
            });
            grid.appendChild(button);
        });
        body.appendChild(grid);
        if (points.length > POPUP_THUMBNAILS) {
            const more = el("button", "ui-pill ui-map-popup-more", `View all ${points.length}`);
            more.type = "button";
            more.addEventListener("click", () => {
                entry.map.closePopup();
                open(block, entry, points, 0);
            });
            body.appendChild(more);
        }
        return body;
    }

    function draw(block, entry) {
        const L = window.L;
        entry.markers.clearLayers();
        for (const cluster of clusterPoints(entry.points, entry.map.getZoom())) {
            const count = cluster.points.length;
            const icon = L.divIcon({
                className: "ui-map-marker",
                html: count > 1
                    ? `<span class="ui-map-marker-dot"></span><span class="ui-map-marker-count">${count}</span>`
                    : '<span class="ui-map-marker-dot"></span>',
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });
            const marker = L.marker([cluster.lat, cluster.lon], {
                icon, keyboard: true, title: count > 1 ? `${count} items` : "One item",
            });
            if (count === 1) {
                marker.on("click", () => open(block, entry, cluster.points, 0));
            } else {
                marker.bindPopup(() => popup(block, entry, cluster.points), { className: "ui-map-leaflet-popup", maxWidth: 280 });
            }
            entry.markers.addLayer(marker);
        }
    }

    function fit(entry) {
        const L = window.L;
        const pairs = entry.points.map((point) => [point.lat, point.lon]);
        if (pairs.length === 1) {
            entry.map.setView(pairs[0], 13);
        } else {
            entry.map.fitBounds(L.latLngBounds(pairs), { padding: [32, 32] });
        }
    }

    function render(block, scope) {
        const points = located(block, scope);
        let entry = maps.get(block);
        if (!entry) {
            const box = el("section", "ui-map");
            const canvas = el("div", "ui-map-canvas");
            canvas.setAttribute("role", "region");
            canvas.setAttribute("aria-label", "Map");
            const notice = el("p", "ui-map-notice");
            notice.hidden = true;
            box.append(canvas, notice);
            entry = { box, canvas, notice, map: null, markers: null, points: [], scope, signature: "", viewing: null, loading: null };
            maps.set(block, entry);
            live.push(entry);
        }
        entry.points = points;
        entry.scope = scope;
        // the viewer open on a cluster follows the page's fresh data (after an action's refresh)
        if (entry.viewing) {
            const keys = new Set(entry.viewing);
            host.gallery.update(block, points.filter((point) => keys.has(point.key)).map((point) => point.item), scope);
        }
        if (!points.length) {
            const empty = block.empty !== undefined ? resolve(block.empty, scope) : null;
            entry.canvas.hidden = true;
            entry.notice.hidden = false;
            entry.notice.textContent = empty === null || empty === undefined || empty === "" ? "Nothing here has a location yet." : String(empty);
            return entry.box;
        }
        entry.canvas.hidden = false;
        entry.notice.hidden = true;
        const signature = points.map((point) => `${point.key}@${point.lat},${point.lon}`).join("|");
        const refit = signature !== entry.signature;
        entry.signature = signature;
        if (entry.map) {
            // the same map, moved back into the redrawn page: it only needs its size again
            requestAnimationFrame(() => {
                entry.map.invalidateSize();
                if (refit) {
                    fit(entry);
                }
                draw(block, entry);
            });
            return entry.box;
        }
        if (!entry.loading) {
            entry.loading = loadLeaflet().then((L) => {
                entry.map = L.map(entry.canvas, { attributionControl: true, zoomControl: true });
                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                    attribution: "&copy; OpenStreetMap contributors",
                    maxZoom: 19,
                }).addTo(entry.map);
                entry.markers = L.layerGroup().addTo(entry.map);
                entry.map.on("zoomend", () => draw(block, entry));
                requestAnimationFrame(() => {
                    entry.map.invalidateSize();
                    fit(entry);
                    draw(block, entry);
                });
            }).catch((error) => {
                entry.loading = null;
                entry.canvas.hidden = true;
                entry.notice.hidden = false;
                entry.notice.textContent = error.message;
            });
        }
        return entry.box;
    }

    function reset() {
        for (const entry of live) {
            entry.map?.remove();
        }
        live = [];
        maps = new WeakMap();
    }

    return { render, reset };
}
