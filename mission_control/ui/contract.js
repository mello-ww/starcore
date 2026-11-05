// StarCore UI contract 1.1 - Mission Control's side of the shared rules:
// bindings, route templates, route safety, formats and compatibility.
// Pure functions, no DOM, so contracts/ui/tests/web.test.mjs can check them
// against the same fixtures the Engine and the Android app use.
// See docs/ui-contract.md. Nothing here ever evaluates code from a document.

export const CONTRACT_NAME = "starcore.ui";
export const MAJOR = 1;
export const MINOR = 2;

export const BLOCK_TYPES = new Set([
    "heading", "text", "field", "metric", "card", "list", "button",
    "toggle", "slider", "form", "file-browser",
    // 1.1
    "chart", "table", "choice", "status", "code",
    // 1.2
    "image", "media-list",
]);
export const FORMATS = new Set([
    "text", "number", "integer", "percent", "bytes", "duration",
    // 1.1
    "bitrate", "byterate", "date", "time", "datetime", "relative",
]);
export const TONES = new Set(["neutral", "ok", "warn", "danger"]);
export const ICONS = new Set([
    "activity", "box", "camera", "check", "circle", "clock", "cpu", "file", "file-text",
    "folder", "grid", "hard-drive", "home", "image", "info", "layers", "list", "lock",
    "music", "plus", "settings", "sliders", "star", "zap",
]);
// device features this client offers a document beyond its blocks: the shared audio host
// (mission_control/media/), which the play action plays through
export const CLIENT_CAPABILITIES = new Set(["media.audio"]);
// Satellite capabilities this client has a shared block for, and the
// protocol versions it speaks
export const CAPABILITY_VERSIONS = { "files.browse": [1], "audio.library": [1] };

const RESERVED_SEGMENTS = new Set(["assets", "enable", "disable", "reload", "ui"]);
const FIRST_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SEGMENT = /^[A-Za-z0-9_.~%-]+$/;
const QUERY = /^[A-Za-z0-9_.~%&=+-]*$/;
const CONTRACT_PATTERN = /^starcore\.ui\/(\d+)\.(\d+)$/;

export function parseContract(value) {
    const match = typeof value === "string" ? CONTRACT_PATTERN.exec(value) : null;
    return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/** null when this client can render the document, else why not. */
export function checkDocument(document) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
        return "The interface description must be an object.";
    }
    const version = parseContract(document.contract);
    if (!version) {
        return "The interface description has no valid contract version.";
    }
    if (version.major !== MAJOR) {
        return `This interface needs ${document.contract}; this Mission Control renders ${CONTRACT_NAME}/${MAJOR}.x.`;
    }
    const pages = document.pages;
    if (!pages || typeof pages !== "object" || Array.isArray(pages) || Object.keys(pages).length === 0) {
        return "The interface description has no pages.";
    }
    if (!Object.hasOwn(pages, document.entry)) {
        return "The interface description's entry page is missing.";
    }
    return null;
}

/** What a document needs that this client or this server can't give it. */
export function missingRequirements(requires, providers) {
    const missing = [];
    for (const name of (requires && requires.client) || []) {
        if (!CLIENT_CAPABILITIES.has(name)) {
            missing.push({ kind: "client", name });
        }
    }
    for (const name of (requires && requires.capabilities) || []) {
        if (!findProvider(providers, name)) {
            missing.push({ kind: "capability", name });
        }
    }
    return missing;
}

/** The first enabled Satellite that provides `name` in a protocol version
 * this client speaks, from GET /api/catalog's capabilities - or null. */
export function findProvider(providers, name) {
    const versions = CAPABILITY_VERSIONS[name] || [];
    const candidates = (providers && providers[name]) || [];
    return candidates.find((entry) => entry.enabled && versions.includes(entry.version)) || null;
}

function lookup(root, path) {
    let value = root;
    for (const segment of path) {
        if (value === null || value === undefined || typeof value !== "object") {
            return null;
        }
        value = Object.hasOwn(value, segment) ? value[segment] : null;
    }
    return value === undefined ? null : value;
}

function resolveString(expression, context) {
    if (!expression.startsWith("$")) {
        return expression;
    }
    if (expression.startsWith("$$")) {
        return expression.slice(1);
    }
    if (expression === "$") {
        return context.data === undefined ? null : context.data;
    }
    if (expression === "$value") {
        return context.value === undefined ? null : context.value;
    }
    const roots = {
        "$.": "data", "$page.": "page", "$params.": "params", "$form.": "form", "$state.": "state", "$sources.": "sources",
    };
    for (const [prefix, key] of Object.entries(roots)) {
        if (expression.startsWith(prefix)) {
            return lookup(context[key], expression.slice(prefix.length).split("."));
        }
    }
    return null;
}

/** A binding (or any literal, nested object or array) resolved against
 * {data, page, params, value, form, state, sources}. Plain lookups only -
 * no expressions. */
