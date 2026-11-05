import * as api from "../api.js";
import * as store from "../store.js";
import { encode, go } from "../router.js";
import { mosaic } from "../ui/artwork.js";
import { button, el, emptyState, iconButton, longDuration, plural } from "/media/dom.js";
import { header, playButtons, trackList } from "../ui/lists.js";
import { confirm, menu, modal, prompt } from "/media/overlay.js";

const FIELDS = {
    title: ["Title", "text"], artist: ["Artist", "text"], album: ["Album", "text"], album_artist: ["Album artist", "text"],
    genre: ["Genre", "text"], composer: ["Composer", "text"], label: ["Label", "text"], format: ["Format", "text"],
    folder: ["Folder", "text"], year: ["Year", "number"], duration: ["Duration (s)", "number"], bitrate: ["Bitrate (bps)", "number"],
    sample_rate: ["Sample rate (Hz)", "number"], bit_depth: ["Bit depth", "number"], lossless: ["Lossless", "bool"],
    liked: ["Liked", "bool"], plays: ["Play count", "number"], added: ["Date added", "date"], last_played: ["Last played", "date"],
};
const OPERATORS = {
    text: [["contains", "contains"], ["is", "is"], ["is_not", "is not"], ["not_contains", "does not contain"], ["starts_with", "starts with"]],
    number: [["gt", "is greater than"], ["lt", "is less than"], ["is", "is"], ["is_not", "is not"], ["between", "is between"]],
    bool: [["is", "is"]],
    date: [["in_last_days", "in the last (days)"], ["not_in_last_days", "not in the last (days)"], ["before", "before"], ["after", "after"]],
};
const SORTS = [["added", "Date added"], ["title", "Title"], ["artist", "Artist"], ["year", "Year"], ["plays", "Play count"], ["last_played", "Last played"], ["duration", "Duration"], ["random", "Random"]];

export async function createPlaylist(tracks = []) {
    const name = await prompt("New playlist", "Name", "My playlist");
    if (!name) {
        return null;
    }
    try {
        const created = await api.post("playlists", { name, tracks: tracks.map((track) => track.id) });
        await store.refreshPlaylists();
        go(`playlist/${encode(created.id)}`);
        return created;
    } catch (error) {
        store.toast(error.message, "error");
        return null;
    }
}

export function importPlaylist() {
    const input = el("input");
    input.type = "file";
    input.accept = ".m3u,.m3u8,audio/x-mpegurl,audio/mpegurl,text/plain";
    input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            store.toast("That playlist file is too large (2 MB at most)", "error");
            return;
        }
        try {
            const content = await file.text();
            const result = await api.post("playlists/import", { name: file.name.replace(/\.m3u8?$/i, ""), content });
            await store.refreshPlaylists();
            const body = el("div");
            body.append(el("p", "mu-modal-text", `${plural(result.matched, "song")} matched from your library.`));
            if (result.unmatched.length) {
                body.append(el("p", "mu-modal-text", `${result.unmatched.length} could not be found here:`));
                const list = el("ul", "mu-unmatched");
                for (const entry of result.unmatched.slice(0, 50)) {
                    list.append(el("li", null, [entry.artist, entry.title].filter(Boolean).join(" - ") || entry.path));
                }
                body.append(list);
            }
            modal("Playlist imported", body, [{ label: "Open playlist", primary: true, action: () => go(`playlist/${encode(result.playlist.id)}`) }]);
        } catch (error) {
            store.toast(error.message, "error");
        }
    });
    input.click();
}

function ruleRow(rule, onRemove) {
    const row = el("div", "mu-rule");
    const field = el("select", "mu-select");
    for (const [key, [label]] of Object.entries(FIELDS)) {
        field.append(new Option(label, key));
    }
    field.value = rule.field || "genre";
    const operator = el("select", "mu-select");
    const value = el("input", "mu-input");
    const second = el("input", "mu-input");
    const boolean = el("select", "mu-select");
    boolean.append(new Option("yes", "true"), new Option("no", "false"));
    const sync = () => {
        const kind = FIELDS[field.value][1];
        const current = operator.value;
        operator.replaceChildren(...OPERATORS[kind].map(([key, label]) => new Option(label, key)));
        operator.value = OPERATORS[kind].some(([key]) => key === current) ? current : OPERATORS[kind][0][0];
        value.hidden = kind === "bool";
        boolean.hidden = kind !== "bool";
        second.hidden = operator.value !== "between";
        value.type = kind === "number" || operator.value.endsWith("days") ? "number" : kind === "date" ? "date" : "text";
        second.type = "number";
    };
    field.addEventListener("change", sync);
    operator.addEventListener("change", sync);
    operator.value = rule.op || "";
    sync();
    if (rule.op) {
        operator.value = rule.op;
        sync();
    }
    if (Array.isArray(rule.value)) {
        value.value = rule.value[0];
        second.value = rule.value[1];
    } else if (typeof rule.value === "boolean") {
        boolean.value = String(rule.value);
    } else if (rule.value !== undefined) {
        value.value = rule.value;
    }
    row.append(field, operator, value, second, boolean, iconButton("close", "Remove rule", onRemove));
    row.read = () => {
        const kind = FIELDS[field.value][1];
        let read = value.value;
        if (kind === "bool") {
            read = boolean.value === "true";
        } else if (operator.value === "between") {
            read = [Number(value.value), Number(second.value)];
        } else if (kind === "number" || operator.value.endsWith("days")) {
            read = Number(value.value);
        }
        return { field: field.value, op: operator.value, value: read };
    };
    return row;
}

