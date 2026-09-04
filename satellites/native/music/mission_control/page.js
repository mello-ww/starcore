const VIEWS = ["albums", "artists", "tracks"];
const SKELETONS = 10;

export function mount(context) {
    const { element: root, satellite, api } = context;

    let summary = null;
    let albums = [];
    let artists = [];
    let tracks = [];
    let view = "albums";
    let filter = "";
    let openAlbum = null;
    let queue = [];
    let playing = -1;

    const tiles = el("dl", "tiles");
    const content = el("div", "music-content");
    const notice = el("p", "music-notice");
    const scanPanel = buildScanPanel();
    const search = buildSearch();
    const tabs = buildTabs();
    const player = buildPlayer();
    notice.hidden = true;

    const body = el("div", "stack");
    body.append(tiles, buildToolbar(), scanPanel, notice, content);
    root.replaceChildren(buildHead(), body, player.element);

    skeleton();
    load();

    return () => {
        player.audio.pause();
        player.audio.removeAttribute("src");
        player.element.remove();
    };

    /* ---------- structure ---------- */

    function buildHead() {
        const head = el("div", "page-head");
        head.append(
            el("h2", null, "Library"),
            el("span", "badge badge-type", satellite.type),
            el("span", `badge ${satellite.enabled ? "badge-up" : "badge-down"}`, satellite.enabled ? "enabled" : "disabled"),
            el("p", null, satellite.description || "Local music library."),
        );
        return head;
    }

    function buildToolbar() {
        const toolbar = el("div", "music-toolbar");
        const scan = el("button", "button button-primary", "Scan library");
        scan.type = "button";
        scan.addEventListener("click", () => toggleScan());

        toolbar.append(tabs, search, scan);
        return toolbar;
    }

    function buildTabs() {
        const group = el("div", "music-tabs");

        for (const name of VIEWS) {
            const button = el("button", "music-tab", name);
            button.type = "button";
            button.dataset.view = name;
            button.addEventListener("click", () => {
                view = name;
                openAlbum = null;
                render();
            });
            group.appendChild(button);
        }

        return group;
    }

    function buildSearch() {
        const input = el("input", "music-search");
        input.type = "search";
        input.placeholder = "Search";
        input.spellcheck = false;
        input.addEventListener("input", () => {
            filter = input.value.trim().toLowerCase();
            openAlbum = null;
            render();
        });
        return input;
    }

    function buildScanPanel() {
        const panel = el("section", "panel music-scan");
        panel.hidden = true;

        const input = el("input");
        input.type = "text";
        input.spellcheck = false;
        input.placeholder = "Folder on the machine running StarCore";

        const run = el("button", "button button-primary", "Scan");
        const result = el("p", "music-scan-result");
        result.hidden = true;
        run.type = "button";

        const submit = async () => {
            run.disabled = true;
            result.className = "music-scan-result";
            result.textContent = "Scanning…";
            result.hidden = false;

            try {
                const source = input.value.trim();
                const report = await api.post("/scan", source ? { source } : {});
                result.textContent = `${report.found} file(s) · ${report.added} added · ${report.updated} updated `
                    + `· ${report.unchanged} unchanged · ${report.failed.length} failed`;
                await load();
            } catch (error) {
                result.className = "music-scan-result failed";
                result.textContent = error.message;
            } finally {
                run.disabled = false;
            }
        };

        run.addEventListener("click", submit);
        input.addEventListener("keydown", (event) => event.key === "Enter" && submit());

        const row = el("div", "music-scan-row");
        row.append(input, run);
        panel.append(
            el("p", "eyebrow", "Scan"),
            el("p", "muted", "Files are indexed where they are. Nothing is copied, moved or changed."),
            row,
            result,
        );
        return panel;
    }

    async function toggleScan(force) {
        scanPanel.hidden = force === undefined ? !scanPanel.hidden : !force;
        if (scanPanel.hidden) return;

        const input = scanPanel.querySelector("input");
        input.value = summary ? summary.source : "";
        input.focus();

        // summary.source reflects the library as it was last constructed, which
        // can lag behind a "library" directory saved through the satellite's own
        // configuration (the gear icon) until StarCore restarts - prefer the
        // freshly configured value here so the scan panel never shows a stale
        // default
        try {
            const configuration = await api.get("/configuration");
            const library = configuration.settings.find((setting) => setting.key === "library");
            if (library && library.value) {
                input.value = library.value;
            }
        } catch (error) {
            // the scan panel still works with the library summary's source above
        }
    }

    /* ---------- data ---------- */

    async function load() {
        try {
            const [library, albumList, artistList, trackList] = await Promise.all([
                api.get("/library"),
                api.get("/albums"),
                api.get("/artists"),
                api.get("/tracks"),
            ]);

            summary = library;
            albums = albumList.albums;
            artists = artistList.artists;
            tracks = trackList.tracks;
            notice.hidden = true;
            renderSummary();
            render();
        } catch (error) {
            content.replaceChildren();
            notice.textContent = `The music library could not be read: ${error.message}`;
            notice.hidden = false;
        }
    }

    /* ---------- rendering ---------- */

    function renderSummary() {
        tiles.replaceChildren(
            tile("Tracks", String(summary.tracks)),
            tile("Albums", String(summary.albums)),
            tile("Artists", String(summary.artists)),
            tile("Duration", readableDuration(summary.duration)),
        );
    }

    function tile(label, value) {
        const cell = el("div", "tile");
        cell.append(el("dt", null, label), el("dd", null, value));
        return cell;
    }

    function skeleton() {
        content.replaceChildren();
        const grid = el("div", "music-albums");
        for (let count = 0; count < SKELETONS; count += 1) {
            grid.appendChild(el("div", "music-album music-skeleton"));
        }
        content.appendChild(grid);
    }

    function render() {
        for (const button of tabs.querySelectorAll(".music-tab")) {
            button.classList.toggle("active", button.dataset.view === view);
        }

        content.replaceChildren();

        if (tracks.length === 0) {
            content.appendChild(buildEmpty());
            return;
        }

        if (openAlbum) {
            content.appendChild(buildAlbumDetail(openAlbum));
        } else if (view === "albums") {
            content.appendChild(buildAlbums());
        } else if (view === "artists") {
            content.appendChild(buildArtists());
        } else {
            content.appendChild(buildTracks(matchingTracks(), true));
        }
    }

    function buildEmpty() {
        const empty = el("div", "music-empty");
        const button = el("button", "button button-primary", "Scan library");
        button.type = "button";
        button.addEventListener("click", () => toggleScan(true));

        empty.innerHTML = `
            <svg width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                <circle cx="23" cy="23" r="16"/><circle cx="23" cy="23" r="9" opacity="0.55"/>
                <circle cx="23" cy="23" r="2.2" fill="currentColor"/>
            </svg>`;
        empty.append(
            el("p", null, "No music has been indexed yet."),
            el("p", "muted", summary ? `Point a scan at ${summary.source} or another folder to begin.` : "Scan a folder to begin."),
            button,
        );
        return empty;
    }

    function matchingAlbums() {
        if (!filter) {
            return albums;
        }
        return albums.filter((album) =>
            album.album.toLowerCase().includes(filter) || album.artist.toLowerCase().includes(filter));
    }

    function matchingTracks() {
        if (!filter) {
            return tracks;
        }
        return tracks.filter((track) => [track.title, track.artist, track.album]
            .some((value) => (value || "").toLowerCase().includes(filter)));
    }

    function buildAlbums() {
        const matches = matchingAlbums();
        if (matches.length === 0) {
            return el("p", "muted", "Nothing matches that search.");
        }

        const grid = el("div", "music-albums");
        for (const album of matches) {
            const card = el("button", "music-album");
            card.type = "button";
            card.append(
                cover(album),
                el("span", "music-album-name", album.album),
                el("span", "music-album-artist", album.artist),
                el("span", "music-album-meta", `${album.tracks} track${album.tracks === 1 ? "" : "s"} · ${readableDuration(album.duration)}`),
            );
            card.addEventListener("click", () => {
                openAlbum = album;
                render();
            });
            grid.appendChild(card);
        }
        return grid;
    }

    function cover(album, size) {
        const frame = el("span", `music-cover${size ? " large" : ""}`);
        frame.innerHTML = `
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
                <circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="8" opacity="0.5"/>
                <circle cx="24" cy="24" r="2" fill="currentColor"/>
            </svg>`;

        if (album.artwork) {
            const image = el("img");
            image.src = api.url(`/artwork/${album.id}`);
            image.alt = "";
            image.loading = "lazy";
            image.addEventListener("error", () => image.remove());
            frame.appendChild(image);
        }

        return frame;
    }

    function buildAlbumDetail(album) {
        const wrapper = el("div", "music-detail");

        const back = el("button", "music-back", "← Albums");
        back.type = "button";
        back.addEventListener("click", () => {
            openAlbum = null;
            render();
        });

        const header = el("div", "music-detail-head");
        const facts = el("div");
        facts.append(
            el("p", "eyebrow", album.artist),
            el("h3", null, album.album),
            el("p", "muted", [album.year, `${album.tracks} tracks`, readableDuration(album.duration)]
                .filter(Boolean).join(" · ")),
        );
        header.append(cover(album, true), facts);

        const albumTracks = tracks.filter((track) => (track.album || "Unknown album") === album.album
            && (track.album_artist || track.artist || "Unknown artist") === album.artist);

        wrapper.append(back, header, buildTracks(albumTracks, false));
        return wrapper;
    }

    function buildArtists() {
        const matches = filter
            ? artists.filter((artist) => artist.name.toLowerCase().includes(filter))
            : artists;

        if (matches.length === 0) {
            return el("p", "muted", "Nothing matches that search.");
        }

        const list = el("div", "music-artists");
        for (const artist of matches) {
            const row = el("button", "music-artist");
            row.type = "button";
            row.append(
                el("span", "music-artist-name", artist.name),
                el("span", "music-artist-meta", `${artist.albums} album${artist.albums === 1 ? "" : "s"} · ${artist.tracks} tracks`),
            );
            row.addEventListener("click", () => {
                filter = artist.name.toLowerCase();
                search.value = artist.name;
                view = "albums";
                render();
            });
            list.appendChild(row);
        }
        return list;
    }

    function buildTracks(list, showAlbum) {
        if (list.length === 0) {
            return el("p", "muted", "Nothing matches that search.");
        }

        const table = el("div", "music-tracks");
        list.forEach((track, position) => {
            const row = el("button", "music-track");
            row.type = "button";
            row.dataset.track = track.id;

            const number = el("span", "music-track-number", String(track.track || position + 1));
            const title = el("span", "music-track-title", track.title);
            const artist = el("span", "music-track-artist", track.artist || "Unknown artist");
            const length = el("span", "music-track-duration", readableDuration(track.duration));

            row.append(number, title, artist);
            if (showAlbum) {
                row.appendChild(el("span", "music-track-album", track.album || "Unknown album"));
            }
            row.appendChild(length);
            row.addEventListener("click", () => play(list, position));
            table.appendChild(row);
        });
        return table;
    }

    /* ---------- player ---------- */

    function buildPlayer() {
        const element = el("div", "music-player");
        element.hidden = true;

        const audio = new Audio();
        audio.preload = "metadata";

        const title = el("p", "music-player-title");
        const artist = el("p", "music-player-artist");
        const elapsed = el("span", "music-player-time", "0:00");
        const total = el("span", "music-player-time", "0:00");
        const seek = el("input", "music-player-seek");
        seek.type = "range";
        seek.min = 0;
        seek.max = 1000;
        seek.value = 0;

        const previous = el("button", "music-player-step", "‹");
        const toggle = el("button", "music-player-toggle", "▶");
        const next = el("button", "music-player-step", "›");
        const close = el("button", "music-player-close", "✕");
        for (const button of [previous, toggle, next, close]) {
            button.type = "button";
        }
        previous.title = "Previous";
        next.title = "Next";
        close.title = "Stop";

        previous.addEventListener("click", () => step(-1));
        next.addEventListener("click", () => step(1));
        toggle.addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
        close.addEventListener("click", stop);

        audio.addEventListener("play", () => (toggle.textContent = "❚❚"));
        audio.addEventListener("pause", () => (toggle.textContent = "▶"));
        audio.addEventListener("ended", () => step(1));
        audio.addEventListener("loadedmetadata", () => (total.textContent = readableDuration(audio.duration)));
        audio.addEventListener("timeupdate", () => {
            elapsed.textContent = readableDuration(audio.currentTime);
            if (audio.duration) {
                seek.value = String((audio.currentTime / audio.duration) * 1000);
            }
        });
        seek.addEventListener("input", () => {
            if (audio.duration) {
                audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
            }
        });

        const details = el("div", "music-player-details");
        details.append(title, artist);

        const controls = el("div", "music-player-controls");
        controls.append(previous, toggle, next);

        const progress = el("div", "music-player-progress");
        progress.append(elapsed, seek, total);

        element.append(controls, details, progress, close);
        return { element, audio, title, artist, seek };
    }

    function play(list, position) {
        queue = list;
        playing = position;
        const track = queue[playing];
        if (!track) {
            return;
        }

        player.element.hidden = false;
        player.title.textContent = track.title;
        player.artist.textContent = [track.artist, track.album].filter(Boolean).join(" · ") || "Unknown artist";
        player.audio.src = api.url(`/stream/${track.id}`);
        player.audio.play().catch(() => {
            notice.textContent = `${track.filename} could not be played by this browser.`;
            notice.hidden = false;
        });

        for (const row of content.querySelectorAll(".music-track")) {
            row.classList.toggle("playing", row.dataset.track === track.id);
        }
    }

    function step(offset) {
        if (queue.length === 0) {
            return;
        }
        play(queue, (playing + offset + queue.length) % queue.length);
    }

    function stop() {
        player.audio.pause();
        player.audio.removeAttribute("src");
        player.element.hidden = true;
        playing = -1;
        for (const row of content.querySelectorAll(".music-track")) {
            row.classList.remove("playing");
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

function readableDuration(seconds) {
    const total = Math.floor(Number(seconds) || 0);
    if (total >= 3600) {
        return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
    }
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
