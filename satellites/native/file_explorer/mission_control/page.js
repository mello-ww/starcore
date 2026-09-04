export function mount(context) {
    const { element: root, satellite, api } = context;

    let path = "";       // "" means the top-level list of roots/drives;
                          // anything else is a real, absolute filesystem path
    let listing = null;  // last successful /entries response
    let busy = false;
    let selected = null; // name of the entry a confirm-delete is pending on
    let upButton = null;

    const head = el("div", "page-head");
    head.append(
        el("h2", null, "File Explorer"),
        el("span", "badge badge-type", satellite.type),
        el("span", `badge ${satellite.enabled ? "badge-up" : "badge-down"}`, satellite.enabled ? "enabled" : "disabled"),
        el("p", null, satellite.description || "Browse and manage files anywhere on this machine."),
    );

    const breadcrumb = el("div", "fe-breadcrumb");
    const toolbar = buildToolbar();
    const error = el("p", "banner error", "");
    error.hidden = true;
    const list = el("div", "fe-list");
    const empty = el("p", "muted", "This is empty.");
    empty.hidden = true;
    const progress = el("p", "fe-progress", "");
    progress.hidden = true;

    const body = el("div", "stack");
    body.append(head, toolbar, breadcrumb, error, progress, list, empty);
    root.replaceChildren(body);

    load(path);

    return () => {};

    /* ---------- data ---------- */

    async function load(nextPath) {
        setBusy(true);
        try {
            listing = await api.get(`/entries?path=${encodeURIComponent(nextPath)}`);
            path = listing.path;
            error.hidden = true;
            render();
        } catch (failure) {
            showError(failure.message);
        } finally {
            setBusy(false);
        }
    }

    function refresh() {
        return load(path);
    }

    /* ---------- path helpers ----------
     *
     * File Explorer now browses the whole filesystem, so a path is always
     * either "" (the virtual list of roots/drives) or a real absolute path
     * ("/home/user/photos" on Linux, "C:/Users/foo" on Windows - the server
     * accepts forward slashes on both, so that is all this file ever sends).
     * There is no per-satellite "root" to be relative to any more. */

    // splits an absolute path into its anchor ("/" or "C:/") and the
    // segments after it, so the breadcrumb can render one crumb per level
    // without caring which platform it's talking to
    function splitPath(value) {
        const normalized = value.replace(/\\/g, "/");
        const match = normalized.match(/^([A-Za-z]:\/)(.*)$/) || normalized.match(/^(\/)(.*)$/);
        if (!match) {
            return { anchor: normalized, segments: [] };
        }
        return { anchor: match[1], segments: match[2].split("/").filter(Boolean) };
    }

    function joinPath(base, name) {
        return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
    }

    /* ---------- structure ---------- */

    function buildToolbar() {
        const bar = el("div", "fe-toolbar");

        const up = el("button", "button", "Up");
        up.type = "button";
        up.addEventListener("click", () => {
            if (listing && listing.parent !== null) {
                load(listing.parent);
            }
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

        bar.append(up, newFolder, uploadLabel);
        upButton = up;
        return bar;
    }

    function render() {
        breadcrumb.replaceChildren(...buildBreadcrumb());
        upButton.disabled = listing.parent === null;

        // the roots/drives list isn't a real, writable directory - there is
        // nothing to create a folder in or upload into at that level
        const atRoots = path === "";
        toolbar.querySelectorAll(".fe-toolbar > button, .fe-toolbar > label").forEach((control) => {
            if (control !== upButton) {
                control.classList.toggle("hidden-control", atRoots);
            }
        });

        const entries = listing.entries;
        empty.hidden = entries.length > 0;
        list.replaceChildren(...entries.map((item) => buildRow(item, atRoots)));
    }

    function buildBreadcrumb() {
        const crumbs = [];

        const computerCrumb = el("button", "fe-crumb", "Computer");
        computerCrumb.type = "button";
        computerCrumb.addEventListener("click", () => load(""));
        crumbs.push(computerCrumb);

        if (path === "") {
            return crumbs;
        }

        const { anchor, segments } = splitPath(path);

        crumbs.push(el("span", "fe-crumb-sep", "/"));
        const anchorCrumb = el("button", "fe-crumb", anchor);
        anchorCrumb.type = "button";
        anchorCrumb.addEventListener("click", () => load(anchor));
        crumbs.push(anchorCrumb);

        let accumulated = anchor;
        for (const segment of segments) {
            accumulated = joinPath(accumulated, segment);
            const target = accumulated;
            crumbs.push(el("span", "fe-crumb-sep", "/"));
            const crumb = el("button", "fe-crumb", segment);
            crumb.type = "button";
            crumb.addEventListener("click", () => load(target));
            crumbs.push(crumb);
        }

        return crumbs;
    }

    function buildRow(item, atRoots) {
        const row = el("div", "fe-row");
        // at the roots/drives level, an entry's name IS the absolute path to
        // navigate to ("/", "C:/", ...) - everywhere else it's a bare name
        // that has to be joined onto the directory currently shown
        const itemPath = atRoots ? item.name : joinPath(path, item.name);

        const info = el("div", "fe-row-info");
        info.appendChild(typeIcon(item.type));
        const name = el(item.type === "dir" ? "button" : "span", "fe-name", item.name);
        if (item.type === "dir") {
            name.type = "button";
            name.addEventListener("click", () => load(itemPath));
        }
        info.append(name);
        row.appendChild(info);

        row.appendChild(el("span", "fe-meta", item.type === "dir" ? "—" : formatBytes(item.size)));
        row.appendChild(el("span", "fe-meta", formatDate(item.modified)));

        const actions = el("div", "fe-row-actions");
        if (item.type === "file") {
            const open = el("a", "icon-button", "");
            open.href = api.url(`/content?path=${encodeURIComponent(itemPath)}`);
            open.target = "_blank";
            open.rel = "noopener";
            open.title = "Open";
            open.appendChild(viewIcon());
            actions.appendChild(open);

            const download = el("a", "icon-button", "");
            download.href = api.url(`/content?path=${encodeURIComponent(itemPath)}&download=1`);
            download.title = "Download";
            download.appendChild(downloadIcon());
            actions.appendChild(download);
        }

        // a root/drive itself can't be renamed or deleted through here
        if (!atRoots) {
            const renameButton = el("button", "icon-button", "");
            renameButton.type = "button";
            renameButton.title = "Rename";
            renameButton.appendChild(renameIcon());
            renameButton.addEventListener("click", () => handleRename(item, itemPath));
            actions.appendChild(renameButton);

            const deleteButton = el("button", "icon-button icon-button-alert", "");
            deleteButton.type = "button";
            deleteButton.title = selected === itemPath ? "Confirm delete?" : "Delete";
            deleteButton.classList.toggle("confirm", selected === itemPath);
            deleteButton.appendChild(deleteIcon());
            deleteButton.addEventListener("click", () => handleDelete(item, itemPath, deleteButton));
            actions.appendChild(deleteButton);
        }

        row.appendChild(actions);
        return row;
    }

    /* ---------- actions ---------- */

    async function handleNewFolder() {
        const name = prompt("New folder name:");
        if (!name) {
            return;
        }
        try {
            await api.post("/mkdir", { path, name });
            refresh();
        } catch (failure) {
            showError(failure.message);
        }
    }

    async function handleRename(item, itemPath) {
        const name = prompt("Rename to:", item.name);
        if (!name || name === item.name) {
            return;
        }
        try {
            await api.post("/rename", { path: itemPath, name });
            refresh();
        } catch (failure) {
            showError(failure.message);
        }
    }

    function handleDelete(item, itemPath, button) {
        if (selected !== itemPath) {
            selected = itemPath;
            render();
            setTimeout(() => {
                if (selected === itemPath) {
                    selected = null;
                    render();
                }
            }, 4000);
            return;
        }

        selected = null;
        api.post("/delete", { path: itemPath })
            .then(refresh)
            .catch((failure) => showError(failure.message));
    }

    async function handleUpload(files) {
        if (files.length === 0) {
            return;
        }

        progress.hidden = false;
        for (const file of files) {
            progress.textContent = `Uploading ${file.name}…`;
            const query = new URLSearchParams({ path, name: file.name });
            try {
                const response = await fetch(`${api.url("/upload")}?${query}`, { method: "POST", body: file });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    if (response.status === 409 && confirm(`'${file.name}' already exists. Overwrite?`)) {
                        const retryQuery = new URLSearchParams({ path, name: file.name, overwrite: "1" });
                        const retry = await fetch(`${api.url("/upload")}?${retryQuery}`, { method: "POST", body: file });
                        if (!retry.ok) {
                            const retryPayload = await retry.json().catch(() => ({}));
                            throw new Error(retryPayload.error || `upload of ${file.name} failed`);
                        }
                    } else {
                        throw new Error(payload.error || `upload of ${file.name} failed`);
                    }
                }
            } catch (failure) {
                showError(failure.message);
            }
        }
        progress.hidden = true;
        refresh();
    }

    /* ---------- helpers ---------- */

    function setBusy(value) {
        busy = value;
        list.classList.toggle("fe-busy", busy);
    }

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

function typeIcon(type) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.3");
    svg.setAttribute("class", "fe-type-icon");
    if (type === "dir") {
        svg.appendChild(shape("path", { d: "M2 4.5A1 1 0 0 1 3 3.5h2.6l1.3 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" }));
    } else {
        svg.appendChild(shape("path", { d: "M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" }));
        svg.appendChild(shape("path", { d: "M9 2.5v3h3" }));
    }
    return svg;
}

function iconBase() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    return svg;
}

function viewIcon() {
    const svg = iconBase();
    svg.appendChild(shape("path", { d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" }));
    svg.appendChild(shape("circle", { cx: "8", cy: "8", r: "1.8" }));
    return svg;
}

function downloadIcon() {
    const svg = iconBase();
    svg.appendChild(shape("path", { d: "M8 2.5v7.2" }));
    svg.appendChild(shape("path", { d: "M4.8 7 8 10.2 11.2 7" }));
    svg.appendChild(shape("path", { d: "M3 12.5h10" }));
    return svg;
}

function renameIcon() {
    const svg = iconBase();
    svg.appendChild(shape("path", { d: "M10.6 2.9 13.1 5.4 5.2 13.3l-3 0.6 0.6-3Z" }));
    return svg;
}

function deleteIcon() {
    const svg = iconBase();
    svg.appendChild(shape("path", { d: "M3 4.5h10" }));
    svg.appendChild(shape("path", { d: "M6.3 4.5v-1a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1" }));
    svg.appendChild(shape("path", { d: "M4.5 4.5 5 13a1 1 0 0 0 1 0.9h4A1 1 0 0 0 11 13l0.5-8.5" }));
    return svg;
}

function shape(tag, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) {
        node.setAttribute(name, value);
    }
    return node;
}
