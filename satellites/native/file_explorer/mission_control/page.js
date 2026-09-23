// the storage dashboard's visual theme is a purely local display
// preference (see mount()'s own docstring below) - persisted per-browser,
// never sent to the server and never round-tripped through satellite
// configuration, since it changes nothing about what File Explorer does
const STORAGE_THEME_KEY = "starcore.fileExplorer.storageTheme";
const STORAGE_THEMES = ["classic", "bar", "donut", "orbital"];
const STORAGE_THEME_LABELS = {
    classic: "Classic StarCore",
    bar: "Bar graph",
    donut: "Donut",
    orbital: "Orbital map",
};
// shared color sequence for anything that needs to color-code drives
// consistently across themes (donut segments/legend, orbital nodes)
const DRIVE_COLOR_VARS = [
    "var(--azure)", "var(--sapphire)", "var(--ice)",
    "var(--royal)", "var(--klein)", "var(--line-bright)",
];

function readStoredTheme() {
    try {
        const stored = window.localStorage.getItem(STORAGE_THEME_KEY);
        return STORAGE_THEMES.includes(stored) ? stored : "classic";
    } catch {
        return "classic"; // storage disabled/unavailable (private browsing, ...) - just don't persist
    }
}

function storeTheme(value) {
    try {
        window.localStorage.setItem(STORAGE_THEME_KEY, value);
    } catch {
        // best-effort only, see readStoredTheme() above
    }
}

