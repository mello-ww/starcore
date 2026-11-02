// The Locked Folder's Mission Control interface, shown as the "Locked Folder"
// tab of Photos (see the Photo page, and section_of in satellite.toml).
//
// States: not set up (choose a location), no PIN (create one), locked (PIN
// entry), unlocked (the vault's photos, videos and files). Every action is
// authorized by the server against this session's own unlock - this page
// only ever shows what the server returns. Leaving the tab, or the page,
// locks it again.

const LOCK_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="5" y="10.5" width="14" height="10" rx="2"/>
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>
    </svg>`;
const PLAY_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg>`;
const FILE_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>
    </svg>`;

const FILE_EXPLORER = "/api/satellites/FileExplorer";

export function mount(context) {
    const { element: root, api } = context;
    const onPhotosChanged = context.onPhotosChanged || (() => {});

    let status = null;
    let items = [];
    let viewer = null;
    let relockTimer = null;
    let countdownTimer = null;
    let settingsOpen = false;
    let busy = false;
    let closed = false;

    const body = el("div", "lf");
    root.replaceChildren(body);
    load();
    // closing or reloading the page counts as leaving too; a beacon still
    // goes out while the page is being torn down, where fetch() may not
    const onPageHide = () => {
        if (status && status.unlocked && navigator.sendBeacon) {
            navigator.sendBeacon(api.url("/lock"));
        }
    };
    window.addEventListener("pagehide", onPageHide);

    const cleanup = () => {
        closed = true;
        window.removeEventListener("pagehide", onPageHide);
        clearTimers();
        closeViewer();
        // leaving the private area always locks it again
        if (status && status.unlocked) {
            api.post("/lock", {}).catch(() => {});
        }
        root.replaceChildren();
    };
    return cleanup;

    /* ---------- data ---------- */

    async function load(message) {
        clearTimers();
        try {
            status = await api.get("/status");
        } catch (failure) {
            renderError(failure.message);
            return;
        }
        if (closed) {
            return;
        }
        if (status.unlocked) {
            try {
                items = (await api.get("/media")).items || [];
            } catch (failure) {
                // most likely the unlock just expired - show the lock screen
                status = await api.get("/status").catch(() => status);
                items = [];
            }
        } else {
            items = [];
            closeViewer();
        }
        render(message);
        scheduleRelock();
    }

    function scheduleRelock() {
        if (!status || !status.unlocked || !status.expires_at) {
            return;
        }
        const wait = new Date(status.expires_at).getTime() - Date.now();
        // capped: setTimeout treats anything past ~24.8 days as "now"
        relockTimer = setTimeout(() => load("Locked again after the time limit."),
            Math.min(Math.max(wait + 500, 1000), 2 ** 31 - 1));
    }

    function clearTimers() {
        clearTimeout(relockTimer);
        clearInterval(countdownTimer);
        relockTimer = null;
        countdownTimer = null;
    }

    /* ---------- render ---------- */

    function render(message) {
        if (!status.configured) {
            body.replaceChildren(buildSetup(message));
        } else if (status.pin_unreadable) {
            body.replaceChildren(buildState("error", "The PIN can't be read",
                "The stored PIN file on the server is damaged, so the Locked Folder stays locked. "
                + "An administrator needs to restore or remove pin.json in StarCore's data folder."));
        } else if (!status.pin_set) {
            body.replaceChildren(buildCreatePin(message));
        } else if (!status.unlocked) {
            body.replaceChildren(buildLocked(message));
        } else {
            body.replaceChildren(buildUnlocked(message));
        }
    }

    function renderError(text) {
        body.replaceChildren(buildState("error", "The Locked Folder isn't available", text));
    }

    function buildState(kind, title, text) {
        const card = el("section", `lf-card lf-state lf-state-${kind}`);
        const icon = el("span", "lf-state-icon");
        icon.innerHTML = LOCK_ICON;
        card.append(icon, el("h3", null, title), el("p", "lf-muted", text));
        return card;
    }

    function buildSetup(message) {
        const card = buildState("setup", "Set up your Locked Folder",
            "Choose a folder on this server to hold private photos and files. They stay hidden from "
            + "Photos, search, albums and File Explorer until you unlock with your PIN.");
        const form = el("form", "lf-form");
        const input = el("input", "lf-input");
        input.type = "text";
        input.placeholder = "Absolute folder path, e.g. /srv/starcore/private";
        input.setAttribute("aria-label", "Locked Folder location");
        input.autocomplete = "off";
        const submit = button("Use this folder", "button button-primary");
        submit.type = "submit";
        const error = banner(message);
        form.append(input, submit);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            await act(submit, error, async () => {
                await api.post("/configuration", { key: "locked_folder_path", value: input.value.trim() });
                await load();
            });
        });
        card.append(form, error);
        return card;
    }

    function buildCreatePin(message) {
        const card = buildState("setup", "Create a PIN",
            "Use 4 to 12 digits. You'll need it every time you open the Locked Folder; it can't be "
            + "recovered, only changed while unlocked.");
        const pin = pinInput("New PIN");
        const confirm = pinInput("Confirm PIN");
        const submit = button("Create PIN", "button button-primary");
        submit.type = "submit";
        const error = banner(message);
        const form = el("form", "lf-form lf-form-stack");
        form.append(pin, confirm, submit);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (pin.value !== confirm.value) {
                show(error, "The PINs don't match.");
                return;
            }
            await act(submit, error, async () => {
                await api.post("/pin", { pin: pin.value });
                await api.post("/unlock", { pin: pin.value });
                await load();
            });
        });
        card.append(form, error);
        queueMicrotask(() => pin.focus());
        return card;
    }

    function buildLocked(message) {
        const card = buildState("locked", "Locked Folder is locked", "Enter your PIN to see what's inside.");
        const form = el("form", "lf-form");
        const pin = pinInput("PIN");
        const submit = button("Unlock", "button button-primary");
        submit.type = "submit";
        const error = banner(message);
        form.append(pin, submit);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            await act(submit, error, async () => {
                await api.post("/unlock", { pin: pin.value });
                await load();
            }, (failure) => {
                pin.value = "";
                const wait = retryAfter(failure);
                if (wait) {
                    countdown(error, submit, pin, wait);
                    return true;
                }
                return false;
            });
        });
        card.append(form, error);
        queueMicrotask(() => pin.focus());
        return card;
    }

    function countdown(error, submit, input, seconds) {
        let left = seconds;
        submit.disabled = true;
        input.disabled = true;
        const tick = () => {
            if (left <= 0) {
                clearInterval(countdownTimer);
                submit.disabled = false;
                input.disabled = false;
                error.hidden = true;
                input.focus();
                return;
            }
            show(error, `Too many incorrect PINs. Try again in ${formatWait(left)}.`);
            left -= 1;
        };
        clearInterval(countdownTimer);
        tick();
        countdownTimer = setInterval(tick, 1000);
    }

    function buildUnlocked(message) {
        const fragment = el("div", "lf-unlocked");

        const bar = el("div", "lf-bar");
        const state = el("p", "lf-unlocked-state");
        const icon = el("span", "lf-mini-lock");
        icon.innerHTML = LOCK_ICON;
        state.append(icon, el("span", null, "Unlocked"),
            el("span", "lf-muted", status.expires_at ? ` · locks at ${formatTime(status.expires_at)}` : ""));
        const actions = el("div", "lf-actions");
        const upload = el("label", "button", "Upload");
        const uploadInput = el("input");
        uploadInput.type = "file";
        uploadInput.multiple = true;
        uploadInput.hidden = true;
        uploadInput.addEventListener("change", () => {
            const files = [...uploadInput.files];
            uploadInput.value = "";
            handleUpload(files);
        });
        upload.appendChild(uploadInput);
        const settings = button("Settings", "button lf-settings-toggle");
        const gear = el("i", "sc-gear");
        gear.setAttribute("aria-hidden", "true");
        settings.prepend(gear);
        settings.setAttribute("aria-expanded", String(settingsOpen));
        settings.addEventListener("click", () => {
            settingsOpen = !settingsOpen;
            render();
        });
        const lockNow = button("Lock", "button button-primary");
        lockNow.addEventListener("click", async () => {
            await api.post("/lock", {}).catch(() => {});
            await load();
        });
        actions.append(upload, settings, lockNow);
        bar.append(state, actions);
        fragment.appendChild(bar);

        const error = banner(message);
        fragment.appendChild(error);
        if (status.path_exists === false) {
            show(error, "The Locked Folder's directory is missing on the server. It may have been moved or "
                + "deleted outside StarCore; nothing was recreated. Delink it in Settings to choose another.");
        }

        if (settingsOpen) {
            fragment.appendChild(buildSettings());
        }

        const media = items.filter((item) => item.media_type !== "file");
        const files = items.filter((item) => item.media_type === "file");
        if (items.length === 0) {
            const empty = el("div", "photo-empty lf-empty");
            const emptyIcon = el("span", "lf-state-icon");
            emptyIcon.innerHTML = LOCK_ICON;
            empty.append(emptyIcon, el("p", null, "Nothing here yet."),
                el("p", "lf-muted", "Move photos here from a photo's viewer in Photos, or upload files."));
            fragment.appendChild(empty);
            return fragment;
        }

        if (media.length) {
            fragment.appendChild(el("p", "eyebrow lf-section-title", `Photos and videos · ${media.length}`));
            const grid = el("div", "photo-gallery lf-gallery");
            media.forEach((item, position) => grid.appendChild(buildTile(item, () => openViewer(media, position))));
            fragment.appendChild(grid);
        }
        if (files.length) {
            fragment.appendChild(el("p", "eyebrow lf-section-title", `Other files · ${files.length}`));
            const list = el("div", "lf-files");
            files.forEach((item) => list.appendChild(buildFileRow(item)));
            fragment.appendChild(list);
        }
        return fragment;
    }

    function buildTile(item, onOpen) {
        const tile = el("button", `photo-tile${item.media_type === "video" ? " photo-tile-video" : ""}`);
        tile.type = "button";
        tile.title = item.name;
        if (item.media_type === "video") {
            const poster = el("span", "lf-video-poster");
            const play = el("span", "photo-tile-play");
            play.innerHTML = PLAY_ICON;
            tile.append(poster, play);
        } else {
            const image = el("img");
            image.src = fileUrl(item.path);
            image.alt = item.name;
            image.loading = "lazy";
            image.decoding = "async";
            image.addEventListener("error", () => tile.classList.add("unavailable"));
            tile.appendChild(image);
        }
        tile.appendChild(el("span", "photo-caption", item.name));
        tile.addEventListener("click", onOpen);
        return tile;
    }

    function buildFileRow(item) {
        const row = el("div", "lf-file");
        const icon = el("span", "lf-file-icon");
        icon.innerHTML = FILE_ICON;
        const info = el("div", "lf-file-info");
        info.append(el("span", "lf-file-name", item.name), el("span", "lf-muted", formatBytes(item.size)));
        const open = el("a", "button", "Download");
        open.href = `${fileUrl(item.path)}&download=1`;
        const remove = button("Delete", "button lf-danger");
        remove.addEventListener("click", () => deleteItem(item, remove));
        row.append(icon, info, open, remove);
        return row;
    }

    function buildSettings() {
        const panel = el("section", "lf-card lf-settings");
        panel.appendChild(el("h3", null, "Locked Folder settings"));

        // change PIN
        const pinForm = el("form", "lf-form lf-form-stack");
        const current = pinInput("Current PIN");
        const next = pinInput("New PIN (4-12 digits)");
        const save = button("Change PIN", "button");
        save.type = "submit";
        const pinMessage = banner();
        pinForm.append(el("p", "lf-label", "Change PIN"), current, next, save, pinMessage);
        pinForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            await act(save, pinMessage, async () => {
                await api.post("/pin", { pin: next.value, current_pin: current.value });
                // the server revokes every unlock when the PIN changes
                await load("PIN changed. Unlock with the new PIN.");
            }, (failure) => {
                const wait = retryAfter(failure);
                if (wait) {
                    show(pinMessage, `Too many incorrect PINs. Try again in ${formatWait(wait)}.`);
                    return true;
                }
                return false;
            });
        });

        // biometric devices are enrolled from the phone; changing the PIN removes them all
        const devices = status.biometric_devices || 0;
        const biometric = el("p", "lf-muted", devices
            ? `${devices} phone${devices === 1 ? "" : "s"} can unlock with biometrics. Changing the PIN turns that off everywhere.`
            : "Phones can add fingerprint or face unlock from the StarCore app.");

        // location
        const location = el("div", "lf-location");
        location.append(el("p", "lf-label", "Location"), el("code", "lf-path", status.path || "—"));
        const delink = button("Delink this folder", "button lf-danger");
        delink.addEventListener("click", async () => {
            const sure = confirm("Delink the Locked Folder? Its folder and files stay on disk untouched, but "
                + "StarCore stops protecting them until you link a folder again.");
            if (!sure) {
                return;
            }
            await act(delink, pinMessage, async () => {
                await api.post("/delink", {});
                settingsOpen = false;
                await load();
            });
        });
        location.appendChild(delink);

        panel.append(pinForm, biometric, location);
        return panel;
    }

    /* ---------- viewer ---------- */

    function openViewer(list, position) {
        closeViewer();
        let index = position;
        const overlay = el("div", "photo-viewer lf-viewer");
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-label", "Locked Folder viewer");
        const title = el("p", "photo-viewer-title");
        const counter = el("p", "photo-viewer-position");
        const moveOut = button("Move to Photos", "button button-primary");
        const remove = button("Delete", "button lf-danger");
        const close = button("✕", "photo-viewer-close");
        close.title = "Close";
        const bar = el("div", "photo-viewer-bar");
        const identity = el("div", "photo-viewer-identity");
        identity.append(el("p", "eyebrow", "StarCore · Locked Folder"), title);
        const actions = el("div", "photo-viewer-bar-actions");
        actions.append(counter, moveOut, remove, close);
        bar.append(identity, actions);

        const stage = el("div", "photo-viewer-stage");
        const previous = button("‹", "photo-viewer-step previous");
        const next = button("›", "photo-viewer-step next");
        const image = el("img", "photo-viewer-image");
        const video = el("video", "photo-viewer-image photo-viewer-video");
        video.controls = true;
        video.playsInline = true;
        stage.append(previous, image, video, next);
        const message = banner();
        overlay.append(bar, message, stage);

        const showItem = () => {
            const item = list[index];
            if (!item) {
                closeViewer();
                return;
            }
            title.textContent = item.name;
            counter.textContent = `${index + 1} / ${list.length}`;
            const isVideo = item.media_type === "video";
            video.pause();
            image.hidden = isVideo;
            video.hidden = !isVideo;
            if (isVideo) {
                image.removeAttribute("src");
                video.src = fileUrl(item.path);
            } else {
                video.removeAttribute("src");
                image.src = fileUrl(item.path);
                image.alt = item.name;
            }
            previous.hidden = next.hidden = list.length < 2;
        };
        const step = (offset) => {
            index = (index + offset + list.length) % list.length;
            showItem();
        };
        previous.addEventListener("click", () => step(-1));
        next.addEventListener("click", () => step(1));
        close.addEventListener("click", closeViewer);
        moveOut.addEventListener("click", () => act(moveOut, message, async () => {
            const result = await api.post("/move_out", { paths: [list[index].path] });
            if (result.failed && result.failed.length) {
                throw new Error(result.failed[0].reason);
            }
            onPhotosChanged();
            closeViewer();
            await load("Moved to Photos.");
        }));
        remove.addEventListener("click", () => {
            const item = list[index];
            if (confirm(`Delete "${item.name}" permanently? This can't be undone.`)) {
                act(remove, message, async () => {
                    await feDelete(item);
                    closeViewer();
                    await load();
                });
            }
        });
        const onKey = (event) => {
            if (event.key === "Escape") {
                closeViewer();
            } else if (event.key === "ArrowLeft") {
                step(-1);
            } else if (event.key === "ArrowRight") {
                step(1);
            }
        };
        document.addEventListener("keydown", onKey);
        document.body.appendChild(overlay);
        viewer = { overlay, video, onKey };
        showItem();
        close.focus();
    }

    function closeViewer() {
        if (!viewer) {
            return;
        }
        viewer.video.pause();
        viewer.video.removeAttribute("src");
        document.removeEventListener("keydown", viewer.onKey);
        viewer.overlay.remove();
        viewer = null;
    }

    /* ---------- actions ---------- */

    async function handleUpload(files) {
        if (!files.length || busy) {
            return;
        }
        busy = true;
        const problems = [];
        for (const file of files) {
            const query = new URLSearchParams({ path: status.path, name: file.name });
            try {
                const response = await fetch(`${FILE_EXPLORER}/upload?${query}`, { method: "POST", body: file });
                if (!response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    problems.push(payload.error || `${file.name} could not be uploaded`);
                }
            } catch (failure) {
                problems.push(failure.message);
            }
        }
        busy = false;
        await load(problems.length ? problems[0] : undefined);
    }

    async function deleteItem(item, control) {
        if (!confirm(`Delete "${item.name}" permanently? This can't be undone.`)) {
            return;
        }
        control.disabled = true;
        try {
            await feDelete(item);
            await load();
        } catch (failure) {
            control.disabled = false;
            await load(failure.message);
        }
    }

    async function feDelete(item) {
        const separator = status.path.includes("\\") ? "\\" : "/";
        const target = status.path.replace(/[\\/]+$/, "") + separator + item.path.split("/").join(separator);
        const response = await fetch(`${FILE_EXPLORER}/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: target }),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "the file could not be deleted");
        }
    }

    // runs `work` with `control` disabled; a failure shows in `message`
    // unless `onFailure` handled it (returned true)
    async function act(control, message, work, onFailure) {
        control.disabled = true;
        message.hidden = true;
        try {
            await work();
        } catch (failure) {
            if (!(onFailure && onFailure(failure))) {
                show(message, failure.message);
            }
            if (/locked/i.test(failure.message || "")) {
                await load("The Locked Folder locked again. Enter your PIN to continue.");
            }
        } finally {
            control.disabled = false;
        }
    }

    function fileUrl(path) {
        return api.url(`/media/file?path=${encodeURIComponent(path)}`);
    }
}

/**
 * Shows a PIN prompt over the page and unlocks this session. Resolves true
 * once unlocked, false if dismissed. Used by Photos before moving a photo in.
 */
export function requestUnlock(api) {
    return new Promise((resolve) => {
        const overlay = el("div", "modal-overlay lf-modal");
        const modal = el("div", "modal");
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-label", "Unlock Locked Folder");
        const head = el("div", "modal-head");
        head.append(el("h2", null, "Unlock Locked Folder"));
        const close = el("button", "modal-close", "✕");
        close.type = "button";
        close.title = "Cancel";
        head.appendChild(close);

        const form = el("form", "lf-form lf-form-stack");
        const pin = pinInput("PIN");
        const message = banner();
        const submit = el("button", "button button-primary", "Unlock");
        submit.type = "submit";
        form.append(el("p", "lf-muted", "Enter your PIN to move this photo into the Locked Folder."), pin, message, submit);

        const finish = (value) => {
            overlay.remove();
            resolve(value);
        };
        close.addEventListener("click", () => finish(false));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                finish(false);
            }
        });
        overlay.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                finish(false);
            }
        });
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            submit.disabled = true;
            message.hidden = true;
            try {
                await api.post("/unlock", { pin: pin.value });
                finish(true);
            } catch (failure) {
                pin.value = "";
                const wait = retryAfter(failure);
                show(message, wait ? `Too many incorrect PINs. Try again in ${formatWait(wait)}.` : failure.message);
                submit.disabled = false;
                pin.focus();
            }
        });

        modal.append(head, form);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        pin.focus();
    });
}

/* ---------- helpers ---------- */

function pinInput(label) {
    const input = el("input", "lf-input lf-pin");
    input.type = "password";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.autocomplete = "off";
    input.maxLength = 12;
    input.required = true;
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    return input;
}

function banner(text) {
    const node = el("p", "banner error lf-banner", text || "");
    node.setAttribute("role", "alert");
    node.hidden = !text;
    return node;
}

function show(node, text) {
    node.textContent = text;
    node.hidden = false;
}

function button(text, className) {
    const node = el("button", className, text);
    node.type = "button";
    return node;
}

function retryAfter(failure) {
    const match = /try again in (\d+)s/i.exec((failure && failure.message) || "");
    return match ? Number(match[1]) : 0;
}

function formatWait(seconds) {
    if (seconds < 90) {
        return `${seconds} s`;
    }
    const minutes = Math.ceil(seconds / 60);
    return minutes < 90 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

function formatTime(iso) {
    try {
        return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (failure) {
        return iso;
    }
}

function formatBytes(size) {
    if (size === null || size === undefined) {
        return "—";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}
