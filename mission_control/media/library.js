// The audio library Mission Control's shared player plays from: whichever Satellite the
// capability catalog (GET /api/catalog) lists first as an enabled audio.library v1 provider,
// with the same Satellite's audio.session v1 when it declares one. Nothing here names a
// Satellite: every URL is built from the provider's catalog entry (docs/media-audio.md).

export const AUDIO_LIBRARY = "audio.library";
export const AUDIO_SESSION = "audio.session";
const LIBRARY_VERSIONS = [1];
const SESSION_VERSIONS = [1];

let provider = null;
let settle = () => {};
/** Settles once the provider is known, or known to be absent. */
export let ready = new Promise((resolve) => { settle = resolve; });

/** {satellite, operations, session} from a catalog's capabilities, or null. */
export function resolveProvider(capabilities) {
    const library = ((capabilities || {})[AUDIO_LIBRARY] || [])
        .find((entry) => entry.enabled && LIBRARY_VERSIONS.includes(entry.version));
    if (!library) {
        return null;
    }
    const session = ((capabilities || {})[AUDIO_SESSION] || [])
        .find((entry) => entry.enabled && entry.satellite === library.satellite && SESSION_VERSIONS.includes(entry.version));
    return { satellite: library.satellite, operations: { ...library.operations }, session: { ...(session ? session.operations : {}) } };
}

export function setProvider(value) {
    provider = value;
    settle();
}

export function currentProvider() {
    return provider;
}

export function offers(operation) {
    return Boolean(provider && provider.operations[operation]);
}

export function offersSession(operation) {
    return Boolean(provider && provider.session[operation]);
}

function base() {
    return `/api/satellites/${encodeURIComponent(provider.satellite)}`;
}

/** A path inside the provider, for media the browser loads itself (a stream the resolve
 * step answered with, say). */
export function url(relative) {
    return provider ? `${base()}/${String(relative).replace(/^\//, "")}` : null;
}

function route(table, operation, rest = "") {
    const name = provider && provider[table][operation];
    if (!name) {
        const error = new Error(`This audio library doesn't offer ${operation}.`);
        error.unsupported = true;
        throw error;
    }
    return `${base()}/${name}${rest}`;
}

export function query(params) {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
    return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
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

/** GET one operation: `table` is "operations" (audio.library) or "session" (audio.session).
 * Async, so an operation the provider doesn't offer is a rejected promise, never a throw. */
export async function get(table, operation, rest = "", options = {}) {
    const path = route(table, operation, rest);
    const response = await fetch(path, { headers: { Accept: "application/json" }, signal: options.signal });
    return parse(response, path);
}

export async function post(table, operation, rest = "", body = {}, options = {}) {
    const path = route(table, operation, rest);
    const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body || {}),
        keepalive: Boolean(options.keepalive),
    });
    return parse(response, path);
}

export function artworkUrl(albumId, sizePx = 300) {
    return albumId && offers("artwork")
        ? `${base()}/${provider.operations.artwork}/${encodeURIComponent(albumId)}?size=${sizePx}`
        : null;
}

/** Only for tests: forget the provider. */
export function reset() {
    provider = null;
    ready = new Promise((resolve) => { settle = resolve; });
}
