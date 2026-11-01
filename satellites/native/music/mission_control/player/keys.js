import * as store from "../store.js";
import { isTyping } from "../ui/dom.js";
import { isFullscreenOpen } from "./fullscreen.js";
import { player } from "./player.js";

let installed = false;

// only while Music is on screen, so other Mission Control pages keep their own keys
function active() {
    return isFullscreenOpen() || Boolean(document.querySelector(".mu-root"));
}

export function installKeys(focusSearch, toggleQueue) {
    if (installed) {
        return;
    }
    installed = true;
    document.addEventListener("keydown", (event) => {
        if (!active() || isTyping(event) || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        if (document.querySelector(".mu-modal-backdrop, .mu-menu")) {
            return;
        }
        const instance = player();
        const key = event.key;
        if (key === " " && !(event.target && event.target.tagName === "BUTTON")) {
            event.preventDefault();
            instance.toggle();
        } else if (event.shiftKey && key === "ArrowRight") {
            event.preventDefault();
            instance.next();
        } else if (event.shiftKey && key === "ArrowLeft") {
            event.preventDefault();
            instance.previous();
        } else if (key === "ArrowRight" && instance.current && event.target === document.body) {
            event.preventDefault();
            instance.seek(instance.engine.position + 5);
        } else if (key === "ArrowLeft" && instance.current && event.target === document.body) {
            event.preventDefault();
            instance.seek(instance.engine.position - 5);
        } else if (key === "m" || key === "M") {
            instance.engine.toggleMute();
        } else if ((key === "l" || key === "L") && instance.current) {
            store.toggleLiked("track", instance.current.id);
        } else if (key === "q" || key === "Q") {
            toggleQueue();
        } else if (key === "/") {
            event.preventDefault();
            focusSearch();
        }
    });
}
