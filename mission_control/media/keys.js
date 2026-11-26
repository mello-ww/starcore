import * as session from "./session.js";
import { isTyping } from "./dom.js";
import { extension } from "./extensions.js";
import { isFullscreenOpen } from "./fullscreen.js";
import { player } from "./player.js";
import { shortcut } from "./keyrule.js";

let installed = false;

// a menu, a dialog (the shared media viewer and pickers are ones: they own the arrows) or a
// full-screen overlay is open
function blocked() {
    return Boolean(document.querySelector(".pl-modal-backdrop, .pl-menu, [role='dialog'][aria-modal='true']"))
        || document.body.classList.contains("ui-viewer-open");
}

// the page's own search: the hook an own page registers, else the first search block drawn
function focusSearch() {
    const hook = extension("focusSearch");
    if (hook) {
        hook();
        return;
    }
    const input = document.querySelector(".ui-search-input");
    if (input) {
        input.focus();
    }
}

export function installKeys(toggleQueue) {
    if (installed) {
        return;
    }
    installed = true;
    document.addEventListener("keydown", (event) => {
        const instance = player();
        const target = event.target;
        const action = shortcut(event, {
            typing: isTyping(event),
            blocked: blocked(),
            hasTrack: Boolean(instance.current),
            onBody: target === document.body,
            onButton: Boolean(target && target.tagName === "BUTTON"),
            ownPage: Boolean(document.querySelector(".pl-root")),
            fullscreen: isFullscreenOpen(),
        });
        if (!action) {
            return;
        }
        if (action !== "mute" && action !== "like" && action !== "queue") {
            event.preventDefault();
        }
        if (action === "toggle") {
            instance.toggle();
        } else if (action === "next") {
            instance.next();
        } else if (action === "previous") {
            instance.previous();
        } else if (action === "forward") {
            instance.seek(instance.engine.position + 5);
        } else if (action === "back") {
            instance.seek(instance.engine.position - 5);
        } else if (action === "mute") {
            instance.engine.toggleMute();
        } else if (action === "like") {
            session.toggleLiked("track", instance.current.id);
        } else if (action === "queue") {
            toggleQueue();
        } else if (action === "search") {
            focusSearch();
        }
    });
}
