// The upload action (UI contract 1.2) in Mission Control: files the person picks with the
// browser's own dialog, each sent in turn as the raw body of a POST to one of the Satellite's
// own routes, with a conflict asked about file by file and a report of every file. The sending
// itself is the host's (a streamed fetch with this browser's session); what is decided here is
// pure, so the tests check it without a browser. It knows the contract, never a Satellite.

import { fileName } from "./files.js";

/** What `$value` is while one file is sent: its name, made safe as a download's, and its size. */
export function uploadValue(file) {
    const size = Number(file && file.size);
    return { name: fileName(file && file.name, "upload"), size: Number.isFinite(size) && size >= 0 ? size : 0 };
}

function failure(answer) {
    const error = answer && answer.payload && typeof answer.payload.error === "string" ? answer.payload.error : "";
    return error || `the server answered ${answer ? answer.status : "nothing"}`;
}

/**
 * Sends `files` one after another for `action` ({route, conflict}). The host gives:
 * - `url(template, value)`: the Satellite URL for a route template with `$value`, or null when
 *   the route would leave the Satellite;
 * - `send(url, file)`: resolves `{status, payload}` for any answer, throws when nothing came back;
 * - `confirm(value, text)`: whether to replace the file `value` names (`text` is the document's
 *   own `conflict.confirm`, unresolved);
 * - `progress(index, total, value)`, optional: before each file.
 * Resolves `{uploaded, skipped, failed}`: names, names, and `{name, error}`.
 */
export async function runUploads(files, action, host) {
    const result = { uploaded: [], skipped: [], failed: [] };
    const conflict = action && action.conflict && typeof action.conflict.route === "string" ? action.conflict : null;
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const value = uploadValue(file);
        if (host.progress) {
            host.progress(index, files.length, value);
        }
        const post = async (template) => {
            const url = host.url(template, value);
            if (!url) {
                throw new Error("the upload points outside its Satellite and was refused");
            }
            const answer = await host.send(url, file);
            if (!answer || typeof answer.status !== "number") {
                throw new Error("the upload failed");
            }
            return answer;
        };
        try {
            let answer = await post(action.route);
            if (answer.status === 409 && conflict) {
                if (!(await host.confirm(value, conflict.confirm))) {
                    result.skipped.push(value.name);
                    continue;
                }
                answer = await post(conflict.route);
            }
            if (answer.status >= 200 && answer.status < 300) {
                result.uploaded.push(value.name);
            } else {
                result.failed.push({ name: value.name, error: failure(answer) });
            }
        } catch (error) {
            result.failed.push({ name: value.name, error: (error && error.message) || "the upload failed" });
        }
    }
    return result;
}

const NAMED = 3;

function names(list) {
    const shown = list.slice(0, NAMED).join(", ");
    return list.length > NAMED ? `${shown} and ${list.length - NAMED} more` : shown;
}

/** What the person is told once every file was tried: `{text, kind}`, an error when any file
 * failed. Part of a selection is never reported as all of it. */
export function uploadReport(result) {
    const { uploaded, skipped, failed } = result;
    const total = uploaded.length + skipped.length + failed.length;
    if (total === 0) {
        return { text: "Nothing was uploaded.", kind: "notice" };
    }
    if (uploaded.length === total) {
        return { text: total === 1 ? `Uploaded ${uploaded[0]}.` : `Uploaded ${total} files.`, kind: "notice" };
    }
    const parts = [];
    if (total > 1) {
        parts.push(`Uploaded ${uploaded.length} of ${total} files.`);
    }
    if (skipped.length) {
        parts.push(`Kept the existing ${names(skipped)}.`);
    }
    if (failed.length) {
        const shown = failed.slice(0, NAMED).map((entry) => `${entry.name} (${entry.error})`).join("; ");
        const more = failed.length > NAMED ? ` and ${failed.length - NAMED} more` : "";
        parts.push(`Could not upload ${shown}${more}.`);
    }
    return { text: parts.join(" "), kind: failed.length ? "error" : "notice" };
}

/** The browser's own file dialog: resolves the files picked, or none when it was closed. */
export function chooseFiles({ multiple = false } = {}, doc = document, win = window) {
    return new Promise((done) => {
        const input = doc.createElement("input");
        input.type = "file";
        input.multiple = multiple;
        input.hidden = true;
        let settled = false;
        const finish = (files) => {
            if (settled) {
                return;
            }
            settled = true;
            win.removeEventListener("focus", onFocus);
            input.remove();
            done(files);
        };
        // a dialog closed without a choice: `cancel` where the browser has it, else the window
        // getting its focus back with nothing chosen
        const onFocus = () => setTimeout(() => {
            if (!input.files || input.files.length === 0) {
                finish([]);
            }
        }, 1500);
        input.addEventListener("change", () => finish([...(input.files || [])]));
        input.addEventListener("cancel", () => finish([]));
        win.addEventListener("focus", onFocus);
        doc.body.appendChild(input);
        input.click();
    });
}

/** One file to `url`, streamed by the browser from disk with this session: always as plain
 * bytes, so a route never mistakes a JSON file for a request. */
export async function sendFile(url, file) {
    const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
        body: file,
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
}
