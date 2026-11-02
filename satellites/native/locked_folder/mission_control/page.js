// The Locked Folder's Mission Control interface, shown as the "Locked Folder"
// tab of Photos (see the Photo page, and section_of in satellite.toml).
//
// States: not set up (choose a location), no PIN (create one), locked (PIN
// entry, or the recovery key), needs attention (damaged or edited security
// state, or a vault key this server can't open), unlocked (the vault's
// photos, videos and files, and its encryption in Settings). Every action is
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

// problems the server reports in status.security.problem, and what to say
// (uploads and deletes go to the Locked Folder's own routes, never File
// Explorer, which refuses an encrypted vault altogether)
const PROBLEMS = {
    pin_unreadable: ["The PIN can't be read",
        "The stored PIN file on the server is damaged, so the Locked Folder stays locked."],
    pin_tampered: ["The PIN was changed outside StarCore",
        "The PIN record on the server doesn't match this Locked Folder, so it stays locked."],
    key_unavailable: ["This server can't open the Locked Folder",
        "The encryption key for these files isn't on this server - it may be a new server, a restored "
        + "backup, or a different Windows account."],
    keyring_damaged: ["The Locked Folder's keyring is missing",
        "The file that holds this vault's encryption key is missing or damaged, here and in StarCore's own "
        + "copy. Restore .starcore-vault/keyring.json from a backup of the vault folder."],
    encryption_unavailable: ["Encryption support isn't installed",
        "This Locked Folder is encrypted, but StarCore's encryption package isn't installed on this server. "
        + "Install the engine's 'encryption' extra and restart StarCore."],
};

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
    let messageTone = "error";

    // the banner for the message load() was given, in its tone
    const messageBanner = (message) => banner(message, messageTone);

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

    // `tone` is "notice" for good news and information, "error" otherwise
    async function load(message, tone = "error") {
        messageTone = tone;
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

    function encryptionRunning() {
        const migration = status && status.encryption && status.encryption.migration;
        return Boolean(migration && migration.running);
    }

    function scheduleRelock() {
        if (encryptionRunning() && status.unlocked) {
            // progress, then the result, without a reload
            relockTimer = setTimeout(() => load(), 1000);
            return;
        }
        if (!status || !status.unlocked || !status.expires_at) {
            return;
        }
        const wait = new Date(status.expires_at).getTime() - Date.now();
        // capped: setTimeout treats anything past ~24.8 days as "now"
        relockTimer = setTimeout(() => load("Locked again after the time limit.", "notice"),
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
        const problem = status.security && status.security.problem;
        if (!status.configured) {
            body.replaceChildren(buildSetup(message));
        } else if (problem) {
            body.replaceChildren(buildProblem(problem, message));
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
        const error = messageBanner(message);
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

    function buildProblem(problem, message) {
        const [title, text] = PROBLEMS[problem] || ["The Locked Folder can't be opened", "Check the server's log."];
        const canRecover = Boolean(status.encryption && status.encryption.recovery_key)
            && ["pin_unreadable", "pin_tampered", "key_unavailable"].includes(problem);
        let advice;
        if (canRecover) {
            advice = "Enter your recovery key to set a new PIN.";
        } else if (problem === "key_unavailable") {
            advice = "No recovery key was set up for this Locked Folder. Without this server's original key, "
                + "its files can't be decrypted.";
        } else if (problem === "pin_unreadable") {
            advice = "An administrator needs to restore pin.json in StarCore's data folder from a backup.";
        } else {
            advice = "";
        }
        const card = buildState("error", title, `${text} ${advice}`.trim());
        if (canRecover) {
            card.appendChild(buildRecoveryForm(message));
        } else if (message) {
            card.appendChild(messageBanner(message));
        }
        return card;
    }

    function buildRecoveryForm(message) {
        const form = el("form", "lf-form lf-form-stack lf-recovery-form");
        const key = el("input", "lf-input lf-recovery-input");
        key.type = "text";
        key.autocomplete = "off";
        key.spellcheck = false;
        key.placeholder = "Recovery key (XXXX-XXXX-…)";
        key.setAttribute("aria-label", "Recovery key");
        key.required = true;
        const pin = pinInput("New PIN (4-12 digits)");
        const confirmPin = pinInput("Confirm new PIN");
        const submit = button("Set new PIN", "button button-primary");
        submit.type = "submit";
        const error = messageBanner(message);
        form.append(key, pin, confirmPin, submit, error);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (pin.value !== confirmPin.value) {
                show(error, "The PINs don't match.");
                return;
            }
            await act(submit, error, async () => {
                await api.post("/recover", { recovery_key: key.value, pin: pin.value });
                key.value = "";
                await load("New PIN set. Biometric unlock was turned off on every phone - turn it on again "
                    + "from the app if you use it.", "notice");
            }, (failure) => {
                const wait = retryAfter(failure);
                if (wait) {
                    show(error, `Too many incorrect recovery keys. Try again in ${formatWait(wait)}.`);
                    return true;
                }
                return false;
            });
        });
        return form;
    }

    function buildCreatePin(message) {
        const card = buildState("setup", "Create a PIN",
            "Use 4 to 12 digits. You'll need it every time you open the Locked Folder. A forgotten PIN can "
            + "only be reset with a recovery key, which you can create when you encrypt the Locked Folder.");
        const pin = pinInput("New PIN");
        const confirm = pinInput("Confirm PIN");
        const submit = button("Create PIN", "button button-primary");
        submit.type = "submit";
        const error = messageBanner(message);
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
        const error = messageBanner(message);
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
        if (status.encryption && status.encryption.recovery_key) {
            const forgot = button("Forgot your PIN?", "lf-link");
            forgot.addEventListener("click", () => {
                forgot.replaceWith(buildRecoveryForm());
            });
            card.appendChild(forgot);
        }
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
        const encrypted = status.encryption && status.encryption.state === "on";
        state.append(icon, el("span", null, "Unlocked"),
            el("span", "lf-muted", status.expires_at ? ` · locks at ${formatTime(status.expires_at)}` : ""));
        if (encrypted) {
            state.appendChild(el("span", "lf-badge", "Encrypted"));
        }
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

        const error = messageBanner(message);
        fragment.appendChild(error);
        if (status.path_exists === false) {
            show(error, "The Locked Folder's directory is missing on the server. It may have been moved or "
                + "deleted outside StarCore; nothing was recreated. Delink it in Settings to choose another.");
        }

        const notice = buildEncryptionNotice();
        if (notice) {
            fragment.appendChild(notice);
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

    // shown above the grid while an encryption run is going, was interrupted,
    // or left files unencrypted - the details and controls are in Settings
    function buildEncryptionNotice() {
        const info = status.encryption || {};
        const migration = info.migration;
        if (migration && migration.running) {
            const card = el("div", "lf-notice");
            const done = migration.total ? Math.round((migration.done / migration.total) * 100) : 0;
            const meter = el("div", "lf-meter");
            const fill = el("span");
            fill.style.width = `${done}%`;
            meter.appendChild(fill);
            card.append(el("p", null, `Encrypting… ${migration.done} of ${migration.total} files`), meter,
                el("p", "lf-muted", "Every original stays in place until all of them are encrypted and checked."));
            return card;
        }
        if (migration && migration.error) {
            return noticeWithSettings(migration.error, "error");
        }
        if (info.state === "interrupted") {
            return noticeWithSettings("Encryption didn't finish. Every original is still in place - resume or "
                + "undo it in Settings.", "error");
        }
        if (migration && migration.failed && migration.failed.length) {
            return noticeWithSettings(`${migration.failed.length} file${migration.failed.length === 1 ? "" : "s"} `
                + `couldn't be encrypted (${migration.failed[0].reason}). The originals were left in place.`, "error");
        }
        if (info.state === "on" && info.unencrypted_files) {
            return noticeWithSettings(`${info.unencrypted_files} file${info.unencrypted_files === 1 ? " isn't" : "s aren't"} `
                + "encrypted yet.", "plain");
        }
        if (info.state === "on" && info.backups && info.backups.length) {
            return noticeWithSettings("Your unencrypted originals are still kept as a backup. Check your files, "
                + "then delete the backup in Settings.", "plain");
        }
        return null;
    }

    function noticeWithSettings(text, kind) {
        const card = el("div", `lf-notice${kind === "error" ? " lf-notice-error" : ""}`);
        card.appendChild(el("p", null, text));
        if (!settingsOpen) {
            const open = button("Open Settings", "lf-link");
            open.addEventListener("click", () => {
                settingsOpen = true;
                render();
            });
            card.appendChild(open);
        }
        return card;
    }

    function buildTile(item, onOpen) {
        const tile = el("button", `photo-tile${item.media_type === "video" ? " photo-tile-video" : ""}`);
        tile.type = "button";
        tile.title = item.name;
        if (item.damaged) {
            tile.classList.add("unavailable");
        } else if (item.media_type === "video") {
            // a poster frame rendered in server memory only (never stored);
            // the plain poster stays when there is none (no ffmpeg, odd format)
            const poster = el("span", "lf-video-poster");
            const frame = el("img");
            frame.alt = "";
            frame.loading = "lazy";
            frame.decoding = "async";
            frame.addEventListener("error", () => frame.remove());
            frame.addEventListener("load", () => showDuration(tile, item.path));
            frame.src = thumbnailUrl(item.path);
            const play = el("span", "photo-tile-play");
            play.innerHTML = PLAY_ICON;
            tile.append(poster, frame, play);
        } else {
            const image = el("img");
            image.src = fileUrl(item.path);
            image.alt = item.name;
            image.loading = "lazy";
            image.decoding = "async";
            image.addEventListener("error", () => tile.classList.add("unavailable"));
            tile.appendChild(image);
        }
        tile.appendChild(el("span", "photo-caption", item.damaged ? "Damaged file" : item.name));
        if (item.damaged) {
            tile.disabled = true;
            tile.title = "This file is damaged and can't be opened";
        } else {
            tile.addEventListener("click", onOpen);
        }
        return tile;
    }

    // the length comes from the same in-memory render as the poster frame
    async function showDuration(tile, path) {
        try {
            const response = await fetch(api.url(`/media/duration?path=${encodeURIComponent(path)}`));
            const label = response.ok ? lengthLabel((await response.json()).duration) : "";
            if (label && tile.isConnected) {
                tile.appendChild(el("span", "photo-tile-duration", label));
            }
        } catch (error) {
            // no length is fine: the play badge still says it is a video
        }
    }

    function lengthLabel(seconds) {
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
            return "";
        }
        const total = Math.round(seconds);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const pad = (value) => String(value).padStart(2, "0");
        return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
    }

    function buildFileRow(item) {
        const row = el("div", "lf-file");
        const icon = el("span", "lf-file-icon");
        icon.innerHTML = FILE_ICON;
        const info = el("div", "lf-file-info");
        info.append(el("span", "lf-file-name", item.name),
            el("span", "lf-muted", item.damaged ? "Damaged - can't be opened" : formatBytes(item.size)));
        const remove = button("Delete", "button lf-danger");
        remove.addEventListener("click", () => deleteItem(item, remove));
        if (item.damaged) {
            row.append(icon, info, remove);
        } else {
            const open = el("a", "button", "Download");
            open.href = `${fileUrl(item.path)}&download=1`;
            row.append(icon, info, open, remove);
        }
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
                await load("PIN changed. Unlock with the new PIN.", "notice");
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

        panel.append(pinForm, biometric, buildEncryptionSettings(), location);
        return panel;
    }

    function buildEncryptionSettings() {
        const info = status.encryption || {};
        const section = el("div", "lf-encryption");
        section.appendChild(el("p", "lf-label", "Encryption"));
        const message = banner();

        if (!info.available && info.state === "off") {
            section.append(el("p", "lf-muted", "Files here are protected by your PIN but stored unencrypted. "
                + "Encryption needs the engine's 'encryption' extra installed on the server."));
            return section;
        }

        if (info.state === "off") {
            section.appendChild(el("p", "lf-muted", "Files here are protected by your PIN but stored unencrypted. "
                + "Encrypting them (AES-256-GCM) means a copy of this folder, or a stolen disk, shows nothing. "
                + "Your originals are kept as a backup until you delete them."));
            const choice = el("label", "lf-check");
            const box = el("input");
            box.type = "checkbox";
            box.checked = true;
            choice.append(box, el("span", null, "Create a recovery key (recommended). It's the only way to reset a "
                + "forgotten PIN, or to open these files on another server."));
            const warning = el("p", "lf-muted lf-warning", "");
            const updateWarning = () => {
                warning.textContent = box.checked ? ""
                    : "Without a recovery key, these files are lost for good if this server's key is lost - "
                    + "for example after reinstalling, or a Windows password reset.";
                warning.hidden = box.checked;
            };
            box.addEventListener("change", updateWarning);
            updateWarning();
            const start = button("Encrypt Locked Folder", "button button-primary");
            start.addEventListener("click", () => act(start, message, async () => {
                const result = await api.post("/encryption/start", { recovery_key: box.checked });
                if (result.recovery_key) {
                    await revealRecoveryKey(result.recovery_key);
                }
                await load();
            }));
            section.append(choice, warning, start, message);
            return section;
        }

        const summary = info.state === "on"
            ? "On - files are stored encrypted with AES-256-GCM."
            : info.state === "encrypting" ? "Encrypting now…" : "Started, but didn't finish.";
        section.appendChild(el("p", null, summary));
        section.appendChild(el("p", "lf-muted", info.recovery_key
            ? "A recovery key is set up."
            : "No recovery key: if this server's key is lost, these files can't be recovered."));

        const controls = el("div", "lf-actions lf-wrap");
        if (info.state === "interrupted" || (info.state === "on" && info.unencrypted_files)) {
            const resume = button(info.state === "interrupted" ? "Resume encryption" : "Encrypt remaining files",
                "button button-primary");
            resume.addEventListener("click", () => act(resume, message, async () => {
                await api.post("/encryption/start", {});
                await load();
            }));
            controls.appendChild(resume);
        }
        if (info.state === "interrupted" && info.interrupted_run) {
            const undo = button("Undo", "button");
            undo.addEventListener("click", () => act(undo, message, async () => {
                await api.post("/encryption/undo", { run: info.interrupted_run });
                await load("Encryption undone. Every original is where it was.", "notice");
            }));
            controls.appendChild(undo);
        }
        if (info.state === "on") {
            const replace = button(info.recovery_key ? "New recovery key" : "Create recovery key", "button");
            replace.addEventListener("click", () => act(replace, message, async () => {
                const pin = await promptPin(info.recovery_key ? "New recovery key" : "Create a recovery key",
                    info.recovery_key ? "The current recovery key stops working." : "You'll see it once - store it safely.");
                if (pin === null) {
                    return;
                }
                const result = await api.post("/encryption/recovery_key", { pin });
                await revealRecoveryKey(result.recovery_key);
                await load();
            }));
            controls.appendChild(replace);
            if (info.recovery_key) {
                const remove = button("Remove recovery key", "button lf-danger");
                remove.addEventListener("click", () => act(remove, message, async () => {
                    const pin = await promptPin("Remove the recovery key",
                        "Without it, a forgotten PIN or a lost server key means these files are lost for good.");
                    if (pin === null) {
                        return;
                    }
                    await api.post("/encryption/recovery_key", { pin, remove: true });
                    await load("Recovery key removed.", "notice");
                }));
                controls.appendChild(remove);
            }
        }
        section.appendChild(controls);

        for (const backup of info.backups || []) {
            const row = el("div", "lf-backup");
            row.appendChild(el("p", "lf-muted", `Unencrypted backup from ${formatDate(backup.created)}: `
                + `${backup.files} file${backup.files === 1 ? "" : "s"}, ${formatBytes(backup.bytes)}.`));
            const restore = button("Restore originals", "button");
            restore.addEventListener("click", () => {
                if (!confirm("Put these originals back unencrypted and remove their encrypted copies?")) {
                    return;
                }
                act(restore, message, async () => {
                    const result = await api.post("/encryption/undo", { run: backup.id });
                    await load(result.kept_in_backup && result.kept_in_backup.length
                        ? `${result.kept_in_backup.length} file(s) stayed in the backup - they were deleted or moved since.`
                        : "Originals restored.", "notice");
                });
            });
            const discard = button("Delete backup", "button lf-danger");
            discard.addEventListener("click", () => act(discard, message, async () => {
                const pin = await promptPin("Delete the unencrypted backup",
                    "Every encrypted copy is checked first. The backup is then deleted permanently.");
                if (pin === null) {
                    return;
                }
                await api.post("/encryption/discard", { run: backup.id, pin });
                await load("Backup deleted.", "notice");
            }));
            const actions = el("div", "lf-actions lf-wrap");
            actions.append(restore, discard);
            row.appendChild(actions);
            section.appendChild(row);
        }
        section.appendChild(message);
        return section;
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
            await load("Moved to Photos.", "notice");
        }));
        remove.addEventListener("click", () => {
            const item = list[index];
            if (confirm(`Delete "${item.name}" permanently? This can't be undone.`)) {
                act(remove, message, async () => {
                    await deleteFile(item);
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
            const query = new URLSearchParams({ name: file.name });
            try {
                // sent to the Locked Folder itself, which encrypts it on the way in once the vault is encrypted
                const response = await fetch(api.url(`/upload?${query}`), {
                    method: "POST",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: file,
                });
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
            await deleteFile(item);
            await load();
        } catch (failure) {
            control.disabled = false;
            await load(failure.message);
        }
    }

    async function deleteFile(item) {
        const result = await api.post("/delete", { paths: [item.path] });
        if (result.failed && result.failed.length) {
            throw new Error(result.failed[0].reason);
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
            if (/is locked - unlock it first/i.test(failure.message || "")) {
                await load("The Locked Folder locked again. Enter your PIN to continue.", "notice");
            }
        } finally {
            control.disabled = false;
        }
    }

    function fileUrl(path) {
        return api.url(`/media/file?path=${encodeURIComponent(path)}`);
    }

    function thumbnailUrl(path) {
        return api.url(`/media/thumbnail?path=${encodeURIComponent(path)}`);
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

/* ---------- dialogs ---------- */

function dialog(title) {
    const overlay = el("div", "modal-overlay lf-modal");
    const modal = el("div", "modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", title);
    const head = el("div", "modal-head");
    head.appendChild(el("h2", null, title));
    modal.appendChild(head);
    overlay.appendChild(modal);
    return { overlay, modal, head };
}

/** Asks for the PIN to confirm a sensitive action. Resolves the PIN, or null. */
function promptPin(title, text) {
    return new Promise((resolve) => {
        const { overlay, modal, head } = dialog(title);
        const close = el("button", "modal-close", "✕");
        close.type = "button";
        close.title = "Cancel";
        head.appendChild(close);
        const form = el("form", "lf-form lf-form-stack");
        const pin = pinInput("PIN");
        const submit = el("button", "button button-primary", "Confirm");
        submit.type = "submit";
        form.append(el("p", "lf-muted", text), pin, submit);
        modal.appendChild(form);
        const finish = (value) => {
            overlay.remove();
            resolve(value);
        };
        close.addEventListener("click", () => finish(null));
        overlay.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                finish(null);
            }
        });
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            finish(pin.value);
        });
        document.body.appendChild(overlay);
        pin.focus();
    });
}

/**
 * Shows a new recovery key - the only time it is ever shown - and only lets
 * go once the owner says it's stored. It is never kept by this page.
 */
function revealRecoveryKey(text) {
    return new Promise((resolve) => {
        const { overlay, modal } = dialog("Your recovery key");
        const content = el("div", "lf-form lf-form-stack");
        const key = el("code", "lf-recovery-key", text);
        const copy = el("button", "button", "Copy");
        copy.type = "button";
        copy.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(text);
                copy.textContent = "Copied";
            } catch (failure) {
                copy.textContent = "Select and copy it instead";
            }
        });
        const saved = el("label", "lf-check");
        const box = el("input");
        box.type = "checkbox";
        saved.append(box, el("span", null, "I've stored this recovery key somewhere safe, away from this server."));
        const done = el("button", "button button-primary", "Done");
        done.type = "button";
        done.disabled = true;
        box.addEventListener("change", () => {
            done.disabled = !box.checked;
        });
        done.addEventListener("click", () => {
            key.textContent = "";
            overlay.remove();
            resolve();
        });
        content.append(
            el("p", "lf-muted", "This is the only time it's shown. With it you can reset a forgotten PIN, or open "
                + "these files on another server. Without it, losing this server's key means losing the files. "
                + "Anyone who has it and can sign in to StarCore can reset your PIN."),
            key, copy, saved, done);
        modal.appendChild(content);
        document.body.appendChild(overlay);
        copy.focus();
    });
}

/* ---------- helpers ---------- */

function formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    } catch (failure) {
        return iso || "";
    }
}

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

function banner(text, tone = "error") {
    const node = el("p", `banner ${tone === "notice" ? "notice" : "error"} lf-banner`, text || "");
    node.setAttribute("role", "alert");
    node.hidden = !text;
    return node;
}

// for problems: a banner that held a notice turns into an error
function show(node, text) {
    node.classList.remove("notice");
    node.classList.add("error");
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
