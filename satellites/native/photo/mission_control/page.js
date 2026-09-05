const SKELETONS = 12;
const TABS = ["photos", "albums", "map"];

// loaded lazily, at most once per browser session, and only when a map is
// actually about to be shown (the Map tab, or a photo's location panel) -
// everything else in Mission Control stays dependency-free (see
// docs/mission_control.md); this is the one deliberate, documented exception
// (see "Map" in docs/photo.md) and it never blocks anything else from working
const LEAFLET_VERSION = "1.9.4";
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
let leafletPromise = null;

function loadLeaflet() {
    if (window.L) {
        return Promise.resolve(window.L);
    }
    if (leafletPromise) {
        return leafletPromise;
    }

    leafletPromise = new Promise((resolve, reject) => {
        if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
            const css = document.createElement("link");
            css.rel = "stylesheet";
            css.href = LEAFLET_CSS;
            document.head.appendChild(css);
        }

        const script = document.createElement("script");
        script.src = LEAFLET_JS;
        script.async = true;
        script.addEventListener("load", () => resolve(window.L));
        script.addEventListener("error", () => {
            leafletPromise = null;  // a later attempt (e.g. once the network is back) gets a fresh try
            reject(new Error("the map library could not be loaded - check this device's internet connection"));
        });
        document.head.appendChild(script);
    });

    return leafletPromise;
}