export function smartPlaylist(existing) {
    const rules = existing && existing.rules ? existing.rules : { match: "all", rules: [{ field: "genre", op: "contains", value: "" }], sort: "added", order: "desc", limit: 100 };
    const body = el("div", "mu-smart");
    const name = el("input", "mu-input");
    name.value = existing ? existing.name : "Smart playlist";
    const nameField = el("label", "mu-field");
    nameField.append(el("span", null, "Name"), name);
    const match = el("select", "mu-select");
    match.append(new Option("all of these rules", "all"), new Option("any of these rules", "any"));
    match.value = rules.match;
    const matchLine = el("div", "mu-smart-line");
    matchLine.append(el("span", null, "Include songs matching"), match);
    const list = el("div", "mu-rules");
    const rows = [];
    const addRule = (rule) => {
        const row = ruleRow(rule, () => {
            rows.splice(rows.indexOf(row), 1);
            row.remove();
        });
        rows.push(row);
        list.append(row);
    };
    rules.rules.forEach(addRule);
    const sort = el("select", "mu-select");
    for (const [value, label] of SORTS) {
        sort.append(new Option(label, value));
    }
    sort.value = rules.sort;
    const order = el("select", "mu-select");
    order.append(new Option("newest / highest first", "desc"), new Option("oldest / lowest first", "asc"));
    order.value = rules.order;
    const limit = el("input", "mu-input mu-input-short");
    limit.type = "number";
    limit.min = "1";
    limit.max = "2000";
    limit.value = String(rules.limit || 100);
    const sortLine = el("div", "mu-smart-line");
    sortLine.append(el("span", null, "Order by"), sort, order, el("span", null, "limit"), limit);
    const preview = el("div", "mu-smart-preview");
    const read = () => ({ match: match.value, rules: rows.map((row) => row.read()), sort: sort.value, order: order.value, limit: Number(limit.value) || 100 });
    const previewButton = button("Preview", "button", async () => {
        try {
            const payload = await api.post("playlists/preview", { rules: read() });
            preview.replaceChildren(el("p", "mu-hint", `${plural(payload.tracks.length, "song")} match right now`),
                trackList(payload.tracks.slice(0, 12), { album: false }));
        } catch (error) {
            preview.replaceChildren(el("p", "mu-error-text", error.message));
        }
    });
    body.append(nameField, matchLine, list, button("+ Add rule", "mu-text-button", () => addRule({ field: "artist", op: "contains", value: "" })), sortLine, previewButton, preview);
    modal(existing ? "Edit smart playlist" : "New smart playlist", body, [
        { label: "Cancel", action: () => {} },
        { label: existing ? "Save" : "Create", primary: true, action: async () => {
            try {
                const saved = existing
                    ? await api.post(`playlists/${encode(existing.id)}`, { name: name.value, rules: read() })
                    : await api.post("playlists", { name: name.value, rules: read() });
                await store.refreshPlaylists();
                go(`playlist/${encode(saved.id)}`);
                window.dispatchEvent(new HashChangeEvent("hashchange"));
                return true;
            } catch (error) {
                store.toast(error.message, "error");
                return false;
            }
        } },
    ]);
}

