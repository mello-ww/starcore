// The download and share actions (UI contract 1.2) in Mission Control: a file from one of the
// Satellite's own routes, fetched with this browser's session, saved or handed to the system
// share sheet. It knows the contract, never a Satellite.

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;
const LONGEST = 120;

/** The name a file is saved under: the document's `name`, else the route's last segment,
 * with no path separator, reserved or control character or leading dot, and never empty. */
export function fileName(name, route) {
    let chosen = name === null || name === undefined ? "" : String(name).trim();
    if (!chosen) {
        const segments = String(route || "").split("?")[0].split("/").filter(Boolean);
        chosen = segments.length ? segments[segments.length - 1] : "";
    }
    // no leading dot either: it would be a hidden file
    chosen = chosen.replace(UNSAFE, "_").replace(/^\.+/, "").slice(0, LONGEST);
    return chosen || "download";
}

/** Whether this browser can hand a file to the system share sheet (the Web Share API with
 * files). Without it the share action is hidden. */
export function canShareFiles(navigatorLike) {
    if (!navigatorLike || typeof navigatorLike.share !== "function" || typeof navigatorLike.canShare !== "function") {
        return false;
    }
    try {
        const probe = typeof File === "function" ? new File([""], "probe.jpg", { type: "image/jpeg" }) : {};
        return Boolean(navigatorLike.canShare({ files: [probe] }));
    } catch {
        return false;
    }
}

/** Saves the file at `url` (the Satellite's own route) as `name`. The browser's own download,
 * with this session's cookie, so a large video streams to disk instead of into memory. */
export function downloadFile(url, name) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/** Fetches the file at `url` with this session and hands it to the system share sheet. Resolves
 * false when the person closes the sheet; throws when the file can't be fetched or shared. */
export async function shareFile(url, name) {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) {
        throw new Error(`The file could not be fetched (${response.status}).`);
    }
    const blob = await response.blob();
    const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    if (!navigator.canShare || !navigator.canShare({ files: [file] })) {
        throw new Error("This browser can't share this file.");
    }
    try {
        await navigator.share({ files: [file], title: name });
        return true;
    } catch (error) {
        if (error && error.name === "AbortError") {
            return false;  // the person closed the share sheet
        }
        throw error;
    }
}
