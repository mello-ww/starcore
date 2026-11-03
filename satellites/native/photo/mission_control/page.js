const SKELETONS = 12;
// "trash" is deliberately not a tab of its own - the Recycle bin is one of
// the four kinds shown inside "albums" (see renderAlbums()); "config" is
// where source_paths/sync_default_path/trash_retention_days/the standalone
// listener's own settings all live together (see buildConfigPanel())
const TABS = ["photos", "albums", "map", "locked", "config"];

// the Locked Folder is its own satellite (own data, own PIN, own routes);
// Photos only hosts its interface as a tab - see section_of in its
// satellite.toml and its own mission_control/page.js
const LOCKED_FOLDER = "LockedFolder";
const LOCKED_URL = `/api/satellites/${LOCKED_FOLDER}`;

function tabLabel(name) {
    if (name === "map") {
        return "Map";
    }
    if (name === "locked") {
        return "Locked Folder";
    }
    if (name === "config") {
        return "Configuration";
    }
    return name[0].toUpperCase() + name.slice(1);
}

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
    let albums = [];            // physical + virtual + Favorites together, each with its own "kind" - see refresh()
    let favoriteIds = new Set();  // kept in sync with the Favorites album's own photo_ids, for the heart toggle
    let trash = [];             // photos currently in the recycle bin (see loadTrash/renderTrash)
    let retentionDays = null;   // from the satellite's own configuration - how long the bin keeps a photo
    let tab = "photos";
    let groupBy = "month";      // "month" (the default), "camera", or "all" - see buildGroupToggle()
    let openAlbum = null;       // full album detail (with resolved .photos), or null
    let trashOpen = false;      // showing the Recycle bin inside the Albums tab, instead of the albums grid
    let viewerList = [];        // whichever array the open viewer is stepping through
    let viewer = null;
    let index = -1;
    let infoOpen = false;
    let mapState = null;        // { map, markers, located } once the Map tab has been built once
    let locationMap = null;     // { map, marker } for the photo-details location panel, built once
    let configState = null;     // { settings } from the last /configuration read - see buildConfigPanel()

    const summary = el("dl", "tiles");
    // why thumbnails are originals or videos have no frame: both are optional tools on the server
    const toolsNote = el("p", "photo-notice photo-notice-ok photo-tools-note");
    toolsNote.hidden = true;
    const tabBar = buildTabBar();
    const photosPanel = buildPhotosPanel();
    const albumsPanel = buildAlbumsPanel();
    const trashPanel = buildTrashPanel();
    const mapPanel = buildMapPanel();
    const configPanel = buildConfigPanel();
    const lockedPanel = el("div", "photo-tab-panel photo-locked-panel");
    const lockedApi = {
        url: (path) => `${LOCKED_URL}${path}`,
        get: (path) => requestJson(`${LOCKED_URL}${path}`),
        post: (path, payload) => requestJson(`${LOCKED_URL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {}),
        }),
    };
    let lockedModule = null;     // the Locked Folder's page module, loaded on first use
    let lockedCleanup = null;    // set while its tab is showing; locks it again when called
    let lockedAvailable = false; // whether a Locked Folder satellite answers at all
    const notice = el("p", "photo-notice");
    notice.hidden = true;

    const body = el("div", "stack");
    body.append(summary, toolsNote, tabBar, notice, photosPanel.element, albumsPanel.element, mapPanel.element, lockedPanel,
        configPanel.element);
    root.replaceChildren(buildHead(), body);

    setTab("photos");
    skeleton();
    refresh();
    detectLockedFolder();
    document.addEventListener("keydown", onKeyDown);

    const cleanup = () => {
        document.removeEventListener("keydown", onKeyDown);
        leaveLockedFolder();
        closeViewer();
        if (mapState) {
            mapState.map.remove();
        }
        if (locationMap) {
            locationMap.map.remove();
        }
    };
    // Mission Control calls this when the route names a section of this page
    // (#/satellite/Photo/LockedFolder) while it is already showing
    cleanup.showSection = (section) => setTab(section === LOCKED_FOLDER ? "locked" : "photos");
    return cleanup;

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
            const button = el("button", "photo-tab", tabLabel(name));
            button.type = "button";
            if (name === "config") {
                // StarCore's shared Settings gear (.sc-gear in Mission Control's core.css)
                const gear = el("i", "sc-gear");
                gear.setAttribute("aria-hidden", "true");
                button.prepend(gear);
            }
            if (name === "locked") {
                const lock = el("span", "photo-tab-lock");
                lock.innerHTML = LOCK_ICON;
                button.prepend(lock);
                button.hidden = true;  // until detectLockedFolder() finds one
            }
            button.dataset.tab = name;
            button.addEventListener("click", () => setTab(name));
            group.appendChild(button);
        }
        return group;
    }

    function setTab(name) {
        if (name === "locked" && !lockedAvailable) {
            name = "photos";
        }
        if (tab === "locked" && name !== "locked") {
            leaveLockedFolder();
        }
        tab = name;
        for (const button of tabBar.querySelectorAll(".photo-tab")) {
            button.classList.toggle("active", button.dataset.tab === name);
        }

        photosPanel.element.hidden = name !== "photos";
        albumsPanel.element.hidden = name !== "albums";
        mapPanel.element.hidden = name !== "map";
        lockedPanel.hidden = name !== "locked";
        configPanel.element.hidden = name !== "config";
        rememberSection(name);

        if (name === "locked") {
            enterLockedFolder();
        } else if (name === "albums") {
            renderAlbums();
        } else if (name === "map") {
            renderMap();
        } else if (name === "config") {
            loadConfig();
        }
    }

    /* ---------- Locked Folder tab ---------- */

    async function detectLockedFolder() {
        try {
            await lockedApi.get("/status");
            lockedAvailable = true;
        } catch (error) {
            lockedAvailable = false;  // no Locked Folder satellite on this server
        }
        tabBar.querySelector('[data-tab="locked"]').hidden = !lockedAvailable;
        if (viewer) {
            viewer.lockButton.hidden = !lockedAvailable;
        }
        if (lockedAvailable && context.section === LOCKED_FOLDER) {
            setTab("locked");
        }
    }

    async function loadLockedModule() {
        if (!lockedModule) {
            const stylesheet = `${LOCKED_URL}/assets/page.css`;
            if (!document.querySelector(`link[href="${stylesheet}"]`)) {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = stylesheet;
                document.head.appendChild(link);
            }
            lockedModule = await import(`${LOCKED_URL}/assets/page.js`);
        }
        return lockedModule;
    }

    async function enterLockedFolder() {
        if (lockedCleanup) {
            return;
        }
        lockedPanel.replaceChildren(el("p", "lf-muted", "Loading…"));
        try {
            const module = await loadLockedModule();
            if (tab !== "locked" || lockedCleanup) {
                return;
            }
            lockedCleanup = module.mount({ element: lockedPanel, api: lockedApi, onPhotosChanged: refresh });
        } catch (error) {
            lockedPanel.replaceChildren(el("p", "photo-notice", `The Locked Folder could not be loaded: ${error.message}`));
        }
    }

    function leaveLockedFolder() {
        if (lockedCleanup) {
            lockedCleanup();  // locks it again
            lockedCleanup = null;
        }
        lockedPanel.replaceChildren();
    }

    function rememberSection(name) {
        // keeps the address in step with the tab, without a navigation
        const base = `#/satellite/${encodeURIComponent(satellite.name)}`;
        const wanted = name === "locked" ? `${base}/${LOCKED_FOLDER}` : base;
        if (location.hash.startsWith(base) && location.hash !== wanted) {
            history.replaceState(null, "", wanted);
        }
    }

    // Moves the photo on screen into the Locked Folder - asking for the PIN
    // first when this session hasn't unlocked it - then drops it from every
    // list here, the same way deleting it does.
    async function moveViewedPhotoToLockedFolder() {
        const photo = viewerList[index];
        if (!photo || !lockedAvailable) {
            return;
        }
        viewer.lockButton.disabled = true;
        try {
            const state = await lockedApi.get("/status");
            if (!state.configured || !state.pin_set) {
                closeViewer();
                setTab("locked");
                return;
            }
            if (!state.unlocked) {
                const module = await loadLockedModule();
                if (!(await module.requestUnlock(lockedApi))) {
                    return;
                }
            }
            const result = await lockedApi.post("/move_in", { photo_ids: [photo.id] });
            if (result.failed && result.failed.length) {
                throw new Error(result.failed[0].reason);
            }
            // the unlock was only needed for the move - lock again straight away
            await lockedApi.post("/lock", {}).catch(() => {});
            await forgetPhoto(photo);
            showNotice("Moved to the Locked Folder.", false);
        } catch (error) {
            showNotice(`The photo could not be moved: ${error.message}`, true);
        } finally {
            if (viewer) {
                viewer.lockButton.disabled = false;
            }
        }
    }

    function showNotice(text, isError) {
        notice.textContent = text;
        notice.classList.toggle("photo-notice-ok", !isError);
        notice.hidden = false;
        clearTimeout(showNotice.timer);
        showNotice.timer = setTimeout(() => {
            notice.hidden = true;
        }, isError ? 8000 : 4000);
    }

    /* ---------- Photos tab ---------- */

    function buildPhotosPanel() {
        const element = el("div", "photo-tab-panel");
        const importPanel = buildImportPanel();
        // a plain block: renderGallery() puts one grid (or one grid per
        // group) inside it, and a grid nested in another grid would be
        // squeezed into a single cell - a single column of photos
        const gallery = el("div", "photo-gallery-host");

        element.append(buildToolbar(importPanel), importPanel, gallery);
        return { element, importPanel, gallery };
    }

    function buildToolbar(importPanel) {
        const toolbar = el("div", "photo-toolbar");
        const button = el("button", "button button-primary", "Import photos");
        button.type = "button";
        button.addEventListener("click", () => toggleImport(importPanel));

        const left = el("div", "photo-toolbar-left");
        left.append(el("p", "eyebrow", "Gallery"), buildGroupToggle());

        const actions = el("div", "photo-actions");
        actions.append(button);
        toolbar.append(left, actions);
        return toolbar;
    }

    function buildGroupToggle() {
        // "By month" is the default grouping (most recent month first, using
        // each photo's own captured_at) - "By camera" only ever shows once at
        // least one photo actually carries that metadata (see renderGallery()),
        // and "All" is a flat grid for anyone who doesn't want either grouping
        const group = el("div", "photo-group-toggle");
        const month = el("button", "photo-tab", "By month");
        const byCamera = el("button", "photo-tab", "By camera");
        const all = el("button", "photo-tab", "All");

        for (const [button, key] of [[month, "month"], [byCamera, "camera"], [all, "all"]]) {
            button.type = "button";
            button.dataset.group = key;
            button.addEventListener("click", () => {
                groupBy = key;
                renderGallery();
            });
        }

        group.append(month, byCamera, all);
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

    function toggleImport(importPanel, force) {
        importPanel.hidden = force === undefined ? !importPanel.hidden : !force;
        if (!importPanel.hidden) {
            importPanel.querySelector("input").focus();
        }
    }

    function renderSync(status) {
        const syncPanel = configPanel.syncSection;
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

        facts.dataset.developer = "";  // upload counters: Developer Mode only
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
            log.dataset.developer = "";  // the upload log: Developer Mode only
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
            const [libraryInfo, listing, status, albumListing, favorites] = await Promise.all([
                api.get("/library"), api.get("/photos"), api.get("/sync"), api.get("/albums"),
                api.get("/albums/favorites")]);
            photos = listing.photos;
            albums = albumListing.albums;
            favoriteIds = new Set(favorites.photo_ids || []);
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
        // "images"/"videos" are only reported once the library actually holds
        // a video - a library that predates video support, or one with none
        // yet, still just says "N photos" rather than "N photos · 0 videos"
        const label = libraryInfo.videos
            ? `${libraryInfo.images} photo${libraryInfo.images === 1 ? "" : "s"} · `
              + `${libraryInfo.videos} video${libraryInfo.videos === 1 ? "" : "s"}`
            : String(libraryInfo.photos);

        summary.replaceChildren(
            tile("Photos", label),
            tile("Library size", readableSize(libraryInfo.size_bytes)),
            tile("Thumbnails", libraryInfo.thumbnails ? "cached" : "originals", libraryInfo.thumbnails),
            tile("Phone sync", status.running ? "listening" : "off", status.running),
        );
        renderToolsNote(libraryInfo);
    }

    function renderToolsNote(libraryInfo) {
        const missing = [];
        if (!libraryInfo.thumbnails && libraryInfo.images) {
            missing.push("Pillow isn't installed on the StarCore server, so the gallery loads every "
                + "photo at full size instead of a small thumbnail.");
        }
        if (!libraryInfo.video_thumbnails && libraryInfo.videos) {
            missing.push("FFmpeg isn't installed on the StarCore server, so videos show a placeholder "
                + "instead of a preview frame.");
        }
        toolsNote.hidden = missing.length === 0;
        toolsNote.textContent = missing.length
            ? `${missing.join(" ")} Install ${missing.length > 1 ? "them" : "it"} and restart StarCore; `
              + "nothing in the library changes."
            : "";
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
        const grid = el("div", "photo-gallery");
        for (let count = 0; count < SKELETONS; count += 1) {
            grid.appendChild(el("div", "photo-tile photo-skeleton"));
        }
        photosPanel.gallery.replaceChildren(grid);
    }

    function renderGallery() {
        const gallery = photosPanel.gallery;
        gallery.replaceChildren();

        const toggle = photosPanel.element.querySelector(".photo-group-toggle");
        const hasCameraData = photos.some((photo) => cameraLabel(photo.metadata || {}));
        const cameraButton = toggle.querySelector('[data-group="camera"]');
        cameraButton.hidden = !hasCameraData;
        if (groupBy === "camera" && !hasCameraData) {
            groupBy = "month";
        }
        for (const button of toggle.querySelectorAll(".photo-tab")) {
            button.classList.toggle("active", button.dataset.group === groupBy);
        }

        if (photos.length === 0) {
            gallery.appendChild(buildEmpty());
            return;
        }

        if (groupBy === "all") {
            gallery.appendChild(buildGrid(photos));
            return;
        }

        if (groupBy === "camera") {
            // grouped by camera/device - a photo with no camera metadata still
            // shows up, in its own "Unknown camera" group, rather than being
            // hidden; alphabetical, since there's no natural chronological
            // order between cameras the way there is between months
            const groups = new Map();
            for (const photo of photos) {
                const label = cameraLabel(photo.metadata || {}) || "Unknown camera";
                if (!groups.has(label)) {
                    groups.set(label, []);
                }
                groups.get(label).push(photo);
            }
            gallery.appendChild(buildGroupedGrid([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))));
            return;
        }

        // groupBy === "month" (the default): most recent month first, each
        // photo placed by when it was captured - falling back to when it was
        // imported for a photo with no capture date at all, so nothing is
        // ever left out of every group
        const groups = new Map();
        for (const photo of photos) {
            const key = monthSortKey(photo);
            if (!groups.has(key)) {
                groups.set(key, { label: monthLabel(photo), items: [] });
            }
            groups.get(key).items.push(photo);
        }
        const ordered = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
        gallery.appendChild(buildGroupedGrid(ordered.map(([, group]) => [group.label, group.items])));
    }

    function buildGroupedGrid(entries) {
        const wrapper = el("div", "photo-groups");
        for (const [label, group] of entries) {
            const section = el("div", "photo-group");
            section.append(el("p", "eyebrow photo-group-title", `${label} · ${group.length}`), buildGrid(group));
            wrapper.appendChild(section);
        }
        return wrapper;
    }

    // "Unknown date" sorts last regardless of grouping key comparisons below,
    // since an empty sort key ("") always loses a descending string compare
    // against any real "YYYY-MM" key
    function monthSortKey(photo) {
        const date = parsedDate(photo);
        return date ? `${date.getFullYear()}-${String(date.getMonth()).padStart(2, "0")}` : "";
    }

    function monthLabel(photo) {
        const date = parsedDate(photo);
        return date ? date.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Unknown date";
    }

    function parsedDate(photo) {
        const raw = photo.captured_at || photo.imported_at;
        if (!raw) {
            return null;
        }
        const date = new Date(raw);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function buildGrid(list) {
        const grid = el("div", "photo-gallery");
        list.forEach((photo, position) =>
            grid.appendChild(buildTile(photo, () => openViewer(list, position),
                [buildFavoriteBadge(photo), buildDeleteBadge(photo, refresh)])));
        return grid;
    }

    // The heart toggle shown on every tile and in the viewer bar - Favorites
    // is just a normal album under the hood (see albums.py), so toggling it
    // here is the exact same /albums/favorites/photos(/remove) call the
    // Favorites album detail view itself uses; `onToggled(isFavorite)` lets a
    // caller react (e.g. dropping the tile from an open Favorites album view
    // the moment it's unfavorited).
    function buildFavoriteBadge(photo, onToggled) {
        const button = el("button", "photo-tile-favorite");
        button.type = "button";
        button.innerHTML = HEART_ICON;

        const sync = () => {
            const isFavorite = favoriteIds.has(photo.id);
            button.classList.toggle("active", isFavorite);
            button.title = isFavorite ? "Remove from Favorites" : "Add to Favorites";
        };
        sync();

        button.addEventListener("click", async (event) => {
            event.stopPropagation();
            button.disabled = true;
            const makeFavorite = !favoriteIds.has(photo.id);
            try {
                const path = makeFavorite ? "/albums/favorites/photos" : "/albums/favorites/photos/remove";
                await api.post(path, { photo_id: photo.id });
                if (makeFavorite) {
                    favoriteIds.add(photo.id);
                } else {
                    favoriteIds.delete(photo.id);
                }
                sync();
                await reloadAlbums();
                if (tab === "albums") {
                    renderAlbums();
                }
                if (viewer && viewerList[index] && viewerList[index].id === photo.id) {
                    updateViewerFavoriteButton(photo);
                }
                if (onToggled) {
                    onToggled(makeFavorite);
                }
            } catch (error) {
                // the heart simply doesn't flip
            } finally {
                button.disabled = false;
            }
        });

        return button;
    }

    // Moves a photo to the recycle bin (see docs/photo.md#recycle-bin) - the
    // same "trash" endpoint the mobile app and the bin itself use, never a
    // separate delete path. `onDeleted` decides how the caller's own view
    // catches up (a full refresh from the main gallery, a narrower re-fetch
    // from inside an open album).
    function buildDeleteBadge(photo, onDeleted) {
        const button = el("button", "photo-tile-remove", "");
        button.type = "button";
        button.title = "Move to Recycle Bin";
        button.innerHTML = DELETE_ICON;
        button.addEventListener("click", async (event) => {
            event.stopPropagation();
            button.disabled = true;
            try {
                await api.post(`/trash/${photo.id}`, {});
                await onDeleted();
            } catch (error) {
                button.disabled = false;
            }
        });
        return button;
    }

    function buildEmpty() {
        const empty = el("div", "photo-empty");
        const button = el("button", "button button-primary", "Import photos");
        button.type = "button";
        button.addEventListener("click", () => toggleImport(photosPanel.importPanel, true));

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

    function buildTile(photo, onOpen, badges) {
        const isVideo = photo.media_type === "video";
        const tileEl = el("button", isVideo ? "photo-tile photo-tile-video" : "photo-tile");
        tileEl.type = "button";
        tileEl.title = photo.filename;

        const image = el("img");
        image.src = api.url(`/thumbnails/${photo.id}`);
        image.alt = photo.filename;
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => {
            tileEl.classList.add("unavailable");
            if (isVideo) {
                image.remove();  // no frame: a plain tile with the play badge, not a broken-image icon
            }
        });

        const caption = el("span", "photo-caption", photo.filename);
        tileEl.append(image, caption);

        // a video without a renderable thumbnail (no ffmpeg on this server -
        // see PhotoLibrary.thumbnail_path) still needs *something* recognizable
        // in the grid rather than a broken-image icon, so the play badge and
        // duration always show, whether or not the poster frame itself loaded
        if (isVideo) {
            const play = el("span", "photo-tile-play");
            play.innerHTML = PLAY_ICON;
            tileEl.appendChild(play);
            const duration = durationLabel(photo.duration);
            if (duration) {
                tileEl.appendChild(el("span", "photo-tile-duration", duration));
            }
        }

        for (const badge of badges || []) {
            if (badge) {
                tileEl.appendChild(badge);
            }
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

        if (trashOpen) {
            content.appendChild(buildTrashSection());
            loadTrash();
            return;
        }

        if (openAlbum) {
            content.appendChild(buildAlbumDetail(openAlbum));
            return;
        }

        // four visually distinguished groups, always in this order - Physical
        // (from Photo configuration's source_paths, see albums.py), Favorites
        // (always present, see AlbumStore.ensure_favorites()), Custom/virtual
        // albums the user created, then the Recycle bin - see docs/photo.md,
        // "Albums"
        const physical = albums.filter((album) => album.kind === "physical");
        const favorites = albums.find((album) => album.kind === "favorites");
        const custom = albums.filter((album) => album.kind === "virtual");

        const wrapper = el("div", "photo-album-groups");
        wrapper.appendChild(buildAlbumGroup(
            "physical", "Physical albums", physical,
            "Mirror your phone's own folder structure - add or edit the mapping in Photo configuration.",
        ));
        if (favorites) {
            wrapper.appendChild(buildAlbumGroup("favorites", "Favorites", [favorites]));
        }
        wrapper.appendChild(buildAlbumGroup(
            "virtual", "Custom albums", custom,
            "Reference a photo from as many of these as you like - nothing is moved or copied.",
        ));
        wrapper.appendChild(buildRecycleBinGroup());
        content.appendChild(wrapper);
    }

    function buildAlbumGroup(kind, title, list, hint) {
        const section = el("div", `photo-album-group photo-album-group-${kind}`);
        section.appendChild(el("p", "eyebrow", title));
        if (hint) {
            section.appendChild(el("p", "muted photo-album-group-hint", hint));
        }

        if (list.length === 0) {
            const message = kind === "physical"
                ? "No source paths configured yet."
                : "No custom albums yet - create one to start grouping photos together.";
            section.appendChild(el("p", "muted photo-album-group-empty", message));
            return section;
        }

        const grid = el("div", "photo-albums");
        for (const album of list) {
            grid.appendChild(buildAlbumCard(album));
        }
        section.appendChild(grid);
        return section;
    }

    function buildRecycleBinGroup() {
        const section = el("div", "photo-album-group photo-album-group-trash");
        section.appendChild(el("p", "eyebrow", "Recycle bin"));

        const card = el("div", "photo-album-card photo-album-card-trash");
        card.tabIndex = 0;

        const cover = el("div", "photo-album-cover empty");
        cover.innerHTML = TRASH_ICON;
        const meta = el("div", "photo-album-meta");
        meta.append(
            el("p", "photo-album-name", "Recycle bin"),
            el("p", "muted", "Deleted photos, until they're restored or erased"),
        );

        const open = () => {
            trashOpen = true;
            renderAlbums();
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
            }
        });

        card.append(cover, meta);
        const grid = el("div", "photo-albums");
        grid.appendChild(card);
        section.appendChild(grid);
        return section;
    }

    function buildTrashSection() {
        const wrapper = el("div", "photo-album-detail");
        const back = el("button", "photo-back", "← Albums");
        back.type = "button";
        back.addEventListener("click", () => {
            trashOpen = false;
            renderAlbums();
        });
        trashPanel.element.hidden = false;
        wrapper.append(back, trashPanel.element);
        return wrapper;
    }

    function albumKindLabel(kind) {
        if (kind === "physical") {
            return "Physical";
        }
        if (kind === "favorites") {
            return "Favorites";
        }
        return "";
    }

    function buildAlbumCard(album) {
        const card = el("div", `photo-album-card photo-album-card-${album.kind}`);
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
            if (album.kind === "favorites") {
                cover.innerHTML = HEART_ICON;
            }
        }

        const meta = el("div", "photo-album-meta");
        const nameRow = el("p", "photo-album-name");
        nameRow.appendChild(document.createTextNode(album.name));
        const kindLabel = albumKindLabel(album.kind);
        if (kindLabel) {
            nameRow.appendChild(el("span", `photo-album-kind-badge photo-album-kind-${album.kind}`, kindLabel));
        }
        meta.append(nameRow, el("p", "muted", `${album.photo_count} photo${album.photo_count === 1 ? "" : "s"}`));

        const open = () => openAlbumDetail(album.id);
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
            }
        });

        card.append(cover, meta);

        // rename/delete only make sense for a custom album - a physical
        // album is derived from configuration and Favorites can't be
        // renamed or deleted at all (see AlbumStore.rename()/delete())
        if (album.kind === "virtual") {
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
            card.appendChild(actions);
        }

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
        const wrapper = el("div", `photo-album-detail photo-album-detail-${album.kind}`);

        const back = el("button", "photo-back", "← Albums");
        back.type = "button";
        back.addEventListener("click", () => {
            openAlbum = null;
            renderAlbums();
        });

        const header = el("div", "photo-album-detail-head");
        const title = el("h3", null, album.name);
        const kindLabel = albumKindLabel(album.kind);
        const titleRow = el("div", "photo-album-detail-title");
        titleRow.appendChild(title);
        if (kindLabel) {
            titleRow.appendChild(el("span", `photo-album-kind-badge photo-album-kind-${album.kind}`, kindLabel));
        }

        const actionsRow = el("div", "photo-album-detail-actions");
        // rename/delete/add-photos only apply to a custom album - a physical
        // album's membership is automatic (its own photos join it purely by
        // physical_path) and Favorites can't be renamed, deleted, or added to
        // this way (use the heart toggle on a photo instead) - the backend
        // rejects all of these for both anyway (see api.py's _albums_post)
        if (album.kind === "virtual") {
            const rename = iconButton("Rename", RENAME_ICON);
            rename.addEventListener("click", () => openAlbumPrompt(album));
            titleRow.appendChild(rename);

            const addPhotos = el("button", "button button-primary", "Add photos");
            addPhotos.type = "button";
            addPhotos.addEventListener("click", () => openAddPhotosPicker(album));
            const remove = el("button", "button button-stop", "Delete album");
            remove.type = "button";
            remove.addEventListener("click", () => confirmDeleteAlbum(album, true));
            actionsRow.append(addPhotos, remove);
        }

        header.append(titleRow, el("p", "muted", `${album.photos.length} photo${album.photos.length === 1 ? "" : "s"}`), actionsRow);

        wrapper.append(back, header);

        if (album.photos.length === 0) {
            const empty = el("div", "photo-empty");
            const message = album.kind === "physical"
                ? "No photos have synced into this physical album yet."
                : album.kind === "favorites"
                ? "You haven't favorited anything yet."
                : "This album has no photos yet.";
            empty.appendChild(el("p", null, message));
            if (album.kind === "virtual") {
                empty.appendChild(el("p", "muted", "Use “Add photos” to choose some."));
            }
            wrapper.appendChild(empty);
            return wrapper;
        }

        const grid = el("div", "photo-gallery");
        album.photos.forEach((photo, position) => {
            const badges = [];
            // physical membership can't be edited directly, but Favorites and
            // custom albums both get the same heart toggle every other grid
            // uses - unfavoriting here (from the Favorites album itself) also
            // drops the tile from this open view, same as the generic
            // "remove from album" badge below does for a custom album
            if (album.kind !== "physical") {
                badges.push(buildFavoriteBadge(photo, (isFavorite) => {
                    if (album.kind === "favorites" && !isFavorite) {
                        openAlbum.photos = openAlbum.photos.filter((candidate) => candidate.id !== photo.id);
                        renderAlbums();
                    }
                }));
            }
            if (album.kind === "virtual") {
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
                badges.push(remove);
            }

            grid.appendChild(buildTile(photo, () => openViewer(album.photos, position), badges));
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

    /* ---------- Recycle bin tab ---------- */

    function buildTrashPanel() {
        const element = el("div", "photo-tab-panel");
        element.hidden = true;

        const toolbar = el("div", "photo-toolbar");
        toolbar.append(el("p", "eyebrow", "Recycle bin"));

        const retentionNote = el("p", "muted photo-trash-retention");
        const notice = el("p", "photo-notice");
        notice.hidden = true;
        const content = el("div", "photo-trash-content");

        element.append(toolbar, retentionNote, notice, content);
        return { element, retentionNote, notice, content };
    }

    async function loadTrash() {
        try {
            const data = await api.get("/trash");
            trash = data.photos;
            retentionDays = data.retention_days;
            trashPanel.notice.hidden = true;
        } catch (error) {
            trash = [];
            trashPanel.notice.textContent = `The recycle bin could not be read: ${error.message}`;
            trashPanel.notice.hidden = false;
        }
        renderTrash();
    }

    function renderTrash() {
        const { content, retentionNote } = trashPanel;

        retentionNote.textContent = retentionDays != null
            ? `Deleted photos stay here for ${retentionDays} day${retentionDays === 1 ? "" : "s"}, then are ` +
              "permanently erased. Restore a photo any time before then, or erase it yourself right away."
            : "";

        content.replaceChildren();
        if (trash.length === 0) {
            content.appendChild(buildTrashEmpty());
            return;
        }

        const grid = el("div", "photo-gallery");
        for (const photo of trash) {
            grid.appendChild(buildTrashTile(photo));
        }
        content.appendChild(grid);
    }

    function buildTrashEmpty() {
        const empty = el("div", "photo-empty");
        empty.innerHTML = `
            <svg width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                <path d="M11 15.5h24M18 15.5V11a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4.5M14.5 15.5l1.6 21a2 2 0 0 0 2 1.85h9.8a2 2 0 0 0 2-1.85l1.6-21"/>
            </svg>`;
        empty.append(
            el("p", null, "The recycle bin is empty."),
            el("p", "muted", "Deleted photos stay here, restorable, until their retention period runs out."),
        );
        return empty;
    }

    function buildTrashTile(photo) {
        const tileEl = el("div", "photo-tile photo-trash-tile");
        tileEl.title = photo.filename;

        const image = el("img");
        image.src = api.url(`/trash/${photo.id}/thumbnail`);
        image.alt = photo.filename;
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => tileEl.classList.add("unavailable"));

        const remaining = daysRemaining(photo.trashed_at);
        const caption = el("span", "photo-caption", remaining ? `${photo.filename} · ${remaining}` : photo.filename);

        const actions = el("div", "photo-trash-actions");
        const restore = iconButton("Restore", RESTORE_ICON);
        const erase = iconButton("Erase permanently", DELETE_ICON);
        restore.addEventListener("click", () => restorePhoto(photo));
        erase.addEventListener("click", () => confirmErasePhoto(photo));
        actions.append(restore, erase);

        tileEl.append(image, caption, actions);
        return tileEl;
    }

    function daysRemaining(trashedAt) {
        if (!trashedAt || retentionDays == null) {
            return "";
        }
        const trashedDate = new Date(trashedAt);
        if (Number.isNaN(trashedDate.getTime())) {
            return "";
        }
        const elapsedDays = (Date.now() - trashedDate.getTime()) / 86400000;
        const remaining = Math.max(0, Math.ceil(retentionDays - elapsedDays));
        return remaining <= 0 ? "erasing soon" : `${remaining} day${remaining === 1 ? "" : "s"} left`;
    }

    async function restorePhoto(photo) {
        try {
            await api.post(`/trash/${photo.id}/restore`, {});
        } catch (error) {
            return;
        }
        trash = trash.filter((candidate) => candidate.id !== photo.id);
        renderTrash();
        await refresh();
    }

    function confirmErasePhoto(photo) {
        const overlay = el("div", "modal-overlay");
        const modal = el("div", "modal");
        const head = el("div", "modal-head");
        head.append(el("h2", null, "Permanently erase photo"));
        const close = el("button", "modal-close", "✕");
        close.type = "button";
        close.addEventListener("click", () => overlay.remove());
        head.appendChild(close);

        const body = el("div", "stack");
        body.append(el("p", null, `Permanently erase "${photo.filename}"? This cannot be undone.`));
        const actions = el("div", "photo-actions");
        const cancel = el("button", "button", "Cancel");
        const confirm = el("button", "button button-stop", "Erase permanently");
        cancel.type = "button";
        confirm.type = "button";
        cancel.addEventListener("click", () => overlay.remove());
        confirm.addEventListener("click", async () => {
            confirm.disabled = true;
            try {
                await api.post(`/trash/${photo.id}/erase`, {});
                trash = trash.filter((candidate) => candidate.id !== photo.id);
                renderTrash();
                overlay.remove();
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

    /* ---------- Configuration tab ---------- */
    //
    // Everything Photo-specific in one place: the phone -> server path
    // mappings physical albums are built from, the default sync
    // destination, the recycle bin's retention period, the default import
    // directory, and the standalone phone-sync listener's own status/token
    // (moved in from what used to be a separate "Phone sync" toggle on the
    // Photos toolbar - see docs/satellites/photo.md, "Mobile app"). All of
    // it goes through the one generic /configuration route (see
    // configuration.py) - there is no second settings mechanism here.

    function buildConfigPanel() {
        const element = el("div", "photo-tab-panel");
        const notice = el("p", "photo-notice");
        notice.hidden = true;

        const sourcePaths = el("section", "panel photo-config-section");
        const otherSettings = el("section", "panel photo-config-section");
        const syncSection = el("section", "panel photo-sync");

        element.append(notice, sourcePaths, otherSettings, syncSection);
        return { element, notice, sourcePaths, otherSettings, syncSection };
    }

    async function loadConfig() {
        configPanel.notice.hidden = true;
        try {
            const payload = await api.get("/configuration");
            configState = { settings: payload.settings };
            renderSourcePaths();
            renderOtherSettings();
        } catch (error) {
            configPanel.notice.textContent = `Configuration could not be loaded: ${error.message}`;
            configPanel.notice.hidden = false;
        }
    }

    function settingValue(key) {
        const setting = (configState?.settings || []).find((item) => item.key === key);
        return setting ? setting.value : undefined;
    }

    async function saveSetting(key, value, onDone) {
        try {
            const payload = await api.post("/configuration", { key, value });
            configState = { settings: payload.settings };
            if (onDone) {
                onDone(null, payload.note);
            }
        } catch (error) {
            if (onDone) {
                onDone(error);
            }
        }
    }

    function renderSourcePaths() {
        const { sourcePaths } = configPanel;
        sourcePaths.replaceChildren();

        const mappings = (settingValue("source_paths") || []).map((entry) => ({ ...entry }));
        const error = el("p", "banner error");
        error.hidden = true;

        const rows = el("div", "photo-source-paths");
        const rerender = () => {
            rows.replaceChildren(...mappings.map((entry, position) => buildSourcePathRow(entry, position)));
        };

        function buildSourcePathRow(entry, position) {
            const row = el("div", "photo-source-path-row");
            const phoneInput = labeledInput("Phone folder", entry.phone_path, "/Pictures/Screenshots");
            const serverInput = labeledInput("Server path", entry.server_path, "screenshots");
            const nameInput = labeledInput("Album name", entry.name, "Screenshots");
            const remove = el("button", "icon-button photo-icon-button", "");
            remove.type = "button";
            remove.title = "Remove this mapping";
            remove.innerHTML = DELETE_ICON;
            remove.addEventListener("click", () => {
                mappings.splice(position, 1);
                rerender();
            });

            for (const [input, key] of [[phoneInput.input, "phone_path"], [serverInput.input, "server_path"], [nameInput.input, "name"]]) {
                input.addEventListener("input", () => (entry[key] = input.value));
            }

            row.append(phoneInput.field, serverInput.field, nameInput.field, remove);
            return row;
        }

        function labeledInput(labelText, value, placeholder) {
            const field = el("label", "photo-source-path-field");
            field.append(el("span", null, labelText));
            const input = document.createElement("input");
            input.type = "text";
            input.value = value || "";
            input.placeholder = placeholder;
            input.spellcheck = false;
            field.appendChild(input);
            return { field, input };
        }

        rerender();

        const add = el("button", "button", "Add mapping");
        add.type = "button";
        add.addEventListener("click", () => {
            mappings.push({ phone_path: "", server_path: "", name: "" });
            rerender();
        });

        const save = el("button", "button button-primary", "Save mappings");
        save.type = "button";
        save.addEventListener("click", async () => {
            error.hidden = true;
            save.disabled = true;
            await saveSetting("source_paths", mappings, (saveError) => {
                save.disabled = false;
                if (saveError) {
                    error.textContent = saveError.message;
                    error.hidden = false;
                } else {
                    renderSourcePaths();
                }
            });
        });

        const actions = el("div", "photo-actions");
        actions.append(add, save);

        sourcePaths.append(
            el("p", "eyebrow", "Phone folder → server path mappings"),
            el("p", "muted", "Each mapping becomes its own physical album (see the Albums tab). The phone "
                + "folder is whatever a phone's own camera-roll grouping calls it; the server path is never "
                + "assumed to be the same string."),
            rows, error, actions,
        );
    }

    function renderOtherSettings() {
        const { otherSettings } = configPanel;
        otherSettings.replaceChildren();

        const fields = [
            { key: "sync_default_path", label: "Default sync destination", placeholder: "camera",
              hint: "Physical album a synced file joins when its phone folder matches no mapping above." },
            { key: "trash_retention_days", label: "Recycle bin retention (days)", type: "number" },
            { key: "photo_directory", label: "Default import directory", placeholder: "/absolute/path" },
        ];

        otherSettings.appendChild(el("p", "eyebrow", "Other settings"));

        for (const field of fields) {
            const wrapper = el("div", "config-field");
            const labelEl = el("label", null, field.label);
            const input = document.createElement("input");
            input.type = field.type || "text";
            input.value = settingValue(field.key) ?? "";
            if (field.placeholder) {
                input.placeholder = field.placeholder;
            }
            const save = el("button", "button", "Save");
            save.type = "button";
            const status = el("span", "photo-config-status");

            save.addEventListener("click", async () => {
                save.disabled = true;
                status.textContent = "";
                await saveSetting(field.key, input.value, (error, note) => {
                    save.disabled = false;
                    status.textContent = error ? error.message : (note || "Saved.");
                    status.classList.toggle("error", Boolean(error));
                });
            });

            const row = el("div", "photo-config-row");
            row.append(input, save, status);
            wrapper.append(labelEl, row);
            if (field.hint) {
                wrapper.appendChild(el("p", "hint", field.hint));
            }
            // a setting Photo describes as advanced: shown in Developer Mode only
            if (settingDescription(field.key)?.developer) {
                wrapper.dataset.developer = "";
            }
            otherSettings.appendChild(wrapper);
        }
    }

    function settingDescription(key) {
        return (configState?.settings || []).find((item) => item.key === key);
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
            viewer.video.pause();
            viewer.video.removeAttribute("src");  // stop it from continuing to buffer once removed
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
        const isVideo = photo.media_type === "video";

        // the previous item's video (if any) must stop before this one shows -
        // otherwise it keeps playing, off-screen, behind whatever comes next
        viewer.video.pause();

        viewer.image.hidden = isVideo;
        viewer.video.hidden = !isVideo;
        if (isVideo) {
            viewer.video.poster = api.url(`/thumbnails/${photo.id}`);
            viewer.video.src = api.url(`/originals/${photo.id}`);
        } else {
            viewer.video.removeAttribute("src");
            viewer.image.src = api.url(`/originals/${photo.id}`);
        }
        viewer.image.alt = photo.filename;
        viewer.title.textContent = photo.filename;
        viewer.position.textContent = `${index + 1} / ${viewerList.length}`;

        const multiple = viewerList.length > 1;
        viewer.previous.hidden = !multiple;
        viewer.next.hidden = !multiple;

        // present fields only - most photos have no EXIF at all, or only some of
        // it, and a wall of "—" is worse than not showing the row. Ordered as a
        // reader would want it: when and where, then the gear, then exposure,
        // then the file itself. A video has none of the EXIF-derived rows (no
        // camera/GPS metadata is read from one - see library.py's add_file()),
        // but does get its own Duration row in their place.
        const rows = [
            ["Captured", formatDate(photo.captured_at) || "unknown"],
            ["Duration", isVideo ? durationLabel(photo.duration) : null],
            ["Location", metadata.gps_coordinates, mapLink(metadata)],
            ["Camera", cameraLabel(metadata)],
            ["Lens", metadata.lens_model],
            ["Focal length", metadata.focal_length ? `${metadata.focal_length} mm` : null],
            ["Aperture", metadata.aperture ? `f/${metadata.aperture}` : null],
            ["Shutter speed", metadata.shutter_speed],
            ["ISO", metadata.iso ? String(metadata.iso) : null],
            ["Dimensions", photo.width && photo.height ? `${photo.width} × ${photo.height}` : null],
            ["Megapixels", metadata.megapixels ? `${metadata.megapixels} MP` : null],
            ["Size", readableSize(photo.size)],
            ["Format", photo.format.toUpperCase()],
            ["Orientation", orientationLabel(metadata.orientation)],
            // the physical album this synced photo landed in (see
            // library.add_file()'s physical_path docstring) - absent for a
            // desktop-imported photo, which never had one resolved at all
            ["Path", photo.physical_path],
            ["Imported", formatDate(photo.imported_at)],
        ];

        const visible = rows.filter(([, value]) => value);
        viewer.meta.replaceChildren(...visible.map(([label, value, href]) => fact(label, value, href)));
        renderLocationPanel(metadata);
        updateViewerFavoriteButton(photo);

        // a photo with nothing beyond its dimensions and size still has those
        // two rows, so the info button only disappears for a fully empty panel
        viewer.infoButton.hidden = visible.length === 0;
        if (visible.length === 0) {
            toggleInfo(false);
        }
    }

    function updateViewerFavoriteButton(photo) {
        const isFavorite = favoriteIds.has(photo.id);
        viewer.favoriteButton.classList.toggle("active", isFavorite);
        viewer.favoriteButton.title = isFavorite ? "Remove from Favorites" : "Add to Favorites";
    }

    // The viewer bar's own heart toggle - see buildFavoriteBadge() for the
    // grid/album-detail equivalent this mirrors exactly.
    async function toggleViewedFavorite() {
        const photo = viewerList[index];
        if (!photo) {
            return;
        }

        viewer.favoriteButton.disabled = true;
        const makeFavorite = !favoriteIds.has(photo.id);
        try {
            const path = makeFavorite ? "/albums/favorites/photos" : "/albums/favorites/photos/remove";
            await api.post(path, { photo_id: photo.id });
            if (makeFavorite) {
                favoriteIds.add(photo.id);
            } else {
                favoriteIds.delete(photo.id);
            }
            updateViewerFavoriteButton(photo);
            await reloadAlbums();
            if (openAlbum && openAlbum.kind === "favorites" && !makeFavorite) {
                openAlbum.photos = openAlbum.photos.filter((candidate) => candidate.id !== photo.id);
            }
            if (tab === "albums") {
                renderAlbums();
            }
        } catch (error) {
            // the heart simply doesn't flip
        } finally {
            viewer.favoriteButton.disabled = false;
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
        const video = el("video", "photo-viewer-image photo-viewer-video");
        video.controls = true;
        video.playsInline = true;
        video.hidden = true;
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
        const favoriteButton = el("button", "photo-viewer-favorite");
        favoriteButton.innerHTML = HEART_ICON;
        const deleteButton = el("button", "photo-viewer-delete");
        deleteButton.innerHTML = DELETE_ICON;
        const lockButton = el("button", "photo-viewer-lock");
        lockButton.innerHTML = LOCK_ICON;
        lockButton.hidden = !lockedAvailable;
        const closeButton = el("button", "photo-viewer-close", "✕");
        const previous = el("button", "photo-viewer-step previous", "‹");
        const next = el("button", "photo-viewer-step next", "›");

        for (const button of [infoButton, favoriteButton, lockButton, deleteButton, closeButton, previous, next]) {
            button.type = "button";
        }
        infoButton.title = "Details";
        infoButton.setAttribute("aria-expanded", "false");
        favoriteButton.title = "Add to Favorites";
        deleteButton.title = "Move to Recycle Bin";
        lockButton.title = "Move to Locked Folder";
        lockButton.setAttribute("aria-label", "Move to Locked Folder");
        closeButton.title = "Close";
        previous.title = "Previous";
        next.title = "Next";

        infoButton.addEventListener("click", () => toggleInfo());
        favoriteButton.addEventListener("click", () => toggleViewedFavorite());
        deleteButton.addEventListener("click", () => deleteViewedPhoto());
        lockButton.addEventListener("click", () => moveViewedPhotoToLockedFolder());
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
        actions.append(position, infoButton, favoriteButton, lockButton, deleteButton, closeButton);
        bar.append(identity, actions);

        const stage = el("div", "photo-viewer-stage");
        stage.append(previous, image, video, next);
        attachSwipe(stage);

        const panelBody = el("div", "photo-viewer-panel-body");
        panelBody.append(meta, locationSection);
        const panel = el("div", "photo-viewer-panel");
        panel.appendChild(panelBody);

        element.append(bar, stage, panel);
        return {
            element, image, video, title, position, meta, panel, infoButton, favoriteButton, deleteButton, lockButton,
            previous, next,
            locationUnavailable, locationMapEl,
        };
    }

    // Moves the photo currently on screen to the recycle bin, then steps to
    // the next one (or closes the viewer if that was the last one) - the same
    // trash endpoint the gallery's own delete badge and the mobile app use.
    async function deleteViewedPhoto() {
        const photo = viewerList[index];
        if (!photo) {
            return;
        }

        viewer.deleteButton.disabled = true;
        try {
            await api.post(`/trash/${photo.id}`, {});
        } catch (error) {
            viewer.deleteButton.disabled = false;
            return;
        }
        viewer.deleteButton.disabled = false;
        await forgetPhoto(photo);
    }

    // drops a photo that left the library view (recycle bin or Locked Folder)
    // from every list on this page, then steps the viewer on
    async function forgetPhoto(photo) {
        viewerList = viewerList.filter((candidate) => candidate.id !== photo.id);
        photos = photos.filter((candidate) => candidate.id !== photo.id);
        favoriteIds.delete(photo.id);
        if (openAlbum) {
            openAlbum.photos = openAlbum.photos.filter((candidate) => candidate.id !== photo.id);
            // a physical album has no photo_ids of its own - membership is
            // computed from physical_path, not stored (see albums.py)
            if (openAlbum.photo_ids) {
                openAlbum.photo_ids = openAlbum.photo_ids.filter((id) => id !== photo.id);
            }
        }

        renderGallery();
        await reloadAlbums();
        if (tab === "albums") {
            renderAlbums();
        }

        if (viewerList.length === 0) {
            closeViewer();
        } else {
            index = Math.min(index, viewerList.length - 1);
            show();
        }
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

async function requestJson(url, init) {
    const response = await fetch(url, { headers: { Accept: "application/json" }, ...init });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error((payload && payload.error) || `${url} failed with status ${response.status}`);
    }
    return payload;
}

const LOCK_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/>
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
    </svg>`;

const RENAME_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11.3 2.7l2 2-7.6 7.6-2.6.6.6-2.6 7.6-7.6z"/>
    </svg>`;
const DELETE_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3.5 4.5h9M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"/>
    </svg>`;
const RESTORE_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3.2 8a4.8 4.8 0 1 1 1.5 3.5"/>
        <path d="M3.2 4.6V8h3.4"/>
    </svg>`;
const PLAY_ICON = `
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M4.5 3.3a.8.8 0 0 1 1.22-.68l7 4.7a.8.8 0 0 1 0 1.36l-7 4.7a.8.8 0 0 1-1.22-.68V3.3z"/>
    </svg>`;
const HEART_ICON = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 13.4S2.4 10 2.4 6.1A3.1 3.1 0 0 1 8 4.2a3.1 3.1 0 0 1 5.6 1.9c0 3.9-5.6 7.3-5.6 7.3z"/>
    </svg>`;
const TRASH_ICON = `
    <svg width="22" height="22" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
        <path d="M11 15.5h24M18 15.5V11a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4.5M14.5 15.5l1.6 21a2 2 0 0 0 2 1.85h9.8a2 2 0 0 0 2-1.85l1.6-21"/>
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

// mirrors videos.py's own duration_label() - the one other place this
// mm:ss/h:mm:ss formatting is written, so both agree on how a video's length
// reads (though the server never actually calls this one; each video's
// "duration" already arrives from the API as a number of seconds)
function durationLabel(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        return "";
    }

    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value) => String(value).padStart(2, "0");

    return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
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
