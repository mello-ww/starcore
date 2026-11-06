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

/** [south, west, north, east] from a binding's value, or null. */
export function boundsOf(value) {
    if (!Array.isArray(value) || value.length !== 4) {
        return null;
    }
    const [south, west, north, east] = value.map(Number);
    if (![south, west, north, east].every(Number.isFinite) || south > north || Math.abs(south) > 90 || Math.abs(north) > 90
        || Math.abs(west) > 180 || Math.abs(east) > 180) {
        return null;
    }
    return [south, west, north, east];
}

/** What a viewport route gets as $value: the area on screen and the zoom. */
export function viewportValue(bounds, zoom) {
    const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
    const [south, west, north, east] = bounds;
    const round = (value) => Math.round(value * 1e5) / 1e5;
    const span = east - west;
    // a map wider than the world wraps: ask for all of it
    const [w, e] = span >= 360 ? [-180, 180] : [clamp(round(west), 180), clamp(round(east), 180)];
    return { bbox: [clamp(round(south), 90), w, clamp(round(north), 90), e].join(","), zoom: Math.max(0, Math.round(zoom)) };
}

// the map asks for what is on screen this long after it stops moving
const VIEWPORT_PAUSE = 250;

/**
 * host: {satelliteBase, runAction(action, scope), gallery, load(route)} - the gallery's shared
 * viewer shows a marker's items; `load` fetches a viewport's items from the Satellite's own
 * route. Returns {render(block, scope), reset()}.
 */
