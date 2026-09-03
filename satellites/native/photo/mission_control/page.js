const SKELETONS = 12;

export function mount(context) {
    const { element: root, satellite, api } = context;

    let photos = [];
    let viewer = null;
    let index = -1;

    const summary = el("dl", "tiles");
    const gallery = el("div", "photo-gallery");
    const importPanel = buildImportPanel();
    const syncPanel = el("section", "panel photo-sync");
    const notice = el("p", "photo-notice");
    syncPanel.hidden = true;
    notice.hidden = true;

    const body = el("div", "stack");
    body.append(summary, buildToolbar(), importPanel, syncPanel, notice, gallery);
    root.replaceChildren(buildHead(), body);

    skeleton();
    refresh();
    document.addEventListener("keydown", onKeyDown);

    return () => {
        document.removeEventListener("keydown", onKeyDown);
        closeViewer();
    };

    /* ---------- structure ---------- */

    function buildHead() {
        const head = el("div", "page-head");
        head.append(
            el("h2", null, "Library"),
            el("span", "badge badge-type", satellite.type),
            el("span", `badge ${satellite.enabled ? "badge-up" : "badge-down"}`, satellite.enabled ? "enabled" : "disabled"),
            el("p", null, satellite.description || "Local photo library."),
        );
        return head;
    }

    function buildToolbar() {
        const toolbar = el("div", "photo-toolbar");
        const phone = el("button", "button", "Phone sync");
        const button = el("button", "button button-primary", "Import photos");
        phone.type = "button";
        button.type = "button";
        phone.addEventListener("click", () => {
            syncPanel.hidden = !syncPanel.hidden;
            importPanel.hidden = true;
        });
        button.addEventListener("click", () => toggleImport());

        const actions = el("div", "photo-actions");
        actions.append(phone, button);
        toolbar.append(el("p", "eyebrow", "Gallery"), actions);
        return toolbar;
    }

    function buildImportPanel() {
        const panel = el("section", "panel photo-import");
        panel.hidden = true;

        const input = el("input");
        input.type = "text";
        input.spellcheck = false;
        input.placeholder = "Folder on the machine running StarCore";

        const scan = el("button", "button", "Scan");
        const run = el("button", "button button-primary", "Import");
        const result = el("p", "photo-import-result");
        result.hidden = true;

        scan.type = "button";
        run.type = "button";
        scan.addEventListener("click", () => submit("scan", input, [scan, run], result));
        run.addEventListener("click", () => submit("import", input, [scan, run], result));
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                submit("scan", input, [scan, run], result);
            }
        });

        const row = el("div", "photo-import-row");
        row.append(input, scan, run);

        panel.append(
            el("p", "eyebrow", "Import"),
            el("p", "muted", "JPEG, PNG and WEBP files are copied into the library. Originals are never moved, changed or deleted, and importing the same folder twice is safe."),
            row,
            result,
        );
        return panel;
    }

    function toggleImport(force) {
        importPanel.hidden = force === undefined ? !importPanel.hidden : !force;
        syncPanel.hidden = true;
        if (!importPanel.hidden) {
            importPanel.querySelector("input").focus();
        }
    }

    function renderSync(status) {
        const address = status.running ? `${status.url}/?token=${encodeURIComponent(status.token)}` : null;
        const state = el("p", "photo-sync-state");
        state.append(
            el("i", `state-dot ${status.running ? "on" : "off"}`),
            el("span", null, status.running
                ? `Listening on ${status.url}`
                : status.enabled ? "Not running" : "Turned off in the satellite's configuration"),
        );

        const facts = el("dl", "facts");
        for (const [label, value] of [["Received", status.counts.received], ["Imported", status.counts.imported],
                                      ["Duplicates", status.counts.duplicates], ["Failed", status.counts.failed]]) {
            const row = document.createElement("div");
            row.append(el("dt", null, label), el("dd", null, String(value)));
            facts.appendChild(row);
        }

        syncPanel.replaceChildren(el("p", "eyebrow", "Phone sync"), state, facts);

        if (address) {
            syncPanel.append(
                el("p", "muted", "Open this address on a phone connected to the same network and pick the photos to send. Uploads go straight into the library."),
                buildAddress(address),
                el("p", "photo-sync-hint", "Reachable from this machine only until sync_host is set to 0.0.0.0 in the satellite's config.toml."),
            );
        }

        if (status.events.length) {
            const log = el("ul", "photo-sync-log");
            for (const event of status.events) {
                const item = document.createElement("li");
                item.append(
                    el("span", "photo-sync-name", event.filename),
                    el("span", `photo-sync-status ${event.status}`, event.detail || event.status),
                );
                log.appendChild(item);
            }
            syncPanel.append(el("p", "eyebrow", "Recent activity"), log);
        }
    }

    function buildAddress(address) {
        const row = el("div", "photo-address");
        const value = el("code", null, address);
        const copy = el("button", "button", "Copy");
        copy.type = "button";
        copy.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(address);
                copy.textContent = "Copied";
            } catch (error) {
                getSelection().selectAllChildren(value);
                copy.textContent = "Select and copy";
            }
            setTimeout(() => (copy.textContent = "Copy"), 2500);
        });

        row.append(value, copy);
        return row;
    }

    /* ---------- data ---------- */

    async function refresh() {
        try {
            const [library, listing, status] = await Promise.all([
                api.get("/library"), api.get("/photos"), api.get("/sync")]);
            photos = listing.photos;
            renderSummary(library, status);
            renderSync(status);
            renderGallery();
            notice.hidden = true;
        } catch (error) {
            gallery.replaceChildren();
            notice.textContent = `The photo library could not be read: ${error.message}`;
            notice.hidden = false;
        }
    }

    async function submit(action, input, buttons, result) {
        const source = input.value.trim();
        if (!source) {
            input.focus();
            return;
        }

        buttons.forEach((button) => (button.disabled = true));
        result.className = "photo-import-result";
        result.textContent = action === "scan" ? "Scanning…" : "Importing…";
        result.hidden = false;

        try {
            const report = await api.post(`/${action}`, { source });
            result.textContent = action === "scan"
                ? `${report.found} supported file(s) · ${report.new} new · ${report.duplicates} already in the library`
                : `${report.imported} imported · ${report.duplicates} duplicate(s) · ${report.failed.length} failed`;

            if (action === "import") {
                await refresh();
            }
        } catch (error) {
            result.className = "photo-import-result failed";
            result.textContent = error.message;
        } finally {
            buttons.forEach((button) => (button.disabled = false));
        }
    }

    /* ---------- rendering ---------- */

    function renderSummary(library, status) {
        summary.replaceChildren(
            tile("Photos", String(library.photos)),
            tile("Library size", readableSize(library.size_bytes)),
            tile("Thumbnails", library.thumbnails ? "cached" : "originals", library.thumbnails),
            tile("Phone sync", status.running ? "listening" : "off", status.running),
        );
    }

    function tile(label, value, state) {
        const cell = el("div", "tile");
        const body = el("dd");

        if (state !== undefined) {
            body.appendChild(el("i", `state-dot ${state ? "on" : "off"}`));
        }
        body.appendChild(el("span", null, value));
        cell.append(el("dt", null, label), body);
        return cell;
    }

    function skeleton() {
        gallery.replaceChildren();
        for (let count = 0; count < SKELETONS; count += 1) {
            gallery.appendChild(el("div", "photo-tile photo-skeleton"));
        }
    }

    function renderGallery() {
        gallery.replaceChildren();

        if (photos.length === 0) {
            gallery.appendChild(buildEmpty());
            return;
        }

        photos.forEach((photo, position) => gallery.appendChild(buildTile(photo, position)));
    }

    function buildEmpty() {
        const empty = el("div", "photo-empty");
        const button = el("button", "button button-primary", "Import photos");
        button.type = "button";
        button.addEventListener("click", () => toggleImport(true));

        empty.innerHTML = `
            <svg width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                <rect x="8.5" y="13.5" width="29" height="21" rx="3"/>
                <circle cx="23" cy="24" r="6"/>
                <ellipse cx="23" cy="24" rx="14" ry="4.6" transform="rotate(-20 23 24)" opacity="0.45"/>
            </svg>`;
        empty.append(
            el("p", null, "Your photo library is empty."),
            el("p", "muted", "Import a folder to begin."),
            button,
        );
        return empty;
    }

    function buildTile(photo, position) {
        const tile = el("button", "photo-tile");
        tile.type = "button";
        tile.title = photo.filename;

        const image = el("img");
        image.src = api.url(`/thumbnails/${photo.id}`);
        image.alt = photo.filename;
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => tile.classList.add("unavailable"));

        const caption = el("span", "photo-caption", photo.filename);
        tile.append(image, caption);
        tile.addEventListener("click", () => openViewer(position));
        return tile;
    }

    /* ---------- viewer ---------- */

    function openViewer(position) {
        index = position;

        if (viewer === null) {
            viewer = buildViewer();
            document.body.appendChild(viewer.element);
        }

        show();
    }

    function closeViewer() {
        if (viewer !== null) {
            viewer.element.remove();
            viewer = null;
        }
        index = -1;
    }

    function step(offset) {
        if (photos.length === 0) {
            return;
        }

        index = (index + offset + photos.length) % photos.length;
        show();
    }

    function show() {
        const photo = photos[index];
        if (!photo) {
            closeViewer();
            return;
        }

        const metadata = photo.metadata || {};

        viewer.image.src = api.url(`/originals/${photo.id}`);
        viewer.image.alt = photo.filename;
        viewer.title.textContent = photo.filename;
        viewer.position.textContent = `${index + 1} / ${photos.length}`;

        // present fields only - most photos have no EXIF at all, or only some of
        // it, and a wall of "—" is worse than not showing the row
        const rows = [
            ["Dimensions", `${photo.width} × ${photo.height}`],
            ["Megapixels", metadata.megapixels ? `${metadata.megapixels} MP` : null],
            ["Size", readableSize(photo.size)],
            ["Format", photo.format.toUpperCase()],
            ["Captured", formatDate(photo.captured_at) || "unknown"],
            ["Imported", formatDate(photo.imported_at)],
            ["Camera", cameraLabel(metadata)],
            ["Lens", metadata.lens_model],
            ["Focal length", metadata.focal_length ? `${metadata.focal_length} mm` : null],
            ["Aperture", metadata.aperture ? `f/${metadata.aperture}` : null],
            ["Shutter speed", metadata.shutter_speed],
            ["ISO", metadata.iso ? String(metadata.iso) : null],
            ["Orientation", orientationLabel(metadata.orientation)],
            ["Location", metadata.gps_coordinates, mapLink(metadata)],
        ];

        viewer.meta.replaceChildren(...rows.filter(([, value]) => value).map(([label, value, href]) => fact(label, value, href)));
    }

    function buildViewer() {
        const element = el("div", "photo-viewer");
        const title = el("p", "photo-viewer-title");
        const position = el("p", "photo-viewer-position");
        const image = el("img", "photo-viewer-image");
        const meta = el("dl", "facts photo-viewer-meta");

        const closeButton = el("button", "photo-viewer-close", "✕");
        const previous = el("button", "photo-viewer-step previous", "‹");
        const next = el("button", "photo-viewer-step next", "›");

        for (const button of [closeButton, previous, next]) {
            button.type = "button";
        }
        closeButton.title = "Close";
        previous.title = "Previous";
        next.title = "Next";

        closeButton.addEventListener("click", closeViewer);
        previous.addEventListener("click", () => step(-1));
        next.addEventListener("click", () => step(1));
        element.addEventListener("click", (event) => {
            if (event.target === element) {
                closeViewer();
            }
        });

        const bar = el("div", "photo-viewer-bar");
        const identity = el("div");
        identity.append(el("p", "eyebrow", "StarCore · Photo"), title);
        bar.append(identity, position, closeButton);

        const stage = el("div", "photo-viewer-stage");
        stage.append(previous, image, next);

        element.append(bar, stage, meta);
        return { element, image, title, position, meta };
    }

    function fact(label, value, href) {
        const row = document.createElement("div");
        const body = document.createElement("dd");

        if (href) {
            const link = el("a", null, value);
            link.href = href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            body.appendChild(link);
        } else {
            body.textContent = value;
        }

        row.append(el("dt", null, label), body);
        return row;
    }

    function cameraLabel(metadata) {
        const { camera_make: make, camera_model: model } = metadata;
        // many cameras (Canon, Nikon...) already write the make into the model
        // string ("Canon EOS R5", "NIKON D850") - shown as-is that would read
        // "Canon Canon EOS R5", so the make is only prefixed when it isn't
        // already there
        if (make && model) {
            return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
        }
        return make || model || null;
    }

    function mapLink(metadata) {
        if (metadata.gps_latitude == null || metadata.gps_longitude == null) {
            return null;
        }
        const { gps_latitude: lat, gps_longitude: lon } = metadata;
        return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
    }

    function onKeyDown(event) {
        if (viewer === null) {
            return;
        }

        if (event.key === "Escape") {
            closeViewer();
        } else if (event.key === "ArrowLeft") {
            step(-1);
        } else if (event.key === "ArrowRight") {
            step(1);
        }
    }
}

/* ---------- helpers ---------- */

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

function readableSize(bytes) {
    let value = Number(bytes) || 0;
    if (value < 1024) {
        return `${value} B`;
    }

    for (const unit of ["KB", "MB", "GB"]) {
        value /= 1024;
        if (value < 1024 || unit === "GB") {
            return `${value.toFixed(1)} ${unit}`;
        }
    }
}

const ORIENTATIONS = {
    1: "Normal", 2: "Flipped horizontally", 3: "Rotated 180°", 4: "Flipped vertically",
    5: "Rotated 90° CW, flipped", 6: "Rotated 90° CW", 7: "Rotated 90° CCW, flipped", 8: "Rotated 90° CCW",
};

function orientationLabel(code) {
    return ORIENTATIONS[code] || null;
}

function formatDate(value) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
