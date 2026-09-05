// Locked Folder's own Mission Control page: status, PIN setup/unlock/lock,
// and - once unlocked - a small protected file browser confined to the
// configured root. That browser is a thin, deliberately narrow wrapper
// around File Explorer's own /entries, /content, /upload, /mkdir, /rename
// and /delete routes (see satellites/native/file_explorer/api.py and
// locked_folder_guard.py): it never re-implements file handling, it simply
// never lets the user navigate above the vault root - see docs/locked_folder.md,
// "Protected file access through the existing File Explorer".

export function mount(context) {
    const { element: root, satellite, api } = context;

    let status = null;      // last successful /status response
    let vaultPath = "";     // "" until status.path is known
    let relative = "";      // current subpath within the vault, "" at the root
    let listing = null;     // last successful FileExplorer /entries response
    let selected = null;    // name of an entry with a confirm-delete pending

    const head = el("div", "page-head");
    head.append(
        el("h2", null, "Locked Folder"),
        el("span", "badge badge-type", satellite.type),
        el("span", `badge ${satellite.enabled ? "badge-up" : "badge-down"}`, satellite.enabled ? "enabled" : "disabled"),
        el("p", null, satellite.description || "A PIN-protected storage area."),
    );

    const error = el("p", "banner error", "");
    error.hidden = true;

    const statusCard = el("section", "panel lf-status");
    const pinCard = el("section", "panel lf-pin");
    const browserCard = el("section", "panel lf-browser");
    browserCard.hidden = true;

    const body = el("div", "stack");
    body.append(head, error, statusCard, pinCard, browserCard);
    root.replaceChildren(body);

    load();

    return () => {};

    /* ---------- data ---------- */

    async function load() {
        try {
            status = await api.get("/status");
            vaultPath = status.path || "";
            error.hidden = true;
            renderStatus();
            renderPin();
            if (status.unlocked) {
                await loadBrowser(relative);
            } else {
                browserCard.hidden = true;
                listing = null;
            }
        } catch (failure) {
            showError(failure.message);
        }
    }

    async function loadBrowser(nextRelative) {
        if (!vaultPath) {
            return;
        }
        const target = joinVaultPath(nextRelative);
        try {
            listing = await getEntries(target);
            relative = nextRelative;
            browserCard.hidden = false;
            renderBrowser();
        } catch (failure) {
            // most likely the unlock expired between actions - re-check status
            // rather than just showing a raw File Explorer error
            await load();
            if (!status.unlocked) {
                showError("Your unlock has expired. Enter the PIN again to continue.");
            } else {
                showError(failure.message);
            }
        }
    }

    function joinVaultPath(subpath) {
        if (!subpath) {
            return vaultPath;
        }
        return vaultPath.endsWith("/") ? `${vaultPath}${subpath}` : `${vaultPath}/${subpath}`;
    }

    /* ---------- File Explorer, reached directly (not through api.*, which is
     * bound to THIS satellite's own routes) - see the module comment above */

    function feUrl(path) {
        return `/api/satellites/FileExplorer${path}`;
    }

    async function getEntries(path) {
        return requestJson(feUrl(`/entries?path=${encodeURIComponent(path)}`));
    }

    async function postJson(path, payload) {
        return requestJson(feUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
    }

    async function requestJson(path, init) {
        const response = await fetch(path, init);
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error((payload && payload.error) || `${path} failed with status ${response.status}`);
        }
        return payload;
    }

    /* ---------- status card ---------- */

    function renderStatus() {
        statusCard.replaceChildren();
        statusCard.append(el("h3", null, "Status"));

        if (!status.configured) {
            statusCard.append(
                el("p", "muted", "No Locked Folder location is configured yet. Use the gear (configuration) "
                    + "button in the topbar to set one."),
            );
            return;
        }

        const facts = el("dl", "facts");
        addFact(facts, "Location", status.path);
        addFact(facts, "State", null, statusBadge());
        if (status.path_exists === false) {
            addFact(facts, "Directory", null, el("span", "badge badge-down", "missing"));
        }
        if (status.unlocked && status.expires_at) {
            addFact(facts, "Unlocked until", formatDate(status.expires_at));
        }
        statusCard.appendChild(facts);

        if (status.path_exists === false) {
            statusCard.appendChild(el("p", "banner error",
                "The configured directory no longer exists on disk - it may have been deleted or moved outside "
                + "StarCore. Nothing StarCore manages was changed; StarCore will not recreate it. Delink this "
                + "location below, then configure a new one if you want a Locked Folder again."));
        }

        const actions = el("div", "lf-actions");
        if (status.unlocked) {
            const lockButton = el("button", "button button-stop", "Lock now");
            lockButton.type = "button";
            lockButton.addEventListener("click", handleLock);
            actions.appendChild(lockButton);
        } else if (status.pin_set) {
            const unlockButton = el("button", "button button-primary", "Unlock");
            unlockButton.type = "button";
            unlockButton.addEventListener("click", () => openUnlockDialog());
            actions.appendChild(unlockButton);
        } else {
            actions.appendChild(el("p", "muted", "Set a PIN below to enable unlocking."));
        }

        const delinkButton = el("button", "button button-stop", "Delink Locked Folder");
        delinkButton.type = "button";
        delinkButton.addEventListener("click", handleDelink);
        actions.appendChild(delinkButton);

        statusCard.appendChild(actions);
    }

    function statusBadge() {
        const badge = el("span", `badge ${status.unlocked ? "badge-up" : "badge-down"}`, status.unlocked ? "unlocked" : "locked");
        return badge;
    }

    function addFact(dl, label, value, node) {
        dl.appendChild(el("dt", null, label));
        const dd = el("dd");
        if (node) {
            dd.appendChild(node);
        } else {
            dd.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
        }
        dl.appendChild(dd);
    }

    /* ---------- unlock dialog ---------- */

    function openUnlockDialog() {
        const overlay = el("div", "modal-overlay");
        const modal = el("div", "modal");
        const headRow = el("div", "modal-head");
        headRow.append(el("h2", null, "Unlock Locked Folder"));
        const close = el("button", "modal-close", "✕");
        close.type = "button";
        close.addEventListener("click", () => overlay.remove());
        headRow.appendChild(close);

        const form = el("form", "stack");
        const field = el("label", "field");
        field.append(el("span", null, "PIN"));
        const input = el("input");
        input.type = "password";
        input.inputMode = "numeric";
        input.autocomplete = "off";
        input.maxLength = 12;
        input.required = true;
        field.appendChild(input);

        const message = el("p", "banner error", "");
        message.hidden = true;
        const submit = el("button", "button button-primary", "Unlock");
        submit.type = "submit";

        form.append(field, message, submit);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            message.hidden = true;
            submit.disabled = true;
            try {
                await api.post("/unlock", { pin: input.value });
                overlay.remove();
                await load();
            } catch (failure) {
                message.textContent = failure.message;
                message.hidden = false;
            } finally {
                submit.disabled = false;
            }
        });

        modal.append(headRow, form);
        overlay.appendChild(modal);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                overlay.remove();
            }
        });
        document.body.appendChild(overlay);
        input.focus();
    }

    async function handleLock() {
        try {
            await api.post("/lock", {});
            await load();
        } catch (failure) {
            showError(failure.message);
        }
    }

    async function handleDelink() {
        const confirmed = confirm(
            "Delink the Locked Folder? This only removes StarCore's association with this location - "
            + "the folder and everything in it are left untouched on disk. You can configure a new "
            + "Locked Folder afterward."
        );
        if (!confirmed) {
            return;
        }
        try {
            await api.post("/delink", {});
            relative = "";
            await load();
        } catch (failure) {
            showError(failure.message);
        }
    }

    /* ---------- PIN setup/change ---------- */

    function renderPin() {
        pinCard.replaceChildren();
        if (!status.configured) {
            return;
        }
        pinCard.append(el("h3", null, status.pin_set ? "Change PIN" : "Set PIN"));

        const form = el("form", "stack");
        let currentField = null;
        if (status.pin_set) {
            currentField = el("label", "field");
            currentField.append(el("span", null, "Current PIN"));
            const currentInput = el("input");
            currentInput.type = "password";
            currentInput.inputMode = "numeric";
            currentInput.autocomplete = "off";
            currentInput.name = "current";
            currentInput.required = true;
            currentField.appendChild(currentInput);
            form.appendChild(currentField);
        }

        const newField = el("label", "field");
        newField.append(el("span", null, status.pin_set ? "New PIN (4-12 digits)" : "PIN (4-12 digits)"));
        const newInput = el("input");
        newInput.type = "password";
        newInput.inputMode = "numeric";
        newInput.autocomplete = "off";
        newInput.maxLength = 12;
        newInput.required = true;
        newField.appendChild(newInput);
        form.appendChild(newField);

        const message = el("p", "banner error", "");
        message.hidden = true;
        const submit = el("button", "button button-primary", status.pin_set ? "Change PIN" : "Set PIN");
        submit.type = "submit";
        form.append(message, submit);

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            message.hidden = true;
            submit.disabled = true;
            try {
                const payload = { pin: newInput.value };
                if (currentField) {
                    payload.current_pin = currentField.querySelector("input").value;
                }
                await api.post("/pin", payload);
                form.reset();
                await load();
            } catch (failure) {
                message.textContent = failure.message;
                message.hidden = false;
            } finally {
                submit.disabled = false;
            }
        });

        pinCard.appendChild(form);
    }

    /* ---------- protected browser ---------- */

    function renderBrowser() {
        browserCard.replaceChildren();
        browserCard.append(el("h3", null, "Protected files"));

        const breadcrumb = el("div", "lf-breadcrumb");
        breadcrumb.append(...buildBreadcrumb());
        browserCard.appendChild(breadcrumb);

        const toolbar = el("div", "lf-toolbar");
        const up = el("button", "button", "Up");
        up.type = "button";
        up.disabled = relative === "";
        up.addEventListener("click", () => {
            const parts = relative.split("/").filter(Boolean);
            parts.pop();
            loadBrowser(parts.join("/"));
        });
        const newFolder = el("button", "button", "New folder");
        newFolder.type = "button";
        newFolder.addEventListener("click", handleNewFolder);
        const uploadLabel = el("label", "button button-primary", "Upload");
        const uploadInput = document.createElement("input");
        uploadInput.type = "file";
        uploadInput.multiple = true;
        uploadInput.hidden = true;
        uploadInput.addEventListener("change", () => {
            const files = [...uploadInput.files];
            uploadInput.value = "";
            handleUpload(files);
        });
        uploadLabel.appendChild(uploadInput);
        toolbar.append(up, newFolder, uploadLabel);
        browserCard.appendChild(toolbar);

        const list = el("div", "lf-list");
        const entries = (listing && listing.entries) || [];
        if (entries.length === 0) {
            browserCard.appendChild(el("p", "muted", "This is empty."));
        } else {
            list.append(...entries.map((item) => buildRow(item)));
            browserCard.appendChild(list);
        }
    }

    function buildBreadcrumb() {
        const crumbs = [];
        const rootCrumb = el("button", "lf-crumb", "Locked Folder");
        rootCrumb.type = "button";
        rootCrumb.addEventListener("click", () => loadBrowser(""));
        crumbs.push(rootCrumb);

        const parts = relative.split("/").filter(Boolean);
        let accumulated = [];
        for (const part of parts) {
            accumulated = [...accumulated, part];
            const target = accumulated.join("/");
            crumbs.push(el("span", "lf-crumb-sep", "/"));
            const crumb = el("button", "lf-crumb", part);
            crumb.type = "button";
            crumb.addEventListener("click", () => loadBrowser(target));
            crumbs.push(crumb);
        }
        return crumbs;
    }

    function buildRow(item) {
        const row = el("div", "lf-row");
        const itemRelative = relative ? `${relative}/${item.name}` : item.name;

        const info = el("div", "lf-row-info");
        const name = el(item.type === "dir" ? "button" : "span", "lf-name", item.name);
        if (item.type === "dir") {
            name.type = "button";
            name.addEventListener("click", () => loadBrowser(itemRelative));
        }
        info.appendChild(name);
        row.appendChild(info);

        row.appendChild(el("span", "lf-meta", item.type === "dir" ? "—" : formatBytes(item.size)));

        const actions = el("div", "lf-row-actions");
        if (item.type === "file") {
            const itemPath = joinVaultPath(itemRelative);
            const open = el("a", "icon-button", "Open");
            open.href = feUrl(`/content?path=${encodeURIComponent(itemPath)}`);
            open.target = "_blank";
            open.rel = "noopener";
            actions.appendChild(open);
        }

        const deleteButton = el("button", "icon-button icon-button-alert", selected === itemRelative ? "Confirm?" : "Delete");
        deleteButton.type = "button";
        deleteButton.addEventListener("click", () => handleDelete(item, itemRelative));
        actions.appendChild(deleteButton);

        row.appendChild(actions);
        return row;
    }

    async function handleNewFolder() {
        const name = prompt("New folder name:");
        if (!name) {
            return;
        }
        try {
            await postJson("/mkdir", { path: joinVaultPath(relative), name });
            await loadBrowser(relative);
        } catch (failure) {
            showError(failure.message);
        }
    }

    function handleDelete(item, itemRelative) {
        if (selected !== itemRelative) {
            selected = itemRelative;
            renderBrowser();
            setTimeout(() => {
                if (selected === itemRelative) {
                    selected = null;
                    renderBrowser();
                }
            }, 4000);
            return;
        }
        selected = null;
        postJson("/delete", { path: joinVaultPath(itemRelative) })
            .then(() => loadBrowser(relative))
            .catch((failure) => showError(failure.message));
    }

    async function handleUpload(files) {
        if (files.length === 0) {
            return;
        }
        for (const file of files) {
            const query = new URLSearchParams({ path: joinVaultPath(relative), name: file.name });
            try {
                const response = await fetch(`${feUrl("/upload")}?${query}`, { method: "POST", body: file });
                if (!response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    throw new Error(payload.error || `upload of ${file.name} failed`);
                }
            } catch (failure) {
                showError(failure.message);
            }
        }
        await loadBrowser(relative);
    }

    /* ---------- helpers ---------- */

    function showError(message) {
        error.textContent = message;
        error.hidden = false;
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

    function formatDate(iso) {
        if (!iso) {
            return "—";
        }
        try {
            return new Date(iso).toLocaleString();
        } catch (failure) {
            return iso;
        }
    }
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
