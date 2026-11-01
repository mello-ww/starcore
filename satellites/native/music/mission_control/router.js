// Mission Control routes on "#/satellite/<name>" and ignores anything after it, so the page keeps
// its own location in the rest of the hash: back/forward and links keep working.
let prefix = "#/satellite/Music";

export function setSatellite(name) {
    prefix = `#/satellite/${encodeURIComponent(name)}`;
}

export function href(path = "") {
    return path ? `${prefix}/${path}` : prefix;
}

export function go(path = "") {
    const target = href(path);
    if (location.hash !== target) {
        location.hash = target;
    }
}

export function current() {
    const hash = location.hash;
    if (!hash.startsWith(prefix)) {
        return null;
    }
    const rest = hash.slice(prefix.length).replace(/^\//, "");
    const [path, search = ""] = rest.split("?");
    const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    return { view: parts[0] || "home", parts: parts.slice(1), params: new URLSearchParams(search) };
}

export function encode(value) {
    return encodeURIComponent(value);
}