export function mount(context) {
    const { element: root, satellite, api } = context;

    let photos = [];
    let albums = [];
    let tab = "photos";
    let groupByCamera = false;
    let openAlbum = null;       // full album detail (with resolved .photos), or null
    let viewerList = [];        // whichever array the open viewer is stepping through
    let viewer = null;
    let index = -1;
    let infoOpen = false;
    let mapState = null;        // { map, markers, located } once the Map tab has been built once
    let locationMap = null;     // { map, marker } for the photo-details location panel, built once

    const summary = el("dl", "tiles");
    const tabBar = buildTabBar();
    const photosPanel = buildPhotosPanel();
    const albumsPanel = buildAlbumsPanel();
    const mapPanel = buildMapPanel();
    const notice = el("p", "photo-notice");
    notice.hidden = true;

    const body = el("div", "stack");
    body.append(summary, tabBar, notice, photosPanel.element, albumsPanel.element, mapPanel.element);
    root.replaceChildren(buildHead(), body);

    setTab("photos");
    skeleton();
    refresh();
    document.addEventListener("keydown", onKeyDown);

    return () => {
        document.removeEventListener("keydown", onKeyDown);
        closeViewer();
        if (mapState) {
            mapState.map.remove();
        }
        if (locationMap) {
            locationMap.map.remove();
        }
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

    function buildTabBar() {
        const group = el("div", "photo-tabs");
        for (const name of TABS) {
            const button = el("button", "photo-tab", name === "map" ? "Map" : name[0].toUpperCase() + name.slice(1));
            button.type = "button";
            button.dataset.tab = name;
            button.addEventListener("click", () => setTab(name));
            group.appendChild(button);
        }
        return group;
    }

    function setTab(name) {
        tab = name;
        for (const button of tabBar.querySelectorAll(".photo-tab")) {
            button.classList.toggle("active", button.dataset.tab === name);
        }

        photosPanel.element.hidden = name !== "photos";
        albumsPanel.element.hidden = name !== "albums";
        mapPanel.element.hidden = name !== "map";

        if (name === "albums") {
            renderAlbums();
        } else if (name === "map") {
            renderMap();
        }
    }

    /* ---------- Photos tab ---------- */

    function buildPhotosPanel() {
        const element = el("div", "photo-tab-panel");
        const importPanel = buildImportPanel();
        const syncPanel = el("section", "panel photo-sync");
        const gallery = el("div", "photo-gallery");
        syncPanel.hidden = true;

        element.append(buildToolbar(importPanel, syncPanel), importPanel, syncPanel, gallery);
        return { element, importPanel, syncPanel, gallery };
    }

    function buildToolbar(importPanel, syncPanel) {
        const toolbar = el("div", "photo-toolbar");
        const phone = el("button", "button", "Phone sync");
        const button = el("button", "button button-primary", "Import photos");
        phone.type = "button";
        button.type = "button";
        phone.addEventListener("click", () => {
            syncPanel.hidden = !syncPanel.hidden;
            importPanel.hidden = true;
        });
        button.addEventListener("click", () => toggleImport(importPanel, syncPanel));

        const left = el("div", "photo-toolbar-left");
        left.append(el("p", "eyebrow", "Gallery"), buildGroupToggle());

        const actions = el("div", "photo-actions");
        actions.append(phone, button);
        toolbar.append(left, actions);
        return toolbar;
    }

    function buildGroupToggle() {
        const group = el("div", "photo-group-toggle");
        group.hidden = true;  // only shown once we know at least one photo has camera metadata

        const all = el("button", "photo-tab", "All");
        const byCamera = el("button", "photo-tab", "By camera");
        all.type = "button";
        byCamera.type = "button";
        all.dataset.group = "all";
        byCamera.dataset.group = "camera";

        all.addEventListener("click", () => {
            groupByCamera = false;
            renderGallery();
        });
        byCamera.addEventListener("click", () => {
            groupByCamera = true;
            renderGallery();
        });

        group.append(all, byCamera);
        return group;
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

    function toggleImport(importPanel, syncPanel, force) {
        importPanel.hidden = force === undefined ? !importPanel.hidden : !force;
        syncPanel.hidden = true;
        if (!importPanel.hidden) {
            importPanel.querySelector("input").focus();
        }
    }

    function renderSync(status) {
        const syncPanel = photosPanel.syncPanel;
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
            const [libraryInfo, listing, status, albumListing] = await Promise.all([
                api.get("/library"), api.get("/photos"), api.get("/sync"), api.get("/albums")]);
            photos = listing.photos;
            albums = albumListing.albums;
            renderSummary(libraryInfo, status);
            renderSync(status);
            renderGallery();
            if (tab === "albums") {
                renderAlbums();
            }
            notice.hidden = true;
        } catch (error) {
            photosPanel.gallery.replaceChildren();
            notice.textContent = `The photo library could not be read: ${error.message}`;
            notice.hidden = false;
        }

        // pre-fills the import field with the configured default directory
        // (set from the satellite's own configuration - the gear icon in the
        // topbar) so importing doesn't require typing the same path every
        // time; a value the user has already typed is never overwritten
        try {
            const configuration = await api.get("/configuration");
            const directory = configuration.settings.find((setting) => setting.key === "photo_directory");
            const input = photosPanel.importPanel.querySelector("input");
            if (directory && directory.value && !input.value) {
                input.value = directory.value;
            }
        } catch (error) {
            // the import panel still works with a typed-in path if this fails
        }
    }

    async function reloadAlbums() {
        try {
            albums = (await api.get("/albums")).albums;
        } catch (error) {
            // the Albums tab keeps whatever it last had and shows its own error below
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

    /* ---------- rendering: summary + gallery ---------- */

    function renderSummary(libraryInfo, status) {
        summary.replaceChildren(
            tile("Photos", String(libraryInfo.photos)),
            tile("Library size", readableSize(libraryInfo.size_bytes)),
            tile("Thumbnails", libraryInfo.thumbnails ? "cached" : "originals", libraryInfo.thumbnails),
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
        photosPanel.gallery.replaceChildren();
        for (let count = 0; count < SKELETONS; count += 1) {
            photosPanel.gallery.appendChild(el("div", "photo-tile photo-skeleton"));
        }
    }

    function renderGallery() {
        const gallery = photosPanel.gallery;
        gallery.replaceChildren();

        const toggle = photosPanel.element.querySelector(".photo-group-toggle");
        const hasCameraData = photos.some((photo) => cameraLabel(photo.metadata || {}));
        toggle.hidden = !hasCameraData;
        if (!hasCameraData) {
            groupByCamera = false;
        }
        for (const button of toggle.querySelectorAll(".photo-tab")) {
            button.classList.toggle("active", (button.dataset.group === "camera") === groupByCamera);
        }

        if (photos.length === 0) {
            gallery.appendChild(buildEmpty());
            return;
        }

        if (!groupByCamera || !hasCameraData) {
            gallery.appendChild(buildGrid(photos));
            return;
        }

        // grouped by camera/device - automatic only, and only offered at all
        // when at least one photo actually carries that metadata (see
        // hasCameraData above); a photo with no camera metadata still shows
        // up, in its own "Unknown camera" group, rather than being hidden
        const groups = new Map();
        for (const photo of photos) {
            const label = cameraLabel(photo.metadata || {}) || "Unknown camera";
            if (!groups.has(label)) {
                groups.set(label, []);
            }
            groups.get(label).push(photo);
        }

        const wrapper = el("div", "photo-groups");
        for (const [label, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const section = el("div", "photo-group");
            section.append(el("p", "eyebrow photo-group-title", `${label} · ${group.length}`), buildGrid(group));
            wrapper.appendChild(section);
        }
        gallery.appendChild(wrapper);
    }

    function buildGrid(list) {
        const grid = el("div", "photo-gallery");
        list.forEach((photo, position) => grid.appendChild(buildTile(photo, () => openViewer(list, position))));
        return grid;
    }

    function buildEmpty() {
        const empty = el("div", "photo-empty");
        const button = el("button", "button button-primary", "Import photos");
        button.type = "button";
        button.addEventListener("click", () => toggleImport(photosPanel.importPanel, photosPanel.syncPanel, true));

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

    function buildTile(photo, onOpen, badge) {
        const tileEl = el("button", "photo-tile");
        tileEl.type = "button";
        tileEl.title = photo.filename;

        const image = el("img");
        image.src = api.url(`/thumbnails/${photo.id}`);
        image.alt = photo.filename;
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => tileEl.classList.add("unavailable"));

        const caption = el("span", "photo-caption", photo.filename);
        tileEl.append(image, caption);
        if (badge) {
            tileEl.appendChild(badge);
        }
        tileEl.addEventListener("click", onOpen);
        return tileEl;
    }

    /* ---------- Albums tab ---------- */

    function buildAlbumsPanel() {
        const element = el("div", "photo-tab-panel");
        element.hidden = true;

        const toolbar = el("div", "photo-toolbar");
        const create = el("button", "button button-primary", "New album");
        create.type = "button";
        create.addEventListener("click", () => openAlbumPrompt());
        toolbar.append(el("p", "eyebrow", "Albums"), create);

        const notice = el("p", "photo-notice");
        notice.hidden = true;
        const content = el("div", "photo-albums-content");

        element.append(toolbar, notice, content);
        return { element, notice, content };
    }

    function renderAlbums() {
        const { content } = albumsPanel;
        content.replaceChildren();

        if (openAlbum) {
            content.appendChild(buildAlbumDetail(openAlbum));
            return;
        }

        if (albums.length === 0) {
            content.appendChild(buildAlbumsEmpty());
            return;
        }

        const grid = el("div", "photo-albums");
        for (const album of albums) {
            grid.appendChild(buildAlbumCard(album));
        }
        content.appendChild(grid);
    }

    function buildAlbumsEmpty() {
        const empty = el("div", "photo-empty");
        const button = el("button", "button button-primary", "New album");
        button.type = "button";
        button.addEventListener("click", () => openAlbumPrompt());

        empty.innerHTML = `
            <svg width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                <rect x="6.5" y="9.5" width="24" height="18" rx="2.5"/>
                <rect x="15.5" y="18.5" width="24" height="18" rx="2.5" fill="none"/>
            </svg>`;
        empty.append(
            el("p", null, "No albums yet."),
            el("p", "muted", "Create one to start grouping photos together."),
            button,
        );
        return empty;
    }

    function buildAlbumCard(album) {
        const card = el("div", "photo-album-card");
        card.tabIndex = 0;

        const cover = el("div", "photo-album-cover");
        if (album.cover_photo_id) {
            const image = el("img");
            image.src = api.url(`/thumbnails/${album.cover_photo_id}`);
            image.alt = "";
            image.loading = "lazy";
            cover.appendChild(image);
        } else {
            cover.classList.add("empty");
        }

        const meta = el("div", "photo-album-meta");
        meta.append(
            el("p", "photo-album-name", album.name),
            el("p", "muted", `${album.photo_count} photo${album.photo_count === 1 ? "" : "s"}`),
        );

        const actions = el("div", "photo-album-actions");
        const rename = iconButton("Rename", RENAME_ICON);
        const remove = iconButton("Delete", DELETE_ICON);
        rename.addEventListener("click", (event) => {
            event.stopPropagation();
            openAlbumPrompt(album);
        });
        remove.addEventListener("click", (event) => {
            event.stopPropagation();
            confirmDeleteAlbum(album);
        });
        actions.append(rename, remove);

        const open = () => openAlbumDetail(album.id);
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
            }
        });

        card.append(cover, meta, actions);
        return card;
    }

    async function openAlbumDetail(albumId) {
        try {
            openAlbum = await api.get(`/albums/${albumId}`);
        } catch (error) {
            openAlbum = null;
            albumsPanel.notice.textContent = `That album could not be opened: ${error.message}`;
            albumsPanel.notice.hidden = false;
            return;
        }
        renderAlbums();
    }

    function buildAlbumDetail(album) {
        const wrapper = el("div", "photo-album-detail");

        const back = el("button", "photo-back", "← Albums");
        back.type = "button";
        back.addEventListener("click", () => {
            openAlbum = null;
            renderAlbums();
        });

        const header = el("div", "photo-album-detail-head");
        const title = el("h3", null, album.name);
        const rename = iconButton("Rename", RENAME_ICON);
        rename.addEventListener("click", () => openAlbumPrompt(album));
        const remove = el("button", "button button-stop", "Delete album");
        remove.type = "button";
        remove.addEventListener("click", () => confirmDeleteAlbum(album, true));
        const addPhotos = el("button", "button button-primary", "Add photos");
        addPhotos.type = "button";
        addPhotos.addEventListener("click", () => openAddPhotosPicker(album));

        const titleRow = el("div", "photo-album-detail-title");
        titleRow.append(title, rename);
        const actionsRow = el("div", "photo-album-detail-actions");
        actionsRow.append(addPhotos, remove);
        header.append(titleRow, el("p", "muted", `${album.photos.length} photo${album.photos.length === 1 ? "" : "s"}`), actionsRow);

        wrapper.append(back, header);

        if (album.photos.length === 0) {
            const empty = el("div", "photo-empty");
            empty.append(el("p", null, "This album has no photos yet."), el("p", "muted", "Use “Add photos” to choose some."));
            wrapper.appendChild(empty);
            return wrapper;
        }

        const grid = el("div", "photo-gallery");
        album.photos.forEach((photo, position) => {
            const remove = el("button", "photo-tile-remove", "✕");
            remove.type = "button";
            remove.title = "Remove from album";
            remove.addEventListener("click", async (event) => {
                event.stopPropagation();
                try {
                    await api.post(`/albums/${album.id}/photos/remove`, { photo_id: photo.id });
                    openAlbum = await api.get(`/albums/${album.id}`);
                    await reloadAlbums();
                } catch (error) {
                    albumsPanel.notice.textContent = error.message;
                    albumsPanel.notice.hidden = false;
                }
                renderAlbums();
            });

            grid.appendChild(buildTile(photo, () => openViewer(album.photos, position), remove));
        });
        wrapper.appendChild(grid);
        return wrapper;
    }

    function openAlbumPrompt(existing) {
        const isRename = Boolean(existing);
        const overlay = el("div", "modal-overlay");
        const modal = el("div", "modal");
        const head = el("div", "modal-head");
        head.append(el("h2", null, isRename ? "Rename album" : "New album"));
        const close = el("button", "modal-close", "✕");
        close.type = "button";
        close.addEventListener("click", () => overlay.remove());
        head.appendChild(close);

        const form = el("form", "stack");
        const field = el("label", "field");
        field.append(el("span", null, "Name"));
        const input = el("input");
        input.type = "text";
        input.maxLength = 120;
        input.required = true;
        input.value = isRename ? existing.name : "";
        field.appendChild(input);

        const error = el("p", "banner error");
        error.hidden = true;
        const submitButton = el("button", "button button-primary", isRename ? "Save" : "Create");
        submitButton.type = "submit";

        form.append(field, error);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            error.hidden = true;
            submitButton.disabled = true;
            try {
                if (isRename) {
                    await api.post(`/albums/${existing.id}`, { name: input.value });
                } else {
                    await api.post("/albums", { name: input.value });
                }
                await reloadAlbums();
                if (isRename && openAlbum && openAlbum.id === existing.id) {
                    openAlbum = await api.get(`/albums/${existing.id}`);
                }
                overlay.remove();
                renderAlbums();
            } catch (requestError) {
                error.textContent = requestError.message;
                error.hidden = false;
            } finally {
                submitButton.disabled = false;
            }
        });
        form.appendChild(submitButton);

        modal.append(head, form);
        overlay.appendChild(modal);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                overlay.remove();
            }
        });
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    }

    function confirmDeleteAlbum(album, backOut) {
        const overlay = el("div", "modal-overlay");
        const modal = el("div", "modal");
        const head = el("div", "modal-head");
        head.append(el("h2", null, "Delete album"));
        const close = el("button", "modal-close", "✕");
        close.type = "button";
        close.addEventListener("click", () => overlay.remove());
        head.appendChild(close);

        const body = el("div", "stack");
        body.append(el("p", null, `Delete "${album.name}"? The photos themselves are not affected - only the album.`));
        const actions = el("div", "photo-actions");
        const cancel = el("button", "button", "Cancel");
        const confirm = el("button", "button button-stop", "Delete");
        cancel.type = "button";
        confirm.type = "button";
        cancel.addEventListener("click", () => overlay.remove());
        confirm.addEventListener("click", async () => {
            confirm.disabled = true;
            try {
                await api.post(`/albums/${album.id}/delete`, {});
                if (backOut) {
                    openAlbum = null;
                }
                await reloadAlbums();
                overlay.remove();
                renderAlbums();
            } catch (error) {
                confirm.disabled = false;
            }
        });
        actions.append(cancel, confirm);
        body.appendChild(actions);

        modal.append(head, body);
        overlay.appendChild(modal);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                overlay.remove();
            }
        });
        document.body.appendChild(overlay);
    }

    function openAddPhotosPicker(album) {
        const overlay = el("div", "modal-overlay");
        const modal = el("div", "modal photo-picker-modal");
        const head = el("div", "modal-head");
        head.append(el("h2", null, "Add photos"));

        // closing this picker any way (the ✕ button or clicking the backdrop)
        // must refresh the album detail and the albums list behind it, since
        // photos may have been added/removed while it was open
        const closeAndRefresh = async () => {
            overlay.remove();
            openAlbum = await api.get(`/albums/${album.id}`).catch(() => openAlbum);
            await reloadAlbums();
            renderAlbums();
        };

        const close = el("button", "modal-close", "✕");
        close.type = "button";
        close.addEventListener("click", closeAndRefresh);
        head.appendChild(close);

        const inAlbum = new Set(album.photo_ids);
        const grid = el("div", "photo-gallery photo-picker-grid");

        for (const photo of photos) {
            const tileEl = el("button", "photo-tile photo-picker-tile");
            tileEl.type = "button";
            const image = el("img");
            image.src = api.url(`/thumbnails/${photo.id}`);
            image.alt = photo.filename;
            image.loading = "lazy";
            tileEl.append(image, el("span", "photo-caption", photo.filename));
            tileEl.classList.toggle("selected", inAlbum.has(photo.id));

            tileEl.addEventListener("click", async () => {
                tileEl.disabled = true;
                try {
                    if (inAlbum.has(photo.id)) {
                        inAlbum.delete(photo.id);
                        await api.post(`/albums/${album.id}/photos/remove`, { photo_id: photo.id });
                    } else {
                        inAlbum.add(photo.id);
                        await api.post(`/albums/${album.id}/photos`, { photo_id: photo.id });
                    }
                    tileEl.classList.toggle("selected", inAlbum.has(photo.id));
                } catch (error) {
                    // the tile's state simply doesn't flip - nothing left half-done
                } finally {
                    tileEl.disabled = false;
                }
            });

            grid.appendChild(tileEl);
        }

        modal.append(head, el("p", "muted", "Select photos to add or remove them from this album."), grid);
        overlay.appendChild(modal);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeAndRefresh();
            }
        });
        document.body.appendChild(overlay);
    }

    function iconButton(title, svg) {
        const button = el("button", "icon-button photo-icon-button");
        button.type = "button";
        button.title = title;
        button.innerHTML = svg;
        return button;
    }

    /* ---------- Map tab ---------- */

    function buildMapPanel() {
        const element = el("div", "photo-tab-panel");
        element.hidden = true;

        const shell = el("div", "photo-map-shell");
        const container = el("div", "photo-map");
        const notice = el("div", "photo-map-notice");
        notice.hidden = true;
        shell.append(container, notice);
        element.appendChild(shell);

        return { element, container, notice };
    }

    async function renderMap() {
        const { container, notice } = mapPanel;
        const located = photos.filter((photo) => hasLocation(photo.metadata));

        if (located.length === 0) {
            container.hidden = true;
            notice.hidden = false;
            notice.textContent = "No photos have location data yet. Photos with GPS metadata will appear here automatically.";
            return;
        }

        notice.hidden = true;
        container.hidden = false;

        if (!mapState) {
            let L;
            try {
                L = await loadLeaflet();
            } catch (error) {
                container.hidden = true;
                notice.hidden = false;
                notice.textContent = error.message;
                return;
            }

            const map = L.map(container, { attributionControl: true, zoomControl: true });
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                attribution: "&copy; OpenStreetMap contributors",
                maxZoom: 19,
            }).addTo(map);

            const markers = L.layerGroup().addTo(map);
            mapState = { map, markers, located: [] };
            map.on("zoomend moveend", () => drawMarkers());
        }

        mapState.located = located;
        fitToLocated();
        drawMarkers();
    }

    function fitToLocated() {
        const L = window.L;
        const points = mapState.located.map((photo) => [photo.metadata.gps_latitude, photo.metadata.gps_longitude]);
        if (points.length === 1) {
            mapState.map.setView(points[0], 13);
        } else {
            mapState.map.fitBounds(L.latLngBounds(points), { padding: [32, 32] });
        }
    }

    function drawMarkers() {
        const L = window.L;
        mapState.markers.clearLayers();

        for (const cluster of clusterLocated(mapState.located, mapState.map.getZoom())) {
            const icon = L.divIcon({
                className: "photo-map-marker",
                html: cluster.photos.length > 1
                    ? `<span class="photo-map-marker-dot"></span><span class="photo-map-marker-count">${cluster.photos.length}</span>`
                    : `<span class="photo-map-marker-dot"></span>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });

            const marker = L.marker([cluster.lat, cluster.lon], { icon });
            marker.bindPopup(buildMapPopup(cluster.photos), { className: "photo-map-popup", maxWidth: 260 });
            mapState.markers.addLayer(marker);
        }
    }

    function buildMapPopup(clusterPhotos) {
        const wrapper = el("div", "photo-map-popup-body");
        wrapper.append(el("p", "muted", clusterPhotos.length === 1
            ? clusterPhotos[0].filename
            : `${clusterPhotos.length} photos here`));

        const grid = el("div", "photo-map-popup-grid");
        clusterPhotos.slice(0, 12).forEach((photo) => {
            const thumb = el("button", "photo-map-popup-thumb");
            thumb.type = "button";
            const image = el("img");
            image.src = api.url(`/thumbnails/${photo.id}`);
            image.alt = photo.filename;
            image.loading = "lazy";
            thumb.appendChild(image);
            thumb.addEventListener("click", () => {
                mapState.map.closePopup();
                openViewer(clusterPhotos, clusterPhotos.indexOf(photo));
            });
            grid.appendChild(thumb);
        });

        wrapper.appendChild(grid);
        return wrapper;
    }

    function hasLocation(metadata) {
        return Boolean(metadata) && metadata.gps_latitude != null && metadata.gps_longitude != null;
    }

    function clusterLocated(located, zoom) {
        // a simple grid-based grouping: photos whose coordinates round to the
        // same value at the current zoom level share one marker, rather than
        // piling up a marker per photo when several were taken at (almost)
        // the same spot - the grid gets finer as the user zooms in, so
        // clusters naturally separate out instead of needing to be rebuilt
        // with a different algorithm
        const precision = Math.max(0, Math.min(6, Math.round((zoom - 1) / 2)));
        const buckets = new Map();

        for (const photo of located) {
            const { gps_latitude: lat, gps_longitude: lon } = photo.metadata;
            const key = `${lat.toFixed(precision)}:${lon.toFixed(precision)}`;
            if (!buckets.has(key)) {
                buckets.set(key, []);
            }
            buckets.get(key).push(photo);
        }

        return [...buckets.values()].map((group) => ({
            lat: average(group.map((photo) => photo.metadata.gps_latitude)),
            lon: average(group.map((photo) => photo.metadata.gps_longitude)),
            photos: group,
        }));
    }

    function average(numbers) {
        return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }

    /* ---------- viewer ---------- */

    function openViewer(list, position) {
        viewerList = list;
        index = position;

        if (viewer === null) {
            infoOpen = false;
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
        viewerList = [];
    }

    function step(offset) {
        if (viewerList.length === 0) {
            return;
        }

        index = (index + offset + viewerList.length) % viewerList.length;
        show();
    }

    function show() {
        const photo = viewerList[index];
        if (!photo) {
            closeViewer();
            return;
        }

        const metadata = photo.metadata || {};

        viewer.image.src = api.url(`/originals/${photo.id}`);
        viewer.image.alt = photo.filename;
        viewer.title.textContent = photo.filename;
        viewer.position.textContent = `${index + 1} / ${viewerList.length}`;

        const multiple = viewerList.length > 1;
        viewer.previous.hidden = !multiple;
        viewer.next.hidden = !multiple;

        // present fields only - most photos have no EXIF at all, or only some of
        // it, and a wall of "—" is worse than not showing the row. Ordered as a
        // reader would want it: when and where, then the gear, then exposure,
        // then the file itself.
        const rows = [
            ["Captured", formatDate(photo.captured_at) || "unknown"],
            ["Location", metadata.gps_coordinates, mapLink(metadata)],
            ["Camera", cameraLabel(metadata)],
            ["Lens", metadata.lens_model],
            ["Focal length", metadata.focal_length ? `${metadata.focal_length} mm` : null],
            ["Aperture", metadata.aperture ? `f/${metadata.aperture}` : null],
            ["Shutter speed", metadata.shutter_speed],
            ["ISO", metadata.iso ? String(metadata.iso) : null],
            ["Dimensions", `${photo.width} × ${photo.height}`],
            ["Megapixels", metadata.megapixels ? `${metadata.megapixels} MP` : null],
            ["Size", readableSize(photo.size)],
            ["Format", photo.format.toUpperCase()],
            ["Orientation", orientationLabel(metadata.orientation)],
            ["Imported", formatDate(photo.imported_at)],
        ];

        const visible = rows.filter(([, value]) => value);
        viewer.meta.replaceChildren(...visible.map(([label, value, href]) => fact(label, value, href)));
        renderLocationPanel(metadata);

        // a photo with nothing beyond its dimensions and size still has those
        // two rows, so the info button only disappears for a fully empty panel
        viewer.infoButton.hidden = visible.length === 0;
        if (visible.length === 0) {
            toggleInfo(false);
        }
    }

    function renderLocationPanel(metadata) {
        const located = hasLocation(metadata);
        viewer.locationUnavailable.hidden = located;
        viewer.locationMapEl.hidden = !located;

        if (!located) {
            return;
        }

        ensureLocationMap()
            .then((L) => {
                if (!viewer) {
                    return;  // the viewer was closed while the map library was loading
                }
                const point = [metadata.gps_latitude, metadata.gps_longitude];
                locationMap.map.setView(point, 13);
                locationMap.marker.setLatLng(point);
                setTimeout(() => locationMap.map.invalidateSize(), 0);
            })
            .catch((error) => {
                viewer.locationMapEl.hidden = true;
                viewer.locationUnavailable.hidden = false;
                viewer.locationUnavailable.textContent = error.message;
            });
    }

    async function ensureLocationMap() {
        const L = await loadLeaflet();
        if (!locationMap) {
            const map = L.map(viewer.locationMapEl, {
                attributionControl: false, zoomControl: true, scrollWheelZoom: false,
            });
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
            const icon = L.divIcon({
                className: "photo-map-marker",
                html: `<span class="photo-map-marker-dot"></span>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12],
            });
            const marker = L.marker([0, 0], { icon }).addTo(map);
            locationMap = { map, marker };
        }
        return L;
    }

    function toggleInfo(force) {
        infoOpen = force === undefined ? !infoOpen : force;
        viewer.panel.classList.toggle("open", infoOpen);
        viewer.infoButton.classList.toggle("active", infoOpen);
        viewer.infoButton.setAttribute("aria-expanded", String(infoOpen));
        if (infoOpen && locationMap) {
            setTimeout(() => locationMap.map.invalidateSize(), 220);
        }
    }

    function buildViewer() {
        const element = el("div", "photo-viewer");
        const title = el("p", "photo-viewer-title");
        const position = el("p", "photo-viewer-position");
        const image = el("img", "photo-viewer-image");
        const meta = el("dl", "facts photo-viewer-meta");

        const locationUnavailable = el("p", "photo-location-unavailable", "Location unavailable");
        const locationMapEl = el("div", "photo-location-map");
        locationUnavailable.hidden = true;
        locationMapEl.hidden = true;
        const locationSection = el("div", "photo-viewer-location");
        locationSection.append(locationUnavailable, locationMapEl);

        const infoButton = el("button", "photo-viewer-info");
        infoButton.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2"/>
                <path d="M8 7.3v4"/>
                <circle cx="8" cy="4.9" r="0.8" fill="currentColor" stroke="none"/>
            </svg>`;
        const closeButton = el("button", "photo-viewer-close", "✕");
        const previous = el("button", "photo-viewer-step previous", "‹");
        const next = el("button", "photo-viewer-step next", "›");

        for (const button of [infoButton, closeButton, previous, next]) {
            button.type = "button";
        }
        infoButton.title = "Details";
        infoButton.setAttribute("aria-expanded", "false");
        closeButton.title = "Close";
        previous.title = "Previous";
        next.title = "Next";

        infoButton.addEventListener("click", () => toggleInfo());
        closeButton.addEventListener("click", closeViewer);
        previous.addEventListener("click", () => step(-1));
        next.addEventListener("click", () => step(1));
        element.addEventListener("click", (event) => {
            if (event.target === element) {
                closeViewer();
            }
        });

        const bar = el("div", "photo-viewer-bar");
        const identity = el("div", "photo-viewer-identity");
        identity.append(el("p", "eyebrow", "StarCore · Photo"), title);
        const actions = el("div", "photo-viewer-bar-actions");
        actions.append(position, infoButton, closeButton);
        bar.append(identity, actions);

        const stage = el("div", "photo-viewer-stage");
        stage.append(previous, image, next);
        attachSwipe(stage);

        const panelBody = el("div", "photo-viewer-panel-body");
        panelBody.append(meta, locationSection);
        const panel = el("div", "photo-viewer-panel");
        panel.appendChild(panelBody);

        element.append(bar, stage, panel);
        return {
            element, image, title, position, meta, panel, infoButton, previous, next,
            locationUnavailable, locationMapEl,
        };
    }

    function attachSwipe(stage) {
        // touch only - a mouse already has the overlay buttons and the keyboard
        // shortcuts, and dragging with a mouse is more often a text/image
        // selection than an attempt to change photos
        let startX = null;
        let startY = null;

        stage.addEventListener("touchstart", (event) => {
            if (event.touches.length !== 1) {
                startX = null;
                return;
            }
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, { passive: true });

        stage.addEventListener("touchend", (event) => {
            if (startX === null || viewerList.length <= 1) {
                startX = null;
                return;
            }

            const touch = event.changedTouches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            startX = null;

            // a deliberate horizontal swipe, not a scroll or a tap
            if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
                step(deltaX < 0 ? 1 : -1);
            }
        }, { passive: true });
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
        } else if (event.key === "i" || event.key === "I") {
            if (!viewer.infoButton.hidden) {
                toggleInfo();
            }
        }
    }
}

/* ---------- helpers ---------- */

const RENAME_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11.3 2.7l2 2-7.6 7.6-2.6.6.6-2.6 7.6-7.6z"/>
    </svg>`;
const DELETE_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3.5 4.5h9M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"/>
    </svg>`;

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

function cameraLabel(metadata) {
    const { camera_make: make, camera_model: model } = metadata || {};
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