export function createMaps(host) {
    let maps = new WeakMap();
    let live = [];  // every Leaflet map drawn on this page, removed when the page changes

    /** The located items of `scope.data`, each with its count: more than one is a cluster the
     * provider made (a viewport answer), opened by zooming into its bounds. */
    function located(block, scope) {
        const resolved = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
        const points = [];
        (Array.isArray(resolved) ? resolved : []).forEach((item, index) => {
            const itemScope = { ...scope, data: item };
            const pair = coordinates(resolve(block.item.lat, itemScope), resolve(block.item.lon, itemScope));
            if (pair) {
                const count = block.item.count !== undefined ? Number(resolve(block.item.count, itemScope)) : 1;
                points.push({
                    lat: pair[0], lon: pair[1], item, key: itemKey(block, item, index, scope), scope: itemScope,
                    count: Number.isFinite(count) && count > 1 ? Math.round(count) : 1,
                    area: block.item.bounds !== undefined ? boundsOf(resolve(block.item.bounds, itemScope)) : null,
                });
            }
        });
        return points;
    }

    /** Loads what is on screen through the block's `viewport`; a reply that arrives after the
     * map moved again is dropped, and a failure keeps what is shown, with a way to retry. */
    function loadViewport(block, entry) {
        if (!block.viewport || !entry.map || !host.load) {
            return;
        }
        const bounds = entry.map.getBounds();
        const value = viewportValue([bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()], entry.map.getZoom());
        const route = resolveTemplate(block.viewport.route, { ...entry.scope, value });
        if (!isSafeRoute(route)) {
            return;
        }
        const token = ++entry.token;
        entry.status.hidden = false;
        entry.status.replaceChildren(el("span", null, "Loading…"));
        host.load(route).then((data) => {
            if (token !== entry.token) {
                return;
            }
            entry.points = located(block, { ...entry.scope, data: data || {}, page: data || {} });
            entry.status.hidden = true;
            draw(block, entry);
            followViewer(block, entry);
        }).catch((error) => {
            if (token !== entry.token) {
                return;
            }
            entry.status.replaceChildren(el("span", null, error.message || "This area could not be loaded."));
            const retry = el("button", "ui-pill", "Try again");
            retry.type = "button";
            retry.addEventListener("click", () => loadViewport(block, entry));
            entry.status.appendChild(retry);
        });
    }

    function followViewer(block, entry) {
        // the viewer open on a marker follows fresh data (after an action's refresh)
        if (entry.viewing) {
            const keys = new Set(entry.viewing);
            host.gallery.update(block, entry.points.filter((point) => keys.has(point.key)).map((point) => point.item), entry.scope);
        }
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
        // the provider's own clusters: a count, and a tap zooms into them
        for (const point of entry.points.filter((each) => each.count > 1)) {
            const icon = L.divIcon({
                className: "ui-map-marker ui-map-marker-group",
                html: `<span class="ui-map-marker-dot"></span><span class="ui-map-marker-count">${point.count}</span>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });
            const marker = L.marker([point.lat, point.lon], { icon, keyboard: true, title: `${point.count} items` });
            marker.on("click", () => {
                if (point.area && (point.area[0] !== point.area[2] || point.area[1] !== point.area[3])) {
                    entry.map.fitBounds([[point.area[0], point.area[1]], [point.area[2], point.area[3]]], { padding: [32, 32] });
                } else {
                    entry.map.setView([point.lat, point.lon], Math.min(entry.map.getZoom() + 3, 19));
                }
            });
            entry.markers.addLayer(marker);
        }
        for (const cluster of clusterPoints(entry.points.filter((each) => each.count <= 1), entry.map.getZoom())) {
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
        if (entry.bounds) {
            const [south, west, north, east] = entry.bounds;
            if (south === north && west === east) {
                entry.map.setView([south, west], 13);
            } else {
                entry.map.fitBounds([[south, west], [north, east]], { padding: [32, 32] });
            }
            return;
        }
        const pairs = entry.points.map((point) => [point.lat, point.lon]);
        if (!pairs.length) {
            entry.map.setView([20, 0], 2);
        } else if (pairs.length === 1) {
            entry.map.setView(pairs[0], 13);
        } else {
            entry.map.fitBounds(L.latLngBounds(pairs), { padding: [32, 32] });
        }
    }

    function render(block, scope) {
        const points = located(block, scope);
        const bounds = block.bounds !== undefined ? boundsOf(resolve(block.bounds, scope)) : null;
        let entry = maps.get(block);
        if (!entry) {
            const box = el("section", "ui-map");
            const canvas = el("div", "ui-map-canvas");
            canvas.setAttribute("role", "region");
            canvas.setAttribute("aria-label", "Map");
            const status = el("div", "ui-map-status");
            status.setAttribute("role", "status");
            status.hidden = true;
            const notice = el("p", "ui-map-notice");
            notice.hidden = true;
            box.append(canvas, status, notice);
            entry = {
                box, canvas, status, notice, map: null, markers: null, points: [], scope, signature: "", viewing: null,
                loading: null, bounds: null, token: 0, timer: null,
            };
            maps.set(block, entry);
            live.push(entry);
        }
        const viewportMode = Boolean(block.viewport);
        entry.scope = scope;
        entry.bounds = bounds;
        if (!viewportMode) {
            entry.points = points;
            followViewer(block, entry);
        }
        if (viewportMode ? !bounds && !points.length : !points.length) {
            const empty = block.empty !== undefined ? resolve(block.empty, scope) : null;
            entry.canvas.hidden = true;
            entry.notice.hidden = false;
            entry.notice.textContent = empty === null || empty === undefined || empty === "" ? "Nothing here has a location yet." : String(empty);
            return entry.box;
        }
        entry.canvas.hidden = false;
        entry.notice.hidden = true;
        const signature = viewportMode
            ? `bounds:${(bounds || []).join(",")}`
            : points.map((point) => `${point.key}@${point.lat},${point.lon}`).join("|");
        const refit = signature !== entry.signature;
        entry.signature = signature;
        if (entry.map) {
            // the same map, moved back into the redrawn page: it only needs its size again
            requestAnimationFrame(() => {
                entry.map.invalidateSize();
                if (refit) {
                    fit(entry);  // a viewport map then loads the new area as it settles
                } else if (viewportMode) {
                    loadViewport(block, entry);  // a refresh: what is on screen, again
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
                if (viewportMode) {
                    entry.map.on("moveend", () => {
                        clearTimeout(entry.timer);
                        entry.timer = setTimeout(() => loadViewport(block, entry), VIEWPORT_PAUSE);
                    });
                }
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
            clearTimeout(entry.timer);
            entry.token += 1;
            entry.map?.remove();
        }
        live = [];
        maps = new WeakMap();
    }

    return { render, reset };
}