export function mount(context) {
    const { element: root, satellite, api } = context;

    let path = "";       // "" means the top-level list of roots/drives;
                          // anything else is a real, absolute filesystem path
    let listing = null;  // last successful /entries response
    let busy = false;
    let selected = null; // name of the entry a confirm-delete is pending on
    let upButton = null;
    let storageTheme = readStoredTheme();

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
    // the storage dashboard shown only at the roots/drives level (see
    // render()) - everywhere else this stays hidden and the ordinary
    // list/empty pair below behaves exactly as it always has
    const dashboard = el("div", "fe-dashboard");
    dashboard.hidden = true;
    const list = el("div", "fe-list");
    const empty = el("p", "muted", "This is empty.");
    empty.hidden = true;
    const progress = el("p", "fe-progress", "");
    progress.hidden = true;

    const body = el("div", "stack");
    body.append(head, toolbar, breadcrumb, error, progress, dashboard, list, empty);
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

        // the storage dashboard REPLACES the plain drive list only at the
        // roots level - navigating into a drive/directory (atRoots false)
        // renders exactly the same list this always has, untouched below
        if (atRoots) {
            dashboard.hidden = false;
            list.hidden = true;
            empty.hidden = true;
            // belt-and-suspenders: the [hidden] CSS rule above is what
            // actually hides `list`, but drop its old rows too so a CSS
            // regression can never again leave a stale directory listing
            // sitting underneath the home dashboard
            list.replaceChildren();
            dashboard.replaceChildren(buildDashboard(listing));
            return;
        }

        dashboard.hidden = true;
        list.hidden = false;
        const entries = listing.entries;
        empty.hidden = entries.length > 0;
        list.replaceChildren(...entries.map((item) => buildRow(item, atRoots)));
    }

    /* ---------- storage dashboard (roots/drives level only) ----------
     *
     * Every figure here comes straight from the server's own
     * shutil.disk_usage() call (see api.py's _disk_usage()/_machine_storage())
     * - nothing is computed from the browser/device running Mission
     * Control. Clicking any drive's representation, in any theme, calls the
     * exact same load(name) a directory click already uses elsewhere in
     * this file - there is no second navigation path.
     */

    function buildDashboard(listingData) {
        const container = el("div", "fe-dashboard-inner");
        container.appendChild(buildMachineHero(listingData.machine));
        container.appendChild(buildThemeSelector());
        const themeBody = el("div", "fe-dashboard-body");
        themeBody.appendChild(buildDriveVisualization(listingData.entries, listingData.machine));
        container.appendChild(themeBody);
        return container;
    }

    function buildMachineHero(machine) {
        const hero = el("div", "fe-hero");
        hero.appendChild(el("span", "fe-hero-label", "Entire system"));
        if (!machine) {
            hero.appendChild(el("p", "muted", "Machine-wide storage totals aren't available right now."));
            return hero;
        }

        const percent = storagePercent(machine);
        hero.appendChild(el("span", "fe-hero-figures", `${formatBytes(machine.used)} / ${formatBytes(machine.total)}`));
        const track = el("div", "fe-hero-track");
        const fill = el("div", "fe-hero-fill");
        fill.style.width = `${percent}%`;
        track.appendChild(fill);
        hero.appendChild(track);
        hero.appendChild(el("span", "fe-hero-note",
            `${percent}% used · ${formatBytes(machine.free)} free across ${machine.volumes} volume${machine.volumes === 1 ? "" : "s"}`));
        return hero;
    }

    function buildThemeSelector() {
        const row = el("div", "fe-theme-row");
        const labelText = el("label", "fe-theme-label", "Storage view");
        labelText.htmlFor = "fe-theme-select";
        row.appendChild(labelText);

        const select = document.createElement("select");
        select.id = "fe-theme-select";
        select.className = "fe-theme-select";
        for (const value of STORAGE_THEMES) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = STORAGE_THEME_LABELS[value];
            option.selected = value === storageTheme;
            select.appendChild(option);
        }
        select.addEventListener("change", () => {
            storageTheme = select.value;
            storeTheme(storageTheme);
            render();
        });
        row.appendChild(select);
        return row;
    }

    function buildDriveVisualization(items, machine) {
        const drives = items.map((item) => ({ name: item.name, storage: item.storage || null }));
        switch (storageTheme) {
            case "bar":
                return buildBarTheme(drives);
            case "donut":
                return buildDonutTheme(drives, machine);
            case "orbital":
                return buildOrbitalTheme(drives, machine);
            default:
                return buildClassicTheme(drives);
        }
    }

    // a drive's clickable representation is always a real <button> -
    // focusable and Enter/Space-activatable for free, and reuses the exact
    // same load(name) every other navigation in this file goes through
    function driveButton(className, name) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className;
        button.title = `Open ${name}`;
        button.addEventListener("click", () => load(name));
        return button;
    }

    function buildClassicTheme(drives) {
        const grid = el("div", "fe-classic-grid");
        for (const drive of drives) {
            const card = driveButton("fe-classic-card", drive.name);
            card.appendChild(el("span", "fe-drive-name", drive.name));
            if (drive.storage) {
                const percent = storagePercent(drive.storage);
                const track = el("div", "fe-classic-track");
                const fill = el("div", "fe-classic-fill");
                fill.style.width = `${percent}%`;
                track.appendChild(fill);
                card.appendChild(track);
                card.appendChild(el("span", "fe-drive-figures",
                    `${formatBytes(drive.storage.used)} / ${formatBytes(drive.storage.total)}`));
                card.appendChild(el("span", "fe-drive-free", `${formatBytes(drive.storage.free)} free`));
            } else {
                card.appendChild(el("span", "fe-drive-figures muted", "Storage information unavailable"));
            }
            grid.appendChild(card);
        }
        return grid;
    }

    function buildBarTheme(drives) {
        const container = el("div", "fe-bar-list");
        for (const drive of drives) {
            const row = driveButton("fe-bar-row", drive.name);
            row.appendChild(el("span", "fe-bar-name", drive.name));
            const track = el("div", "fe-bar-track");
            const fill = el("div", "fe-bar-fill");
            const percent = drive.storage ? storagePercent(drive.storage) : 0;
            fill.style.width = `${percent}%`;
            track.appendChild(fill);
            row.appendChild(track);
            row.appendChild(el("span", "fe-bar-percent", drive.storage ? `${percent}%` : "—"));
            container.appendChild(row);
        }
        return container;
    }

    // orbital storage map - the machine is the central hub, each drive an
    // orbiting node placed at an even angle around it. A node's size
    // reflects its share of capacity among the drives shown; the
    // conic-gradient ring around its face reflects its own percent used.
    // Full names and exact figures live in the legend below, so the map
    // itself never has to squeeze text onto a small circle to stay useful.
    function buildOrbitalTheme(drives, machine) {
        const wrap = el("div", "fe-orbital-wrap");
        const withStorage = drives.filter((drive) => drive.storage && drive.storage.total > 0);
        const withoutStorage = drives.filter((drive) => !(drive.storage && drive.storage.total > 0));

        const orbit = el("div", "fe-orbital-orbit");
        const guide = el("div", "fe-orbital-ring-guide");
        guide.setAttribute("aria-hidden", "true");
        orbit.appendChild(guide);

        const hub = el("div", "fe-orbital-hub");
        hub.appendChild(el("span", "fe-orbital-hub-label", "System"));
        if (machine) {
            const percent = storagePercent(machine);
            hub.appendChild(el("span", "fe-orbital-hub-figures", `${formatBytes(machine.used)} / ${formatBytes(machine.total)}`));
            hub.appendChild(el("span", "fe-orbital-hub-percent", `${percent}% used`));
        } else {
            hub.appendChild(el("span", "fe-orbital-hub-figures muted", "—"));
        }
        orbit.appendChild(hub);

        if (withStorage.length > 0) {
            const maxCapacity = Math.max(...withStorage.map((drive) => drive.storage.total));
            const minNodeSize = 3.1;   // rem
            const maxNodeSize = 5.4;   // rem
            const orbitRadiusPct = 38; // % from center, matches .fe-orbital-ring-guide
            const angleStep = (2 * Math.PI) / withStorage.length;

            withStorage.forEach((drive, index) => {
                const angle = -Math.PI / 2 + angleStep * index; // first node at 12 o'clock
                const left = 50 + orbitRadiusPct * Math.cos(angle);
                const top = 50 + orbitRadiusPct * Math.sin(angle);
                const sizeShare = Math.sqrt(drive.storage.total / maxCapacity);
                const size = minNodeSize + (maxNodeSize - minNodeSize) * sizeShare;
                const percent = storagePercent(drive.storage);
                const color = DRIVE_COLOR_VARS[index % DRIVE_COLOR_VARS.length];

                const node = driveButton("fe-orbital-node", drive.name);
                node.style.left = `${left}%`;
                node.style.top = `${top}%`;
                node.style.width = `${size}rem`;
                node.style.height = `${size}rem`;
                node.style.background = `conic-gradient(${color} ${percent}%, var(--line) ${percent}% 100%)`;
                node.title = `${drive.name} — ${formatBytes(drive.storage.used)} used of ${formatBytes(drive.storage.total)} ` +
                    `(${formatBytes(drive.storage.free)} free, ${percent}%)`;

                const face = el("span", "fe-orbital-node-face", `${percent}%`);
                node.appendChild(face);
                orbit.appendChild(node);
            });
        }
        wrap.appendChild(orbit);

        if (withStorage.length > 0) {
            const legend = el("div", "fe-donut-legend");
            withStorage.forEach((drive, index) => {
                const item = driveButton(`fe-donut-legend-item fe-donut-color-${index % 6}`, drive.name);
                item.appendChild(el("span", "fe-donut-swatch"));
                item.appendChild(el("span", "fe-donut-legend-name", drive.name));
                item.appendChild(el("span", "fe-donut-legend-figures",
                    `${formatBytes(drive.storage.used)} / ${formatBytes(drive.storage.total)}`));
                legend.appendChild(item);
            });
            wrap.appendChild(legend);
        } else {
            wrap.appendChild(el("p", "muted", "No drives report usable storage information."));
        }

        if (withoutStorage.length > 0) {
            const leftover = el("div", "fe-orbital-leftover");
            leftover.appendChild(el("span", "muted", "Also available:"));
            withoutStorage.forEach((drive) => {
                const chip = driveButton("fe-orbital-leftover-chip", drive.name);
                chip.textContent = drive.name;
                leftover.appendChild(chip);
            });
            wrap.appendChild(leftover);
        }

        return wrap;
    }

    function buildDonutTheme(drives, machine) {
        const wrap = el("div", "fe-donut-wrap");
        const withStorage = drives.filter((drive) => drive.storage && drive.storage.total > 0);
        const withoutStorage = drives.filter((drive) => !(drive.storage && drive.storage.total > 0));

        if (withStorage.length > 0) {
            // each drive's segment is proportional to its own capacity
            // (total), out of the sum of capacities actually shown here -
            // the center figure is the deduplicated machine-wide total, not
            // just a sum of these segments (see api.py's _machine_storage())
            const totalCapacity = withStorage.reduce((sum, drive) => sum + drive.storage.total, 0);
            const size = 200;
            const donutRadius = 78;
            const circumference = 2 * Math.PI * donutRadius;

            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
            svg.setAttribute("class", "fe-donut-svg");
            svg.appendChild(shape("circle", { cx: size / 2, cy: size / 2, r: donutRadius, class: "fe-donut-track" }));

            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            group.setAttribute("class", "fe-donut-segments");
            let cumulative = 0;
            withStorage.forEach((drive, index) => {
                const length = (drive.storage.total / totalCapacity) * circumference;
                const segment = shape("circle", {
                    cx: size / 2, cy: size / 2, r: donutRadius,
                    class: `fe-donut-segment fe-donut-color-${index % 6}`,
                    "stroke-dasharray": `${length} ${circumference - length}`,
                    "stroke-dashoffset": `${-cumulative}`,
                });
                segment.setAttribute("tabindex", "0");
                segment.setAttribute("role", "button");
                segment.setAttribute("aria-label", `Open ${drive.name}`);
                segment.addEventListener("click", () => load(drive.name));
                segment.addEventListener("keydown", (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        load(drive.name);
                    }
                });
                group.appendChild(segment);
                cumulative += length;
            });
            svg.appendChild(group);

            const center = el("div", "fe-donut-center");
            center.appendChild(el("span", "fe-donut-center-label", "Total"));
            if (machine) {
                const percent = storagePercent(machine);
                center.appendChild(el("span", "fe-donut-center-figures", `${formatBytes(machine.used)} / ${formatBytes(machine.total)}`));
                center.appendChild(el("span", "fe-donut-center-percent", `${percent}% used`));
            } else {
                center.appendChild(el("span", "fe-donut-center-figures muted", "—"));
            }

            // svg and center share one grid cell (see .fe-donut-ring) so the
            // readout stays exactly centered on the ring at any size,
            // rather than depending on a fixed pixel offset
            const ring = el("div", "fe-donut-ring");
            ring.append(svg, center);
            wrap.appendChild(ring);

            const legend = el("div", "fe-donut-legend");
            withStorage.forEach((drive, index) => {
                const item = driveButton(`fe-donut-legend-item fe-donut-color-${index % 6}`, drive.name);
                item.appendChild(el("span", "fe-donut-swatch"));
                item.appendChild(el("span", "fe-donut-legend-name", drive.name));
                item.appendChild(el("span", "fe-donut-legend-figures",
                    `${formatBytes(drive.storage.used)} / ${formatBytes(drive.storage.total)}`));
                legend.appendChild(item);
            });
            wrap.appendChild(legend);
        } else {
            wrap.appendChild(el("p", "muted", "No drives report usable storage information."));
        }

        if (withoutStorage.length > 0) {
            const leftover = el("div", "fe-donut-leftover");
            leftover.appendChild(el("span", "muted", "Also available:"));
            withoutStorage.forEach((drive) => {
                const chip = driveButton("fe-donut-leftover-chip", drive.name);
                chip.textContent = drive.name;
                leftover.appendChild(chip);
            });
            wrap.appendChild(leftover);
        }

        return wrap;
    }

    function storagePercent(storage) {
        if (!storage || storage.total <= 0) {
            return 0;
        }
        return Math.min(100, Math.round((storage.used / storage.total) * 100));
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
        // this is the Locked Folder itself (or, in principle, something
        // nested under it) - the entry still shows up here, it just can't be
        // opened without unlocking first (see locked_folder_guard.py, which
        // is what actually enforces that; this badge is a hint, not a lock)
        if (item.locked) {
            const badge = el("span", "badge badge-down fe-locked-badge", "");
            badge.title = "Protected by the Locked Folder - unlock it from the Locked Folder page first.";
            badge.appendChild(lockIcon());
            badge.append(" locked");
            info.appendChild(badge);
        }
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

function lockIcon() {
    const svg = iconBase();
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.appendChild(shape("rect", { x: "3.2", y: "7.2", width: "9.6", height: "6.3", rx: "1" }));
    svg.appendChild(shape("path", { d: "M5.3 7.2V5a2.7 2.7 0 0 1 5.4 0v2.2" }));
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