export function resolve(expression, context) {
    if (typeof expression === "string") {
        return resolveString(expression, context);
    }
    if (Array.isArray(expression)) {
        return expression.map((item) => resolve(item, context));
    }
    if (expression && typeof expression === "object") {
        return Object.fromEntries(Object.entries(expression).map(([key, item]) => [key, resolve(item, context)]));
    }
    return expression;
}

/** "items/{$params.id}" -> "items/item%207": each placeholder is a binding,
 * always URL-encoded, so a value can never add a path segment of its own. */
export function resolveTemplate(template, context) {
    return String(template).replace(/\{([^{}]*)\}/g, (_, expression) => {
        const value = resolve(expression, context);
        return value === null || value === undefined ? "" : encodeURIComponent(String(value));
    });
}

/** Whether a resolved route stays beneath its Satellite - never a Core
 * endpoint, another Satellite or another host. */
export function isSafeRoute(route) {
    if (typeof route !== "string" || route === "") {
        return false;
    }
    const question = route.indexOf("?");
    const path = question === -1 ? route : route.slice(0, question);
    if (question !== -1 && !QUERY.test(route.slice(question + 1))) {
        return false;
    }
    const segments = path.split("/");
    if (!FIRST_SEGMENT.test(segments[0]) || RESERVED_SEGMENTS.has(segments[0])) {
        return false;
    }
    return segments.slice(1).every((segment) => segment !== "" && segment !== "." && segment !== ".."
        && SEGMENT.test(segment));
}

export function isVisible(value) {
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    return Boolean(value);
}

export function toneOf(value) {
    return TONES.has(value) ? value : "neutral";
}

function trimNumber(value, digits) {
    return String(Number(value.toFixed(digits)));
}

function scaled(value, units, base) {
    let index = 0;
    let amount = value;
    while (Math.abs(amount) >= base && index < units.length - 1) {
        amount /= base;
        index += 1;
    }
    return `${index === 0 ? Math.round(amount) : trimNumber(amount, 1)} ${units[index]}`;
}

function duration(seconds) {
    const total = Math.round(seconds);
    const parts = [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]];
    for (let index = 0; index < parts.length; index += 1) {
        const [size, unit] = parts[index];
        if (total >= size || size === 1) {
            const whole = Math.floor(total / size);
            const rest = index < parts.length - 1 ? Math.floor((total % size) / parts[index + 1][0]) : 0;
            return rest ? `${whole}${unit} ${rest}${parts[index + 1][1]}` : `${whole}${unit}`;
        }
    }
    return `${total}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function moment(seconds, format, utc) {
    const date = new Date(seconds * 1000);
    const hours = utc ? date.getUTCHours() : date.getHours();
    const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
    const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    const day = `${utc ? date.getUTCDate() : date.getDate()} ${MONTHS[utc ? date.getUTCMonth() : date.getMonth()]} `
        + `${utc ? date.getUTCFullYear() : date.getFullYear()}`;
    return format === "time" ? clock : format === "date" ? day : `${day}, ${clock}`;
}

function relative(seconds, now) {
    const difference = now - seconds;
    const size = Math.abs(difference);
    if (size < 10) {
        return "just now";
    }
    const amount = size < 60 ? `${Math.floor(size)}s`
        : size < 3600 ? `${Math.floor(size / 60)} min`
            : size < 86400 ? `${Math.floor(size / 3600)} h`
                : `${Math.floor(size / 86400)} d`;
    return difference > 0 ? `${amount} ago` : `in ${amount}`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];
const BIT_UNITS = ["b/s", "kb/s", "Mb/s", "Gb/s", "Tb/s"];

/** A value as display text - see "Formats" in docs/ui-contract.md.
 * `options.utc` and `options.now` (epoch seconds) exist for the tests. */
export function formatValue(value, format = "text", unit, options = {}) {
    const numeric = typeof value === "number" && Number.isFinite(value);
    let text;
    if (value === null || value === undefined) {
        return "—";
    } else if (typeof value === "boolean") {
        text = value ? "Yes" : "No";
    } else if (typeof value === "object") {
        return "—";
    } else if (!numeric) {
        text = String(value);
    } else if (format === "integer") {
        text = String(Math.round(value));
    } else if (format === "percent") {
        return `${trimNumber(value, 1)}%`;
    } else if (format === "bytes") {
        return scaled(value, BYTE_UNITS, 1024);
    } else if (format === "byterate") {
        return `${scaled(value, BYTE_UNITS, 1024)}/s`;
    } else if (format === "bitrate") {
        return scaled(Math.max(value, 0) * 8, BIT_UNITS, 1000);
    } else if (format === "duration") {
        return duration(value);
    } else if (format === "time" || format === "date" || format === "datetime") {
        return moment(value, format, Boolean(options.utc));
    } else if (format === "relative") {
        return relative(value, typeof options.now === "number" ? options.now : Date.now() / 1000);
    } else {
        text = trimNumber(value, 2);
    }
    return unit ? `${text} ${unit}` : text;
}
