import * as api from "./api.js";
import * as store from "./store.js";
import { deviceName } from "./player/player.js";

const MAX_BACKOFF = 30000;

export async function fetchTracks(ids) {
    const unique = [...new Set(ids)].slice(0, 500);
    const found = new Map();
    for (let start = 0; start < unique.length; start += 12) {
        const chunk = unique.slice(start, start + 12);
        const results = await Promise.all(chunk.map((id) => api.get(`tracks/${encodeURIComponent(id)}`).catch(() => null)));
        for (const track of results) {
            if (track) {
                found.set(track.id, track);
            }
        }
    }
    return ids.map((id) => found.get(id)).filter(Boolean);
}

class Connect {
    constructor(player) {
        this.player = player;
        this.devices = [];
        this.cursor = 0;
        this.running = false;
        this.backoff = 1000;
        this.online = false;
        this.handlers = new Set();
        this.lastPlaying = null;
        player.on("state", () => {
            const playing = player.engine.playing;
            if (playing !== this.lastPlaying) {
                this.lastPlaying = playing;
                player.scheduleSave();
            }
        });
    }

    subscribe(handler) {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    notify() {
        for (const handler of this.handlers) {
            handler(this);
        }
    }

    async start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.loop();
    }

    async register() {
        const payload = await api.post("connect/register", {
            device_id: this.player.device,
            name: deviceName(),
            kind: "web",
            capabilities: { play: true, remote: true, volume: true, transcode: true },
        });
        this.cursor = Math.max(this.cursor, payload.cursor || 0);
        this.online = true;
        await this.refresh();
    }

    async refresh() {
        try {
            const payload = await api.get("connect/devices");
            this.devices = payload.devices;
            this.active = payload.active;
            if (this.player.remote) {
                const device = this.devices.find((entry) => entry.id === this.player.remote.device.id);
                if (!device || !device.online) {
                    this.player.setRemote(null);
                    store.toast("The remote device went offline");
                }
            }
            this.notify();
        } catch (error) {
            // shown as offline below
        }
    }

    async loop() {
        while (this.running) {
            try {
                if (!this.online) {
                    await this.register();
                }
                const payload = await api.get(`connect/events${api.query({ device: this.player.device, since: this.cursor, timeout: 25 })}`);
                this.backoff = 1000;
                for (const event of payload.events) {
                    await this.handle(event);
                }
                this.cursor = Math.max(this.cursor, payload.cursor);
            } catch (error) {
                this.online = false;
                this.notify();
                await new Promise((resolve) => setTimeout(resolve, this.backoff));
                this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
            }
        }
    }

    async handle(event) {
        if (event.type === "devices") {
            await this.refresh();
            return;
        }
        if (event.type === "state") {
            if (event.device !== this.player.device) {
                const device = this.devices.find((entry) => entry.id === event.device);
                if (device) {
                    device.playing = event.state.playing;
                    device.track_id = event.state.track_id;
                }
                if (this.player.remote && this.player.remote.device.id === event.device) {
                    this.player.remote.state = event.state;
                    this.player.remote.track = await this.trackFor(event.state.track_id);
                    this.player.emit("state");
                    this.player.emit("remote");
                }
                this.notify();
            }
            return;
        }
        if (event.type !== "command" || event.target !== this.player.device) {
            return;
        }
        await this.apply(event);
    }

    async trackFor(id) {
        if (!id) {
            return null;
        }
        if (this.trackCache && this.trackCache.id === id) {
            return this.trackCache;
        }
        this.trackCache = await api.get(`tracks/${encodeURIComponent(id)}`).catch(() => null);
        return this.trackCache;
    }

    async apply(event) {
        const player = this.player;
        const args = event.arguments || {};
        if (player.remote && event.command !== "transfer_in") {
            return;
        }
        switch (event.command) {
            case "play":
                await player.resume();
                break;
            case "pause":
                player.engine.pause();
                player.scheduleSave();
                if (args.transferred) {
                    await this.refresh();
                    const target = this.devices.find((device) => device.id !== player.device && device.online && device.playing)
                        || this.devices.find((device) => device.id !== player.device && device.online);
                    if (target) {
                        this.control(target);
                    }
                }
                break;
            case "toggle":
                player.toggle();
                break;
            case "stop":
                player.engine.pause();
                break;
            case "next":
                player.next();
                break;
            case "previous":
                player.previous();
                break;
            case "seek":
                player.seek(args.position);
                break;
            case "volume":
                player.setVolume(args.value);
                break;
            case "shuffle":
                player.setShuffle(args.on);
                break;
            case "repeat":
                player.repeat = args.mode;
                player.changed();
                break;
            case "set_queue": {
                const tracks = await fetchTracks(args.tracks);
                await player.play(tracks, args.index || 0, args.context);
                break;
            }
            case "add_queue":
                player.addToQueue(await fetchTracks(args.tracks));
                break;
            case "play_next":
                player.playNext(await fetchTracks(args.tracks));
                break;
            case "transfer_in":
                await this.receive(args.state, args.from_device);
                break;
            default:
                break;
        }
    }

    async receive(state, fromDevice) {
        const player = this.player;
        player.setRemote(null);
        let tracks = [];
        if (fromDevice) {
            try {
                const payload = await api.get(`queue${api.query({ device: fromDevice, expand: 1 })}`);
                tracks = (payload.state && payload.state.tracks) || [];
            } catch (error) {
                tracks = [];
            }
        }
        const known = new Set(tracks.map((track) => track.id));
        const missing = state.queue.filter((id) => !known.has(id));
        if (missing.length) {
            tracks = tracks.concat(await fetchTracks(missing));
        }
        await player.applyState(state, tracks, state.playing);
        store.toast("Playback moved to this browser");
    }

    control(device) {
        this.player.setRemote({ device, state: null, track: null });
        this.trackFor(device.track_id).then((track) => {
            if (this.player.remote && this.player.remote.device.id === device.id) {
                this.player.remote.track = track;
                this.player.emit("remote");
            }
        });
    }

    async transfer(target) {
        const player = this.player;
        if (target === player.device) {
            if (!player.remote) {
                return;
            }
            const source = player.remote.device.id;
            await api.post("connect/transfer", { device_id: player.device, target: player.device, source, play: true });
            return;
        }
        await player.save();
        const device = this.devices.find((entry) => entry.id === target);
        await api.post("connect/transfer", {
            device_id: player.device,
            target,
            source: player.remote ? player.remote.device.id : player.device,
            play: true,
        });
        player.engine.pause();
        if (device) {
            this.control(device);
        }
        store.toast(`Playing on ${device ? device.name : "another device"}`);
    }

    disconnectRemote() {
        this.player.setRemote(null);
    }
}

let instance = null;

export function connect(player) {
    if (!instance) {
        instance = new Connect(player);
    }
    return instance;
}
