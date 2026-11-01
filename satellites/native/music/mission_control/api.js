// the player outlives any one mount of the page, so it talks to the API through its own client
let base = "/api/satellites/Music";

export function setBase(url) {
    base = url.replace(/\/$/, "");
}

export function url(path) {
    return `${base}/${String(path).replace(/^\//, "")}`;
}

async function parse(response, path) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error((payload && payload.error) || `${path} failed with status ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}

export async function get(path, options = {}) {
    const response = await fetch(url(path), { headers: { Accept: "application/json" }, signal: options.signal });
    return parse(response, path);
}

export async function post(path, body, options = {}) {
    const response = await fetch(url(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body || {}),
        keepalive: Boolean(options.keepalive),
    });
    return parse(response, path);
}

export async function upload(path, file) {
    const response = await fetch(url(path), {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", Accept: "application/json" },
        body: file,
    });
    return parse(response, path);
}

export function query(params) {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
    return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

export function artworkUrl(albumId, sizePx = 300) {
    return albumId ? url(`artwork/${encodeURIComponent(albumId)}?size=${sizePx}`) : null;
}

export function coverUrl(cover, sizePx = 300) {
    if (!cover) {
        return null;
    }
    const [kind, id] = cover.split(":");
    if (kind === "upload") {
        return url(`covers/${id}`);
    }
    return artworkUrl(id, sizePx);
}

export function streamUrl(trackId, quality, format) {
    return url(`stream/${encodeURIComponent(trackId)}${query({ quality: quality === "original" ? undefined : quality, format: quality === "original" ? undefined : format })}`);
}
