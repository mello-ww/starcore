import { connect } from "./connect.js";
import * as session from "./session.js";
import { button, el, emptyState, icon } from "./dom.js";
import { player } from "./player.js";

export function devicesPanel() {
    const hub = connect(player());
    const node = el("div", "mu-devices");
    const stop = hub.subscribe(render);
    const stopRemote = player().on("remote", render);

    function render() {
        const me = player().device;
        const remote = player().remote;
        const items = [el("h4", null, "Play on")];
        if (!hub.online) {
            items.push(el("p", "mu-devices-note", "Reconnecting to StarCore Connect…"));
        }
        const local = button(null, `mu-device${!remote ? " current" : ""}`, () => hub.transfer(me).catch((error) => session.toast(error.message, "error")));
        local.append(icon("devices"), el("span", "mu-device-name", "This browser"), el("span", "mu-device-state", !remote ? "Listening here" : "Move playback here"));
        items.push(local);
        const others = hub.devices.filter((device) => device.id !== me);
        for (const device of others) {
            const entry = button(null, `mu-device${remote && remote.device.id === device.id ? " current" : ""}${device.online ? "" : " offline"}`, async () => {
                if (!device.online) {
                    session.toast(`${device.name} is offline`);
                    return;
                }
                try {
                    if (player().current) {
                        await hub.transfer(device.id);
                    } else {
                        hub.control(device);
                    }
                } catch (error) {
                    session.toast(error.message, "error");
                }
            });
            entry.disabled = !device.online;
            entry.append(icon(device.kind === "mobile" ? "devices" : "volume"), el("span", "mu-device-name", device.name),
                el("span", "mu-device-state", device.online ? (device.playing ? "Playing" : "Available") : "Offline"));
            items.push(entry);
        }
        if (!others.length) {
            items.push(emptyState("No other devices", "Open StarCore Music on your phone or another browser signed in to this server and it appears here."));
        }
        if (remote) {
            items.push(button("Stop controlling and stay here", "mu-text-button", () => hub.disconnectRemote()));
        }
        node.replaceChildren(...items);
    }

    hub.refresh().then(render);
    render();
    node.dispose = () => {
        stop();
        stopRemote();
    };
    return node;
}