function editDetails(playlist, refresh) {
    const body = el("div", "mu-edit");
    const name = el("input", "mu-input");
    name.value = playlist.name;
    const description = el("textarea", "mu-input");
    description.rows = 3;
    description.value = playlist.description;
    const folder = el("input", "mu-input");
    folder.value = playlist.folder;
    folder.placeholder = "No folder";
    const cover = el("input");
    cover.type = "file";
    cover.accept = "image/png,image/jpeg";
    const fields = [["Name", name], ["Description", description], ["Folder", folder], ["Cover image (PNG or JPEG, 4 MB)", cover]];
    for (const [label, input] of fields) {
        const field = el("label", "mu-field");
        field.append(el("span", null, label), input);
        body.append(field);
    }
    if (playlist.cover) {
        body.append(button("Use automatic mosaic cover", "mu-text-button", async () => {
            await api.post(`playlists/${encode(playlist.id)}`, { cover: null });
            refresh();
        }));
    }
    modal("Edit details", body, [
        { label: "Cancel", action: () => {} },
        { label: "Save", primary: true, action: async () => {
            try {
                await api.post(`playlists/${encode(playlist.id)}`, { name: name.value, description: description.value, folder: folder.value });
                if (cover.files && cover.files[0]) {
                    await api.upload(`playlists/${encode(playlist.id)}/cover`, cover.files[0]);
                }
                await store.refreshPlaylists();
                refresh();
                return true;
            } catch (error) {
                store.toast(error.message, "error");
                return false;
            }
        } },
    ]);
}

export async function render({ node, parts, alive }) {
    const id = parts[0];
    const draw = async () => {
        const playlist = await api.get(`playlists/${encode(id)}`);
        if (!alive()) {
            return;
        }
        const context = `playlist:${playlist.id}`;
        const refresh = () => draw().catch((error) => store.toast(error.message, "error"));
        const pinned = store.isPinned("playlist", playlist.id);
        const moreMenu = (event) => menu([
            playlist.smart ? { label: "Edit rules", action: () => smartPlaylist(playlist) } : null,
            { label: "Edit details", action: () => editDetails(playlist, refresh) },
            { label: pinned ? "Unpin" : "Pin to Your Library", action: () => store.setPinned("playlist", playlist.id, !pinned).then(refresh).catch((error) => store.toast(error.message, "error")) },
            { label: "Export as M3U8", action: () => { location.href = api.url(`playlists/${encode(playlist.id)}/export`); } },
            "-",
            { label: "Delete playlist", danger: true, action: async () => {
                if (await confirm("Delete playlist", `Delete "${playlist.name}"? The songs stay in your library.`)) {
                    await api.post(`playlists/${encode(playlist.id)}/delete`, {});
                    await store.refreshPlaylists();
                    go("library/playlists");
                }
            } },
        ], event);
        const hero = header({
            art: mosaic(playlist.mosaic, playlist.cover, "mu-art mu-hero-art", 600),
            kind: playlist.smart ? "Smart playlist" : "Playlist",
            title: playlist.name,
            description: playlist.description,
            meta: [playlist.folder ? `Folder: ${playlist.folder}` : null, `${plural(playlist.track_count - playlist.unavailable, "song")}, ${longDuration(playlist.duration)}`,
                playlist.unavailable ? `${playlist.unavailable} unavailable` : null],
            actions: [...playButtons(async () => playlist.tracks, context), button("Edit", "mu-chip", () => (playlist.smart ? smartPlaylist(playlist) : editDetails(playlist, refresh))),
                iconButton("more", "More options", moreMenu)],
        });
        hero.querySelector(".mu-hero-title").addEventListener("dblclick", () => editDetails(playlist, refresh));
        const options = { art: true, context };
        if (!playlist.smart) {
            options.onReorder = async (from, to) => {
                const entry = playlist.tracks[from];
                try {
                    await api.post(`playlists/${encode(playlist.id)}/move`, { entry: entry.entry_id, to });
                    refresh();
                } catch (error) {
                    store.toast(error.message, "error");
                }
            };
            options.extras = (track) => [{ label: "Remove from this playlist", danger: true, action: async () => {
                await api.post(`playlists/${encode(playlist.id)}/remove`, { entries: [track.entry_id] });
                store.refreshPlaylists();
                refresh();
            } }];
        }
        const list = playlist.tracks.length ? trackList(playlist.tracks, options)
            : emptyState(playlist.smart ? "No songs match these rules yet" : "This playlist is empty",
                playlist.smart ? "Edit the rules, or add music that fits them." : "Use “Add to playlist” from any song's menu, or search for something to add.",
                playlist.smart ? button("Edit rules", "button", () => smartPlaylist(playlist)) : button("Search", "button", () => go("search")));
        node.replaceChildren(hero, list);
        if (!playlist.smart && playlist.tracks.length) {
            node.append(el("p", "mu-hint", "Drag songs by the handle to reorder them."));
        }
    };
    await draw();
}
